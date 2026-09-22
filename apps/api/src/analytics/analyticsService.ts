// AnalyticsService — v0.5 "Analytics & Tagging".
//
// CAPABILITY: a trader must be able to see how they are actually doing —
// summary KPIs, the equity curve, and where the money is made or lost. The
// Legacy equivalents were `DashboardController::summary` (raw SELECTs with SQL
// AVG/SUM) and its window helpers; those queries are NOT carried over (they are
// MySQL-specific and recompute per request). The RULES they encoded are carried
// over, and are enumerated in `packages/domain/src/metrics.ts`.
//
// WINDOW SEMANTICS (deliberately uniform across every analytics route):
//   `from` inclusive, `to` EXCLUSIVE, both ISO-8601 instants; absent ⇒ open on
//   that side. `period` is sugar for a relative window and is resolved ONCE,
//   here, so no two endpoints can disagree about what "last 30 days" means.
//   An unparseable parameter is a 400 — never a silently different window.
import { computeEquityCurve, computePerStrategy, computeSummary, type MetricTrade } from "@velora/domain";
import type { AnalyticsStore, AnalyticsTradeRow } from "./analyticsStore.js";

export interface AnalyticsWindow {
  readonly from: string | null;
  readonly to: string | null;
}

export const PERIODS: readonly string[] = ["7d", "30d", "90d", "1y", "all"];

const DAY_MS = 86_400_000;

/**
 * Resolve a `period` value into an absolute window.
 *
 * `all` (and an absent period) is an OPEN window — it is not translated into a
 * fabricated start date, because inventing one would silently hide older trades.
 */
export function resolveWindow(period: string | null, now: Date): AnalyticsWindow {
  if (period === null || period === "" || period === "all") return { from: null, to: null };
  const match = /^(\d{1,3})([dmy])$/.exec(period.trim().toLowerCase());
  if (match === null) throw new WindowError(`unsupported period: ${period}`);
  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) throw new WindowError(`unsupported period: ${period}`);
  const days = unit === "d" ? amount : unit === "m" ? amount * 30 : amount * 365;
  if (days > 3650) throw new WindowError("period exceeds the supported range");
  return { from: new Date(now.getTime() - days * DAY_MS).toISOString(), to: null };
}

export class WindowError extends Error {}

/** Validate explicit from/to instants. A bad instant is a 400, never a fallback. */
export function parseInstant(value: string | null, field: string): string | null {
  if (value === null || value.trim() === "") return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new WindowError(`${field} must be an ISO-8601 instant`);
  return new Date(ms).toISOString();
}

function asMetricTrade(row: AnalyticsTradeRow): MetricTrade {
  return { netPnl: row.netPnl, rMultiple: row.rMultiple, strategy: row.strategy };
}

export interface EquityPointView {
  readonly day: string;
  readonly cumulativePnl: string;
}

/** Series longer than this are refused: the API contract is a bounded read. */
export const MAX_EQUITY_POINTS = 2000;

export class AnalyticsService {
  constructor(private readonly store: AnalyticsStore) {}

  private async rows(userId: string, window: AnalyticsWindow, accountId: string | null): Promise<AnalyticsTradeRow[]> {
    return this.store.listTrades({ userId, from: window.from, to: window.to, accountId });
  }

  /** Roadmap `/analytics/summary` + CTO directive KPI set. */
  async summary(userId: string, window: AnalyticsWindow, accountId: string | null): Promise<Record<string, unknown>> {
    const rows = await this.rows(userId, window, accountId);
    const metrics = computeSummary(rows.map(asMetricTrade));
    return {
      ...metrics,
      byStrategy: computePerStrategy(rows.map(asMetricTrade)),
      window: { from: window.from, to: window.to, accountId },
    };
  }

  /** Roadmap `/analytics/equity-curve` (R-multiple equity is a v0.5 chart). */
  async equityCurve(userId: string, window: AnalyticsWindow, accountId: string | null): Promise<EquityPointView[]> {
    const rows = await this.rows(userId, window, accountId);
    const byDay = new Map<string, string>();
    for (const row of rows) {
      if (row.netPnl === null) continue;
      const current = byDay.get(row.day);
      byDay.set(row.day, current === undefined ? row.netPnl : addDecimal(current, row.netPnl));
    }
    const points = [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([day, netPnl]) => ({ day, netPnl }));
    if (points.length > MAX_EQUITY_POINTS) {
      throw new WindowError(`equity curve exceeds ${MAX_EQUITY_POINTS} points; narrow the window`);
    }
    return computeEquityCurve(points);
  }

  /** Weekday × hour heatmap (v0.5 "when do I trade well"). */
  async heatmap(
    userId: string,
    window: AnalyticsWindow,
    accountId: string | null,
  ): Promise<{ weekday: number; hour: number; metrics: ReturnType<typeof computeSummary> }[]> {
    const rows = await this.rows(userId, window, accountId);
    const buckets = new Map<string, AnalyticsTradeRow[]>();
    for (const row of rows) {
      const key = `${row.weekday}:${row.hour}`;
      const list = buckets.get(key);
      if (list === undefined) buckets.set(key, [row]);
      else list.push(row);
    }
    return [...buckets.entries()]
      .map(([key, list]) => {
        const [weekday, hour] = key.split(":").map(Number);
        return {
          weekday: weekday ?? 0,
          hour: hour ?? 0,
          metrics: computeSummary(list.map(asMetricTrade)),
        };
      })
      .sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);
  }

  /** Symbol breakdown — the Legacy "best/worst instrument" view. */
  async bySymbol(userId: string, window: AnalyticsWindow, accountId: string | null): Promise<unknown[]> {
    const rows = await this.rows(userId, window, accountId);
    const groups = new Map<string, AnalyticsTradeRow[]>();
    for (const row of rows) {
      const list = groups.get(row.symbol);
      if (list === undefined) groups.set(row.symbol, [row]);
      else list.push(row);
    }
    return [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([symbol, list]) => ({ symbol, ...computeSummary(list.map(asMetricTrade)) }));
  }
}

/** Exact decimal addition without floats (money at scale 2). */
function addDecimal(a: string, b: string): string {
  const toMinor = (s: string): bigint => {
    const neg = s.trim().startsWith("-");
    const digits = s.trim().replace(/^[+-]/, "");
    const [intPart = "0", fracPart = ""] = digits.split(".");
    const frac = (fracPart + "00").slice(0, 2);
    const value = BigInt(intPart + frac);
    return neg ? -value : value;
  };
  const total = toMinor(a) + toMinor(b);
  const neg = total < 0n;
  const abs = (neg ? -total : total).toString().padStart(3, "0");
  return `${neg ? "-" : ""}${abs.slice(0, -2)}.${abs.slice(-2)}`;
}
