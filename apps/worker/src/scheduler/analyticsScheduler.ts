// Analytics recompute tick — the producer for `analytics.recompute-daily`.
//
// WHY A TICK AND NOT "RECOMPUTE WHEN A TRADE IS WRITTEN". The roadmap's pivot is
// explicitly asynchronous: request-time work must not include aggregate
// computation. A tick also means one code path serves every writer — manual
// trades, MetaAPI imports, EA ingestion — without any of them knowing that
// analytics exists.
//
// WHO IS DUE. Users with at least one live trade whose instant falls inside the
// recompute window. That is a bounded, index-supported read (`trades` carries
// the account/time indexes from 0016/0022), and a user with no recent activity
// costs nothing.
//
// IDEMPOTENCY KEY = user + the UTC HOUR. A doubled tick inside the same hour
// collapses to one job; the next hour is a new job. Because the recompute itself
// is a pure function of the ledger, re-running is not merely safe — it is the
// mechanism by which a corrected or deleted trade reaches the pre-aggregates.
import { DEFAULT_JOB_POLICIES } from "@velora/contracts";
import type { SafeJobDescriptor } from "@velora/contracts";
import type { QueuePort } from "../queue/QueuePort.js";
import { ANALYTICS_RECOMPUTE_JOB_CLASS } from "../handlers/analyticsRecomputeHandler.js";
import { DEFAULT_WINDOW_DAYS, type AggregateQuery } from "../analytics/dailyRecompute.js";

export const ANALYTICS_TICK_JOB_CLASS = "analytics.recompute-tick";

/** Hourly at :20 — off the hour so it never competes with the sync tick. */
export const DEFAULT_ANALYTICS_CRON = "20 * * * *";

/** Users fanned out per tick (the tick is not allowed to be unbounded work). */
export const DEFAULT_ANALYTICS_BATCH = 50;

export function buildAnalyticsDescriptor(userId: string, from: string, to: string, hourBucket: string): SafeJobDescriptor {
  const policy = DEFAULT_JOB_POLICIES.reports;
  return {
    jobClass: ANALYTICS_RECOMPUTE_JOB_CLASS,
    priorityClass: "reports",
    idempotencyKey: `analytics:daily:${userId}:${hourBucket}`,
    payload: { userId, from, to },
    ...policy,
  };
}

/** Users with ledger activity inside the window. */
export async function listRecomputeUsers(q: AggregateQuery, from: string, limit: number): Promise<string[]> {
  const rows = await q(
    `SELECT DISTINCT t.user_id::text AS user_id
       FROM trades t
      WHERE t.deleted_at IS NULL
        AND t.quarantined = false
        AND t.occurred_at >= $1::timestamptz
      ORDER BY 1
      LIMIT $2::int`,
    [from, limit],
  );
  return rows.map((row) => String(row["user_id"]));
}

/** Resolve the [from, to) window the tick will ask each job to recompute. */
export function recomputeWindow(now: Date, days: number = DEFAULT_WINDOW_DAYS): { from: string; to: string } {
  const to = now.toISOString();
  const from = new Date(now.getTime() - days * 86_400_000).toISOString();
  return { from, to };
}

/**
 * Enqueue one recompute per due user. Returns the number of jobs enqueued, so
 * the caller logs an honest count (a tick with no due users is not work).
 */
export async function runAnalyticsTick(
  q: AggregateQuery,
  queue: QueuePort,
  now: Date = new Date(),
  batch: number = DEFAULT_ANALYTICS_BATCH,
): Promise<number> {
  const { from, to } = recomputeWindow(now);
  const hourBucket = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const users = await listRecomputeUsers(q, from, batch);
  for (const userId of users) await queue.enqueue(buildAnalyticsDescriptor(userId, from, to, hourBucket));
  return users.length;
}
