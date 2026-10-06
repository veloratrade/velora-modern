import type { Metadata } from "next";
import { createTranslator } from "../../../i18n/catalog";
import { CheckoutForm } from "../../checkout/CheckoutForm";

/** /en/checkout — the English mirror (ADR-009 URL contract). */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator("en", ["common", "checkout"]);
  return {
    title: t("pages.checkout.p05.title", null, "Complete the Pro subscription | VELORA"),
    alternates: {
      canonical: "https://veloratrade.ir/en/checkout",
      languages: { fa: "https://veloratrade.ir/checkout", en: "https://veloratrade.ir/en/checkout", "x-default": "https://veloratrade.ir/en/checkout" },
    },
  };
}

export default function CheckoutPage() {
  return <CheckoutForm />;
}
