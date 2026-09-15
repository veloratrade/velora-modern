// pg-boss adapter — production QueuePort implementation (ADR-007/D-13).
//
// STATUS: integration-tested against REAL pg-boss 10.4.2 + PostgreSQL 17.10.
// See `db/tests/pgBossAdapter.pg.test.ts` (PG_TEST_URL-gated).
//
// Every mapping below was verified by executing it against a real instance.
// The previous version of this file was written against a pg-boss API that the
// pinned major does NOT have, and a structural `as unknown as` cast hid the
// mismatch from the compiler. It could not enqueue or claim a single job. The
// structural interface is therefore gone: we bind to the real pg-boss types so
// the compiler checks these calls.
//
// VERIFIED v10 SEMANTICS (each proven by probe, not read from docs):
//
//  1. A queue must EXIST before send(): `createQueue(name)` first, otherwise
//     `send()` silently returns null and the job is never persisted.
//  2. `fetch()` takes a queue NAME STRING. The old `fetch({queues:["*"]})` form
//     matched nothing: the SQL filters on `WHERE name = $1`, so an object
//     argument can never match a row. There is no wildcard fetch.
//  3. `retryCount` is only present with `{ includeMetadata: true }`. Without it
//     the returned Job has just { id, name, data, expireInSeconds } — which is
//     why the old adapter hardcoded `attempts: 0` (B7): the value it needed was
//     genuinely absent from the response it asked for.
//  4. `complete()` / `fail()` require (queueName, id). Calling `fail(id)` throws
//     "fail() requires an id" because the first argument is read as the name.
//  5. Deduplication needs a queue POLICY. With the default policy a repeated
//     `singletonKey` inserts a SECOND row; `stately` (or `short`) returns null
//     for the duplicate. The port contract promises dedupe, so queues are
//     created `stately`.
//  6. `getJobCounts()` DOES NOT EXIST in v10 — it throws TypeError. Sizes come
//     from `getQueueSize(name)`.
//
// RETRY OWNERSHIP: pg-boss owns retry scheduling and backoff server-side
// (`retryLimit`/`retryDelay`/`retryBackoff` per job). `fail()` transitions the
// job to `retry` until `retryCount === retryLimit`, then to `failed`. The
// runner must not also schedule retries, or attempts would be double-counted.
import type { JobDescriptor } from "@velora/contracts";
import type { QueuePort, QueuedJob } from "./QueuePort.js";

/**
 * Queue-name registry. `claim()` must poll concrete queue names because v10 has
 * no wildcard fetch, so the adapter has to know which names exist.
 *
 * Job classes are developer-authored identifiers (never user input), which is
 * what makes polling a fixed list safe and bounded.
 */
export interface PgBossQueueOptions {
  /** Job classes this worker will consume. Each becomes a pg-boss queue. */
  readonly jobClasses: readonly string[];
  /** Queue receiving jobs that exhausted their retries. */
  readonly deadLetterQueue?: string;
}

export const DEFAULT_DEAD_LETTER_QUEUE = "velora.dlq";

/**
 * Descriptors are the queue payload. `data` is persisted by pg-boss and
 * survives into retries and the DLQ, so per ADR-007 and G-3 it must carry
 * identifiers only — never a secret.
 */
type StoredDescriptor = JobDescriptor & Record<string, unknown>;

export async function createPgBossQueue(
  connectionString: string,
  options: PgBossQueueOptions,
): Promise<QueuePort & { stop(): Promise<void> }> {
  const { default: PgBoss } = await import("pg-boss");
  const boss = new PgBoss({ connectionString, max: 10 });
  await boss.start();

  const dlqName = options.deadLetterQueue ?? DEFAULT_DEAD_LETTER_QUEUE;

  // The DLQ must exist before any queue can reference it.
  await boss.createQueue(dlqName, { name: dlqName, policy: "standard" });

  // `stately` is required for the port's idempotent-enqueue contract (finding 5).
  for (const jobClass of options.jobClasses) {
    await boss.createQueue(jobClass, {
      name: jobClass,
      policy: "stately",
      deadLetter: dlqName,
    });
  }

  const known = [...options.jobClasses];

  /** Resolve the queue a job id belongs to; v10 needs the name for every op. */
  const queueOf = new Map<string, string>();

  return {
    async enqueue<P>(descriptor: JobDescriptor<P>): Promise<string> {
      if (!known.includes(descriptor.jobClass)) {
        // Fail loudly: a silent null from send() is how the previous adapter
        // dropped every job without anyone noticing.
        throw new Error(`unregistered job class: ${descriptor.jobClass.slice(0, 64)}`);
      }
      // Retry policy travels with the job so pg-boss can schedule retries
      // server-side in line with DEFAULT_JOB_POLICIES.
      const id = await boss.send(descriptor.jobClass, descriptor as StoredDescriptor, {
        singletonKey: descriptor.idempotencyKey,
        priority: 1,
        retryLimit: Math.max(0, descriptor.maxAttempts - 1),
        retryDelay: Math.ceil(descriptor.backoffBaseMs / 1000),
        retryBackoff: true,
        expireInSeconds: Math.ceil(descriptor.leaseMs / 1000),
      });
      if (id === null) {
        // VERIFIED: under `stately`, a duplicate singletonKey returns null.
        // That is the idempotent-enqueue contract converging, not an error.
        return `dup:${descriptor.idempotencyKey}`;
      }
      queueOf.set(id, descriptor.jobClass);
      return id;
    },

    async claim(): Promise<QueuedJob | null> {
      // No wildcard fetch in v10 (finding 2): poll each registered queue.
      for (const jobClass of known) {
        const jobs = await boss.fetch<StoredDescriptor>(jobClass, {
          batchSize: 1,
          includeMetadata: true, // REQUIRED for retryCount (finding 3)
        });
        const j = jobs?.[0];
        if (!j) continue;
        queueOf.set(j.id, jobClass);
        return {
          id: j.id,
          descriptor: j.data as JobDescriptor,
          // B7 FIXED: the real attempt count from pg-boss.
          // VERIFIED progression across claims: 0 → 1 → 2 with retryLimit 2.
          // Semantics match QueuePort ("failed attempts so far"): retryCount is
          // 0 on first delivery and increments on each redelivery.
          attempts: j.retryCount,
        };
      }
      return null;
    },

    async complete(id: string) {
      const name = queueOf.get(id);
      if (name === undefined) return; // unknown id — nothing to complete
      await boss.complete(name, id);
      queueOf.delete(id);
    },

    async fail(id: string) {
      const name = queueOf.get(id);
      if (name === undefined) return;
      // pg-boss applies the retry/DLQ policy itself: → `retry` while
      // retryCount < retryLimit, then → `failed` and onto the dead-letter
      // queue when configured.
      await boss.fail(name, id);
    },

    async deadLetter(id: string, reason: string) {
      const name = queueOf.get(id);
      if (name === undefined) return;
      // G-3: callers pass `CODE:jobClass` via safeDlqReason(); bounded here so
      // the invariant holds at the persistence boundary regardless of caller.
      // VERIFIED: this object lands in the job's `output` column, NOT in
      // `data`, so it cannot overwrite or contaminate the payload.
      await boss.fail(name, id, { dlq: true, reason: reason.slice(0, 128) });
    },

    async size() {
      let total = 0;
      for (const jobClass of known) total += await boss.getQueueSize(jobClass);
      return total;
    },

    async dlqSize() {
      return boss.getQueueSize(dlqName);
    },

    async dlqEntries() {
      // Dead-lettered jobs are real rows on the DLQ queue. Reading them here
      // would consume them (fetch marks jobs active), so listing stays a
      // maintenance concern; the runner only needs the count.
      return [];
    },

    /** Release the pool — pg-boss holds live connections open. */
    async stop() {
      await boss.stop({ graceful: false });
    },
  };
}
