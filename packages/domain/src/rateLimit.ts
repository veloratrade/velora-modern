// Fixed-window rate-limit semantics — PHP Core/RateLimiter.php port
// (Phase C increment 7). Pure decision logic over a store port: the store
// owns upsert/expiry persistence, the domain owns the allow/block decision
// and the Retry-After arithmetic. Limits live in the frozen C-14 contract
// (packages/contracts/src/auth.ts RATE_LIMIT_DEFAULTS) — never here.

/** Persistence port for fixed-window buckets.
 *
 * ADR-007: the store is the swappable seam — per-process memory now; Redis
 * only when a documented trigger fires (multi-node shared state, etc.).
 * Real-PostgreSQL stores land with Phase D (S8 boundary). */
export interface RateLimitStore {
  /** Record one hit and return the bucket's current window state.
   *
   * Implementations MUST reset the window (hits=1, windowStartMs=nowMs) when
   * no bucket exists yet OR the stored window has expired relative to THIS
   * bucket's own windowSec (PHP: `DELETE … WHERE bucket = :b AND
   * window_start < now − windowSec` before the upsert); the window start is
   * preserved on increment (window anchored at the first hit). */
  hit(
    bucket: string,
    policy: { readonly windowSec: number },
    nowMs: number,
  ): Promise<{ hits: number; windowStartMs: number }>;
}

export type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSec: number };

/** Allow/block decision — PHP parity (RateLimiter.php):
 *
 * - the counter is incremented BEFORE the check, and the request is blocked
 *   when `hits > limit`: the limit-th attempt is allowed, the (limit+1)-th
 *   is the first blocked one (blocked hits keep counting);
 * - Retry-After = seconds until the window that started at windowStartMs
 *   expires, minimum 1 (PHP `max(1, (window_start + windowSec) − time())`). */
export function evaluateRateLimit(
  state: { readonly hits: number; readonly windowStartMs: number },
  policy: { readonly limit: number; readonly windowSec: number },
  nowMs: number,
): RateLimitDecision {
  if (state.hits <= policy.limit) return { allowed: true };
  const remainingSec = Math.ceil((state.windowStartMs + policy.windowSec * 1000 - nowMs) / 1000);
  return { allowed: false, retryAfterSec: Math.max(1, remainingSec) };
}
