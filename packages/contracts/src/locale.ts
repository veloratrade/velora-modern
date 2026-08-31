// Locale & public URL contract — ADR-009 (Accepted, D-14).
// Frozen URL contract: "/" = fa default, "/en/" prefix for English,
// checkout = "/fa/checkout" + "/en/checkout" (owner decision).
// X-VELORA-Locale header preserved (external contract C-02).
export const LOCALE_HEADER = "X-VELORA-Locale" as const;
export type Locale = "fa" | "en";

export type RouteClass = "A" /* market: short cache */ | "B" /* editorial: long + invalidate */ | "C" /* static public */ | "D" /* authenticated: no-store */;

export interface PublicRoute {
  path: string; // URL contract path
  locale: Locale;
  routeClass: Exclude<RouteClass, "D">;
}

// The public route map is CONTRACT DATA. Adding/removing rows is a contract
// change requiring owner review (ADR-006 frozen tier, C-03).
export const PUBLIC_ROUTES: readonly PublicRoute[] = [
  { path: "/", locale: "fa", routeClass: "C" },
  { path: "/en/", locale: "en", routeClass: "C" },
  { path: "/fa/checkout", locale: "fa", routeClass: "C" },
  { path: "/en/checkout", locale: "en", routeClass: "C" },
  { path: "/register", locale: "fa", routeClass: "C" },
  { path: "/en/register", locale: "en", routeClass: "C" },
  { path: "/login", locale: "fa", routeClass: "C" },
  { path: "/en/login", locale: "en", routeClass: "C" },
  { path: "/forgot-password", locale: "fa", routeClass: "C" },
  { path: "/en/forgot-password", locale: "en", routeClass: "C" },
  { path: "/verify-email", locale: "fa", routeClass: "C" },
  { path: "/reset-password", locale: "fa", routeClass: "C" },
  { path: "/privacy", locale: "fa", routeClass: "C" },
  { path: "/terms", locale: "fa", routeClass: "C" },
  { path: "/support", locale: "fa", routeClass: "C" },
  { path: "/markets", locale: "fa", routeClass: "A" },
  { path: "/en/markets", locale: "en", routeClass: "A" },
  { path: "/news", locale: "fa", routeClass: "B" },
  { path: "/blog/", locale: "fa", routeClass: "B" },
  { path: "/en/blog/", locale: "en", routeClass: "B" },
];

export function resolvePublicRoute(pathname: string): PublicRoute | undefined {
  // exact match first
  const exact = PUBLIC_ROUTES.find((r) => r.path === pathname);
  if (exact) return exact;
  // blog/news article prefixes (class B)
  if (pathname.startsWith("/blog/") || pathname.startsWith("/en/blog/") || pathname.startsWith("/news/")) {
    const locale: Locale = pathname.startsWith("/en/") ? "en" : "fa";
    return { path: pathname, locale, routeClass: "B" };
  }
  return undefined;
}

export function localeOf(pathname: string): Locale | undefined {
  return resolvePublicRoute(pathname)?.locale;
}

// Cache-Control per route class (ADR-009 §4 — market ≠ editorial ≠ static).
export const CACHE_POLICY: Record<RouteClass, string> = {
  A: "public, s-maxage=120, stale-while-revalidate=300",
  B: "public, s-maxage=3600, stale-while-revalidate=86400",
  C: "public, max-age=86400",
  D: "private, no-store",
};
