// Per-process fixed-window rate-limit store (Phase C increment 7).
// Single-node dev/test posture: real-PostgreSQL stores land with Phase D
// (S8); Redis only on a documented ADR-007 trigger — this store port is the
// swappable seam. Semantics mirror PHP Core/RateLimiter.php: window anchored
// at the first hit, preserved on increment, reset only after the bucket's OWN
// window expires, plus an opportunistic 48h stale sweep.
import type { RateLimitStore } from "@velora/domain";

/** PHP parity: stale storage bounded independently of any bucket policy. */
const STALE_AFTER_MS = 172800 * 1000; // 48 h

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { hits: number; windowStartMs: number }>();

  async hit(
    bucket: string,
    policy: { windowSec: number },
    nowMs: number,
  ): Promise<{ hits: number; windowStartMs: number }> {
    this.sweepStale(nowMs);
    const existing = this.buckets.get(bucket);
    // PHP: `DELETE … WHERE bucket = :b AND window_start < now − windowSec` —
    // strictly older than the window expires; exactly-at-the-edge keeps the window.
    if (existing !== undefined && nowMs - existing.windowStartMs <= policy.windowSec * 1000) {
      existing.hits += 1;
      return existing;
    }
    const fresh = { hits: 1, windowStartMs: nowMs };
    this.buckets.set(bucket, fresh);
    return fresh;
  }

  /** PHP parity: opportunistic stale sweep on every hit (storage hygiene,
   * not part of the allow/block contract). */
  private sweepStale(nowMs: number): void {
    for (const [key, entry] of this.buckets) {
      if (nowMs - entry.windowStartMs > STALE_AFTER_MS) this.buckets.delete(key);
    }
  }
}
