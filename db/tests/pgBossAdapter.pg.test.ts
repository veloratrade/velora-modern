// B7 / B10 real-pg-boss evidence. Excluded from `npm test` by the *.pg.test.ts
// convention (tools/run-tests.mjs); run explicitly with DATABASE_URL set.
//
// WHY THIS FILE EXISTS
//   pgBossAdapter was written against a pg-boss API the pinned major does not
//   have, and a structural `as unknown as` cast hid it from the compiler. The
//   MemoryQueue suite passed throughout, because it proves the runner's
//   SEMANTICS, not the adapter's BINDING. Only a real instance can prove the
//   binding, so nothing here is simulated: every assertion runs against real
//   pg-boss on real PostgreSQL.
//
// Each test states the pg-boss v10 fact it pins down, so a future upgrade that
// changes one of them fails loudly here instead of silently dropping jobs.
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import type { JobDescriptor } from "@velora/contracts";
import { createPgBossQueue } from "../../apps/worker/src/queue/pgBossAdapter.js";
import { WorkerRunner } from "../../apps/worker/src/runner.js";
import { safeLogFields } from "../../apps/worker/src/observability/safeLog.js";

const URL = process.env["DATABASE_URL"];
const SYNC = "test.sync";
const OTHER = "test.other";

function descriptor(over: Partial<JobDescriptor> = {}): JobDescriptor {
  return {
    jobClass: SYNC,
    priorityClass: "sync",
    idempotencyKey: `sync:${Math.random().toString(36).slice(2)}`,
    payload: { accountId: "acc-1", userId: "7" },
    // DEFAULT_JOB_POLICIES.sync, scaled down so the suite stays fast.
    timeoutMs: 5_000,
    leaseMs: 60_000,
    maxAttempts: 3,
    backoffBaseMs: 1_000,
    backoffMaxMs: 300_000,
    ...over,
  };
}

/**
 * Poll until a job becomes claimable or the budget expires.
 *
 * Needed because pg-boss schedules retries with a real server-side delay; a
 * bare claim() immediately after fail() legitimately returns null.
 */
async function claimWithin(
  q: { claim: () => Promise<unknown> },
  budgetMs: number,
): Promise<{ id: string; attempts: number } | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const job = (await q.claim()) as { id: string; attempts: number } | null;
    if (job) return job;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Fresh pg-boss schema per test: no cross-test state, no ordering coupling. */
async function withQueue(
  fn: (q: Awaited<ReturnType<typeof createPgBossQueue>>) => Promise<void>,
): Promise<void> {
  const queue = await createPgBossQueue(URL!, { jobClasses: [SYNC, OTHER] });
  try {
    await fn(queue);
  } finally {
    await queue.stop();
  }
}

async function resetSchema(): Promise<void> {
  const pool = new Pool({ connectionString: URL });
  try {
    await pool.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
  } finally {
    await pool.end();
  }
}

test("pgBossAdapter on real pg-boss", { skip: URL ? false : "DATABASE_URL not set" }, async (t) => {
  await resetSchema();

  await t.test("enqueue creates a REAL persisted job (not a silent null)", async () => {
    await withQueue(async (q) => {
      const id = await q.enqueue(descriptor());
      assert.ok(id.length > 0);
      // The previous adapter returned a synthetic `dup:` id here because
      // send() silently returned null against a non-existent queue.
      assert.equal(id.startsWith("dup:"), false, "job must be genuinely persisted");
      assert.equal(await q.size(), 1, "the row must exist in PostgreSQL");
    });
  });

  await t.test("claim retrieves the real job with its descriptor intact", async () => {
    await resetSchema();
    await withQueue(async (q) => {
      const d = descriptor();
      await q.enqueue(d);
      const job = await q.claim();
      assert.ok(job, "claim must return the job the old adapter could never find");
      assert.equal(job.descriptor.jobClass, SYNC);
      assert.equal(job.descriptor.idempotencyKey, d.idempotencyKey);
      assert.deepEqual(job.descriptor.payload, { accountId: "acc-1", userId: "7" });
    });
  });

  await t.test("B7: attempts comes from pg-boss retryCount, not a hardcoded 0", async () => {
    await resetSchema();
    await withQueue(async (q) => {
      await q.enqueue(descriptor({ maxAttempts: 3, backoffBaseMs: 0 }));

      const first = await q.claim();
      assert.equal(first?.attempts, 0, "first delivery has no prior failures");
      await q.fail(first!.id);

      // VERIFIED pg-boss v10 behaviour: with retryBackoff enabled the retry is
      // scheduled into the FUTURE even when retryDelay is 0 (startAfter lands
      // ~1s out). That is the correct production posture — a hot failure loop
      // would otherwise hammer the provider — so the test waits for the real
      // schedule instead of weakening the adapter to make itself pass.
      const second = await claimWithin(q, 4_000);
      assert.ok(second, "job must be redelivered after fail()");
      assert.equal(second.attempts, 1, "attempts MUST increment — this is the B7 fix");
      await q.fail(second.id);

      const third = await claimWithin(q, 6_000);
      assert.equal(third?.attempts, 2, "attempts keeps tracking real redeliveries");
    });
  });

  await t.test("complete() acknowledges and removes the job from the queue", async () => {
    await resetSchema();
    await withQueue(async (q) => {
      await q.enqueue(descriptor());
      const job = await q.claim();
      await q.complete(job!.id);
      assert.equal(await q.claim(), null, "a completed job must not be redelivered");
    });
  });

  await t.test("retry is bounded by maxAttempts, then the job stops being delivered", async () => {
    await resetSchema();
    await withQueue(async (q) => {
      // maxAttempts 2 → retryLimit 1 → deliveries: initial + 1 retry.
      await q.enqueue(descriptor({ maxAttempts: 2, backoffBaseMs: 0 }));
      let deliveries = 0;
      for (let i = 0; i < 5; i++) {
        const job = await claimWithin(q, 4_000);
        if (!job) break;
        deliveries++;
        await q.fail(job.id);
      }
      assert.equal(deliveries, 2, "exactly maxAttempts deliveries, matching ADR-007");
      assert.equal(await claimWithin(q, 2_000), null, "exhausted job is no longer runnable");
    });
  });

  await t.test("exhausted jobs land on the dead-letter queue", async () => {
    await resetSchema();
    await withQueue(async (q) => {
      await q.enqueue(descriptor({ maxAttempts: 1, backoffBaseMs: 0 }));
      const job = await q.claim();
      await q.fail(job!.id);
      assert.equal(await q.dlqSize(), 1, "pg-boss must route it to the configured DLQ");
    });
  });

  await t.test("deadLetter() records a bounded, classified reason", async () => {
    await resetSchema();
    await withQueue(async (q) => {
      await q.enqueue(descriptor());
      const job = await q.claim();
      await q.deadLetter(job!.id, "NO_HANDLER:test.sync");

      const pool = new Pool({ connectionString: URL });
      try {
        const { rows } = await pool.query<{ output: unknown; data: unknown }>(
          "SELECT output, data FROM pgboss.job WHERE id = $1",
          [job!.id],
        );
        const out = JSON.stringify(rows[0]?.output);
        assert.match(out, /NO_HANDLER:test\.sync/, "reason is a fixed code, not free text");
        // The reason must not overwrite the payload.
        assert.deepEqual(rows[0]?.data, job!.descriptor);
      } finally {
        await pool.end();
      }
    });
  });

  await t.test("idempotent enqueue: the same key does not create a second job", async () => {
    await resetSchema();
    await withQueue(async (q) => {
      const d = descriptor({ idempotencyKey: "sync:acct-42:cursor-1" });
      const first = await q.enqueue(d);
      const second = await q.enqueue(d);
      assert.equal(await q.size(), 1, "duplicate must NOT create a second row");
      assert.equal(first.startsWith("dup:"), false);
      assert.equal(second.startsWith("dup:"), true, "duplicate converges to a derived id");
    });
  });

  await t.test("an unregistered job class is rejected instead of silently dropped", async () => {
    await resetSchema();
    await withQueue(async (q) => {
      await assert.rejects(
        () => q.enqueue(descriptor({ jobClass: "never.registered" })),
        /unregistered job class/,
      );
    });
  });

  await t.test("the runner drives a real queue end to end", async () => {
    await resetSchema();
    await withQueue(async (q) => {
      await q.enqueue(descriptor());
      let ran = 0;
      const runner = new WorkerRunner(q, new Map([[SYNC, async () => { ran++; }]]));
      assert.equal(await runner.processOnce(), "done");
      assert.equal(ran, 1);
      assert.equal(await q.size(), 0, "the job is gone from PostgreSQL");
      assert.equal(await runner.processOnce(), "idle");
    });
  });

  await t.test("a handler failure dead-letters through the real queue, secret-free", async () => {
    await resetSchema();
    await withQueue(async (q) => {
      const FAKE_SECRET = "investorPassword=Hunter2-NOT-REAL";
      await q.enqueue(descriptor({ maxAttempts: 1, backoffBaseMs: 0 }));
      const lines: string[] = [];
      const runner = new WorkerRunner(
        q,
        new Map([[SYNC, async () => { throw new Error(`MetaAPI 401 ${FAKE_SECRET}`); }]]),
        (e) => lines.push(JSON.stringify(safeLogFields(e))),
      );
      assert.equal(await runner.processOnce(), "failed");
      assert.equal(
        lines.join("\n").includes(FAKE_SECRET),
        false,
        "G-3 must hold on the real queue path too",
      );
      assert.equal(await q.dlqSize(), 1);
    });
  });

  await t.test("no secret from a job payload is persisted by the queue", async () => {
    await resetSchema();
    await withQueue(async (q) => {
      // The payload type forbids nesting; this proves what IS stored, so a
      // reviewer can see exactly what a compromised DB would expose.
      const d = descriptor({ payload: { accountId: "acc-9", userId: "3" } });
      await q.enqueue(d);
      const pool = new Pool({ connectionString: URL });
      try {
        const { rows } = await pool.query<{ data: Record<string, unknown> }>(
          "SELECT data FROM pgboss.job WHERE name = $1",
          [SYNC],
        );
        const stored = JSON.stringify(rows[0]?.data);
        for (const forbidden of ["password", "investorPassword", "secret", "token", "masterKey"]) {
          assert.equal(stored.includes(forbidden), false, `payload must not contain ${forbidden}`);
        }
        assert.match(stored, /acc-9/, "identifiers ARE stored — that is the contract");
      } finally {
        await pool.end();
      }
    });
  });
});
