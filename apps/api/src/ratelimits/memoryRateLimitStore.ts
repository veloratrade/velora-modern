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
      // A SNAPSHOT, never the live bucket. The stored object keeps being mutated by every later hit in
      // the same tick, so a caller that receives it reads whatever the counter became AFTER its own
      // request — which for a burst is the final total. A burst of 20 parallel hits against a limit of 5
      // used to be refused in full, including the five that were genuinely first in line: the throttle
      // converted an idle identity's own parallel updates into a lockout. Returning a copy costs one
      // object and makes the decision depend on the caller's place in the queue and nothing else.
      // `PgRateLimitStore` has always returned its own row per call (its upsert is serialised by the row
      // lock), so the two stores now agree on this, and the concurrency assertion in
      // `rateLimiter.test.ts` is the thing that keeps them agreeing.
      return { hits: existing.hits, windowStartMs: existing.windowStartMs };
    }
    const fresh = { hits: 1, windowStartMs: nowMs };
    this.buckets.set(bucket, fresh);
    // Same rule on the insert path, where it matters most: this is the caller whose `hits` is 1, and an
    // alias here is how "the first request in a burst is the one that gets blocked" happens.
    return { ...fresh };
  }

  /** PHP parity: opportunistic stale sweep on every hit (storage hygiene,
   * not part of the allow/block contract). */
  private sweepStale(nowMs: number): void {
    for (const [key, entry] of this.buckets) {
      if (nowMs - entry.windowStartMs > STALE_AFTER_MS) this.buckets.delete(key);
    }
  }
}
