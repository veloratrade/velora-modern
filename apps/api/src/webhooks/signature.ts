// Webhook signature + freshness primitives (ADR-008 / D-05).
//
// CONCEPTUAL MIGRATION NOTE. The Legacy controller
// (`api/src/Webhooks/MetaApiWebhookController.php`) is the CAPABILITY source:
//   - HMAC-SHA256 over the RAW body with a provider secret
//   - a SEPARATE timestamp signature over `<timestamp>.<rawBody>`, because a
//     generic deal/trade timestamp is NOT a delivery timestamp (comment is
//     explicit in the Legacy source)
//   - a freshness window (default 300 s, floor 30 s, +30 s future skew)
//   - timing-safe comparison in every case (`hash_equals`)
// What is NOT carried over: the PHP controller's own class, its `Config` lookup
// path, and its exception plumbing. The RULES are carried; the structure is
// native to this platform.
//
// The secrets are read through a thunk so a caller can supply a value that is
// resolved at request time (and so no module-scope string ever holds it).
import { createHmac, timingSafeEqual } from "node:crypto";
import { WEBHOOK_TOLERANCE_MS_DEFAULT } from "@velora/contracts";

/** Header names accepted for the body signature — Legacy order, verbatim. */
export const BODY_SIGNATURE_HEADERS: readonly string[] = [
  "x-metaapi-signature",
  "x-webhook-signature",
  "authorization",
];

export const TIMESTAMP_HEADER = "x-metaapi-timestamp";
export const TIMESTAMP_SIGNATURE_HEADER = "x-metaapi-timestamp-signature";

/** Freshness bounds. The Legacy floor of 30 s and +30 s skew are preserved. */
export const MIN_TOLERANCE_MS = 30_000;
export const FUTURE_SKEW_MS = 30_000;
export const DEFAULT_MAX_AGE_MS = WEBHOOK_TOLERANCE_MS_DEFAULT; // 5 min (D-05)

/**
 * Normalize a presented signature: strip an `sha256=`/`SHA256 ` scheme prefix,
 * trim, lowercase. Legacy `normalizeSignature()` behaviour.
 */
export function normalizeSignature(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let value = raw.trim();
  if (value === "") return null;
  const scheme = /^(sha256|hmac-sha256|bearer)\s*[:=]?\s*/i.exec(value);
  if (scheme !== null) value = value.slice(scheme[0].length).trim();
  value = value.toLowerCase();
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

/** HMAC-SHA256 hex over a Buffer/string. */
export function hmacHex(payload: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Length-safe constant-time comparison of two hex digests. */
export function signaturesMatch(expectedHex: string, presentedHex: string): boolean {
  const a = Buffer.from(expectedHex, "utf8");
  const b = Buffer.from(presentedHex, "utf8");
  if (a.length !== b.length) return false; // length is not secret; content is
  return timingSafeEqual(a, b);
}

export type FreshnessVerdict =
  | { readonly ok: true; readonly at: Date }
  | { readonly ok: false; readonly reason: "missing" | "unparseable" | "stale" | "future" };

/**
 * Parse and bound-check a delivery timestamp.
 *
 * Accepts an ISO-8601 string or an epoch seconds/milliseconds string, which is
 * what a provider realistically sends in a header. The window is deliberately
 * asymmetric: stale deliveries are rejected hard, while a small future skew is
 * tolerated because clocks drift.
 */
export function checkFreshness(
  raw: string | null | undefined,
  now: Date,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): FreshnessVerdict {
  if (raw === null || raw === undefined || raw.trim() === "") return { ok: false, reason: "missing" };
  const value = raw.trim();
  let ms: number;
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    // 10-digit values are seconds; 13-digit values are milliseconds.
    ms = value.length >= 12 ? n : n * 1000;
  } else {
    const parsed = Date.parse(value);
    ms = Number.isNaN(parsed) ? Number.NaN : parsed;
  }
  if (!Number.isFinite(ms)) return { ok: false, reason: "unparseable" };
  const ageMs = now.getTime() - ms;
  const effectiveMaxAge = Math.max(MIN_TOLERANCE_MS, maxAgeMs);
  if (ageMs > effectiveMaxAge) return { ok: false, reason: "stale" };
  if (-ageMs > FUTURE_SKEW_MS) return { ok: false, reason: "future" };
  return { ok: true, at: new Date(ms) };
}
