// Copy-signal tick — the producer that feeds `copy.signal-dispatch`.
//
// WHY A TICK RATHER THAN AN ENQUEUE FROM THE API. The API does write the signal
// row, inside the trade's transaction (that is the outbox). What it must NOT do
// is enqueue a queue job: the API process would then need the queue's
// connection and its queue table privileges, and a queue unavailable at that
// moment would fail a user's trade. The signal row is the durable fact; this
// tick is what turns the fact into work, and it can be re-run as often as
// needed because the signal's own state (lease + attempts) decides what is due.
//
// WHY THE IDEMPOTENCY KEY CARRIES THE ATTEMPT COUNT. `{signalId}:{attempts}`
// means a duplicated tick over the same due set collapses onto one job per
// (signal, attempt) — while a signal that returns to the due set after a
// backoff produces a NEW key and is therefore enqueued again. A key without the
// attempt counter would be deduplicated forever and the signal would stall.
import { DEFAULT_JOB_POLICIES } from "@velora/contracts";
import type { SafeJobDescriptor } from "@velora/contracts";
import type { QueuePort } from "../queue/QueuePort.js";
import { COPY_SIGNAL_JOB_CLASS } from "../copytrading/copyDispatchHandler.js";
import type { DispatchableSignal, SignalQueue } from "../copytrading/signalQueue.js";

export const COPY_TICK_JOB_CLASS = "copy.signals-tick";

/**
 * Every minute. The cadence is not a latency promise: it bounds how long a
 * queued signal waits for a worker to pick it up. The roadmap's "<100 ms
 * replication" acceptance figure is NOT claimed anywhere in this pass — it
 * would have to be measured against the live transport and the real broker, and
 * that has not happened.
 */
export const DEFAULT_COPY_CRON = "* * * * *";

/** Bounded fan-out per tick: the tick is not allowed to be unbounded work. */
export const DEFAULT_COPY_BATCH = 100;

export function buildCopyDescriptor(signal: DispatchableSignal): SafeJobDescriptor {
  const policy = DEFAULT_JOB_POLICIES.sync;
  return {
    jobClass: COPY_SIGNAL_JOB_CLASS,
    priorityClass: "sync",
    // One key per (signal, attempt): see the header.
    idempotencyKey: `copy:signal:${signal.id}:attempt:${signal.attempts}`,
    // Identifier only — never a price, never a symbol, never a credential.
    payload: { signalId: signal.id },
    ...policy,
  };
}

/**
 * Enqueue every due signal. Returns the number of jobs enqueued so the caller
 * logs an honest count (a tick with nothing due is not work).
 */
export async function runCopyTick(
  signals: SignalQueue,
  queue: QueuePort,
  batch: number = DEFAULT_COPY_BATCH,
): Promise<number> {
  const due = await signals.listDispatchable(batch);
  for (const signal of due) await queue.enqueue(buildCopyDescriptor(signal));
  return due.length;
}
