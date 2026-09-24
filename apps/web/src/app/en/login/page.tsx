import type { Metadata } from "next";
import { createTranslator } from "../../../i18n/catalog";
import { LoginForm } from "../../../features/auth/LoginForm";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator("en", ["common", "errors", "auth"]);
  return {
    title: t("pages.login.login.velora.smart.trading.journal.01cdfd4d", null, "Login | VELORA"),
    description: t("pages.login.login.to.access.your.trading.dashboard.32a261f6", null, "Login to access your trading dashboard"),
    alternates: {
      canonical: "https://veloratrade.ir/en/login",
      languages: { fa: "https://veloratrade.ir/login", en: "https://veloratrade.ir/en/login", "x-default": "https://veloratrade.ir/en/login" },
    },
    openGraph: { locale: "en_GB", url: "https://veloratrade.ir/en/login" },
  };
}

export default async function LoginPageEn() {
  return <LoginForm locale="en" />;
}
