/**
 * SEC-04 — the edge's protected-route contract.
 *
 * Legacy's HTML layer refused to hand a protected page to anyone without a live
 * server session (`locale-router.php`: `$protectedRoutes`, then a 302 to
 * `/{locale}/login/` + `no-store`). Modern does the same, but the answer has to
 * be asked of the API (the web tier holds no database credentials by contract).
 *
 * WHY A LIST AND NOT `!isPublic(...)`: a gate derived by subtraction silently
 * covers whatever the public contract forgot — a typo'd public path would turn
 * a page nobody meant to protect into a login wall, and a new page would be
 * gated or not by accident. An explicit list plus the drift test
 * (`protectedRoutes.test.ts`, which walks the real `(app)` route tree) makes
 * every page's class a decision somebody wrote down.
 *
 * Modern paths carry no trailing slash (ADR-009); the `(app)` group serves both
 * `/x` and `/en/x`, so every helper here normalizes the locale prefix first.
 */

/**
 * The 10 authenticated application routes (13 with the market/news/support
 * public surfaces excluded — those are class A/B in the frozen PUBLIC_ROUTES
 * contract and render no user data).
 *
 * Legacy protected 11 HTML routes; the delta is documented in
 * `docs/audits/2026-10-04-CAPABILITY-AUDIT-legacy-to-modern.md` §SEC-04:
 * Legacy's list includes markets + news, which Modern's frozen contract
 * (ADR-009 C-03 / `contracts/locale.ts`) declares public — an OWNER DECISION
 * flagged as R8, not a frontend change to make silently.
 */
export const PROTECTED_APP_ROUTES: readonly string[] = [
  "/accounts",
  "/admin",
  "/analytics",
  "/dashboard",
  "/intelligence",
  "/performance",
  "/profile",
  "/settings",
  "/trades",
  "/wallet",
];

/** Routes that additionally require a PANEL role (Legacy: admin | super_admin). */
export const PANEL_ROLES: readonly string[] = ["admin", "super_admin"];

/** `/en/dashboard/` → `/dashboard`; `/` stays `/`. */
export function barePath(pathname: string): string {
  const withoutLocale = pathname === "/en" || pathname.startsWith("/en/") ? pathname.slice(3) : pathname;
  const trimmed = withoutLocale.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function matchesRoute(bare: string, route: string): boolean {
  return bare === route || bare.startsWith(`${route}/`);
}

/** Does this HTML path require a live session? */
export function isProtectedAppPath(pathname: string): boolean {
  const bare = barePath(pathname);
  return PROTECTED_APP_ROUTES.some((route) => matchesRoute(bare, route));
}

/** Is this the admin shell (a second, stricter gate: panel role required)? */
export function isAdminAppPath(pathname: string): boolean {
  return matchesRoute(barePath(pathname), "/admin");
}

/** Where a refused visitor goes — Legacy's `/{locale}/login/`, in Modern's URLs. */
export function loginPathFor(pathname: string): string {
  return pathname === "/en" || pathname.startsWith("/en/") ? "/en/login" : "/login";
}

/** Where a signed-in non-panel visitor goes (Legacy: back to the user area). */
export function dashboardPathFor(pathname: string): string {
  return pathname === "/en" || pathname.startsWith("/en/") ? "/en/dashboard" : "/dashboard";
}
