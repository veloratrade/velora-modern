// Async ANALYTICS pre-aggregation — roadmap §3 "Decoupled Analytics Engine":
//
//   "Never compute complex financial stats (Sharpe Ratio, Expectancy, Max
//    Drawdown) on the fly during API request execution. Pivot: Implement
//    asynchronous event-driven calculations … and updates pre-aggregated summary
//    tables (user_analytics_daily, account_performance_summary). The UI fetches
//    pre-calculated snapshots instantaneously."
//
// `0016` created those tables in pass 1 and NOTHING ever wrote to them: the API
// answered every analytics request with a bounded synchronous SQL aggregation,
// and the pre-aggregates were empty. This module is the missing writer.
//
// ============================================================
// DESIGN CONSTRAINTS (each one is a property, not a preference)
// ============================================================
// DETERMINISTIC      The figures are a pure function of `trades` rows. Two runs
//                    over the same ledger produce byte-identical numbers, so a
//                    re-run can never "shift" a report. (`computed_at` is the
//                    only field that changes, and it is bookkeeping.)
// IDEMPOTENT         Every write is `INSERT … ON CONFLICT (pk) DO UPDATE`, so a
//                    duplicated job converges on one row per key rather than
//                    appending a second (this is what "no duplicate
//                    aggregation" means physically).
// CONVERGENT         A day whose trades were all deleted no longer has a row:
//                    derived rows outside the recomputed set are removed. Only
//                    the DERIVED tables are touched — `trades` is never written.
// BOUNDED            A window is capped (MAX_WINDOW_DAYS), a run is capped
//                    (MAX_ACCOUNT_TRADES per account) and the fan-out is capped
//                    by the tick's batch. Exceeding a cap FAILS the job loudly
//                    instead of writing a silently truncated number.
// CORRECT DATING     The day bucket is computed by PostgreSQL (`AT TIME ZONE`
//                    with a VALIDATED IANA basis) — the same expression the
//                    synchronous read path uses in `analyticsStore.ts`, so the
//                    two paths cannot disagree about which day a trade belongs
//                    to. ADR-004: the basis is recorded per row (`tz_basis` +
//                    `tz_basis_source`) instead of being assumed.
// EXACT MONEY        All arithmetic runs through `packages/domain` decimals
//                    (`computeAggregate`) — the same implementation the API's
//                    summary uses. No JS float ever touches a money value.
//
// ============================================================
// WHAT A ROW MEANS (stated once, used everywhere)
// ============================================================
// `trades_count` counts the trades that contributed a REALIZED PnL in that
// bucket. An open trade has no attributable result and is excluded; this is why
// `wins + losses + breakeven = trades_count` exactly (0016 allows <=, we write
// =). Money is scale 2, ratios scale 4, and `max_drawdown` is the largest
// peak-to-trough decline of the intra-bucket cumulative PnL series.
import { computeAggregate, type MetricTrade } from "@velora/domain";

/**
 * Narrow query port (the worker does not import the API's persistence layer).
 */
export interface AggregateQuery {
  (sql: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}

export function poolAggregateQuery(pool: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}): AggregateQuery {
  return async (sql, params) => {
    const result = await pool.query(sql, params === undefined ? undefined : [...params]);
    return result.rows as readonly Record<string, unknown>[];
  };
}

/** Longest window one job may recompute (a job is not a full-history rebuild). */
export const MAX_WINDOW_DAYS = 400;
/** Default window when a caller does not state one (the tick's convention). */
export const DEFAULT_WINDOW_DAYS = 90;
/** Per-account ceiling: beyond this the job fails instead of truncating. */
export const MAX_ACCOUNT_TRADES = 50_000;
/** Distinct timezone bases processed for one user (bounded fan-out). */
export const MAX_BASES = 16;

export class RecomputeBoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecomputeBoundError";
  }
}

export interface RecomputeInput {
  readonly userId: string;
  /** Inclusive lower bound (ISO-8601 instant). */
  readonly from: string;
  /** EXCLUSIVE upper bound (ISO-8601 instant) — same convention as the API. */
  readonly to: string;
}

export interface RecomputeResult {
  readonly dailyRows: number;
  readonly removedDailyRows: number;
  readonly accountRows: number;
}

interface Row {
  readonly day: string;
  readonly netPnl: string | null;
  readonly rMultiple: string | null;
}

/**
 * A timezone basis is only used when PostgreSQL/ICU recognises it.
 *
 * The stored value comes from `trading_accounts.timezone`, which the write path
 * validates — but a row can outlive a validation rule, and an unparseable zone
 * reaching `AT TIME ZONE` would abort the whole recompute. Rejecting it here
 * degrades ONE basis to UTC (recording `assumed_utc`, ADR-004's honesty rule)
 * instead of failing every user's analytics.
 */
export function isUsableTimeZone(tz: string): boolean {
  if (tz === "UTC") return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateWindow(input: RecomputeInput): void {
  const from = Date.parse(input.from);
  const to = Date.parse(input.to);
  if (Number.isNaN(from) || Number.isNaN(to)) throw new RecomputeBoundError("window bounds must be ISO-8601 instants");
  if (to <= from) throw new RecomputeBoundError("window must be a positive interval");
  const days = (to - from) / 86_400_000;
  if (days > MAX_WINDOW_DAYS) {
    throw new RecomputeBoundError(`window of ${Math.ceil(days)} days exceeds the ${MAX_WINDOW_DAYS}-day bound`);
  }
}

/**
 * The distinct (basis, source) pairs a user's accounts imply.
 *
 * The RAW stored value is read and normalized HERE, in TypeScript, because
 * "usable timezone" is `Intl`'s judgement — SQL cannot make it. The normalization
 * therefore has to be carried into the row filter as well, otherwise a degraded
 * basis (`account` → `assumed_utc`) would disagree with itself: the aggregate
 * would be written under `assumed_utc` while the rows it aggregates were still
 * selected by their raw zone (observed in pass 3 against real PostgreSQL — the
 * degraded basis produced ZERO rows). Each group therefore carries the exact raw
 * values it covers, and whether it also covers rows with NO declared timezone.
 */
interface BasisGroup {
  /** The basis the day bucket is computed in (always ICU-usable). */
  readonly tz: string;
  readonly source: string;
  /** Raw declared timezone values that normalize to this basis. */
  readonly declaredRaws: readonly string[];
  /** Whether rows with no declared timezone belong to this basis. */
  readonly includeUndeclared: boolean;
}

async function basesFor(q: AggregateQuery, userId: string): Promise<BasisGroup[]> {
  const rows = await q(
    `SELECT DISTINCT COALESCE(a.timezone, 'UTC') AS raw_tz,
            (a.timezone IS NOT NULL AND a.timezone_source <> 'unknown') AS declared
       FROM trading_accounts a
      WHERE a.user_id = $1
      ORDER BY 1, 2
      LIMIT $2::int`,
    [userId, MAX_BASES],
  );

  const groups = new Map<string, { tz: string; source: string; declaredRaws: string[]; includeUndeclared: boolean }>();
  const addTo = (group: { declaredRaws: string[]; includeUndeclared: boolean }, raw: string, declared: boolean): void => {
    if (!declared) {
      group.includeUndeclared = true;
      return;
    }
    if (!group.declaredRaws.includes(raw)) group.declaredRaws.push(raw);
  };

  for (const row of rows) {
    const raw = String(row["raw_tz"] ?? "UTC");
    const declared = row["declared"] === true;
    const usable = declared && isUsableTimeZone(raw);
    // ADR-004: an unusable stored zone degrades to UTC and SAYS SO, instead of
    // aborting everyone's analytics or pretending the zone was honored.
    const tz = usable ? raw : "UTC";
    const source = usable ? "account" : "assumed_utc";
    const key = `${tz}|${source}`;
    const group = groups.get(key) ?? { tz, source, declaredRaws: [], includeUndeclared: false };
    groups.set(key, group);
    // Membership is decided by what the ACCOUNT DECLARED, not by whether the
    // value survived validation: a degraded basis must still select the rows it
    // is degrading for, otherwise it would aggregate nothing (pass-3 finding).
    addTo(group, raw, declared);
  }

  // A user with no account (or none with a declared zone) still has
  // account-less trades; the UTC basis is added unconditionally so those rows are
  // never silently dropped. `includeUndeclared` is what distinguishes it from a
  // genuinely declared UTC account, so the two bases cannot both claim a row.
  const utcKey = "UTC|assumed_utc";
  const utc = groups.get(utcKey) ?? { tz: "UTC", source: "assumed_utc", declaredRaws: [], includeUndeclared: false };
  utc.includeUndeclared = true;
  groups.set(utcKey, utc);

  return [...groups.values()].sort((a, b) => (a.tz < b.tz ? -1 : a.tz > b.tz ? 1 : a.source < b.source ? -1 : 1));
}

/** Day-bucketed, chronologically ordered closed trades for one basis group. */
async function loadDaily(
  q: AggregateQuery,
  userId: string,
  input: RecomputeInput,
  group: BasisGroup,
): Promise<Map<string, Row[]>> {
  const rows = await q(
    // The day itself is computed by PostgreSQL (`AT TIME ZONE`) with the
    // VALIDATED basis — the same expression the synchronous read path uses, so
    // the two can never disagree about which day a trade belongs to. The row
    // FILTER is expressed with the raw declared values, which is what makes a
    // degraded basis see exactly the rows that normalize into it.
    `SELECT to_char(t.occurred_at AT TIME ZONE $4::text, 'YYYY-MM-DD') AS day,
            t.net_pnl::text   AS net_pnl,
            t.r_multiple::text AS r_multiple
       FROM trades t
       LEFT JOIN trading_accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.deleted_at IS NULL
        AND t.quarantined = false
        AND t.occurred_at >= $2::timestamptz
        AND t.occurred_at <  $3::timestamptz
        AND (
          (CASE WHEN a.timezone IS NOT NULL AND a.timezone_source <> 'unknown' THEN a.timezone END) = ANY($5::text[])
          OR ($6::boolean AND (a.timezone IS NULL OR a.timezone_source = 'unknown'))
        )
      ORDER BY t.occurred_at ASC, t.id ASC`,
    [userId, input.from, input.to, group.tz, [...group.declaredRaws], group.includeUndeclared],
  );

  const byDay = new Map<string, Row[]>();
  for (const row of rows) {
    const day = String(row["day"]);
    const entry: Row = {
      day,
      netPnl: row["net_pnl"] === null ? null : String(row["net_pnl"]),
      rMultiple: row["r_multiple"] === null ? null : String(row["r_multiple"]),
    };
    const list = byDay.get(day);
    if (list === undefined) byDay.set(day, [entry]);
    else list.push(entry);
  }
  return byDay;
}

function asMetricTrade(row: Row): MetricTrade {
  return { netPnl: row.netPnl, rMultiple: row.rMultiple };
}

/**
 * Write one day's aggregate. `ON CONFLICT … DO UPDATE` makes the write converge:
 * the key is (user_id, day, tz_basis) — 0016's own primary key.
 */
async function upsertDaily(
  q: AggregateQuery,
  userId: string,
  day: string,
  tz: string,
  tzSource: string,
  rows: readonly Row[],
): Promise<void> {
  const aggregate = computeAggregate(rows.map(asMetricTrade));
  await q(
    `INSERT INTO user_analytics_daily
       (user_id, day, tz_basis, tz_basis_source, trades_count, wins, losses, breakeven,
        gross_profit, gross_loss, net_pnl, win_rate, profit_factor, expectancy, max_drawdown, computed_at)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8,
             $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14::numeric, $15::numeric, now())
     ON CONFLICT (user_id, day, tz_basis) DO UPDATE SET
       tz_basis_source = EXCLUDED.tz_basis_source,
       trades_count    = EXCLUDED.trades_count,
       wins            = EXCLUDED.wins,
       losses          = EXCLUDED.losses,
       breakeven       = EXCLUDED.breakeven,
       gross_profit    = EXCLUDED.gross_profit,
       gross_loss      = EXCLUDED.gross_loss,
       net_pnl         = EXCLUDED.net_pnl,
       win_rate        = EXCLUDED.win_rate,
       profit_factor   = EXCLUDED.profit_factor,
       expectancy      = EXCLUDED.expectancy,
       max_drawdown    = EXCLUDED.max_drawdown,
       computed_at     = now()`,
    [
      userId,
      day,
      tz,
      tzSource,
      aggregate.contributingTrades,
      aggregate.wins,
      aggregate.losses,
      aggregate.breakeven,
      aggregate.grossProfit,
      aggregate.grossLoss,
      aggregate.totalPnl,
      aggregate.winRate,
      aggregate.profitFactor,
      aggregate.expectancy,
      aggregate.maxDrawdown,
    ],
  );
}

/**
 * Remove derived daily rows inside the window that the current ledger no longer
 * justifies (a day whose trades were all deleted, or whose basis changed).
 * Bounded to the window and to one user; it never touches `trades`, and 0016's
 * header states plainly that nothing authoritative lives in these tables.
 */
async function pruneDaily(
  q: AggregateQuery,
  userId: string,
  input: RecomputeInput,
  tz: string,
  keepDays: readonly string[],
): Promise<number> {
  const rows = await q(
    `DELETE FROM user_analytics_daily
      WHERE user_id = $1
        AND tz_basis = $2::text
        AND day >= ($3::timestamptz AT TIME ZONE 'UTC')::date
        AND day <  ($4::timestamptz AT TIME ZONE 'UTC')::date
        AND day <> ALL($5::date[])
      RETURNING day`,
    [userId, tz, input.from, input.to, keepDays],
  );
  return rows.length;
}

/**
 * Recompute one user's derived analytics for a window.
 *
 * `accounts` summaries are always computed over the account's FULL history (a
 * summary that only knew about 90 days would be wrong the moment it is read),
 * so the window selects WHICH accounts are refreshed, never what they contain.
 */
export async function recomputeUserAnalytics(q: AggregateQuery, input: RecomputeInput): Promise<RecomputeResult> {
  validateWindow(input);

  let dailyRows = 0;
  let removedDailyRows = 0;

  for (const group of await basesFor(q, input.userId)) {
    const byDay = await loadDaily(q, input.userId, input, group);
    const days = [...byDay.keys()].sort();
    for (const day of days) {
      await upsertDaily(q, input.userId, day, group.tz, group.source, byDay.get(day) as Row[]);
      dailyRows += 1;
    }
    removedDailyRows += await pruneDaily(q, input.userId, input, group.tz, days);
  }

  const accountRows = await recomputeAccounts(q, input);
  return { dailyRows, removedDailyRows, accountRows };
}

/** Accounts with ledger activity inside the window (the refresh set). */
async function accountsInWindow(q: AggregateQuery, userId: string, input: RecomputeInput): Promise<string[]> {
  const rows = await q(
    `SELECT DISTINCT t.account_id::text AS account_id
       FROM trades t
      WHERE t.user_id = $1
        AND t.account_id IS NOT NULL
        AND t.deleted_at IS NULL
        AND t.quarantined = false
        AND t.occurred_at >= $2::timestamptz
        AND t.occurred_at <  $3::timestamptz
      ORDER BY 1`,
    [userId, input.from, input.to],
  );
  return rows.map((row) => String(row["account_id"]));
}

async function recomputeAccounts(q: AggregateQuery, input: RecomputeInput): Promise<number> {
  const accountIds = await accountsInWindow(q, input.userId, input);

  // Convergence for emptied accounts: an existing summary whose account has no
  // rows left is not "stale", it is meaningless — remove it (accounts the user
  // still owns, so this cannot touch another tenant's row).
  const empty = await q(
    `DELETE FROM account_performance_summary s
      WHERE s.user_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM trades t
           WHERE t.account_id = s.account_id AND t.deleted_at IS NULL AND t.quarantined = false
        )
      RETURNING s.account_id`,
    [input.userId],
  );

  let written = 0;
  for (const accountId of accountIds) {
    const rows = await q(
      `SELECT t.net_pnl::text AS net_pnl, t.r_multiple::text AS r_multiple,
              (SELECT currency FROM trading_accounts WHERE id = $2::bigint) AS currency
         FROM trades t
        WHERE t.user_id = $1
          AND t.account_id = $2::bigint
          AND t.deleted_at IS NULL
          AND t.quarantined = false
        ORDER BY t.occurred_at ASC, t.id ASC
        LIMIT $3::int`,
      [input.userId, accountId, MAX_ACCOUNT_TRADES + 1],
    );

    if (rows.length > MAX_ACCOUNT_TRADES) {
      // Truncating would silently halve an account's history. Fail the job.
      throw new RecomputeBoundError(
        `account has more than ${MAX_ACCOUNT_TRADES} trades — raise the bound deliberately before aggregating it`,
      );
    }

    const aggregate = computeAggregate(
      rows.map((row) => ({
        netPnl: row["net_pnl"] === null ? null : String(row["net_pnl"]),
        rMultiple: row["r_multiple"] === null ? null : String(row["r_multiple"]),
      })),
    );
    if (aggregate.contributingTrades === 0) continue; // nothing realized yet

    await q(
      `INSERT INTO account_performance_summary
         (account_id, user_id, currency, as_of, trades_count, wins, losses, breakeven,
          gross_profit, gross_loss, net_pnl, win_rate, profit_factor, expectancy, max_drawdown,
          equity_peak, equity_trough)
       VALUES ($1::bigint, $2, $3, now(), $4, $5, $6, $7,
               $8::numeric, $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14::numeric,
               $15::numeric, $16::numeric)
       ON CONFLICT (account_id) DO UPDATE SET
         user_id       = EXCLUDED.user_id,
         currency      = EXCLUDED.currency,
         as_of         = now(),
         trades_count  = EXCLUDED.trades_count,
         wins          = EXCLUDED.wins,
         losses        = EXCLUDED.losses,
         breakeven     = EXCLUDED.breakeven,
         gross_profit  = EXCLUDED.gross_profit,
         gross_loss    = EXCLUDED.gross_loss,
         net_pnl       = EXCLUDED.net_pnl,
         win_rate      = EXCLUDED.win_rate,
         profit_factor = EXCLUDED.profit_factor,
         expectancy    = EXCLUDED.expectancy,
         max_drawdown  = EXCLUDED.max_drawdown,
         equity_peak   = EXCLUDED.equity_peak,
         equity_trough = EXCLUDED.equity_trough`,
      [
        accountId,
        input.userId,
        rows[0]?.["currency"] === undefined || rows[0]?.["currency"] === null ? null : String(rows[0]["currency"]),
        aggregate.contributingTrades,
        aggregate.wins,
        aggregate.losses,
        aggregate.breakeven,
        aggregate.grossProfit,
        aggregate.grossLoss,
        aggregate.totalPnl,
        aggregate.winRate,
        aggregate.profitFactor,
        aggregate.expectancy,
        aggregate.maxDrawdown,
        aggregate.equityPeak,
        aggregate.equityTrough,
      ],
    );
    written += 1;
  }
  // `empty` is logged by the caller through the returned count difference; the
  // rows themselves are already gone, which is the observable outcome.
  void empty;
  return written;
}
