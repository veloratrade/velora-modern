// R1 regression battery: deferred work must belong to exactly one invocation.
//
// The bug this file pins down was real: the queue lived at module scope, so two
// concurrent webhook deliveries in the same isolate shared it, and the second
// request's flush could splice the first request's task out and run it under the
// *second* request's `waitUntil`. The first request had already answered Telegram
// 200 — which is precisely what suppresses a retry — so if the second invocation
// was terminated at its own budget, the claimed update lost its work with nobody
// noticing. Everything expensive here is one shared array; the fix is one queue per
// invocation, so the tests are about ownership, not about timing luck.
//
// No database and no network: `composeRuntime` only builds a driver lazily, and each
// test ends the pool it opened.
import assert from "node:assert/strict";
import { test } from "node:test";

import { composeRuntime, createDeferredWork, type Env } from "./runtime.js";

interface FakeCtx {
  readonly props: Promise<unknown>[];
  waitUntil(promise: Promise<unknown>): void;
}

const mkCtx = (): FakeCtx => {
  const props: Promise<unknown>[] = [];
  return { props, waitUntil: (promise: Promise<unknown>): void => void props.push(promise) };
};

const gate = (): { readonly waited: Promise<void>; release: () => void } => {
  let release: () => void = () => {};
  const waited = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waited, release };
};

// No credentials in the URL: the repo's secret scan rejects `user:pass@host`.
let connections = 0;
const envFor = (): Env => {
  connections += 1;
  return {
    // Distinct connection string per call, so each test owns and ends its driver.
    HYPERDRIVE: { connectionString: `postgres://localhost:5432/velora_cf_test_${connections}` },
    TELEGRAM_BOT_TOKEN: "123456:AA_fake_fake_fake_fake_fake_fake_fake1",
    TELEGRAM_WEBHOOK_SECRET: "deferredregressiontestdeferredregressiont",
    TELEGRAM_UPDATE_MODE: "webhook",
    VELORA_APP_URL: "https://app.velora.test",
    APP_ENV: "development",
  } as Env;
};

const endPool = async (pool: { end(): Promise<void> } | null): Promise<void> => {
  try {
    await pool?.end();
  } catch {
    // An already-ended driver is not a test failure.
  }
};

test("one invocation cannot consume another invocation's deferred task", async () => {
  const ctxA = mkCtx();
  const ctxB = mkCtx();
  const a = createDeferredWork(ctxA);
  const b = createDeferredWork(ctxB);
  const hold = gate();
  const order: string[] = [];

  a.defer(async () => {
    order.push("a:start");
    await hold.waited;
    order.push("a:end");
  });
  b.defer(async () => {
    order.push("b:end");
  });

  assert.equal(a.handedOff, 1, "A deferred exactly one task");
  assert.equal(b.handedOff, 1, "B deferred exactly one task");
  assert.equal(ctxA.props.length, 1, "A handed its work to its OWN waitUntil");
  assert.equal(ctxB.props.length, 1, "B handed its work to its OWN waitUntil");

  // The decisive assertion: B settles without waiting on A's gate. Under the shared
  // array, B's drain had A's task inside it and could only finish after the gate.
  await b.settle();
  assert.deepEqual(order, ["a:start", "b:end"]);
  assert.equal(a.outstanding, 1, "A's task is still A's, and still running");

  hold.release();
  await a.settle();
  assert.deepEqual(order, ["a:start", "b:end", "a:end"], "A's task ran exactly once");
  assert.equal(a.outstanding, 0);
  assert.equal(b.outstanding, 0);
});

test("a failing task does not escape to the runtime nor strand later work", async () => {
  const ctx = mkCtx();
  const errors: unknown[] = [];
  const ran: string[] = [];
  const work = createDeferredWork(ctx, (err) => void errors.push(err));
  const boom = new Error("bot api exploded");

  work.defer(async () => {
    ran.push("first");
    throw boom;
  });
  work.defer(async () => {
    ran.push("second");
  });

  await work.settle();
  assert.deepEqual(ran, ["first", "second"], "one failure must not strand the rest");
  assert.deepEqual(errors, [boom]);
  assert.equal(work.outstanding, 0);
  // Every promise handed to the runtime RESOLVES rather than rejects: a rejection
  // reaching waitUntil surfaces as an unhandled error for the whole invocation.
  // (Each defer hands over the chain so far, so two promises are expected here.)
  assert.equal(ctx.props.length, 2, "one waitUntil per deferral");
  const settled = await Promise.allSettled(ctx.props);
  assert.deepEqual(settled.map((s) => s.status), ["fulfilled", "fulfilled"]);
});

test("without an ExecutionContext the work still runs and is still awaitable", async () => {
  // The local harness path: no waitUntil exists, so `settle()` is the only promise
  // that keeps a test from racing the work it triggered.
  const work = createDeferredWork();
  let done = false;
  work.defer(async () => {
    await Promise.resolve();
    done = true;
  });
  assert.equal(work.outstanding, 1);
  await work.settle();
  assert.equal(done, true);
  assert.equal(work.outstanding, 0);
});

test("tasks run in deferral order", async () => {
  const work = createDeferredWork();
  const order: number[] = [];
  for (const n of [1, 2, 3]) {
    work.defer(async () => {
      await new Promise((r) => setTimeout(r, 4 - n));
      order.push(n);
    });
  }
  await work.settle();
  assert.deepEqual(order, [1, 2, 3], "the chain preserves the old sequential flush order");
});

test("composeRuntime gives every invocation its own handle", async () => {
  const ctxA = mkCtx();
  const ctxB = mkCtx();
  const rtA = composeRuntime(envFor(), ctxA);
  const rtB = composeRuntime(envFor(), ctxB);
  try {
    assert.equal(rtA.reason, "ok");
    assert.equal(rtB.reason, "ok");
    assert.notEqual(rtA.deferred, rtB.deferred, "no shared handle between requests");
    rtA.deferred.defer(async () => {});
    assert.equal(rtA.deferred.handedOff, 1);
    assert.equal(rtB.deferred.handedOff, 0, "B saw nothing of A's deferral");
    // A holds exactly its own task; B holds nothing at all. Any extra entry in B
    // would mean A's work travelled to B — the R1 fault. The connection-cleanup
    // promise is registered by the fetch handler rather than by composeRuntime
    // (closing here would settle an empty chain and drop the driver before the first
    // query), so the per-request `waitUntil` count including that cleanup is asserted
    // end-to-end in scripts/integration.mjs ("each request got its OWN waitUntil
    // handle -> A=2 B=2").
    assert.equal(rtA.deferred.outstanding, 1);
    assert.equal(rtB.deferred.outstanding, 0);
    assert.equal(ctxA.props.length, 1);
    assert.equal(ctxB.props.length, 0);
  } finally {
    await Promise.all([endPool(rtA.pool), endPool(rtB.pool)]);
  }
});

test("the refusal paths still carry a usable handle", async () => {
  // /ready and the capability-absent answers compose a runtime without a pipeline.
  // A missing `deferred` there would turn a refusal into a TypeError.
  const unconfigured = composeRuntime({ APP_ENV: "development" } as Env);
  assert.equal(unconfigured.reason, "UNCONFIGURED");
  unconfigured.deferred.defer(async () => {});
  await unconfigured.deferred.settle();

  // Configured for Telegram, but no Hyperdrive binding: the capability is absent,
  // the handle must still be there.
  const noDatabase = composeRuntime({
    TELEGRAM_BOT_TOKEN: "123456:AA_fake_fake_fake_fake_fake_fake_fake1",
    TELEGRAM_WEBHOOK_SECRET: "deferredregressiontestdeferredregressiont",
    TELEGRAM_UPDATE_MODE: "webhook",
    VELORA_APP_URL: "https://app.velora.test",
    APP_ENV: "development",
  } as Env, mkCtx());
  try {
    assert.equal(noDatabase.reason, "NO_DATABASE_BINDING");
    assert.equal(noDatabase.pipeline, null);
    assert.equal(noDatabase.deferred.handedOff, 0);
    await noDatabase.deferred.settle();
  } finally {
    await endPool(noDatabase.pool);
  }
});

/*
 * CANARY — this is what the code used to do, kept here so the file above cannot
 * quietly become a tautology. If someone reintroduces a module-scope queue, this
 * test documents that the assertions in it are the very ones the new code passes.
 */
test("canary: a shared module-scope queue does lose the guarantee", async () => {
  const shared: (() => Promise<void>)[] = [];
  const ranBy: string[] = [];
  const hold = gate();

  // Request A defers (this is the old `defer: (task) => pending.push(task)`).
  shared.push(async () => {
    ranBy.push("A's task ran under B");
    await hold.waited;
  });

  // Request B flushes first: the old `pending.splice(0, pending.length)` hands
  // A's task to B, and B's waitUntil owns it from then on.
  const drainedByB = shared.splice(0, shared.length);
  const bOwns = Promise.all(drainedByB.map((task) => task()));
  assert.deepEqual(
    ranBy,
    ["A's task ran under B"],
    "A's work has already begun, under B, before B's response even existed",
  );

  // A now flushes — and finds nothing of its own to hand over. It answers Telegram
  // 200 with its outcome depending entirely on whether B's invocation survives:
  // if B is terminated at its budget (CPU, wall time, alarm), the task is cancelled
  // and the claimed update never reaches `handled`.
  assert.equal(shared.length, 0, "A has nothing left to hand to its own waitUntil");

  hold.release();
  await bOwns;
  assert.equal(ranBy.length, 1, "the task ran once, and only because B awaited it");
});
