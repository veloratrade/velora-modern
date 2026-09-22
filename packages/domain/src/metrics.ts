// Performance metrics — pure functions, extracted from the Legacy aggregation
// (`api/src/Dashboard/MetricsService.php`) and rebuilt natively.
//
// ============================================================
// RULES CARRIED OVER (each one is a behaviour a naive port gets wrong)
// ============================================================
//  1. Classification is by NET PnL: wins = net > 0, losses = net < 0,
//     breakeven = net == 0.
//  2. win_rate = wins / (wins + losses) — **breakeven trades are excluded from
//     the denominator**. A naive "wins / tradeCount" is a different number and
//     is NOT what Velora has always reported.
//  3. profit_factor = grossProfit / grossLoss, where grossProfit sums the
//     positive nets and grossLoss sums |negative nets|. When grossLoss is zero:
//     the value is NULL (semantics: infinite / no losses) if there were any
//     profits, and "0" when there were no profits either. Legacy encodes this
//     exactly (`$profitFactor = null` with the inline note "بی‌نهایت").
//  4. average_r averages only the trades that HAVE an R multiple. A trade with
//     undefined risk (no stop loss / wrong side / zero risk) is skipped, never
//     counted as zero.
//  5. bestTrade / worstTrade are the max/min net and default to "0" when there
//     are no trades (Legacy COALESCE(...,0)).
//  6. Rounding follows ADR-001 (money at currency scale, ratios at 4 dp).
//     No value is ever produced as a JS float: every result is a decimal string.
import * as D from "./decimal.js";
import { SCALES, type RoundingMode } from "@velora/contracts";

/** One contributing trade, reduced to what the metrics need. */
export interface MetricTrade {
  /** Net PnL as an exact decimal string (scale 2 in storage). Null = open trade. */
  readonly netPnl: string | null;
  /** R multiple as an exact decimal string, or null when risk was undefined. */
  readonly rMultiple: string | null;
  /** Optional grouping key (journal strategy tag) for the per-strategy view. */
  readonly strategy?: string | null;
}

export interface SummaryMetrics {
  readonly tradeCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakeven: number;
  /** 4 dp decimal string. */
  readonly winRate: string;
  /** 2 dp decimal string. */
  readonly totalPnl: string;
  /** 4 dp decimal string, or null when there were no losses but some profit. */
  readonly profitFactor: string | null;
  /** 4 dp decimal string. */
  readonly averageR: string;
  readonly bestTrade: string;
  readonly worstTrade: string;
}

const ZERO = "0";

function isClosed(t: MetricTrade): boolean {
  return t.netPnl !== null;
}

/**
 * Compute the dashboard summary.
 *
 * Open trades (netPnl === null) do not contribute to any figure — the Legacy
 * query is over `trades.profit_loss`, which is NULL until a trade closes, and
 * SQL aggregates ignore NULLs for SUM/AVG/MAX/MIN. COUNT(*) however DOES count
 * them, so `tradeCount` is the true row count while the PnL figures exclude
 * nulls. That asymmetry is preserved deliberately: it is observable behaviour.
 */
export function computeSummary(trades: readonly MetricTrade[], mode: RoundingMode = "half-even"): SummaryMetrics {
  const S_CUR = SCALES.currency;
  const closed = trades.filter(isClosed);

  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let grossProfit = D.fromString(ZERO);
  let grossLoss = D.fromString(ZERO);
  let totalPnl = D.fromString(ZERO);
  let rSum = D.fromString(ZERO);
  let rCount = 0;
  let best: D.Fixed | null = null;
  let worst: D.Fixed | null = null;

  for (const t of closed) {
    const net = D.fromString(t.netPnl as string);
    totalPnl = D.add(totalPnl, net);
    const sign = D.cmp(net, D.fromString(ZERO));
    if (sign > 0) {
      wins += 1;
      grossProfit = D.add(grossProfit, net);
    } else if (sign < 0) {
      losses += 1;
      grossLoss = D.add(grossLoss, D.mul(net, D.fromString("-1")));
    } else {
      breakeven += 1;
    }
    if (best === null || D.cmp(net, best) > 0) best = net;
    if (worst === null || D.cmp(net, worst) < 0) worst = net;
    if (t.rMultiple !== null) {
      rSum = D.add(rSum, D.fromString(t.rMultiple));
      rCount += 1;
    }
  }

  // SCALE IS PART OF THE CONTRACT. A ratio is always emitted at 4 dp and money
  // at 2 dp, including the zero cases: `"0"` and `"0.0000"` are the same number
  // but not the same wire value, and a client that formats the field would
  // render them differently. (Found by the golden-vector test.)
  const RATIO_ZERO = D.rescale(D.fromString(ZERO), 4, mode);
  const decided = wins + losses;
  const winRate =
    decided > 0
      ? D.rescale(D.div(D.fromString(String(wins)), D.fromString(String(decided)), 8, mode), 4, mode)
      : RATIO_ZERO;

  const profitFactor: string | null =
    D.cmp(grossLoss, D.fromString(ZERO)) > 0
      ? D.toString(D.rescale(D.div(grossProfit, grossLoss, 8, mode), 4, mode))
      : D.cmp(grossProfit, D.fromString(ZERO)) > 0
        ? null
        : "0";

  const averageR =
    rCount > 0
      ? D.rescale(D.div(rSum, D.fromString(String(rCount)), 8, mode), 4, mode)
      : RATIO_ZERO;

  return {
    tradeCount: trades.length,
    wins,
    losses,
    breakeven,
    winRate: D.toString(winRate),
    totalPnl: D.toString(D.rescale(totalPnl, S_CUR, mode)),
    profitFactor,
    averageR: D.toString(averageR),
    bestTrade: D.toString(D.rescale(best ?? D.fromString(ZERO), S_CUR, mode)),
    worstTrade: D.toString(D.rescale(worst ?? D.fromString(ZERO), S_CUR, mode)),
  };
}

/**
 * The AGGREGATE figure set — the summary plus the four numbers `0016` stores
 * that `computeSummary` (an API/view contract) does not emit.
 *
 * WHY THIS LIVES IN `packages/domain` AND NOT IN THE WORKER. The async
 * pre-aggregation path (roadmap §3) writes `user_analytics_daily` /
 * `account_performance_summary`, and the synchronous API path answers the same
 * questions over an ad-hoc window. If the two computed money with different
 * arithmetic — or rounded differently — the product would show two answers for
 * the same question. Both call the SAME implementation here; the aggregate
 * simply calls `computeSummary` first and extends it, so the shared fields
 * cannot drift by construction.
 *
 * ORDER IS PART OF THE CONTRACT. `maxDrawdown`, `equityPeak` and `equityTrough`
 * are properties of a SERIES, so the caller must pass the trades in
 * chronological order (`occurred_at ASC, id ASC` — the same ordering the
 * analytics read path uses). Shuffling the input changes the drawdown, exactly
 * as it would change a real equity curve.
 *
 * SIGNS. `grossLoss` is reported NEGATIVE (a sum of losing trades), because
 * that is what `0016`'s `CHECK (gross_loss <= 0)` stores. `maxDrawdown` is a
 * magnitude and is therefore always >= 0.
 */
export interface AggregateMetrics extends SummaryMetrics {
  /** Trades that contributed a realized PnL (wins + losses + breakeven). */
  readonly contributingTrades: number;
  /** Sum of winning trades, money scale, always >= 0. */
  readonly grossProfit: string;
  /** Sum of losing trades, money scale, always <= 0. */
  readonly grossLoss: string;
  /** Net PnL per contributing trade, money scale. `"0.00"` when there are none. */
  readonly expectancy: string;
  /** Max peak-to-trough decline of the cumulative series, money scale, >= 0. */
  readonly maxDrawdown: string;
  /** Highest / lowest point of the cumulative PnL series, money scale. */
  readonly equityPeak: string;
  readonly equityTrough: string;
}

/**
 * Aggregate metrics for one bucket (a day in a stated timezone, or an account's
 * whole history). Deterministic: identical rows in identical order produce
 * byte-identical output, which is what makes the recompute safe to re-run.
 *
 * OPEN TRADES (netPnl === null) are excluded from every money figure and from
 * the drawdown series, and are not counted in `contributingTrades`: an unrealized
 * trade has no attributable result. `tradeCount` (from `computeSummary`) still
 * counts the rows, preserving the established summary asymmetry.
 */
export function computeAggregate(
  trades: readonly MetricTrade[],
  mode: RoundingMode = "half-even",
): AggregateMetrics {
  const summary = computeSummary(trades, mode);
  const S_CUR = SCALES.currency;

  let grossProfit = D.fromString(ZERO);
  // Accumulated as a POSITIVE magnitude and negated once at the end, so the
  // sign of every intermediate value is unambiguous.
  let grossLossMagnitude = D.fromString(ZERO);
  let running = D.fromString(ZERO);
  let peak = D.fromString(ZERO);
  let trough = D.fromString(ZERO);
  let maxDrawdown = D.fromString(ZERO);
  let contributing = 0;

  for (const t of trades) {
    if (t.netPnl === null) continue; // open trade: not attributable
    contributing += 1;
    const net = D.fromString(t.netPnl);
    const sign = D.cmp(net, D.fromString(ZERO));
    if (sign > 0) grossProfit = D.add(grossProfit, net);
    else if (sign < 0) grossLossMagnitude = D.add(grossLossMagnitude, D.mul(net, D.fromString("-1")));

    running = D.add(running, net);
    // Peak/trough are tracked on the EXACT running value (no intermediate
    // rounding) so a long series cannot accumulate a rounding drift that hides
    // a real drawdown.
    if (D.cmp(running, peak) > 0) peak = running;
    if (D.cmp(running, trough) < 0) trough = running;
    const fromPeak = D.sub(peak, running);
    if (D.cmp(fromPeak, maxDrawdown) > 0) maxDrawdown = fromPeak;
  }

  const expectancy =
    contributing > 0
      ? D.rescale(D.div(D.fromString(summary.totalPnl), D.fromString(String(contributing)), 8, mode), S_CUR, mode)
      : D.fromString(ZERO);

  return {
    ...summary,
    contributingTrades: contributing,
    grossProfit: D.toString(D.rescale(grossProfit, S_CUR, mode)),
    grossLoss: D.toString(D.rescale(D.mul(grossLossMagnitude, D.fromString("-1")), S_CUR, mode)),
    expectancy: D.toString(expectancy),
    maxDrawdown: D.toString(D.rescale(maxDrawdown, S_CUR, mode)),
    equityPeak: D.toString(D.rescale(peak, S_CUR, mode)),
    equityTrough: D.toString(D.rescale(trough, S_CUR, mode)),
  };
}

export interface DailyPnl {
  /** Calendar day, `YYYY-MM-DD` (already bucketed by the caller, ADR-004). */
  readonly day: string;
  /** Summed net PnL for that day, exact decimal string. */
  readonly netPnl: string;
}

export interface EquityPoint {
  readonly day: string;
  /** Cumulative net PnL from the start of the window, 2 dp. */
  readonly cumulativePnl: string;
}

/**
 * Daily equity curve: cumulative net PnL starting from zero.
 *
 * The caller supplies day buckets (bucketing is a time-model concern owned by
 * ADR-004 and is NOT decided here). Days are returned in the order given; the
 * service sorts them ascending before calling.
 */
export function computeEquityCurve(points: readonly DailyPnl[], mode: RoundingMode = "half-even"): EquityPoint[] {
  let running = D.fromString(ZERO);
  const out: EquityPoint[] = [];
  for (const p of points) {
    running = D.add(running, D.fromString(p.netPnl));
    out.push({ day: p.day, cumulativePnl: D.toString(D.rescale(running, SCALES.currency, mode)) });
  }
  return out;
}

export interface StrategyMetrics extends SummaryMetrics {
  readonly strategy: string;
}

/** Per-strategy breakdown: the same summary rules, grouped by journal tag. */
export function computePerStrategy(
  trades: readonly MetricTrade[],
  mode: RoundingMode = "half-even",
): StrategyMetrics[] {
  const groups = new Map<string, MetricTrade[]>();
  for (const t of trades) {
    const key = t.strategy === null || t.strategy === undefined || t.strategy.trim() === "" ? "(untagged)" : t.strategy;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [t]);
    else list.push(t);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([strategy, list]) => ({ strategy, ...computeSummary(list, mode) }));
}

/** Bucket by an integer key (weekday 0-6, hour 0-23) for the heatmaps. */
export interface HeatmapCell extends SummaryMetrics {
  readonly bucket: number;
}
