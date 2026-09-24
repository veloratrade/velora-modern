
"use client";
import React, { useEffect, useState } from "react";
import { getAnalyticsSummary, getEquityCurve, getBySymbol } from "../../../lib/api/resources";
import { createTranslator } from "../../../i18n/catalog";
import type { Locale } from "../../../contracts/locale";
import { htmlLang } from "../../../i18n/registry";
import { usePathname } from "next/navigation";

function useLocale(): Locale { const p = typeof window !== "undefined" ? window.location.pathname : ""; return p.startsWith("/en") ? "en" : "fa"; }

export default function DashboardPage() {
  const locale = useLocale();
  const t = createTranslator(locale, ["common","errors"]);
  const [summary, setSummary] = useState<any>(null);
  const [curve, setCurve] = useState<any>(null);
  const [bySymbol, setBySymbol] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [capAbsent, setCapAbsent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await getAnalyticsSummary();
        const c = await getEquityCurve();
        const b = await getBySymbol();
        if (!cancelled) { setSummary(s); setCurve(c); setBySymbol(b); }
      } catch (e: any) {
        if (cancelled) return;
        // 503 SERVICE_UNAVAILABLE = capability not wired in this deployment
        // (dev PERSISTENCE=memory never wires analytics; PG does). Honest state.
        if (e?.code === "SERVICE_UNAVAILABLE") setCapAbsent(true);
        else setError(e?.message || "Failed to load analytics");
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  const number = (v: any) => new Intl.NumberFormat(htmlLang(locale), { numberingSystem: "latn" } as any).format(Number(v)||0);

  if (loading) return <div className="empty"><h3>{locale==="fa"?"در حال بارگذاری":"Loading"}</h3><p>{locale==="fa"?"داده‌های داشبورد در حال دریافت است":"Fetching dashboard data"}</p></div>;
  if (capAbsent) return (
    <div>
      <div className="page-head"><div><h1 className="page-title">{locale==="fa"?"داشبورد":"Dashboard"}</h1></div><span className="badge badge-disconnected">503 SERVICE_UNAVAILABLE</span></div>
      <div className="card"><div className="empty">
        <h3>{locale==="fa"?"تحلیل‌ها در دسترس نیست":"Analytics unavailable"}</h3>
        <p>{locale==="fa"?"این قابلیت در این محیط در دسترس نیست (analytics). در استقرار با پایگاه‌داده PostgreSQL فعال می‌شود.":"This capability is not available in this environment (analytics). It becomes active in deployments with PostgreSQL."}</p>
        <p className="muted-xs mt-8">GET /api/v1/analytics/summary → 503 capabilityAbsent (dev PERSISTENCE=memory does not wire analytics; PgAnalyticsStore is wired when DATABASE_URL is set).</p>
        <p className="muted-xs">{locale==="fa"?"حساب‌ها و ژورنال معاملات در این محیط فعال هستند — از منو ببینید.":"Accounts and the trades journal ARE active in this environment — see the menu."}</p>
      </div></div>
    </div>
  );
  if (error) return <div className="card"><div className="empty"><h3>Error</h3><p>{error}</p></div></div>;
  const s: any = summary || {};
  // Modern analytics summary shape may vary; adapt gracefully
  const totalTrades = s.totalTrades ?? s.total ?? 0;
  const winRate = s.winRate ?? s.win_rate ?? 0;
  const pf = s.profitFactor ?? s.profit_factor ?? 0;
  const pnl = s.totalPnL ?? s.total_pnl ?? s.pnl ?? "0";

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{locale==="fa"?"داشبورد":"Dashboard"} <span className="v-latn-num">{totalTrades ? number(totalTrades) : ""}</span></h1>
          <p className="page-sub">{locale==="fa"?"نمای کلی عملکرد معاملاتی شما — داده‌ها از /analytics/*":"Overview of your trading performance — data from /analytics/*"}</p>
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi"><div className="kpi-label">{locale==="fa"?"کل معاملات":"Total Trades"}</div><div className="kpi-value v-latn-num">{number(totalTrades)}</div><div className="kpi-sub">from /analytics/summary</div></div>
        <div className="kpi"><div className="kpi-label">Win Rate</div><div className="kpi-value v-latn-num">{typeof winRate==="number" ? (winRate*100).toFixed(1)+"%" : String(winRate)}</div><div className="kpi-sub">profit factor {typeof pf==="number" ? pf.toFixed(2) : String(pf)}</div></div>
        <div className="kpi"><div className="kpi-label">Total PnL</div><div className={"kpi-value v-latn-num " + (Number(pnl)>=0 ? "pnl-positive" : "pnl-negative")}>{String(pnl)}</div><div className="kpi-sub">base currency</div></div>
        <div className="kpi"><div className="kpi-label">{locale==="fa"?"امتیاز":"Score"}</div><div className="kpi-value v-latn-num">{s.sharpeRatio ? Number(s.sharpeRatio).toFixed(2) : "—"}</div><div className="kpi-sub">Sharpe / analytics</div></div>
      </div>

      <div className="grid-2 mt-16">
        <div className="card">
          <h3 className="label text-gold label-nocap">Equity Curve — /analytics/equity-curve</h3>
          <div className="chart-wrap">
            {curve?.points?.length ? (
              <svg viewBox="0 0 400 200" className="equity-svg" role="img" aria-label="equity curve">
                <defs><linearGradient id="eqG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="rgba(212,175,55,.4)"/><stop offset="1" stopColor="rgba(212,175,55,0)"/></linearGradient></defs>
                <polyline fill="none" stroke="#e9c45c" strokeWidth="2" points={(curve.points as any[]).map((pt:any,i:number)=>`${(i/(curve.points.length-1))*380+10},${190 - (Math.min(180, Math.max(0, (Number(pt.equity)||0)/1000 * 20)))}`).join(" ")} />
              </svg>
            ) : <div className="empty">No equity data yet — create trades to see curve</div>}
          </div>
        </div>
        <div className="card">
          <h3 className="label text-gold label-nocap">By Symbol — /analytics/by-symbol</h3>
          <div className="grid-gap-8">
            {(bySymbol?.symbols as any[])?.length ? (bySymbol.symbols as any[]).slice(0,6).map((row:any)=>(
              <div key={row.symbol} className="card-alt flex-between">
                <span className="v-latn-num font-800">{row.symbol}</span>
                <span className="v-latn-num">{row.trades} trades · {row.pnl} · {(row.winRate*100).toFixed(0)}% WR</span>
              </div>
            )) : <div className="empty">No symbol breakdown yet</div>}
          </div>
        </div>
      </div>

      <div className="card mt-16">
        <h3 className="label text-gold">Recent analytics — heatmap preview</h3>
        <p className="page-sub mt-8">Heatmap from <code className="v-latn-num">/analytics/heatmap</code> — hourly PnL distribution (not shown in detail to avoid inventing data).</p>
      </div>
    </div>
  );
}
