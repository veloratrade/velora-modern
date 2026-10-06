import type { Metadata } from "next";
import { createTranslator } from "../../i18n/catalog";
import { PrivacyDocument } from "../../features/legal/PrivacyDocument";

/** Privacy policy (fa canonical) — content from the ported `privacy` chunk. */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator("fa", ["common", "privacy"]);
  return {
    title: t("pages.privacy.p05.title", null, "حریم خصوصی | VELORA"),
    alternates: {
      canonical: "https://veloratrade.ir/privacy",
      languages: { fa: "https://veloratrade.ir/privacy", en: "https://veloratrade.ir/en/privacy", "x-default": "https://veloratrade.ir/en/privacy" },
    },
  };
}

export default function PrivacyPage() {
  return <PrivacyDocument locale="fa" />;
}
