// Handler for `analytics.recompute-daily`.
//
// FAILURE SEMANTICS. Bounds are hard failures: a window that is too long or an
// account larger than the aggregation ceiling throws, the runner records a
// failed job, and the pre-aggregates keep their previous (consistent) values —
// no partial day set, no truncated account history. Re-running is always safe
// because every write converges on its primary key.
import type { QueuedJob } from "../queue/QueuePort.js";
import { RecomputeBoundError, recomputeUserAnalytics, type AggregateQuery } from "../analytics/dailyRecompute.js";

export const ANALYTICS_RECOMPUTE_JOB_CLASS = "analytics.recompute-daily";

export interface AnalyticsRecomputeDeps {
  readonly q: AggregateQuery;
  readonly log: (event: Record<string, unknown>) => void;
}

function stringField(job: QueuedJob, name: string): string {
  const raw = (job.descriptor.payload as Record<string, unknown> | undefined)?.[name];
  return typeof raw === "string" ? raw : "";
}

export function createAnalyticsRecomputeHandler(deps: AnalyticsRecomputeDeps) {
  return async function handleAnalyticsRecompute(job: QueuedJob): Promise<void> {
    const userId = stringField(job, "userId");
    const from = stringField(job, "from");
    const to = stringField(job, "to");
    if (userId === "" || from === "" || to === "") {
      // A payload without its window is a producer bug, not a transport failure:
      // failing it is what surfaces the bug instead of recomputing "everything".
      throw new Error("analytics.recompute-daily: payload requires userId, from and to");
    }

    try {
      const result = await recomputeUserAnalytics(deps.q, { userId, from, to });
      deps.log({
        level: "info",
        event: "analytics.recomputed",
        count: result.dailyRows,
        accounts: result.accountRows,
        pruned: result.removedDailyRows,
      });
    } catch (err) {
      if (err instanceof RecomputeBoundError) {
        deps.log({ level: "error", event: "analytics.recompute_rejected", code: "BOUND_EXCEEDED" });
      }
      throw err;
    }
  };
}
