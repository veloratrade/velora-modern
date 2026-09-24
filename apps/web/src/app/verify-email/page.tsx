import type { Metadata } from "next";
import { createTranslator } from "../../i18n/catalog";
import { VerifyEmail } from "../../features/auth/VerifyEmail";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator("fa", ["common", "errors", "auth"]);
  return {
    title: t("pages.verify_email.email.verification.velora.c0ee3088", null, "تأیید ایمیل | VELORA"),
    alternates: { canonical: "https://veloratrade.ir/verify-email", languages: { fa: "https://veloratrade.ir/verify-email", en: "https://veloratrade.ir/en/verify-email" } },
  };
}

export default async function Page() {
  return <VerifyEmail locale="fa" />;
}
