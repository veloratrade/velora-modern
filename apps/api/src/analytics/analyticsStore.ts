// Analytics reads — the repository behind the v0.5 analytics surface.
//
// WHAT THIS READS. `trades` (net_pnl, r_multiple, symbol, strategy_tag,
// occurred_at) and `trading_accounts` (timezone), all of which already exist in
// the frozen foundation (0005, 0022). No migration is proposed.
//
// WHY THE AGGREGATION IS IN SQL, NOT IN THE REQUEST. Roadmap CTO directive:
// analytics must not be computed per request against raw rows at scale. The
// store therefore pushes the day-bucketing and grouping into PostgreSQL, and the
// domain layer only assembles exact decimals over the (already reduced) buckets.
// The pre-aggregate tables `user_analytics_daily` / `account_performance_summary`
// (0016) remain the async path for large windows; this read path is the
// synchronous one the API contract needs and is bounded by an explicit window.
//
// TIME BUCKETING follows ADR-004: storage is UTC (`occurred_at`), and a day
// bucket is taken in the ACCOUNT's timezone when the account declares one,
// otherwise UTC. The rule is stated once, here, and used by every analytics
// route so two endpoints can never disagree about which day a trade belongs to.
import type { QueryFn } from "../persistence/pg.js";

/** One closed-or-open trade reduced to the analytics columns. */
export interface AnalyticsTradeRow {
  readonly tradeId: string;
  readonly accountId: string | null;
  readonly symbol: string;
  /** Exact decimal string, or null for a still-open trade. */
  readonly netPnl: string | null;
  readonly rMultiple: string | null;
  /** `YYYY-MM-DD` bucket in the account's timezone (or UTC). */
  readonly day: string;
  /** 0 = Sunday … 6 = Saturday, in the same bucket timezone. */
  readonly weekday: number;
  /** 0-23 hour in the same bucket timezone. */
  readonly hour: number;
  /** Journal strategy: the tag when present, else the free-text strategy. */
  readonly strategy: string | null;
}

export interface AnalyticsQuery {
  readonly userId: string;
  /** Inclusive lower bound (ISO-8601 instant). */
  readonly from: string | null;
  /** Exclusive upper bound (ISO-8601 instant). */
  readonly to: string | null;
  /** Optional single-account scope; ownership is verified by the caller. */
  readonly accountId: string | null;
}

export interface AnalyticsStore {
  /**
   * Trades in the window, ascending by occurrence.
   *
   * `deletedAt IS NULL` (soft-delete, 0005) and `quarantined = false` (0013) are
   * applied here rather than by the caller: a quarantined row's numbers are not
   * trustworthy and must never reach a report.
   */
  listTrades(query: AnalyticsQuery): Promise<AnalyticsTradeRow[]>;
}

/**
 * Bucket timezone.
 *
 * When the request scopes a single account AND that account declares a verified
 * timezone, buckets use it; otherwise UTC. `timezone_source <> 'unknown'` is the
 * guard: 0004 leaves `timezone` NULL until one is known, and an unknown timezone
 * must never silently become the host's local zone (ADR-004). The expression is
 * inlined three times because a SQL parameter cannot carry an identifier-free
 * expression without a second round trip.
 */
const TZ = `COALESCE((
    SELECT a2.timezone FROM trading_accounts a2
     WHERE $4::bigint IS NOT NULL AND a2.id = $4::bigint AND a2.timezone_source <> 'unknown'
  ), 'UTC')`;

const SELECT_TRADES = `
  SELECT t.id::text                                   AS trade_id,
         t.account_id::text                           AS account_id,
         t.symbol                                     AS symbol,
         t.net_pnl::text                              AS net_pnl,
         t.r_multiple::text                           AS r_multiple,
         COALESCE(t.strategy_tag, t.strategy)         AS strategy,
         to_char((t.occurred_at AT TIME ZONE ${TZ}), 'YYYY-MM-DD') AS day,
         EXTRACT(DOW  FROM (t.occurred_at AT TIME ZONE ${TZ}))::int AS weekday,
         EXTRACT(HOUR FROM (t.occurred_at AT TIME ZONE ${TZ}))::int AS hour
    FROM trades t
   WHERE t.user_id = $1
     AND t.deleted_at IS NULL
     AND t.quarantined = false
     AND ($2::timestamptz IS NULL OR t.occurred_at >= $2::timestamptz)
     AND ($3::timestamptz IS NULL OR t.occurred_at <  $3::timestamptz)
     AND ($4::bigint IS NULL OR t.account_id = $4::bigint)
   ORDER BY t.occurred_at ASC, t.id ASC`;

export class PgAnalyticsStore implements AnalyticsStore {
  constructor(private readonly q: QueryFn) {}

  async listTrades(query: AnalyticsQuery): Promise<AnalyticsTradeRow[]> {
    const rows = await this.q(SELECT_TRADES, [
      query.userId,
      query.from,
      query.to,
      query.accountId,
    ]);
    return rows.map((row) => ({
      tradeId: String(row["trade_id"]),
      accountId: row["account_id"] === null ? null : String(row["account_id"]),
      symbol: String(row["symbol"]),
      netPnl: row["net_pnl"] === null ? null : String(row["net_pnl"]),
      rMultiple: row["r_multiple"] === null ? null : String(row["r_multiple"]),
      day: String(row["day"]),
      weekday: Number(row["weekday"]),
      hour: Number(row["hour"]),
      strategy: row["strategy"] === null ? null : String(row["strategy"]),
    }));
  }
}

/** In-memory double — same contract, used by service/route tests. */
export class MemoryAnalyticsStore implements AnalyticsStore {
  readonly #rows: AnalyticsTradeRow[] = [];

  constructor(rows: readonly AnalyticsTradeRow[] = []) {
    this.#rows.push(...rows);
  }

  async listTrades(query: AnalyticsQuery): Promise<AnalyticsTradeRow[]> {
    return this.#rows
      .filter((r) => (query.accountId === null || r.accountId === query.accountId) && (query.from === null || r.day >= query.from.slice(0, 10)))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }
}
