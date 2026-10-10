"use client";
/**
 * Intelligence — AC-32 (MG-FRONTEND-SURFACES + MG-I18N-COVERAGE).
 *
 * Legacy's page was a SIMULATED demo: its answer and metrics (72% win rate,
 * "best strategy 15M order block") were hardcoded strings. Modern owns real AI
 * capabilities and renders only returned data. The real weekly-report route
 * requires server-resolved, caller-owned trade IDs; this page obtains the
 * selected UTC-week trades from the authenticated journal and renders the
 * report response rather than claiming it appears in the separate coach log.
 */
import React, { useEffect, useState } from "react";
import { createTranslator } from "../../../i18n/catalog";
import { request } from "../../../lib/api/client";
import { getAiCoachInsights, listTrades } from "../../../lib/api/resources";
import type { AiCoachInsightsView } from "../../../lib/api/resources";
import type { Locale } from "../../../contracts/locale";

function useLocale(): Locale {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/en") ? "en" : "fa";
}

interface AiStatusView {
  consent: { consented: boolean; consentedAt: string | null };
  providerConfigured: boolean;
  features: { feature: string; flag: string; enabled: boolean; providerConfigured: boolean; available: boolean }[];
}

interface WeeklyReportResponse {
  report: Record<string, unknown>;
  period_start: string;
  period_end: string;
  locale: string;
  tradesAnalyzed: number;
  provider: string;
  model: string;
  confidence: number | null;
  latency_ms: number;
  attempt_id: string;
}

interface GeneratedReport {
  response: WeeklyReportResponse;
  omittedTrades: number;
}

const REPORT_SECTIONS = [
  ["summary", "surface.reportSummary"],
  ["strengths", "surface.reportStrengths"],
  ["mistakes", "surface.reportMistakes"],
  ["weaknesses", "surface.reportWeaknesses"],
  ["risk_behavior", "surface.reportRiskBehavior"],
  ["suggestions", "surface.reportSuggestions"],
  ["recommendations", "surface.reportRecommendations"],
] as const;

function displayStrings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() === "" ? [] : [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

export default function IntelligencePage() {
  const locale = useLocale();
  const t = createTranslator(locale, ["common", "errors", "intelligence"]);
  const [status, setStatus] = useState<AiStatusView | null>(null);
  const [insights, setInsights] = useState<AiCoachInsightsView | null>(null);
  const [weeklyReport, setWeeklyReport] = useState<GeneratedReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [s, i] = await Promise.all([
          request<AiStatusView>("/api/v1/ai/status"),
          getAiCoachInsights(10).catch(() => null),
        ]);
        if (cancelled) return;
        setStatus(s);
        setInsights(i);
      } catch (e) {
        const err = e as { message?: string };
        if (!cancelled) setError(err.message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const weeklyFeature = status?.features.find((feature) => feature.feature === "weekly_report");
  const canGenerateWeeklyReport = status?.consent.consented === true && weeklyFeature?.available === true;
  const reportSections = weeklyReport === null ? [] : REPORT_SECTIONS
    .map(([field, label]) => ({ field, label, values: displayStrings(weeklyReport.response.report[field]) }))
    .filter((section) => section.values.length > 0);

  async function runWeeklyReport() {
    setBusy(true);
    setNotice("");
    setError("");
    setWeeklyReport(null);
    try {
      // The service needs explicit owned IDs. Select the 200 latest closed trades
      // in the last seven UTC calendar days; 200 is the route's hard bound.
      const now = new Date();
      const periodEnd = now.toISOString().slice(0, 10);
      const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6))
        .toISOString().slice(0, 10);
      const rows = await listTrades({
        page: "1",
        limit: "200",
        from: `${periodStart}T00:00:00.000Z`,
        to: `${periodEnd}T23:59:59.999Z`,
        order: "close_time",
      });
      const tradeIds = rows.items.map((trade) => trade.id);
      if (tradeIds.length === 0) {
        setNotice(t("surface.noTrades"));
        return;
      }

      const response = await request<WeeklyReportResponse>("/api/v1/ai/weekly-report", {
        method: "POST",
        body: { trade_ids: tradeIds, period_start: periodStart, period_end: periodEnd },
      });
      setWeeklyReport({ response, omittedTrades: Math.max(0, rows.pagination.total - tradeIds.length) });
      setNotice(t("surface.weeklyDone"));
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === "CONSENT_REQUIRED") setNotice(t("surface.consentNeeded"));
      else if (err.code === "FEATURE_DISABLED") setNotice(t("surface.featureDisabled"));
      else if (err.code === "NO_OWNED_TRADES" || err.code === "AI_NO_OWNED_TRADES") setNotice(t("surface.noTrades"));
      else if (err.code === "PROVIDER_NOT_CONFIGURED" || err.code === "NO_PROVIDER_AVAILABLE") setNotice(t("surface.providerOff"));
      else setNotice(err.code ? `${err.code}: ${err.message ?? ""}` : err.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("common.velora.ai.9017596d", null, "VELORA AI")}</h1>
          <p className="page-sub">{t("pages.intelligence.automatic.trade.and.emotional.behaviour.analysis.with.a328e039", null, "Automatic trade and emotional-behaviour analysis")}</p>
        </div>
        <span className={`badge ${status?.providerConfigured ? "badge-connected" : "badge-disconnected"}`}>
          {status?.providerConfigured ? t("surface.providerOn") : t("surface.providerOff")}
        </span>
      </div>

      {loading ? <div className="card"><p className="muted-sm">…</p></div> : null}
      {error ? <div className="card"><p className="muted-sm">{error}</p></div> : null}

      {status ? (
        <div className="card mt-16">
          <h3 className="label text-gold">{t("surface.aiStatus")}</h3>
          <div className="flex-gap-8 mt-12">
            <span className={`badge ${status.consent.consented ? "badge-connected" : "badge-disconnected"}`}>
              {status.consent.consented ? t("surface.consentGranted") : t("surface.consentNeeded")}
            </span>
            {status.features.map((feature) => (
              <span key={feature.feature} className={`badge ${feature.available ? "badge-connected" : "badge-disconnected"}`}>
                {feature.feature} · {feature.available ? t("surface.featureReady") : feature.enabled ? t("surface.featureProviderMissing") : t("surface.featureDisabled")}
              </span>
            ))}
          </div>
          {!status.providerConfigured ? <p className="muted-xs mt-8">{t("surface.providerOff")}</p> : null}
        </div>
      ) : null}

      <div className="card mt-16">
        <h3 className="label text-gold">{t("surface.journalReports")}</h3>
        <p className="muted-sm mt-8">{t("surface.reportScope")}</p>
        <button
          type="button"
          className="btn-gold mt-12"
          disabled={busy || loading || !canGenerateWeeklyReport}
          onClick={() => void runWeeklyReport()}
        >
          {busy ? "…" : t("surface.runWeekly")}
        </button>
        {notice ? <p className="muted-sm mt-8" role="status">{notice}</p> : null}

        {weeklyReport ? (
          <div className="card-alt mt-12" aria-live="polite">
            <p className="muted-xs">
              {t("surface.reportMeta", {
                from: weeklyReport.response.period_start,
                to: weeklyReport.response.period_end,
                count: weeklyReport.response.tradesAnalyzed,
                provider: weeklyReport.response.provider,
              })}
            </p>
            {weeklyReport.omittedTrades > 0 ? (
              <p className="muted-xs mt-6">{t("surface.reportTruncated", { count: weeklyReport.omittedTrades })}</p>
            ) : null}
            {reportSections.length === 0 ? <p className="muted-sm mt-12">{t("surface.reportNoFields")}</p> : null}
            {reportSections.map(({ field, label, values }) => (
              <section key={field} className="mt-12">
                <h4 className="label">{t(label)}</h4>
                {field === "summary" || field === "risk_behavior" ? (
                  <p className="muted-sm mt-6">{values.join(" · ")}</p>
                ) : (
                  <ul className="muted-sm mt-6">
                    {values.map((value, index) => <li key={`${field}-${index}`}>{value}</li>)}
                  </ul>
                )}
              </section>
            ))}
          </div>
        ) : null}
      </div>

      <div className="card mt-16">
        <h3 className="label text-gold">{t("surface.storedInsights")}</h3>
        {!insights || insights.insights.length === 0 ? (
          <p className="muted-sm mt-8">{t("surface.noInsights")}</p>
        ) : (
          <div className="mt-12">
            {insights.insights.map((insight) => (
              <div key={insight.id} className="card-alt mb-8">
                <small className="muted-xs v-latn-num">{insight.created_at} · {insight.feature}</small>
                <p className="mt-6">{insight.insight}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
