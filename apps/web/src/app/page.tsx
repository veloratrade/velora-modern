import type { Metadata } from "next";
import { createLandingI18n } from "../features/landing/landingI18n";
import { LandingPage } from "../features/landing/LandingPage";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const l = createLandingI18n("fa");
  const t = l.raw;
  return {
    title: t("common.velora.ai.trading.journal.for.forex.crypto.4da0de5c"),
    description: t("pages.landing.velora.is.an.ai.powered.trading.journal.98d2d555"),
    alternates: {
      canonical: "https://veloratrade.ir/fa/",
      languages: {
        fa: "https://veloratrade.ir/fa/",
        en: "https://veloratrade.ir/en/",
        "x-default": "https://veloratrade.ir/en/",
      },
    },
    openGraph: {
      title: t("pages.landing.velora.ai.trading.journal.for.forex.crypto.583d55b4"),
      description: t("pages.landing.record.and.analyze.trades.manage.risk.review.d135a331"),
      url: "https://veloratrade.ir/fa/",
      type: "website",
      locale: t("pages.landing.seo.og_locale"),
    },
    twitter: {
      card: "summary",
      title: t("pages.landing.velora.ai.trading.journal.fa5b8df9"),
      description: t("pages.landing.ai.powered.trading.journal.for.recording.analyzing.ec688e05"),
    },
    other: {
      "content-language": "fa",
    },
  };
}

export default function Page() {
  const l = createLandingI18n("fa");
  return <LandingPage locale="fa" l={l} />;
}
