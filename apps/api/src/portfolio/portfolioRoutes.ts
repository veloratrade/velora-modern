// Portfolio — v1.5 "Multi-Account & Prop Drawdown".
//
//   GET /api/v1/portfolio/summary      per-account + combined performance
//   GET /api/v1/portfolio/by-symbol    best/worst instruments across accounts
//   GET /api/v1/portfolio/fx-rates     stored ECB rates
//   GET /api/v1/portfolio/prop-status  drawdown vs the account's prop-firm rules
//
// ============================================================
// WHAT IS CARRIED OVER
// ============================================================
// Legacy had no portfolio surface (its dashboard was single-account). The
// roadmap (v1.5) is therefore the source of truth for the SHAPE, and the
// business RULES come from the same metric definitions the single-account
// analytics already use (`packages/domain/src/metrics.ts`) — a portfolio figure
// that disagreed with the per-account figure would be a bug, so both call the
// same computation.
//
// ============================================================
// CURRENCY AND FX — WHAT IS HONEST HERE
// ============================================================
// `trading_accounts.currency` varies per account, and `currency_rates` stores
// ECB rates. Converting every account to one base requires a rate for the
// ACCOUNT's currency, and the roadmap's daily ECB ingestion job is a WORKER
// concern that this pass does not run (network egress + scheduling are out of
// scope for the API process). So the portfolio summary reports each account in
// ITS OWN currency, plus a `convertedTotal` ONLY when every required rate is
// present. It never invents a 1:1 rate and never silently mixes currencies —
// an unconvertible account is reported as such. Recorded in the report as
// PARTIALLY_IMPLEMENTED (conversion depends on the FX ingestion job).
import { fail, ok } from "@velora/contracts";
import * as D from "@velora/domain";
import { computeSummary, type MetricTrade } from "@velora/domain";
import type { QueryFn } from "../persistence/pg.js";
import { capabilityAbsent, unauthenticated, validation } from "../routes/responses.js";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";

export const SUMMARY = "/api/v1/portfolio/summary";
export const BY_SYMBOL = "/api/v1/portfolio/by-symbol";
export const FX_RATES = "/api/v1/portfolio/fx-rates";
export const PROP_STATUS = "/api/v1/portfolio/prop-status";

export interface AccountPerformance {
  readonly accountId: string;
  readonly label: string;
  readonly currency: string;
  readonly provider: string;
  readonly syncState: string;
  readonly balance: string;
  readonly equity: string;
  readonly metrics: ReturnType<typeof computeSummary>;
}

export interface PropStatus {
  readonly accountId: string;
  readonly ruleSetName: string;
  readonly maxTotalDrawdown: string | null;
  readonly maxDailyDrawdown: string | null;
  readonly profitTarget: string | null;
  readonly drawdownBasis: string;
  readonly alertThresholdPct: string;
  /** Peak-to-current drawdown as a positive amount, 2 dp. */
  readonly currentDrawdown: string;
  /** Drawdown as a percentage of the basis, 2 dp. Empty when the basis is 0. */
  readonly drawdownPct: string | null;
  /** True when drawdownPct ≥ alertThresholdPct — the roadmap's 80% alert. */
  readonly alert: boolean;
  /** True when the limit itself is breached. */
  readonly breached: boolean;
  readonly profitTargetReached: boolean;
}

export interface PortfolioStore {
  accounts(userId: string): Promise<
    {
      accountId: string;
      label: string;
      currency: string;
      provider: string;
      syncState: string;
      balance: string;
      equity: string;
      startingBalance: string;
      peakEquity: string | null;
    }[]
  >;
  tradesByAccount(userId: string): Promise<{ accountId: string; netPnl: string | null; rMultiple: string | null; symbol: string; strategy: string | null }[]>;
  fxRate(base: string, quote: string): Promise<{ rate: string; rateDate: string; source: string } | null>;
  propRules(accountId: string, userId: string): Promise<{
    ruleSetName: string;
    maxDailyDrawdown: string | null;
    maxTotalDrawdown: string | null;
    profitTarget: string | null;
    drawdownBasis: string;
    alertThresholdPct: string;
  } | null>;
}

type Row = Record<string, unknown>;

function s(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

export class PgPortfolioStore implements PortfolioStore {
  constructor(private readonly q: QueryFn) {}

  async accounts(userId: string) {
    const rows = await this.q(
      `SELECT a.id::text AS account_id, a.label, a.currency, a.provider, a.sync_status, a.balance::text, a.equity::text,
              a.starting_balance::text,
              -- PEAK (high-water mark) for drawdown.
              --
              -- The foundation stores no equity-snapshot table, so the peak is
              -- DERIVED from the account's own closed-trade history: the running
              -- sum of net PnL added to the starting balance, and the starting
              -- balance itself always counts as a candidate peak (an account
              -- that has only lost money has not yet made a new high).
              --   peak = GREATEST(starting_balance, starting_balance + max(running_sum))
              -- A derived peak is stated as such rather than presented as a
              -- stored fact; when the account has no closed trades the peak is
              -- NULL and the drawdown evaluates to zero.
              (SELECT GREATEST(
                        a.starting_balance,
                        a.starting_balance + MAX(running.cum)
                      )::text
                 FROM (
                   SELECT SUM(t2.net_pnl) OVER (ORDER BY t2.occurred_at ASC, t2.id ASC) AS cum
                     FROM trades t2
                    WHERE t2.account_id = a.id
                      AND t2.deleted_at IS NULL
                      AND t2.quarantined = false
                      AND t2.net_pnl IS NOT NULL
                 ) running) AS peak_equity
         FROM trading_accounts a
        WHERE a.user_id = $1
        ORDER BY a.id ASC`,
      [userId],
    );
    return rows.map((row: Row) => ({
      accountId: s(row["account_id"]),
      label: s(row["label"]),
      currency: s(row["currency"]),
      provider: s(row["provider"]),
      syncState: s(row["sync_status"]),
      balance: s(row["balance"]),
      equity: s(row["equity"]),
      startingBalance: s(row["starting_balance"]),
      peakEquity: row["peak_equity"] === null || row["peak_equity"] === undefined ? null : s(row["peak_equity"]),
    }));
  }

  async tradesByAccount(userId: string) {
    const rows = await this.q(
      `SELECT account_id::text AS account_id, net_pnl::text, r_multiple::text, symbol,
              COALESCE(strategy_tag, strategy) AS strategy
         FROM trades
        WHERE user_id = $1 AND account_id IS NOT NULL AND deleted_at IS NULL AND quarantined = false
        ORDER BY occurred_at ASC, id ASC`,
      [userId],
    );
    return rows.map((row: Row) => ({
      accountId: s(row["account_id"]),
      netPnl: row["net_pnl"] === null ? null : s(row["net_pnl"]),
      rMultiple: row["r_multiple"] === null ? null : s(row["r_multiple"]),
      symbol: s(row["symbol"]),
      strategy: row["strategy"] === null ? null : s(row["strategy"]),
    }));
  }

  async fxRate(base: string, quote: string) {
    const rows = await this.q(
      `SELECT rate::text, rate_date::text, source FROM currency_rates
        WHERE base = $1 AND quote = $2 ORDER BY rate_date DESC LIMIT 1`,
      [base, quote],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { rate: s(row["rate"]), rateDate: s(row["rate_date"]), source: s(row["source"]) };
  }

  async propRules(accountId: string, userId: string) {
    const rows = await this.q(
      `SELECT rule_set_name, max_daily_drawdown::text, max_total_drawdown::text, profit_target::text,
              drawdown_basis, alert_threshold_pct::text
         FROM prop_firm_rules
        WHERE account_id = $1 AND user_id = $2 AND enabled = true
        LIMIT 1`,
      [accountId, userId],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          ruleSetName: s(row["rule_set_name"]),
          maxDailyDrawdown: row["max_daily_drawdown"] === null ? null : s(row["max_daily_drawdown"]),
          maxTotalDrawdown: row["max_total_drawdown"] === null ? null : s(row["max_total_drawdown"]),
          profitTarget: row["profit_target"] === null ? null : s(row["profit_target"]),
          drawdownBasis: s(row["drawdown_basis"]),
          alertThresholdPct: s(row["alert_threshold_pct"]),
        };
  }
}

/** In-memory double (contract-identical; not database evidence). */
export class MemoryPortfolioStore implements PortfolioStore {
  constructor(
    private readonly accountRows: Awaited<ReturnType<PortfolioStore["accounts"]>>,
    private readonly tradeRows: Awaited<ReturnType<PortfolioStore["tradesByAccount"]>>,
    private readonly rates: Map<string, { rate: string; rateDate: string; source: string }> = new Map(),
    private readonly rules: Map<string, NonNullable<Awaited<ReturnType<PortfolioStore["propRules"]>>>> = new Map(),
  ) {}

  async accounts(): ReturnType<PortfolioStore["accounts"]> {
    return this.accountRows;
  }
  async tradesByAccount(): ReturnType<PortfolioStore["tradesByAccount"]> {
    return this.tradeRows;
  }
  async fxRate(base: string, quote: string): ReturnType<PortfolioStore["fxRate"]> {
    return this.rates.get(`${base}/${quote}`) ?? null;
  }
  async propRules(accountId: string): ReturnType<PortfolioStore["propRules"]> {
    return this.rules.get(accountId) ?? null;
  }
}

/**
 * Drawdown against a prop-firm rule set.
 *
 * RULE (roadmap v1.5 + 0018): drawdown is measured from the PEAK of the chosen
 * basis. `basis = balance` → peak balance vs current balance; `basis = equity`
 * → peak equity vs current equity. The alert fires at `alert_threshold_pct`
 * (default 80) and the LIMIT is breached at 100%. Both are reported separately:
 * a warning is not a breach, and conflating them would either cry wolf or hide
 * an account that has already failed the challenge.
 */
export function evaluatePropRules(
  basisValue: string,
  peakValue: string | null,
  rules: {
    maxDailyDrawdown: string | null;
    maxTotalDrawdown: string | null;
    profitTarget: string | null;
    alertThresholdPct: string;
  },
  startingBalance: string,
): Omit<PropStatus, "accountId" | "ruleSetName" | "drawdownBasis"> {
  const current = D.fromString(basisValue === "" ? "0" : basisValue);
  const peak = D.fromString(peakValue ?? (basisValue === "" ? "0" : basisValue));
  const drawdown = D.cmp(peak, current) > 0 ? D.sub(peak, current) : D.fromString("0");
  const limit = rules.maxTotalDrawdown !== null ? D.fromString(rules.maxTotalDrawdown) : null;

  let pct: string | null = null;
  let alert = false;
  let breached = false;
  if (limit !== null && D.cmp(limit, D.fromString("0")) > 0) {
    const ratio = D.div(drawdown, limit, 8, "half-even");
    pct = D.toString(D.rescale(D.mul(ratio, D.fromString("100")), 2, "half-even"));
    alert = D.cmp(D.fromString(pct), D.fromString(rules.alertThresholdPct)) >= 0;
    breached = D.cmp(D.fromString(pct), D.fromString("100")) >= 0;
  }

  const target = rules.profitTarget !== null ? D.fromString(rules.profitTarget) : null;
  const start = D.fromString(startingBalance === "" ? "0" : startingBalance);
  const profitTargetReached =
    target !== null && D.cmp(D.sub(current, start), target) >= 0;

  return {
    maxTotalDrawdown: rules.maxTotalDrawdown,
    maxDailyDrawdown: rules.maxDailyDrawdown,
    profitTarget: rules.profitTarget,
    alertThresholdPct: rules.alertThresholdPct,
    currentDrawdown: D.toString(D.rescale(drawdown, 2, "half-even")),
    drawdownPct: pct,
    alert,
    breached,
    profitTargetReached,
  };
}

/** Convert to a base currency; `null` when a rate is missing (never 1:1). */
export function convert(amount: string, rate: string | null): string | null {
  if (rate === null) return null;
  return D.toString(D.rescale(D.mul(D.fromString(amount), D.fromString(rate)), 2, "half-even"));
}

const BASE_CURRENCY = "USD";

export async function handlePortfolioRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  if (ctx.path !== SUMMARY && ctx.path !== BY_SYMBOL && ctx.path !== FX_RATES && ctx.path !== PROP_STATUS) return null;
  const store: PortfolioStore | null = ctx.config.portfolio ?? null;
  if (store === null) return capabilityAbsent(ctx, "portfolio");
  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);

  const accounts = await store.accounts(claims.sub);
  const trades = await store.tradesByAccount(claims.sub);

  if (ctx.path === SUMMARY) {
    if (ctx.method !== "GET") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
    const perAccount: AccountPerformance[] = [];
    const converted: string[] = [];
    let unconvertible = 0;
    for (const account of accounts) {
      const rows = trades.filter((t) => t.accountId === account.accountId);
      const metrics = computeSummary(rows.map((r): MetricTrade => ({ netPnl: r.netPnl, rMultiple: r.rMultiple, strategy: r.strategy })));
      perAccount.push({
        accountId: account.accountId,
        label: account.label,
        currency: account.currency,
        provider: account.provider,
        syncState: account.syncState,
        balance: account.balance,
        equity: account.equity,
        metrics,
      });
      if (account.currency.toUpperCase() === BASE_CURRENCY) {
        converted.push(metrics.totalPnl);
      } else {
        const rate = await store.fxRate(account.currency.toUpperCase(), BASE_CURRENCY);
        const amount = convert(metrics.totalPnl, rate === null ? null : rate.rate);
        if (amount === null) unconvertible += 1;
        else converted.push(amount);
      }
    }
    let total = D.fromString("0");
    for (const amount of converted) total = D.add(total, D.fromString(amount));
    return {
      status: 200,
      body: ok({
        baseCurrency: BASE_CURRENCY,
        accounts: perAccount,
        convertedTotalPnl: D.toString(D.rescale(total, 2, "half-even")),
        // Stated explicitly so a client never reads `convertedTotalPnl` as a
        // complete figure when a rate was missing.
        unconvertibleAccounts: unconvertible,
      }),
    };
  }

  if (ctx.path === BY_SYMBOL) {
    if (ctx.method !== "GET") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
    const groups = new Map<string, MetricTrade[]>();
    for (const t of trades) {
      const list = groups.get(t.symbol);
      const metric: MetricTrade = { netPnl: t.netPnl, rMultiple: t.rMultiple, strategy: t.strategy };
      if (list === undefined) groups.set(t.symbol, [metric]);
      else list.push(metric);
    }
    return {
      status: 200,
      body: ok({
        symbols: [...groups.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([symbol, list]) => ({ symbol, ...computeSummary(list) })),
      }),
    };
  }

  if (ctx.path === FX_RATES) {
    if (ctx.method !== "GET") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
    const base = (ctx.url.searchParams.get("base") ?? "").toUpperCase();
    const quote = (ctx.url.searchParams.get("quote") ?? "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote) || base === quote) {
      return validation(ctx, { pair: "base and quote must be distinct ISO-4217 codes" });
    }
    const rate = await store.fxRate(base, quote);
    if (rate === null) return { status: 404, body: fail("NOT_FOUND", "No stored rate for that pair.", ctx.requestId) };
    return { status: 200, body: ok({ base, quote, ...rate }) };
  }

  // prop-status
  if (ctx.method !== "GET") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
  const accountId = ctx.url.searchParams.get("account_id");
  if (accountId === null || !/^\d+$/.test(accountId)) return validation(ctx, { account_id: "must be a numeric id" });
  const account = accounts.find((a) => a.accountId === accountId);
  // Non-disclosing: an account the caller does not own is not distinguishable
  // from one that does not exist.
  if (account === undefined) return { status: 404, body: fail("NOT_FOUND", "Account not found.", ctx.requestId) };
  const rules = await store.propRules(accountId, claims.sub);
  if (rules === null) return { status: 404, body: fail("NOT_FOUND", "No enabled rule set for that account.", ctx.requestId) };
  const basisValue = rules.drawdownBasis === "equity" ? account.equity : account.balance;
  const peakValue = rules.drawdownBasis === "equity" ? (account.equity === "" ? null : account.equity) : account.peakEquity;
  const evaluated = evaluatePropRules(basisValue, peakValue, rules, account.startingBalance);
  return {
    status: 200,
    body: ok({ accountId, ruleSetName: rules.ruleSetName, drawdownBasis: rules.drawdownBasis, ...evaluated }),
  };
}
