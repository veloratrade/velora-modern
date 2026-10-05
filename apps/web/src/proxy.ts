import { NextRequest, NextResponse } from "next/server";
import { decide } from "./localeKernel";
import { CACHE_POLICY } from "./contracts/locale";
import {
  PANEL_ROLES,
  dashboardPathFor,
  isAdminAppPath,
  isProtectedAppPath,
  loginPathFor,
} from "./lib/auth/protectedRoutes";

/**
 * Web proxy — ADR-009 URL contract + ADR-009 §5 CSP + security headers.
 * Runs on every page request (matcher below skips static assets).
 *
 * 1) Locale routing via localeKernel.decide(pathname):
 *    - "/en" → 308 "/en/"
 *    - public routes ("/", "/en/", "/register", ...) → set X-VELORA-Locale + Cache-Control
 *    - app routes / api → passthrough
 * 2) Per-request nonce for CSP (strict, no unsafe-inline in prod):
 *    - generates random base64 nonce, sets request header `x-nonce` so Next
 *      injects it into its inline RSC scripts/styles.
 *    - sets response CSP header `Content-Security-Policy` with that nonce.
 *    - makes the page dynamic (proxy always runs → dynamic).
 * 3) Security headers (parity with API kernel + Legacy .htaccess):
 *    X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
 *    Permissions-Policy, Cross-Origin-Opener-Policy, HSTS, Vary.
 * 4) SEC-04 edge authorisation (parity with Legacy locale-router.php):
 *    a protected HTML route is NOT served until the API confirms a live session
 *    for the presented refresh cookie, and /admin additionally requires a panel
 *    role. Refusals are 302 + no-store; an unavailable answer fails closed.
 */

/** Same default the Next rewrite uses for /api (next.config.ts). */
const API_ORIGIN = process.env.VELORA_API_ORIGIN ?? "http://127.0.0.1:8080";
/** A page render must not wait on a hung probe; expiry fails closed. */
const SESSION_PROBE_TIMEOUT_MS = 1500;

/**
 * Ask the API whether this request carries a live session.
 *
 * Deliberately NOT POST /auth/refresh: the probe must not rotate (read-only),
 * and it must not spend the 30/300 refresh budget on page views. See
 * kernel/server.ts GET /api/v1/auth/session for the API side of the contract.
 */
async function probeSession(
  request: NextRequest,
): Promise<{ ok: true; authenticated: boolean; role: string | null } | { ok: false }> {
  const cookie = request.headers.get("cookie");
  try {
    const res = await fetch(`${API_ORIGIN}/api/v1/auth/session`, {
      method: "GET",
      headers: cookie === null ? {} : { cookie },
      cache: "no-store",
      signal: AbortSignal.timeout(SESSION_PROBE_TIMEOUT_MS),
    });
    if (res.status !== 200) return { ok: false };
    const payload: unknown = await res.json();
    const data = (payload as { data?: unknown }).data;
    if (data === null || typeof data !== "object") return { ok: false };
    const { authenticated, role } = data as { authenticated?: unknown; role?: unknown };
    if (typeof authenticated !== "boolean") return { ok: false };
    return { ok: true, authenticated, role: typeof role === "string" ? role : null };
  } catch {
    // Unreachable / timed out / not JSON: fail closed — never serve protected
    // HTML on an unanswered check (Legacy: `$sessionIsValid = false`).
    return { ok: false };
  }
}

type GateVerdict =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly location: string; readonly reason: string };

/** SEC-04: the two fail-closed gates, in Legacy's order (session, then role). */
async function gateProtectedRoute(request: NextRequest, pathname: string): Promise<GateVerdict> {
  const probe = await probeSession(request);
  if (!probe.ok) {
    return { kind: "deny", location: loginPathFor(pathname), reason: "gate-unavailable" };
  }
  if (!probe.authenticated) {
    return { kind: "deny", location: loginPathFor(pathname), reason: "unauthenticated" };
  }
  if (isAdminAppPath(pathname) && (probe.role === null || !PANEL_ROLES.includes(probe.role))) {
    // Legacy: "the Admin shell must never be delivered to a signed-in
    // non-admin, regardless of client-side guards."
    return { kind: "deny", location: dashboardPathFor(pathname), reason: "not-panel" };
  }
  return { kind: "allow" };
}

/** The refusal page: Legacy's 302 + no-store, in Modern's URL contract. */
function denial(request: NextRequest, location: string, reason: string): NextResponse {
  const res = NextResponse.redirect(new URL(location, request.url), 302);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Strict-Transport-Security", "max-age=31536000");
  res.headers.set("X-Velora-Edge-Gate", reason);
  return res;
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  const decision = decide(pathname);

  // ---- 1) Redirect normalization ----
  if (decision.kind === "redirect") {
    // Build absolute URL via WHATWG URL (not NextURL) to preserve trailing slash.
    const dest = new URL(decision.location, request.url).toString();
    const res = NextResponse.redirect(dest, decision.status);
    // Security headers even on redirect.
    res.headers.set("X-Content-Type-Options", "nosniff");
    res.headers.set("X-Frame-Options", "DENY");
    res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    return res;
  }

  // ---- SEC-04: edge authorisation for protected HTML ----
  const protectedRoute = decision.kind !== "route" && isProtectedAppPath(pathname);
  if (protectedRoute) {
    const verdict = await gateProtectedRoute(request, pathname);
    if (verdict.kind === "deny") return denial(request, verdict.location, verdict.reason);
  }

  // Generate nonce for this request (Node crypto is available in proxy runtime).
  // S2 (audit §10.2): FAIL CLOSED. A CSP nonce is a security token — if a
  // cryptographically random value cannot be produced, we do NOT fall back to
  // Math.random() (predictable → nonce-guessing bypass). The request is
  // refused with 503 instead of being served under a forgeable policy.
  let nonce: string;
  try {
    const uuid = crypto.randomUUID();
    nonce = typeof Buffer !== "undefined" ? Buffer.from(uuid).toString("base64") : btoa(uuid);
  } catch {
    return new NextResponse("Service temporarily unavailable.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "30" },
    });
  }

  const isDev = process.env.NODE_ENV === "development";

  // ADR-009 §5: strict CSP, no unsafe-inline in prod. Next will add nonce to its
  // own inline scripts/styles automatically when it sees x-nonce in the request.
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-inline'" : ""}`,
    "img-src 'self' data: https:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Expose decided locale to the app via request header (so layout can set html lang/dir without re-parsing).
  if (decision.kind === "route") {
    requestHeaders.set(decision.localeHeader.name, decision.localeHeader.value);
    requestHeaders.set("x-velora-locale", decision.localeHeader.value);
    requestHeaders.set("x-velora-cache", decision.cacheControl);
  } else {
    // Authenticated app routes are passthrough for cache/contract purposes, but
    // the URL still owns the locale (ADR-009): /en/* → en, everything else → fa.
    // Without this, /en/dashboard would SSR html lang="fa" (root layout fallback).
    const appLocale = pathname === "/en" || pathname.startsWith("/en/") ? "en" : "fa";
    requestHeaders.set("x-velora-locale", appLocale);
  }

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  // ---- 2) CSP + nonce propagation ----
  response.headers.set("Content-Security-Policy", csp);
  // Next's automatic nonce handling also checks x-nonce on the response? Set both.
  response.headers.set("x-nonce", nonce);

  // ---- 3) Locale + cache headers for public routes ----
  if (decision.kind === "route") {
    response.headers.set(decision.localeHeader.name, decision.localeHeader.value);
    response.headers.set("Cache-Control", decision.cacheControl);
    // Legacy locale-router also set Content-Language and Vary.
    response.headers.set("Content-Language", decision.locale);
    response.headers.set("Vary", "Cookie, Accept-Language");
  } else {
    // App routes are private, no-store (security).
    // Don't override if the page itself sets cache; but ensure no accidental public cache.
    response.headers.set("Vary", "Cookie, Accept-Language");
    if (protectedRoute) {
      // ADR-009 §4: route class D ("authenticated: no-store") — now actually
      // applied. Legacy's equivalent was `.htaccess`'s
      // `Cache-Control "private, max-age=0, must-revalidate"` on HTML plus
      // no-store on the protected gate; class D is the stricter Modern contract,
      // and it is what keeps a signed-out dashboard shell out of bfcache.
      response.headers.set("Cache-Control", CACHE_POLICY.D);
    }
  }

  // ---- 4) Security headers (always) ----
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  // SEC-04: Legacy set HSTS from the web root's .htaccess, i.e. at exactly this
  // layer — the HTML entry point. The value is Legacy's own
  // (`max-age=31536000`, no includeSubDomains/preload). Browsers ignore it over
  // plain HTTP, so it can only ever affect a TLS deployment.
  response.headers.set("Strict-Transport-Security", "max-age=31536000");

  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
