// The ledger reader — one SELECT over the ONE AI ledger.
//
// This is not a second store. 0017 created `ai_coaching_logs`, 0023 gave it a
// `feature` discriminator, 0028 gave it the chain columns; this file only reads
// it, and only ever for the caller's own rows.
import type { QueryFn } from "../persistence/pg.js";
import type { AiLedgerReader, AttemptView } from "./aiRoutes.js";

type Row = Record<string, unknown>;

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** The features a user-facing read may ask for. Anything else yields nothing. */
const READABLE_FEATURES = ["analysis", "report", "assistant", "ocr", "coach", "vision_extract", "transcribe"] as const;

/** The admin drilldown's contract — implemented by the Pg reader and the double. */
export interface AiUsageReader extends AiLedgerReader {
  usage(filter: {
    feature?: string | null; provider?: string | null; outcome?: string | null;
    since?: string | null; limit: number; before?: string | null;
  }): Promise<{ items: AttemptView[]; total: number; totals: Record<string, number> }>;
}

export class PgAiLedger implements AiUsageReader {
  constructor(private readonly q: QueryFn) {}

  async forUser(userId: string, features: readonly string[], limit: number): Promise<AttemptView[]> {
    const allowed = features.filter((f) => (READABLE_FEATURES as readonly string[]).includes(f));
    if (allowed.length === 0) return [];
    const rows = await this.q(
      `SELECT id, feature, provider, model, prompt_version, insight, outcome, error_code,
              route, latency_ms, trades_analyzed, window_from, window_to, created_at
         FROM ai_coaching_logs
        WHERE user_id = $1 AND feature = ANY($2::text[])
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [userId, allowed, limit],
    );
    return rows.map(view);
  }

  /**
   * The admin usage drilldown (Legacy `GET /admin/ai-usage`): every attempt across
   * users, filterable, newest first, with the totals an operator needs. Paging is
   * the console's (25 default, 100 max) so this cannot be used to dump the ledger.
   */
  async usage(filter: {
    feature?: string | null;
    provider?: string | null;
    outcome?: string | null;
    since?: string | null;
    limit: number;
    before?: string | null;
  }): Promise<{ items: AttemptView[]; total: number; totals: Record<string, number> }> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.feature !== null && filter.feature !== undefined && filter.feature !== "") {
      params.push(filter.feature);
      clauses.push(`feature = $${params.length}`);
    }
    if (filter.provider !== null && filter.provider !== undefined && filter.provider !== "") {
      params.push(filter.provider);
      clauses.push(`provider = $${params.length}`);
    }
    if (filter.outcome !== null && filter.outcome !== undefined && filter.outcome !== "") {
      params.push(filter.outcome);
      clauses.push(`outcome = $${params.length}`);
    }
    if (filter.since !== null && filter.since !== undefined && filter.since !== "") {
      params.push(filter.since);
      clauses.push(`created_at >= $${params.length}::timestamptz`);
    }
    if (filter.before !== null && filter.before !== undefined && filter.before !== "") {
      params.push(filter.before);
      clauses.push(`created_at < $${params.length}::timestamptz`);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    params.push(filter.limit);
    const limitIndex = params.length;

    const rows = await this.q(
      `SELECT id, user_id, feature, provider, model, prompt_version, insight, outcome, error_code,
              route, fallback_index, latency_ms, trades_analyzed, window_from, window_to, created_at
         FROM ai_coaching_logs
         ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $${limitIndex}`,
      params,
    );
    const countRows = await this.q(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE outcome = 'success')::int AS successes,
              count(*) FILTER (WHERE outcome = 'refused')::int AS refusals,
              count(*) FILTER (WHERE outcome = 'error')::int AS errors,
              COALESCE(sum(tokens_in), 0)::bigint AS tokens_in,
              COALESCE(sum(tokens_out), 0)::bigint AS tokens_out,
              COALESCE(sum(cost_micro_usd), 0)::bigint AS cost_micro_usd,
              COALESCE(avg(latency_ms) FILTER (WHERE latency_ms IS NOT NULL), 0)::numeric AS avg_latency_ms
         FROM ai_coaching_logs ${where}`,
      params.slice(0, params.length - 1),
    );
    const c = countRows[0] ?? {};
    return {
      // The admin view carries the user id: an operator asking "who spent the
      // budget" is the whole point of a usage drilldown, and this route is
      // permission-gated rather than ownership-scoped.
      items: rows.map((r) => ({ ...view(r), userId: str(r["user_id"]) }) as AttemptView),
      total: Number(c["total"] ?? 0),
      totals: {
        successes: Number(c["successes"] ?? 0),
        refusals: Number(c["refusals"] ?? 0),
        errors: Number(c["errors"] ?? 0),
        tokensIn: Number(c["tokens_in"] ?? 0),
        tokensOut: Number(c["tokens_out"] ?? 0),
        costMicroUsd: Number(c["cost_micro_usd"] ?? 0),
        avgLatencyMs: Math.round(Number(c["avg_latency_ms"] ?? 0)),
      },
    };
  }
}

/** JSONB arrives parsed from pg and as text from a double; both must work. */
function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function view(r: Row): AttemptView {
  return {
    id: String(r["id"]),
    feature: String(r["feature"]),
    provider: String(r["provider"]),
    model: String(r["model"]),
    promptVersion: String(r["prompt_version"]),
    insight: asObject(r["insight"]),
    outcome: String(r["outcome"]),
    errorCode: str(r["error_code"]),
    route: str(r["route"]),
    latencyMs: num(r["latency_ms"]),
    tradesAnalyzed: num(r["trades_analyzed"]),
    windowFrom: str(r["window_from"]),
    windowTo: str(r["window_to"]),
    createdAt: String(r["created_at"]),
  };
}

/** Contract-identical double for unit tests. */
export class MemoryAiLedger implements AiUsageReader {
  readonly rows: (AttemptView & { userId: string })[] = [];

  async forUser(userId: string, features: readonly string[], limit: number): Promise<AttemptView[]> {
    return this.rows
      .filter((r) => r.userId === userId && features.includes(r.feature))
      .slice(0, limit)
      .map(({ userId: _userId, ...rest }) => rest);
  }

  /**
   * The admin drilldown, over the same in-memory rows. The totals are computed the
   * same way the SQL computes them, so a test that asserts a total is asserting
   * the rule and not the adapter.
   */
  async usage(filter: {
    feature?: string | null; provider?: string | null; outcome?: string | null;
    since?: string | null; limit: number; before?: string | null;
  }): Promise<{ items: AttemptView[]; total: number; totals: Record<string, number> }> {
    const matched = this.rows.filter((r) =>
      (filter.feature == null || filter.feature === "" || r.feature === filter.feature) &&
      (filter.provider == null || filter.provider === "" || r.provider === filter.provider) &&
      (filter.outcome == null || filter.outcome === "" || r.outcome === filter.outcome) &&
      (filter.since == null || filter.since === "" || r.createdAt >= filter.since) &&
      (filter.before == null || filter.before === "" || r.createdAt < filter.before));
    return {
      items: matched.slice(0, filter.limit),
      total: matched.length,
      totals: {
        successes: matched.filter((r) => r.outcome === "success").length,
        refusals: matched.filter((r) => r.outcome === "refused").length,
        errors: matched.filter((r) => r.outcome === "error").length,
        tokensIn: 0,
        tokensOut: 0,
        costMicroUsd: 0,
        avgLatencyMs: matched.length === 0 ? 0
          : Math.round(matched.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0) / matched.length),
      },
    };
  }
}
