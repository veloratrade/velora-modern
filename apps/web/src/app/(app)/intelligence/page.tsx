"use client";
/**
 * Intelligence — AC-32 (MG-FRONTEND-SURFACES + MG-I18N-COVERAGE).
 *
 * Legacy's page was a SIMULATED demo — its own catalog literally contains
 * `pages.intelligence.simulatedAnswer`, and the metrics (72% win rate, "best
 * strategy 15M order block") were hardcoded strings. Modern owns the REAL AI
 * capability: `/api/v1/ai/status` (provider configured? consent? feature
 * flags), `/api/v1/ai-coach/latest-insights` (stored insights — generation is
 * worker-gated, never faked, see aicoach/aiCoachRoutes.ts), and
 * `POST /api/v1/ai/weekly-report`. This page renders those honestly; Legacy's
 * copy (title, description, example questions) rides on top. No insight is
 * ever invented.
 */
import React, { useEffect, useState } from "react";
import { createTranslator } from "../../../i18n/catalog";
import { request } from "../../../lib/api/client";
import { getAiCoachInsights } from "../../../lib/api/resources";
import type { AiCoachInsightsView } from "../../../lib/api/resources";
import type { Locale } from "../../../contracts/locale";

function useLocale(): Locale {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/en") ? "en" : "fa";
}

interface AiStatusView {
  consent: { consented: boolean; consentedAt: string | null };
  providerConfigured: boolean;
  features: { feature: string; flag: string; enabled: boolean }[];
}

export default function IntelligencePage() {
  const locale = useLocale();
  const t = createTranslator(locale, ["common", "errors", "intelligence"]);
  const [status, setStatus] = useState<AiStatusView | null>(null);
  const [insights, setInsights] = useState<AiCoachInsightsView | null>(null);
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

  async function runWeeklyReport() {
    setBusy(true);
    setNotice("");
    try {
      const periodStart = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      await request("/api/v1/ai/weekly-report", {
        method: "POST",
        body: { period_start: periodStart },
      });
      setNotice(t("surface.weeklyDone"));
      const fresh = await getAiCoachInsights(10).catch(() => null);
      if (fresh) setInsights(fresh);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      setNotice(err.code ? `${err.code}: ${err.message ?? ""}` : err.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("common.velora.ai.9017596d", null, "VELORA AI")}</h1>
          <p className="page-sub">{t("pages.intelligence.automatic.trade.and.emotional.behaviour.analysis.with.a328e039", null, "Automatic trade and emotional behaviour analysis")}</p>
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
            {status.features
              .filter((f) => f.enabled)
              .map((f) => (
                <span key={f.feature} className="badge">{f.feature}</span>
              ))}
          </div>
          {!status.providerConfigured ? (
            <p className="muted-xs mt-8">{t("surface.providerOff")}</p>
          ) : null}
        </div>
      ) : null}

      <div className="card mt-16">
        <h3 className="label text-gold">{t("pages.intelligence.ask.your.trading.journal.a231c215", null, "Ask your trading journal")}</h3>
        <p className="muted-sm mt-8">{t("pages.intelligence.answers.cite.your.trades.and.rules.stored.3cb87d14", null, "Answers cite your trades and rules stored in the journal.")}</p>
        <div className="flex-gap-8 mt-12">
          <span className="badge">{t("pages.intelligence.what.is.my.best.setup.53d921df")}</span>
          <span className="badge">{t("pages.intelligence.what.is.my.repeated.mistake.2022448e")}</span>
          <span className="badge">{t("pages.intelligence.am.i.trading.emotionally.75585ef5")}</span>
        </div>
        <button type="button" className="btn-gold mt-12" disabled={busy} onClick={runWeeklyReport}>
          {busy ? "…" : t("surface.runWeekly")}
        </button>
        {notice ? <p className="muted-sm mt-8">{notice}</p> : null}
      </div>

      <div className="card mt-16">
        <h3 className="label text-gold">{t("surface.storedInsights")}</h3>
        {!insights || insights.insights.length === 0 ? (
          <p className="muted-sm mt-8">{t("surface.noInsights")}</p>
        ) : (
          <div className="mt-12">
            {insights.insights.map((i) => (
              <div key={i.id} className="card-alt mb-8">
                <small className="muted-xs v-latn-num">{i.created_at} · {i.feature}</small>
                <p className="mt-6">{i.insight}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
