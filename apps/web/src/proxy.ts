import { NextRequest, NextResponse } from "next/server";
import { decide } from "./localeKernel";

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
 *    Permissions-Policy, Cross-Origin-Opener-Policy, Vary.
 */

export function proxy(request: NextRequest) {
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

  // Generate nonce for this request (Node crypto is available in proxy runtime).
  let nonce: string;
  try {
    const uuid = crypto.randomUUID();
    nonce = typeof Buffer !== "undefined" ? Buffer.from(uuid).toString("base64") : btoa(uuid);
  } catch {
    nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
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
    // For passthrough, still set a locale hint from cookie/accept? For now leave absent;
    // app routes will resolve via user.locale / cookie / Accept-Language on the client.
    // Set Vary so caches know locale matters.
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
  }

  // ---- 4) Security headers (always) ----
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  // HSTS is at the proxy (ops), not here (no TLS termination knowledge).

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
