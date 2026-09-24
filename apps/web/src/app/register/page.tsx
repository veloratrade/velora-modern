import type { Metadata } from "next";
import { createTranslator } from "../../i18n/catalog";
import { RegisterForm } from "../../features/auth/RegisterForm";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator("fa", ["common", "errors", "auth"]);
  return {
    title: t("pages.register.sign.up.velora.smart.trading.journal.85a0118f", null, "ثبت‌نام | VELORA"),
    description: t("pages.register.start.recording.analysing.and.improving.your.trades.1b6aad36", null, "از همین امروز معاملات خود را ثبت، تحلیل و بهینه کنید"),
    alternates: {
      canonical: "https://veloratrade.ir/register",
      languages: { fa: "https://veloratrade.ir/register", en: "https://veloratrade.ir/en/register", "x-default": "https://veloratrade.ir/en/register" },
    },
  };
}

export default async function RegisterPage() {
  return <RegisterForm locale="fa" />;
}
