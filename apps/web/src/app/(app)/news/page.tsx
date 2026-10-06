"use client";
/**
 * News — AC-32 (MG-FRONTEND-SURFACES + MG-I18N-COVERAGE).
 *
 * Legacy's news page was a STATIC editorial snapshot (four hardcoded cards +
 * three sidebar items — zero API calls @edede31). Modern renders the same
 * editorial content from the ported `news` chunk — Legacy's own words — until
 * a real news ingestion source is an owner decision. Nothing on this page is
 * presented as live data.
 */
import React from "react";
import { createTranslator } from "../../../i18n/catalog";
import type { Locale } from "../../../contracts/locale";

function useLocale(): Locale {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/en") ? "en" : "fa";
}

/** Legacy's four cards: (time·source, teaser) pairs, in page order. */
const CARDS: readonly [string, string][] = [
  ["pages.news.30m.ago.bloomberg.7ef42f29", "pages.news.us.cpi.inflation.data.came.in.below.03cb6e0b"],
  ["pages.news.2h.ago.reuters.45c2af51", "pages.news.annual.inflation.reached.3.2.raising.the.63336563"],
  ["pages.news.4h.ago.coindesk.907091e0", "pages.news.bitcoin.reclaimed.62k.channel.b7adea1e"],
  ["pages.news.2h.ago.reuters.45c2af51", "pages.news.gold.approached.a.new.all.time.high.18dddc59"],
];

/** Legacy's sidebar: three high-risk event labels. */
const SIDEBAR = [
  "pages.news.us.interest.rate.0d47e91b",
  "pages.news.dollar.index.dxy.a70e9ab8",
  "pages.news.3.key.events.b5ebaa7f",
] as const;

export default function NewsPage() {
  const locale = useLocale();
  const t = createTranslator(locale, ["common", "errors", "news"]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("common.news.bba91630", null, "News")}</h1>
          <p className="page-sub">{t("pages.news.latest.forex.and.crypto.news.live.news.d3dad383", null, "Latest forex and crypto news")}</p>
        </div>
        <span className="badge badge-disconnected">{t("pages.news.today.s.important.news.88663162", null, "Today's important news")}</span>
      </div>

      <div className="grid-2 mt-16">
        {CARDS.map(([when, teaser], i) => (
          <div key={`${when}-${i}`} className="card">
            <small className="muted-xs">{t(when)}</small>
            <p className="mt-8">{t(teaser)}</p>
          </div>
        ))}
      </div>

      <div className="card mt-16">
        <h3 className="label text-gold">{t("pages.news.high.risk.events.0b69975c", null, "High-risk events")}</h3>
        <div className="flex-gap-8 mt-12">
          {SIDEBAR.map((key) => (
            <span key={key} className="badge">{t(key)}</span>
          ))}
        </div>
        <p className="muted-xs mt-12">{t("pages.news.higher.demand.for.safe.haven.assets.and.b242598a")}</p>
      </div>
    </div>
  );
}
