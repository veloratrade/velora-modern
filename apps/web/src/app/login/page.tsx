import type { Metadata } from "next";
import { createTranslator } from "../../i18n/catalog";
import { LoginForm } from "../../features/auth/LoginForm";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator("fa", ["common", "errors", "auth"]);
  return {
    title: t("pages.login.login.velora.smart.trading.journal.01cdfd4d", null, "ورود | VELORA"),
    description: t("pages.login.login.to.access.your.trading.dashboard.32a261f6", null, "برای دسترسی به داشبورد معاملاتی خود وارد شوید"),
    alternates: {
      canonical: "https://veloratrade.ir/login",
      languages: { fa: "https://veloratrade.ir/login", en: "https://veloratrade.ir/en/login", "x-default": "https://veloratrade.ir/en/login" },
    },
  };
}

export default async function LoginPage() {
  return <LoginForm locale="fa" />;
}
