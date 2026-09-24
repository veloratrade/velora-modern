/*
 * Legacy landing href -> Modern URL (ADR-009 URL contract, Stage 1 §H.4).
 *
 * Legacy linked unprefixed paths and relied on cookie negotiation (plus the F-03
 * `data-velora-localized-href` rewrite for checkout). Modern public routes are
 * locale-explicit: "/" = fa, "/en/..." = en. Rules:
 *   - public routes with an en variant in PUBLIC_ROUTES get "/en" for en;
 *   - public routes that are fa-only in the contract (privacy, terms, support)
 *     keep the fa URL for both locales — CAPABILITY GAP recorded (no /en/ variant);
 *   - checkout follows owner decision D-14: /fa/checkout + /en/checkout;
 *   - app routes (dashboard, trades, ...) use the canonical no-trailing-slash form.
 * Hash links and mailto: are returned unchanged. Unknown paths are returned
 * unchanged (never invented).
 */
import { PUBLIC_ROUTES, type Locale } from "../../contracts";

const APP_ROUTES = new Set(["/dashboard", "/trades", "/intelligence", "/performance", "/accounts/connect", "/profile", "/wallet"]);

export function mapLegacyHref(locale: Locale, legacy: string): string {
  if (!legacy.startsWith("/")) return legacy;
  const q = legacy.indexOf("?");
  const pathPart = q === -1 ? legacy : legacy.slice(0, q);
  const query = q === -1 ? "" : legacy.slice(q);
  const bare = pathPart.length > 1 ? pathPart.replace(/\/+$/, "") : pathPart;

  if (bare === "/checkout") return `/${locale}/checkout${query}`;
  if (APP_ROUTES.has(bare)) return bare + query;

  if (bare === "/blog") return (locale === "en" ? "/en/blog/" : "/blog/") + query;
  const faRoute = PUBLIC_ROUTES.find((r) => r.locale === "fa" && r.path === bare);
  if (faRoute) {
    if (locale === "fa") return faRoute.path + query;
    const en = PUBLIC_ROUTES.find((r) => r.locale === "en" && r.path === `/en${bare}`);
    return (en ? en.path : faRoute.path) + query;
  }
  return legacy;
}
