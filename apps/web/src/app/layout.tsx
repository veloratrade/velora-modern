import type { Metadata } from "next";
import { headers } from "next/headers";
import type { Locale } from "../contracts";
import { htmlLang } from "../i18n/registry";
import { localeMeta } from "../i18n/registry";
import "../features/landing/styles/fonts.css";
import "../features/landing/styles/landing.css";
import "../features/auth/styles/auth.css";
import { SessionProvider } from "../lib/auth/session";

export const metadata: Metadata = {
  metadataBase: new URL("https://veloratrade.ir"),
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  // Proxy sets x-velora-locale for public routes; fallback to default fa.
  const raw = h.get("x-velora-locale") ?? h.get("X-VELORA-Locale") ?? "fa";
  const locale = (raw === "en" ? "en" : "fa") as Locale;
  const meta = localeMeta(locale);
  const nonce = h.get("x-nonce") ?? undefined;

  return (
    <html lang={htmlLang(locale)} dir={meta.direction} data-locale={locale} data-direction={meta.direction} data-numbering="latn" suppressHydrationWarning>
      <head>
        {/* Preconnect for self-hosted fonts is not needed; keep minimal */}
        {nonce ? <meta property="csp-nonce" content={nonce} /> : null}
      </head>
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
