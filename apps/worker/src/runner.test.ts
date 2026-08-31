// Worker semantics tests — ADR-007/D-13: retry, timeout, DLQ, lease reclaim,
// idempotent enqueue. Deterministic (fake clock, injected rng, zero real sleep).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryQueue } from "./queue/memoryQueue.js";
import { WorkerRunner } from "./runner.js";
import type { JobDescriptor } from "@velora/contracts";

let now = 0;
const clock = { nowMs: () => now };
function job(over: Partial<JobDescriptor> = {}): JobDescriptor {
  return {
    jobClass: "test.tick",
    priorityClass: "sync",
    idempotencyKey: "test:1",
    payload: {},
    timeoutMs: 50,
    leaseMs: 1000,
    maxAttempts: 3,
    backoffBaseMs: 10,
    backoffMaxMs: 100,
    ...over,
  };
}

test("success path: job completes and leaves the queue", async () => {
  const q = new MemoryQueue(clock, () => 0);
  const id = await q.enqueue(job());
  const r = new WorkerRunner(q, new Map([["test.tick", async () => {}]]));
  assert.equal(await r.processOnce(), "done");
  assert.equal(await q.size(), 0);
  assert.equal(await q.dlqSize(), 0);
  void id;
});

test("failing job: bounded retries then DLQ (exactly maxAttempts executions)", async () => {
  const q = new MemoryQueue(clock, () => 1); // max jitter → backoff = cap
  await q.enqueue(job());
  let executions = 0;
  const r = new WorkerRunner(q, new Map([["test.tick", async () => { executions++; throw new Error("boom"); }]]));
  const outcomes: string[] = [];
  for (let i = 0; i < 10; i++) {
    outcomes.push(await r.processOnce());
    now += 1000; // advance past backoff window
  }
  assert.equal(executions, 3); // maxAttempts bounded
  assert.equal(await q.dlqSize(), 1);
  assert.deepEqual(outcomes.slice(0, 3), ["failed", "failed", "failed"]);
  assert.ok(outcomes.slice(3).every((o) => o === "idle")); // nothing left to run
  const dlq = await q.dlqEntries();
  assert.match(dlq[0]!.reason, /max attempts \(3\)/);
});

test("hard timeout: a hanging handler is killed and retried (no runaway jobs)", async () => {
  const q = new MemoryQueue(clock, () => 0);
  await q.enqueue(job({ timeoutMs: 20 }));
  let started = 0;
  const r = new WorkerRunner(q, new Map([["test.tick", async () => { started++; await new Promise(() => {}); }]])); // never resolves
  assert.equal(await r.processOnce(), "timeout"); // returns despite the hanging handler
  assert.equal(started, 1);
  now += 1000;
  assert.equal(await r.processOnce(), "timeout"); // second attempt
  assert.equal(started, 2);
});

test("lease reclaim: crashed worker's job is claimable after lease expiry", async () => {
  const q = new MemoryQueue(clock, () => 0);
  await q.enqueue(job({ leaseMs: 100 }));
  const first = await q.claim(); // worker A claims then "crashes"
  assert.ok(first);
  assert.equal(await q.claim(), null); // not yet — lease held
  now += 101; // lease expires
  assert.equal(await q.reclaimExpired(), 1);
  const second = await q.claim(); // worker B reclaims the SAME job
  assert.ok(second);
  assert.equal(second!.id, first!.id);
});

test("idempotent enqueue: same idempotencyKey never double-enqueues", async () => {
  const q = new MemoryQueue(clock, () => 0);
  const a = await q.enqueue(job({ idempotencyKey: "sync:acc1:cur42" }));
  const b = await q.enqueue(job({ idempotencyKey: "sync:acc1:cur42" }));
  assert.equal(a, b);
  assert.equal(await q.size(), 1);
});

test("unknown job class → immediate DLQ with reason (no silent drops)", async () => {
  const q = new MemoryQueue(clock, () => 0);
  await q.enqueue(job({ jobClass: "unknown.class" }));
  const r = new WorkerRunner(q, new Map());
  assert.equal(await r.processOnce(), "no-handler");
  assert.equal(await q.dlqSize(), 1);
});
