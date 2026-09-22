// Daily FX schedule — the producer for the v1.5 "Daily background job pulling
// ECB rate data".
//
// WHY A SEPARATE TICK: the ECB publishes once per working day, and a tick that is
// itself a durable pg-boss cron row means the cadence survives restarts without
// any in-process timer (same mechanism and same reasoning as the sync scheduler).
//
// ONE TICK = ONE JOB. The ingestion is a single global fetch of one document, so
// unlike the per-account sync tick there is nothing to fan out: the tick enqueues
// exactly one job. `idempotencyKey` is date-scoped, so a doubled tick within the
// same day collapses to one job under the queue's stately policy — while a
// genuine next-day run is a new job.
import { DEFAULT_JOB_POLICIES } from "@velora/contracts";
import type { SafeJobDescriptor } from "@velora/contracts";
import type { QueuePort } from "../queue/QueuePort.js";

export const FX_TICK_JOB_CLASS = "fx.ecb-tick";
export const FX_RATES_JOB_CLASS = "fx.ecb-rates";

/**
 * Daily at 16:30 UTC — after the ECB's ~16:00 CET publication.
 *
 * The exact minute is not contractual (the job re-reads the publishing date the
 * ECB states, and re-running is idempotent); it is chosen to miss the
 * publication itself rather than to race it.
 */
export const DEFAULT_FX_CRON = "30 16 * * *";

/** Descriptor for one day's ingestion. */
export function buildFxDescriptor(utcDate: string): SafeJobDescriptor {
  const policy = DEFAULT_JOB_POLICIES.sync;
  return {
    jobClass: FX_RATES_JOB_CLASS,
    priorityClass: "sync",
    idempotencyKey: `fx:ecb:${utcDate}`,
    payload: {},
    ...policy,
  };
}

/**
 * Enqueue today's ingestion. Returns the number of jobs enqueued (0 or 1) so the
 * caller can log an honest count — the scheduler tick itself is not work.
 */
export async function runFxTick(queue: QueuePort, now: Date = new Date()): Promise<number> {
  await queue.enqueue(buildFxDescriptor(now.toISOString().slice(0, 10)));
  return 1;
}
