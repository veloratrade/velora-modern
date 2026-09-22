// Copy-dispatch handler semantics — the durable state machine, without a
// database. The SQL itself is proven separately by
// db/tests/copyDispatch.pg.test.ts; what this file pins down is the DECISION
// LOGIC: who gets dispatched, how a failure is recorded, when a signal becomes
// terminal, and that a duplicated job cannot double-deliver.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCopyDispatchHandler, copyIdempotencyKey } from "./copyDispatchHandler.js";
import { MAX_ATTEMPTS, retryDelaySeconds, type DispatchableSignal, type FollowerTarget, type SignalQueue } from "./signalQueue.js";
import type { CopyDispatchRequest, CopyDispatchResult, CopyTransport } from "./transports.js";
import type { QueuedJob } from "../queue/QueuePort.js";

/**
 * The double's working row. `DispatchableSignal` is read-only on purpose (the
 * port hands out snapshots), so the mutable fields are re-declared here and the
 * queue returns spread copies — exactly what a real UPDATE … RETURNING does.
 */
interface Row extends Omit<DispatchableSignal, "attempts"> {
  attempts: number;
  status: "queued" | "dispatched" | "acked" | "failed" | "expired";
  leaseExpiresMs: number | null;
  lastErrorCode: string | null;
}

/** In-memory double of the queue's state machine (semantics, not SQL). */
class FakeSignalQueue implements SignalQueue {
  readonly rows = new Map<string, Row>();
  readonly followers = new Map<string, FollowerTarget[]>();
  claimCalls = 0;

  add(
    signal: Omit<Row, "attempts" | "status" | "leaseExpiresMs" | "lastErrorCode"> & { attempts?: number },
    followers: FollowerTarget[],
  ): void {
    this.rows.set(signal.id, {
      ...signal,
      attempts: signal.attempts ?? 0,
      status: "queued",
      leaseExpiresMs: null,
      lastErrorCode: null,
    });
    this.followers.set(signal.leaderAccountId, followers);
  }

  async listDispatchable(limit: number): Promise<DispatchableSignal[]> {
    const now = Date.now();
    return [...this.rows.values()]
      .filter((r) => (r.status === "queued" || r.status === "dispatched") && (r.leaseExpiresMs === null || r.leaseExpiresMs < now))
      .filter((r) => r.attempts < MAX_ATTEMPTS)
      .slice(0, limit);
  }

  async claim(id: string, leaseSeconds: number): Promise<DispatchableSignal | null> {
    this.claimCalls += 1;
    const row = this.rows.get(id);
    if (row === undefined) return null;
    const now = Date.now();
    const due = row.leaseExpiresMs === null || row.leaseExpiresMs < now;
    if (!due || (row.status !== "queued" && row.status !== "dispatched")) return null;
    row.status = "dispatched";
    row.attempts += 1;
    row.leaseExpiresMs = now + leaseSeconds * 1000;
    return { ...row };
  }

  async followersOf(leaderAccountId: string): Promise<FollowerTarget[]> {
    return this.followers.get(leaderAccountId) ?? [];
  }

  async markAcked(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row === undefined) return;
    row.status = "acked";
    row.leaseExpiresMs = null;
  }

  async markExpired(id: string, errorCode: string): Promise<void> {
    const row = this.rows.get(id);
    // Terminal states are terminal — same predicate as the UPDATE.
    if (row === undefined || (row.status !== "queued" && row.status !== "dispatched")) return;
    row.status = "expired";
    row.leaseExpiresMs = null;
    row.lastErrorCode = errorCode;
  }

  async markFailed(id: string, errorCode: string, terminal: boolean, retryAfterSeconds: number): Promise<void> {
    const row = this.rows.get(id);
    if (row === undefined || (row.status !== "queued" && row.status !== "dispatched")) return;
    row.lastErrorCode = errorCode;
    if (terminal) {
      row.status = "failed";
      row.leaseExpiresMs = null;
      return;
    }
    // Retry: lease pushed out by the backoff, status stays 'dispatched'.
    row.leaseExpiresMs = Date.now() + retryAfterSeconds * 1000;
  }

  async attemptsOf(id: string): Promise<number> {
    return this.rows.get(id)?.attempts ?? 0;
  }
}

/** Transport double: records every request; fails/hrows on demand. */
class RecordingTransport implements CopyTransport {
  readonly name = "recording";
  readonly calls: CopyDispatchRequest[] = [];
  failWith: string | null = null;
  throwInstead = false;

  async dispatch(request: CopyDispatchRequest): Promise<CopyDispatchResult> {
    this.calls.push(request);
    if (this.throwInstead) throw new Error("provider said: user 42's account rejected the order");
    if (this.failWith !== null) return { ok: false, errorCode: this.failWith };
    return { ok: true };
  }
}

function job(signalId: string): QueuedJob {
  return {
    id: `job-${signalId}`,
    attempts: 0,
    descriptor: {
      jobClass: "copy.signal-dispatch",
      priorityClass: "sync",
      idempotencyKey: `copy:signal:${signalId}:attempt:0`,
      payload: { signalId },
      timeoutMs: 1000,
      leaseMs: 1000,
      maxAttempts: 5,
      backoffBaseMs: 100,
      backoffMaxMs: 1000,
    },
  };
}

function signal(id = "1") {
  return {
    id,
    leaderAccountId: "10",
    leaderUserId: "1",
    symbol: "EURUSD",
    direction: "buy" as const,
    volume: "0.50000000",
    price: "1.10000000",
    occurredAt: "2026-09-22T10:00:00.000Z",
    attempts: 0,
  };
}

const followerA: FollowerTarget = { relationshipId: "100", followerAccountId: "20", followerUserId: "2" };
const followerB: FollowerTarget = { relationshipId: "101", followerAccountId: "21", followerUserId: "3" };

function handler(queue: FakeSignalQueue, transport: RecordingTransport, events: Record<string, unknown>[] = []) {
  return createCopyDispatchHandler({ queue, transport, log: (e) => events.push(e) });
}

test("every active follower is dispatched once per signal, with a stable idempotency key", async () => {
  const queue = new FakeSignalQueue();
  const transport = new RecordingTransport();
  queue.add(signal("7"), [followerA, followerB]);
  await handler(queue, transport)(job("7"));

  assert.equal(transport.calls.length, 2);
  assert.deepEqual(
    transport.calls.map((c) => c.followerAccountId).sort(),
    ["20", "21"],
  );
  // The key is what makes an at-least-once retry safe: one key per
  // (signal, follower) pair, and it is derived, never caller-supplied.
  assert.deepEqual(
    transport.calls.map((c) => c.idempotencyKey).sort(),
    [copyIdempotencyKey("7", "20"), copyIdempotencyKey("7", "21")].sort(),
  );
  // Exact decimals travel as strings — never as JS numbers.
  assert.equal(transport.calls[0]?.volume, "0.50000000");
  assert.equal(transport.calls[0]?.price, "1.10000000");
  assert.equal(queue.rows.get("7")?.status, "acked");
});

test("a duplicated job cannot double-dispatch: the second claim finds a live lease", async () => {
  const queue = new FakeSignalQueue();
  const transport = new RecordingTransport();
  queue.add(signal("8"), [followerA]);
  const run = handler(queue, transport);
  await run(job("8"));
  await run(job("8")); // same signal, replayed job

  assert.equal(transport.calls.length, 1, "the replay must not dispatch again");
  assert.equal(queue.rows.get("8")?.attempts, 1);
  assert.equal(queue.rows.get("8")?.status, "acked");
});

test("no active follower ⇒ terminal `expired`, never `acked` (nothing was delivered)", async () => {
  const queue = new FakeSignalQueue();
  const transport = new RecordingTransport();
  queue.add(signal("9"), []); // e.g. the follower revoked between emit and dispatch
  const events: Record<string, unknown>[] = [];
  await handler(queue, transport, events)(job("9"));

  assert.equal(transport.calls.length, 0);
  const row = queue.rows.get("9");
  assert.equal(row?.status, "expired");
  assert.equal(row?.lastErrorCode, "NO_ACTIVE_FOLLOWER");
  assert.equal(events.at(-1)?.["reason"], "NO_ACTIVE_FOLLOWER");
});

test("a transport failure is recorded and retried under a moved lease, then fails terminally", async () => {
  const queue = new FakeSignalQueue();
  const transport = new RecordingTransport();
  transport.failWith = "FOLLOWER_ACCOUNT_OFFLINE";
  queue.add(signal("10"), [followerA]);

  const run = handler(queue, transport);
  const row = queue.rows.get("10");
  assert.ok(row);

  // Attempts 1..MAX-1 are retries.
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    row.leaseExpiresMs = null; // simulate the lease expiring (the tick's view)
    await run(job("10"));
    assert.equal(row.status, "dispatched", `attempt ${attempt} stays retryable`);
    assert.equal(row.lastErrorCode, "FOLLOWER_ACCOUNT_OFFLINE");
    assert.ok(row.leaseExpiresMs !== null && row.leaseExpiresMs > Date.now(), "lease moved into the future");
  }

  row.leaseExpiresMs = null;
  await run(job("10"));
  assert.equal(row.status, "failed", "the signal reaches a terminal state for a human to act on");
  assert.equal(row.attempts, MAX_ATTEMPTS);
  assert.equal(row.leaseExpiresMs, null);
});

test("a THROWING transport is a transport failure; its message is never recorded", async () => {
  const queue = new FakeSignalQueue();
  const transport = new RecordingTransport();
  transport.throwInstead = true;
  queue.add(signal("11"), [followerA]);
  await handler(queue, transport)(job("11"));

  const row = queue.rows.get("11");
  assert.equal(row?.lastErrorCode, "TRANSPORT_ERROR");
  assert.notEqual(row?.status, "acked");
  // The thrown text mentioned a user id; none of it may reach durable state.
  assert.ok(!JSON.stringify([...queue.rows.values()]).includes("user 42"));
});

test("a payload without signalId is a producer bug and fails the job", async () => {
  const queue = new FakeSignalQueue();
  const transport = new RecordingTransport();
  const broken: QueuedJob = { ...job("x"), descriptor: { ...job("x").descriptor, payload: {} } };
  await assert.rejects(() => handler(queue, transport)(broken), /missing signalId/);
});

test("retry backoff is deterministic and capped", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(retryDelaySeconds), [30, 60, 120, 240, 480, 900]);
});
