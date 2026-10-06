"use client";
/**
 * Markets — AC-32 (MG-FRONTEND-SURFACES + MG-I18N-COVERAGE).
 *
 * Legacy's markets page had NO live feed — its prices and daily changes were
 * hardcoded demo values (verified @edede31: the page makes zero API calls).
 * The honest port renders the watchlist INSTRUMENTS and the snapshot cards with
 * Legacy's own words, never fabricating quotes. Wiring a real market-data
 * provider is a recorded owner decision (MG-I18N/market-data source), not a
 * guess. R8 (public vs protected) is also still the owner's call — the page
 * stays inside the session-gated (app) group.
 */
import React from "react";
import { createTranslator } from "../../../i18n/catalog";
import type { Locale } from "../../../contracts/locale";

function useLocale(): Locale {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/en") ? "en" : "fa";
}

/** Legacy's own watchlist instruments (markets chunk keys — no invented rows). */
const WATCHLIST = [
  "pages.markets.gold.us.dollar.b891c472",
  "pages.markets.euro.us.dollar.8a347568",
  "pages.markets.bitcoin.dollar.d01a70e1",
  "pages.markets.dow.jones.index.6f659eda",
] as const;

export default function MarketsPage() {
  const locale = useLocale();
  const t = createTranslator(locale, ["common", "errors", "markets"]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("common.markets.9f1cdf65", null, "Markets")}</h1>
          <p className="page-sub">{t("pages.markets.live.forex.and.crypto.watchlist.707e34a1", null, "Live forex and crypto watchlist")}</p>
        </div>
        <span className="badge badge-disconnected">{t("pages.markets.daily.changes.8e3bb240", null, "Daily changes")}</span>
      </div>

      <div className="grid-3 mt-16">
        <div className="card">
          <small className="muted-xs">{t("pages.markets.top.symbol.today.2bf63bd8", null, "Top symbol today")}</small>
          <b className="stat-value text-gold">{t("pages.markets.gold.us.dollar.b891c472")}</b>
        </div>
        <div className="card">
          <small className="muted-xs">{t("pages.markets.next.event.e4cec292", null, "Next event")}</small>
          <b className="stat-value">{t("pages.markets.us.cpi.16.00.433e4048")}</b>
        </div>
        <div className="card">
          <small className="muted-xs">{t("pages.markets.daily.changes.8e3bb240", null, "Daily changes")}</small>
          <b className="stat-value">{t("pages.markets.display.d201afbc")}</b>
        </div>
      </div>

      <div className="card mt-16">
        <h3 className="label text-gold">{t("pages.markets.live.forex.and.crypto.watchlist.707e34a1", null, "Watchlist")}</h3>
        <div className="flex-gap-8 mt-12">
          {WATCHLIST.map((key) => (
            <span key={key} className="badge">{t(key)}</span>
          ))}
        </div>
        <p className="muted-xs mt-12">{t("surface.snapshotNote")}</p>
      </div>
    </div>
  );
}
