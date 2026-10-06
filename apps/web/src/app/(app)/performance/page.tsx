"use client";
/**
 * Performance — AC-32 (MG-FRONTEND-SURFACES + MG-I18N-COVERAGE).
 *
 * Legacy's page was a STATIC snapshot of demo metrics (hardcoded Profit Factor
 * 2.14 / 4.2% drawdown / 66.7% win rate). Capability-first: Modern already owns
 * the REAL metrics (`/api/v1/analytics/summary` + `/analytics/equity-curve`),
 * so this page renders the user's own numbers — the Legacy copy (titles,
 * labels, Jalali month names via the ported `performance` chunk) rides on top
 * of real data. No metric is invented; every failure is shown honestly.
 */
import React, { useEffect, useMemo, useState } from "react";
import { createTranslator } from "../../../i18n/catalog";
import { getAnalyticsSummary, getEquityCurve } from "../../../lib/api/resources";
import type { AnalyticsSummary, AnalyticsCurvePoint } from "../../../lib/api/resources";
import type { Locale } from "../../../contracts/locale";

function useLocale(): Locale {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/en") ? "en" : "fa";
}

/** Format a 4-dp decimal-string ratio as a percent, e.g. "0.6670" → "66.7%". */
function pct(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function fixed(value: string | null | undefined, dp = 2): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(dp);
}

/**
 * Attribute a UTC curve day to a Jalali (Persian calendar) month index (0..11)
 * using the platform's Intl calendar — exact, not approximated. The month NAME
 * is rendered locale-appropriately (fa-IR → «فروردین», en → "Farvardin") via
 * Intl too; Legacy's four chunk month-names stay in the catalog as the
 * provenance record of the original page's labels.
 */
function jalaliMonthIndex(day: string): { month: number; year: number } | null {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US-u-ca-persian", {
    timeZone: "UTC",
    year: "numeric",
    month: "numeric",
  }).formatToParts(d);
  const year = Number(parts.find((p) => p.type === "year")?.value ?? NaN);
  const month = Number(parts.find((p) => p.type === "month")?.value ?? NaN);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  return { month: month - 1, year };
}

function jalaliMonthLabel(month: number, locale: Locale): string {
  // month index 0..11 → a reference date inside that Persian month.
  const ref = new Date(Date.UTC(2024, 2, 25 + month * 29));
  const tag = locale === "fa" ? "fa-IR-u-ca-persian" : "en-US-u-ca-persian";
  return new Intl.DateTimeFormat(tag, { timeZone: "UTC", month: "long" }).format(ref);
}

export default function PerformancePage() {
  const locale = useLocale();
  const t = createTranslator(locale, ["common", "errors", "performance", "dashboard"]);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [curve, setCurve] = useState<AnalyticsCurvePoint[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [capAbsent, setCapAbsent] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [s, c] = await Promise.all([
          getAnalyticsSummary(),
          getEquityCurve({ window: "90d" }),
        ]);
        if (cancelled) return;
        setSummary(s);
        setCurve(c.points);
      } catch (e) {
        const err = e as { code?: string; message?: string };
        if (cancelled) return;
        if (err.code === "SERVICE_UNAVAILABLE") setCapAbsent(true);
        else setError(err.message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Net P&L booked per Jalali month, from the user's real cumulative curve.
  const monthly = useMemo(() => {
    if (!curve || curve.length === 0) return [] as { label: string; net: number }[];
    const byMonth = new Map<string, { sort: number; end: number; month: number }>();
    for (const p of curve) {
      const jm = jalaliMonthIndex(p.day);
      if (jm === null) continue;
      const key = `${jm.year}-${String(jm.month).padStart(2, "0")}`;
      byMonth.set(key, { sort: jm.year * 12 + jm.month, end: Number(p.cumulativePnl), month: jm.month });
    }
    const order = [...byMonth.entries()].sort((a, b) => a[1].sort - b[1].sort);
    const out: { label: string; net: number }[] = [];
    let prevEnd: number | null = null;
    for (const [, e] of order) {
      const net = prevEnd === null ? e.end : e.end - prevEnd;
      out.push({ label: jalaliMonthLabel(e.month, locale), net });
      prevEnd = e.end;
    }
    return out;
  }, [curve, locale]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("common.performance.a68933d2", null, "Performance")}</h1>
          <p className="page-sub">{t("pages.performance.monthly.returns.and.risk.to.reward.metrics.e640980b", null, "Monthly returns and risk-to-reward metrics")}</p>
        </div>
        <span className="badge badge-connected">{t("surface.realData")}</span>
      </div>

      {loading ? <div className="card"><p className="muted-sm">…</p></div> : null}
      {capAbsent ? (
        <div className="card">
          <h3 className="label text-gold">{t("common.performance.a68933d2", null, "Performance")}</h3>
          <p className="muted-sm mt-8">{t("errors.api", null, "The analytics capability is not configured on this deployment.")}</p>
        </div>
      ) : null}
      {error ? <div className="card"><p className="muted-sm">{error}</p></div> : null}

      {summary ? (
        <>
          <div className="grid-3 mt-16">
            <div className="card">
              <small className="muted-xs">{t("common.profit.factor.4f05d40f", null, "Profit Factor")}</small>
              <b className="stat-value text-gold">
                {summary.profitFactor === null ? t("surface.infinite") : fixed(summary.profitFactor, 2)}
              </b>
            </div>
            <div className="card">
              <small className="muted-xs">{t("pages.performance.total.win.rate.9294474a", null, "Total Win Rate")}</small>
              <b className="stat-value">{pct(summary.winRate)}</b>
            </div>
            <div className="card">
              <small className="muted-xs">{t("surface.averageR")}</small>
              <b className="stat-value">{fixed(summary.averageR, 2)}</b>
            </div>
          </div>
          <div className="grid-3 mt-12">
            <div className="card">
              <small className="muted-xs">{t("surface.totalPnl")}</small>
              <b className="stat-value">{fixed(summary.totalPnl, 2)}</b>
            </div>
            <div className="card">
              <small className="muted-xs">{t("surface.totalTrades")}</small>
              <b className="stat-value">{String(summary.tradeCount)}</b>
            </div>
            <div className="card">
              <small className="muted-xs">{t("surface.winsLosses")}</small>
              <b className="stat-value">{summary.wins} / {summary.losses}</b>
            </div>
          </div>

          <div className="card mt-16">
            <h3 className="label text-gold">{t("pages.performance.monthly.returns.and.risk.to.reward.metrics.e640980b", null, "Monthly returns")}</h3>
            {monthly.length === 0 ? (
              <p className="muted-sm mt-8">{t("surface.noData")}</p>
            ) : (
              <div className="grid-3 mt-12">
                {monthly.map((row) => (
                  <div key={row.label} className="card-alt">
                    <small className="muted-xs">{row.label}</small>
                    <b
                      className="stat-value"
                      style={{ color: row.net >= 0 ? "var(--green, #4CD39A)" : "var(--red, #f87171)" }}
                    >
                      {`${row.net >= 0 ? "+" : ""}${row.net.toFixed(2)}`}
                    </b>
                  </div>
                ))}
              </div>
            )}
            <p className="muted-xs mt-8">{t("surface.jalaliNote")}</p>
          </div>
        </>
      ) : null}
    </div>
  );
}
