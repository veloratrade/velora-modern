import type { Metadata } from "next";
import { createTranslator } from "../../i18n/catalog";
import { ResetPassword } from "../../features/auth/ResetPassword";
export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator("fa", ["common", "errors", "auth"]);
  return { title: t("pages.reset_password.reset.password.velora.73c390ce", null, "بازنشانی رمز | VELORA"), alternates: { canonical: "https://veloratrade.ir/reset-password" } };
}
export default async function Page() {
  return <ResetPassword locale="fa" />;
}
