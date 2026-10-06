import type { Metadata } from "next";
import { createTranslator } from "../../../i18n/catalog";
import { TermsDocument } from "../../../features/legal/TermsDocument";

/** /en/terms — the English mirror (ADR-009). */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator("en", ["common", "terms"]);
  return {
    title: t("pages.terms.p05.title", null, "Terms | VELORA"),
    alternates: {
      canonical: "https://veloratrade.ir/en/terms",
      languages: { fa: "https://veloratrade.ir/terms", en: "https://veloratrade.ir/en/terms", "x-default": "https://veloratrade.ir/en/terms" },
    },
  };
}

export default function TermsPage() {
  return <TermsDocument locale="en" />;
}
