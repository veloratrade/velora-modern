import type { Metadata } from "next";
import { createTranslator } from "../../i18n/catalog";
import { TermsDocument } from "../../features/legal/TermsDocument";

/** Terms of service (fa canonical) — content from the ported `terms` chunk. */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator("fa", ["common", "terms"]);
  return {
    title: t("pages.terms.p05.title", null, "قوانین و مقررات | VELORA"),
    alternates: {
      canonical: "https://veloratrade.ir/terms",
      languages: { fa: "https://veloratrade.ir/terms", en: "https://veloratrade.ir/en/terms", "x-default": "https://veloratrade.ir/en/terms" },
    },
  };
}

export default function TermsPage() {
  return <TermsDocument locale="fa" />;
}
