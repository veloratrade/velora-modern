// Locale routing kernel — ADR-009 (Accepted, D-14).
// Pure logic shared by the API (contract-tested) and, at Phase 2 framework
// install, the Next.js middleware (the adapter will be a thin wrapper around
// this kernel — framework wiring deliberately deferred, see ADR-011).
import { resolvePublicRoute, CACHE_POLICY, LOCALE_HEADER, type Locale } from "./contracts";

/** Normalization redirects — no silent alternative URL structures (D-14). */
export const LOCALE_REDIRECTS: Readonly<Record<string, string>> = {
  "/en": "/en/", // bare /en normalizes to the English home contract URL
};

export interface LocaleDecision {
  kind: "route";
  locale: Locale;
  cacheControl: string;
  localeHeader: { name: typeof LOCALE_HEADER; value: Locale };
}

export interface RedirectDecision {
  kind: "redirect";
  location: string;
  status: 308;
}

export interface PassThroughDecision {
  kind: "passthrough"; // authenticated app routes, API, assets — not public-route business
}

export type Decision = LocaleDecision | RedirectDecision | PassThroughDecision;

export function decide(pathname: string): Decision {
  const redirect = LOCALE_REDIRECTS[pathname];
  if (redirect) return { kind: "redirect", location: redirect, status: 308 };

  const pub = resolvePublicRoute(pathname);
  if (pub) {
    return {
      kind: "route",
      locale: pub.locale,
      cacheControl: CACHE_POLICY[pub.routeClass],
      localeHeader: { name: LOCALE_HEADER, value: pub.locale },
    };
  }
  return { kind: "passthrough" };
}
