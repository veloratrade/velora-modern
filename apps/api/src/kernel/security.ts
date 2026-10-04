// Security middleware primitives — ADR-005 (origin guard), ADR-009 (CSP nonce).
import { randomBytes, randomUUID } from "node:crypto";

export interface SecurityContext {
  requestId: string;
  nonce: string;
}

export function newSecurityContext(): SecurityContext {
  return { requestId: randomUUID(), nonce: randomBytes(16).toString("base64") };
}

/** Strict CSP with per-request nonce (ADR-009 §5) — no unsafe-inline, ever. */
export function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self'",
    "img-src 'self' data: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // SEC-04. Legacy sets this on every response from the web root's .htaccess
  // (`Header always set Strict-Transport-Security "max-age=31536000"`), so the
  // API now emits Legacy's exact value instead of deferring it to ops. Plain
  // HTTP clients ignore it, which is correct: it exists for the TLS deployment.
  // `includeSubDomains` and `preload` are deliberately NOT added — Legacy does
  // not set them, and both are commitments stronger than the app can make.
  "Strict-Transport-Security": "max-age=31536000",
};

/**
 * Same-origin guard for state-changing routes — parity with the verified PHP
 * behavior (forged Origin → 403; live-proven on the logout endpoint).
 */
export function originAllowed(originHeader: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (originHeader === undefined) return true; // non-browser client — auth handles identity
  return allowedOrigins.includes(originHeader);
}
