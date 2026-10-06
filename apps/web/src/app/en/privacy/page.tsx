import type { Metadata } from "next";
import { createTranslator } from "../../../i18n/catalog";
import { PrivacyDocument } from "../../../features/legal/PrivacyDocument";

/** /en/privacy — the English mirror (ADR-009). */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator("en", ["common", "privacy"]);
  return {
    title: t("pages.privacy.p05.title", null, "Privacy | VELORA"),
    alternates: {
      canonical: "https://veloratrade.ir/en/privacy",
      languages: { fa: "https://veloratrade.ir/privacy", en: "https://veloratrade.ir/en/privacy", "x-default": "https://veloratrade.ir/en/privacy" },
    },
  };
}

export default function PrivacyPage() {
  return <PrivacyDocument locale="en" />;
}
