import type { Metadata } from "next";
import { createTranslator } from "../../i18n/catalog";
import { ForgotPassword } from "../../features/auth/ForgotPassword";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator("fa", ["common", "errors", "auth"]);
  return { title: t("pages.forgot_password.forgot.password.velora.d0f6f0ca", null, "فراموشی رمز | VELORA"), alternates: { canonical: "https://veloratrade.ir/forgot-password" } };
}
export default async function Page() {
  return <ForgotPassword locale="fa" />;
}
