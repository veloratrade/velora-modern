
"use client";
import React, { useEffect, useState } from "react";
import { getAnalyticsSummary, getEquityCurve, getHeatmap, getBySymbol } from "../../../lib/api/resources";

export default function AnalyticsPage() {
  const locale = typeof window!=="undefined" && window.location.pathname.startsWith("/en") ? "en":"fa";
  const [summary, setSummary] = useState<any>(null);
  const [err, setErr] = useState("");
  const [capAbsent, setCapAbsent] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(()=>{ (async()=>{ try{ const s:any = await getAnalyticsSummary(); setSummary(s); }catch(e:any){ if (e?.code === "SERVICE_UNAVAILABLE") setCapAbsent(true); else setErr(e.message);} finally{ setLoading(false);} })(); }, []);
  if (loading) return <div className="empty"><h3>{locale==="fa"?"در حال بارگذاری":"Loading"}</h3><p>/analytics/summary</p></div>;
  if (capAbsent) return (
    <div>
      <div className="page-head"><div><h1 className="page-title">{locale==="fa"?"تحلیل عملکرد":"Performance Analytics"}</h1></div><span className="badge badge-disconnected">503 SERVICE_UNAVAILABLE</span></div>
      <div className="card"><div className="empty">
        <h3>{locale==="fa"?"تحلیل‌ها در دسترس نیست":"Analytics unavailable"}</h3>
        <p>{locale==="fa"?"این قابلیت در این محیط در دسترس نیست (analytics). در استقرار با پایگاه‌داده PostgreSQL فعال می‌شود.":"This capability is not available in this environment (analytics). It becomes active in deployments with PostgreSQL."}</p>
        <p className="muted-xs mt-8">GET /api/v1/analytics/* → 503 capabilityAbsent (PgAnalyticsStore requires DATABASE_URL).</p>
      </div></div>
    </div>
  );
  if (err) return <div className="card text-error">{err}</div>;
  return (
    <div>
      <div className="page-head"><div><h1 className="page-title">{locale==="fa"?"تحلیل عملکرد":"Performance Analytics"}</h1><p className="page-sub">GET /analytics/* — summary, equity-curve, heatmap, by-symbol (all keyed by your user id, optional account_id filter)</p></div></div>
      <div className="kpi-grid">
        <div className="kpi"><div className="kpi-label">Total</div><div className="kpi-value v-latn-num">{summary?.totalTrades ?? summary?.total ?? 0}</div></div>
        <div className="kpi"><div className="kpi-label">Win Rate</div><div className="kpi-value v-latn-num">{summary?.winRate ? (summary.winRate*100).toFixed(1)+"%" : "0%"}</div></div>
        <div className="kpi"><div className="kpi-label">Profit Factor</div><div className="kpi-value v-latn-num">{summary?.profitFactor ?? "—"}</div></div>
        <div className="kpi"><div className="kpi-label">PnL</div><div className="kpi-value v-latn-num">{summary?.totalPnL ?? "0"}</div></div>
      </div>
      <div className="card mt-16"><h3 className="label text-gold">Details — raw summary JSON (Modern contract, no invented fields)</h3><pre className="v-latn-num code-block mt-8">{JSON.stringify(summary, null, 2)}</pre></div>
    </div>
  );
}
