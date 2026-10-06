import type { Metadata } from "next";
import { createTranslator } from "../../i18n/catalog";
import { CheckoutForm } from "./CheckoutForm";

/**
 * Checkout — AC-32. Public page (class C in the locale contract, like Legacy's
 * standalone /checkout). The plan summary and flow copy are Legacy's own words
 * (`checkout` chunk); the payment path is Modern's real, provider-gated
 * billing capability. See CheckoutForm for the honesty notes.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator("fa", ["common", "checkout"]);
  return {
    title: t("pages.checkout.p05.title", null, "تکمیل اشتراک حرفه‌ای | VELORA"),
    alternates: {
      canonical: "https://veloratrade.ir/checkout",
      languages: { fa: "https://veloratrade.ir/checkout", en: "https://veloratrade.ir/en/checkout", "x-default": "https://veloratrade.ir/en/checkout" },
    },
  };
}

export default function CheckoutPage() {
  return <CheckoutForm />;
}
