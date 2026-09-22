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

/**
 * The DUE SET — who must be recomputed, and why the answer must be FINITE.
 *
 * Pass 2's version selected only users with ledger activity inside the window,
 * which had two costs: a user whose trades were deleted or edited AFTER their
 * analytics were computed never returned to the due set (a derived row could
 * outlive the ledger that justified it — the CONVERGENT property was not
 * reachable from the tick), and every active user was re-enqueued every hour
 * forever even after converging.
 *
 * The due set is therefore three bounded, index-supported reasons, UNIONed, each
 * of which ONE window-bounded run removes:
 *
 *   (A) LEDGER MOVED — a LIVE trade inside the window whose `updated_at` is newer
 *       than the user's newest `computed_at`: an insert, an exit, a correction.
 *       `COALESCE(..., '-infinity')` makes a user who has never been aggregated
 *       due. A converged user therefore goes SILENT (the assertion the pass-3
 *       battery failed on first: an unfiltered "newer than the last run" rule
 *       keeps a user due forever once their only trade is gone and the derived
 *       rows have been pruned, because `max(computed_at)` over no rows is
 *       `-infinity`). Deletion is not lost: a tombstone moves the trade out of
 *       (A) and into (B), which is exactly the state that needs the prune.
 *   (B) LEDGER GONE — a window row whose user has no live trade left at all. This
 *       is the safety net for rows removed without a bump.
 *   (C) ORPHANED SUMMARY — an account summary whose account has no live trade.
 *       The account pass is not window-bounded, so this is always fixable.
 *
 * WHY EVERY REASON IS WINDOW-SCOPED (or provably fixable). The recompute only
 * writes or prunes rows inside [from, to). A reason it could not act on would
 * re-enqueue the same user every hour forever, which is why a merely stale
 * summary for an account with no activity inside the window is deliberately NOT
 * listed, and why a user who has converged is silent (asserted by the
 * real-PostgreSQL battery: `due → []` after a run).
 *
 * KNOWN LIMITATION (documented, not invented away): a trade flipped to
 * `quarantined` while other live trades remain, and outside the (A) window, is not
 * detected — no application write path sets that column today (only tests do), so
 * the rule to implement is "whoever writes `quarantined` must bump `updated_at`",
 * exactly as the tombstone path already does.
 *
 * The day-range comparisons mirror `pruneDaily` exactly, so "fixable by this run"
 * and "removed by this run" are the same statement.
 */
export async function listRecomputeUsers(
  q: AggregateQuery,
  from: string,
  to: string,
  limit: number,
): Promise<string[]> {
  const rows = await q(
    `SELECT user_id FROM (
       SELECT t.user_id::text AS user_id
         FROM trades t
        WHERE t.deleted_at IS NULL
          AND t.quarantined = false
          AND t.occurred_at >= $1::timestamptz
          AND t.occurred_at <  $2::timestamptz
          AND t.updated_at > COALESCE(
                (SELECT max(d.computed_at) FROM user_analytics_daily d WHERE d.user_id = t.user_id),
                '-infinity'::timestamptz
              )
       UNION
       SELECT d.user_id::text AS user_id
         FROM user_analytics_daily d
        WHERE d.day >= ($1::timestamptz AT TIME ZONE 'UTC')::date
          AND d.day <  ($2::timestamptz AT TIME ZONE 'UTC')::date
          AND NOT EXISTS (
            SELECT 1 FROM trades t3
             WHERE t3.user_id = d.user_id
               AND t3.deleted_at IS NULL
               AND t3.quarantined = false
          )
       UNION
       SELECT s.user_id::text AS user_id
         FROM account_performance_summary s
        WHERE NOT EXISTS (
          SELECT 1 FROM trades t4
           WHERE t4.account_id = s.account_id
             AND t4.deleted_at IS NULL
             AND t4.quarantined = false
        )
     ) AS due
     ORDER BY user_id
     LIMIT $3::int`,
    [from, to, limit],
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
  const users = await listRecomputeUsers(q, from, to, batch);
  for (const userId of users) await queue.enqueue(buildAnalyticsDescriptor(userId, from, to, hourBucket));
  return users.length;
}
