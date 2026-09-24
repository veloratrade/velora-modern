import type { Metadata } from "next";
import { createTranslator } from "../../../i18n/catalog";
import { RegisterForm } from "../../../features/auth/RegisterForm";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator("en", ["common", "errors", "auth"]);
  return {
    title: t("pages.register.sign.up.velora.smart.trading.journal.85a0118f", null, "Sign Up | VELORA"),
    description: t("pages.register.start.recording.analysing.and.improving.your.trades.1b6aad36", null, "Start recording, analysing and improving your trades today"),
    alternates: {
      canonical: "https://veloratrade.ir/en/register",
      languages: { fa: "https://veloratrade.ir/register", en: "https://veloratrade.ir/en/register", "x-default": "https://veloratrade.ir/en/register" },
    },
    openGraph: { locale: "en_GB", url: "https://veloratrade.ir/en/register" },
  };
}

export default async function RegisterPageEn() {
  return <RegisterForm locale="en" />;
}
