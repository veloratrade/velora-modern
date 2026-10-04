"use client";
// Dashboard — the trader's performance overview (TRD-07).
//
// WHAT WAS WRONG (found while auditing this page against the API it calls):
//   * the KPI row read `s.totalTrades ?? s.total` and `s.totalPnL`, but
//     `/analytics/summary` answers `tradeCount` and `totalPnl`. Both KPIs
//     therefore rendered 0 forever — a page that looked alive and told the
//     trader nothing;
//   * `winRate` is a RATIO STRING ("0.5333", Legacy's own wire shape) and the
//     page only formatted it when it was a number, so it printed "0.5333";
//   * the equity curve read `point.equity`, while the API answers
//     `{day, cumulativePnl}` — the chart was a flat line at zero by
//     construction, i.e. invented-looking data;
//   * the labels were hand-written fa/en pairs, which is exactly the drift the
//     catalog exists to prevent.
// All four are fixed here against the real response shapes, and
// `dashboardSurface.test.ts` pins them so they cannot rot back.
//
// Legacy parity: Legacy's `/dashboard/summary` covers ALL of the user's trades,
// while its equity curve defaults to a 30-day window (clamped 7…365). The
// summary here is likewise unwindowed, and the curve defaults to 30 days with
// the same 7/30/90 selector Legacy's chart offered.
import React, { useEffect, useState } from "react";
import { getAnalyticsSummary, getEquityCurve, getBySymbol } from "../../../lib/api/resources";
import type { AnalyticsSummary, AnalyticsCurvePoint, AnalyticsSymbolRow } from "../../../lib/api/resources";
import { createTranslator } from "../../../i18n/catalog";
import type { Locale } from "../../../contracts/locale";
import { fmtDecimal, fmtMoney, fmtPercent } from "../../../i18n/format";

function useLocale(): Locale {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/en") ? "en" : "fa";
}

/** Legacy's chart selector: 7 / 30 / 90 days; 30 is the default. */
const CURVE_WINDOWS: readonly { period: string; key: string }[] = [
  { period: "7d", key: "common.7.days.4b6569f5" },
  { period: "30d", key: "common.30.days.6ff5e162" },
  { period: "90d", key: "pages.dashboard.90.days.8814804c" },
];

export default function DashboardPage() {
  const locale = useLocale();
  const t = createTranslator(locale, ["common", "errors", "trades", "dashboard"]);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [curve, setCurve] = useState<AnalyticsCurvePoint[] | null>(null);
  const [bySymbol, setBySymbol] = useState<AnalyticsSymbolRow[] | null>(null);
  const [window, setWindow] = useState<string>("30d");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [capAbsent, setCapAbsent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        // Summary + by-symbol are unwindowed (all recorded trades, Legacy parity);
        // only the curve follows the selector.
        const [s, c, b] = await Promise.all([
          getAnalyticsSummary(),
          getEquityCurve({ period: window }),
          getBySymbol(),
        ]);
        if (cancelled) return;
        setSummary(s);
        setCurve(c.points);
        setBySymbol(b.symbols);
        setError("");
      } catch (e: unknown) {
        if (cancelled) return;
        const code = (e as { code?: string } | null)?.code;
        // 503 SERVICE_UNAVAILABLE = the capability is not wired in this
        // deployment (memory persistence never wires analytics; PostgreSQL
        // does). Say so instead of showing zeroes that look like real data.
        if (code === "SERVICE_UNAVAILABLE") setCapAbsent(true);
        else setError(t("trades.loadFailed", null, locale === "fa" ? "بارگذاری ناموفق بود" : "Could not load"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `window` is the curve selector; `t` is stable per locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [window, locale]);

  if (loading && summary === null && !capAbsent && error === "") {
    return (
      <div className="empty">
        <h3>{t("pages.dashboard.loading.dashboard.4116bcc3", null, "Loading dashboard…")}</h3>
      </div>
    );
  }

  if (capAbsent) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1 className="page-title">{t("common.dashboard.2aea7aaf", null, "Dashboard")}</h1>
          </div>
          <span className="badge badge-disconnected">503 SERVICE_UNAVAILABLE</span>
        </div>
        <div className="card">
          <div className="empty">
            <h3>{t("errors.capabilityUnavailable", { capability: "analytics" }, "Analytics unavailable")}</h3>
            <p className="muted-xs mt-8">
              GET /api/v1/analytics/summary → 503 capabilityAbsent · {t("common.trades.c19408e7", null, "Trade Journal")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card error-card">
        <h3>{t("common.dashboard.2aea7aaf", null, "Dashboard")}</h3>
        <p>{error}</p>
      </div>
    );
  }

  const s = summary;
  const points = curve ?? [];
  const maxAbs = Math.max(1, ...points.map((p) => Math.abs(Number(p.cumulativePnl) || 0)));
  const chartWidth = 380;
  const chartHeight = 160;
  const polyline = points
    .map((p, i) => {
      const x = points.length === 1 ? chartWidth / 2 : (i / (points.length - 1)) * chartWidth + 10;
      const y = chartHeight - ((Number(p.cumulativePnl) || 0) / maxAbs) * (chartHeight / 2 - 10) - chartHeight / 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const bestStrategy = s?.byStrategy?.length
    ? [...s.byStrategy].sort((a, b) => Number(b.totalPnl) - Number(a.totalPnl))[0]
    : undefined;
  const bestSymbol = bySymbol?.length ? [...bySymbol].sort((a, b) => Number(b.totalPnl) - Number(a.totalPnl))[0] : undefined;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("common.dashboard.2aea7aaf", null, "Dashboard")}</h1>
          <p className="page-sub">{t("dashboard.summaryNote", null, "Summary from /analytics/summary")}</p>
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi">
          <div className="kpi-label">{t("pages.trades.total.trades.b3aaafd2", null, "Total Trades")}</div>
          <div className="kpi-value v-latn-num">{s?.tradeCount ?? 0}</div>
          <div className="kpi-sub">
            {t("common.win.rate.f57b9504", null, "Win Rate")} {fmtPercent(locale, s?.winRate)}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t("common.win.rate.f57b9504", null, "Win Rate")}</div>
          <div className="kpi-value v-latn-num">{fmtPercent(locale, s?.winRate)}</div>
          <div className="kpi-sub v-latn-num">
            {s?.wins ?? 0} / {s?.losses ?? 0} / {s?.breakeven ?? 0}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t("common.net.p.l.21997b05", null, "Net P&L")}</div>
          <div
            className={
              "kpi-value v-latn-num " + ((Number(s?.totalPnl ?? "0") || 0) >= 0 ? "pnl-positive" : "pnl-negative")
            }
          >
            {fmtMoney(locale, s?.totalPnl)}
          </div>
          <div className="kpi-sub">
            {/* Legacy prints an unlimited factor as ∞; every other value at 2 dp. */}
            {t("common.profit.factor.4f05d40f", null, "Profit Factor")}{" "}
            {s?.profitFactor === null || s?.profitFactor === undefined ? "∞" : fmtDecimal(locale, s.profitFactor, 2)}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t("dashboard.averageR", null, "Average R")}</div>
          <div className="kpi-value v-latn-num">{fmtDecimal(locale, s?.averageR, 2)}</div>
          <div className="kpi-sub v-latn-num">
            {t("dashboard.bestTrade", null, "Best trade")} {fmtMoney(locale, s?.bestTrade)} ·{" "}
            {t("dashboard.worstTrade", null, "Worst trade")} {fmtMoney(locale, s?.worstTrade)}
          </div>
        </div>
      </div>

      <div className="grid-2 mt-16">
        <div className="card">
          <div className="flex-between">
            <h3 className="label text-gold label-nocap">{t("common.equity.curve.cf3d44ce", null, "Equity Curve")}</h3>
            <div className="flex-gap-8" role="group" aria-label={t("dashboard.curveWindow", null, "Curve window")}>
              {CURVE_WINDOWS.map((w) => (
                <button
                  key={w.period}
                  type="button"
                  className={"btn-" + (window === w.period ? "primary" : "ghost") + " btn-sm"}
                  aria-pressed={window === w.period}
                  onClick={() => setWindow(w.period)}
                >
                  {t(w.key, null, w.period)}
                </button>
              ))}
            </div>
          </div>
          <div className="chart-wrap mt-8">
            {points.length > 0 ? (
              <svg viewBox="0 0 400 180" className="equity-svg" role="img" aria-label={t("common.equity.curve.cf3d44ce", null, "Equity Curve")}>
                <defs>
                  <linearGradient id="eqG" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="rgba(212,175,55,.4)" />
                    <stop offset="1" stopColor="rgba(212,175,55,0)" />
                  </linearGradient>
                </defs>
                <polyline fill="none" stroke="#e9c45c" strokeWidth="2" points={polyline} />
              </svg>
            ) : (
              <div className="empty">
                <p>{t("dashboard.noEquityData", null, "No equity data yet.")}</p>
              </div>
            )}
          </div>
          <p className="muted-xs mt-8 v-latn-num">
            {points.length > 0
              ? `${points[0]!.day} → ${points[points.length - 1]!.day} · ${points[points.length - 1]!.cumulativePnl}`
              : "GET /api/v1/analytics/equity-curve"}
          </p>
        </div>

        <div className="card">
          <h3 className="label text-gold label-nocap">
            {t("pages.dashboard.strategy.performance.0633088a", null, "Strategy Performance")}
          </h3>
          <div className="grid-gap-8 mt-8">
            {s?.byStrategy?.length ? (
              s.byStrategy
                .slice()
                .sort((a, b) => Number(b.totalPnl) - Number(a.totalPnl))
                .slice(0, 6)
                .map((row) => (
                  <div key={row.strategy} className="card-alt flex-between">
                    <span className="font-800">{row.strategy}</span>
                    <span className="v-latn-num">
                      {row.tradeCount} · {fmtMoney(locale, row.totalPnl)} ·{" "}
                      {fmtPercent(locale, row.winRate, { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                ))
            ) : (
              <div className="empty">
                <p>{t("dashboard.noStrategies", null, "No tagged strategy yet.")}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid-2 mt-16">
        <div className="card">
          <h3 className="label text-gold label-nocap">{t("common.symbol.159cbe33", null, "Symbol")}</h3>
          <div className="grid-gap-8 mt-8">
            {bySymbol?.length ? (
              bySymbol
                .slice()
                .sort((a, b) => Number(b.totalPnl) - Number(a.totalPnl))
                .slice(0, 6)
                .map((row) => (
                  <div key={row.symbol} className="card-alt flex-between">
                    <span className="v-latn-num font-800">{row.symbol}</span>
                    <span className="v-latn-num">
                      {row.tradeCount} · {fmtMoney(locale, row.totalPnl)} ·{" "}
                      {fmtPercent(locale, row.winRate, { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                ))
            ) : (
              <div className="empty">
                <p>{t("trades.empty", null, "No trades recorded yet.")}</p>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <h3 className="label text-gold label-nocap">{t("pages.trades.best.strategy.87602ad2", null, "Best Strategy")}</h3>
          <div className="grid-gap-8 mt-8">
            <div className="card-alt flex-between">
              <span>{t("pages.trades.best.strategy.87602ad2", null, "Best Strategy")}</span>
              <span className="v-latn-num font-800">{bestStrategy ? `${bestStrategy.strategy} · ${fmtMoney(locale, bestStrategy.totalPnl)}` : "—"}</span>
            </div>
            <div className="card-alt flex-between">
              <span>{t("pages.trades.best.symbol.b7749a1a", null, "Best Symbol")}</span>
              <span className="v-latn-num font-800">{bestSymbol ? `${bestSymbol.symbol} · ${fmtMoney(locale, bestSymbol.totalPnl)}` : "—"}</span>
            </div>
            <p className="muted-xs mt-8">{t("pages.trades.your.best.strategy.and.symbol.are.calculated.48f21baf", null, "")}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
