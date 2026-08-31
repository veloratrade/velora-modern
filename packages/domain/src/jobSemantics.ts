// Job semantics — ADR-007 (Accepted, D-13): backoff with full jitter,
// bounded attempts → DLQ, lease discipline, timeout enforcement.
export interface RetryPolicy {
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

/** Full-jitter exponential backoff (thundering-herd safe). rng injectable for tests. */
export function computeBackoffMs(
  attempt: number, // 1-based attempt that just failed
  policy: RetryPolicy,
  rng: () => number = Math.random,
): number {
  if (attempt < 1) throw new RangeError("attempt must be >= 1");
  const exp = policy.backoffBaseMs * 2 ** (attempt - 1);
  const cap = Math.min(policy.backoffMaxMs, exp);
  return Math.floor(rng() * cap);
}

/** True when the job must move to the DLQ instead of being retried again. */
export function shouldDeadLetter(latestAttempt: number, policy: RetryPolicy): boolean {
  return latestAttempt >= policy.maxAttempts;
}

/** Lease health: renew when >50% of the lease has elapsed (visibility safety). */
export function leaseNeedsRenewal(elapsedMs: number, leaseMs: number): boolean {
  if (leaseMs <= 0) throw new RangeError("leaseMs must be > 0");
  return elapsedMs >= leaseMs / 2;
}

/** A job whose lease expired while still running is reclaimable by another worker. */
export function isLeaseExpired(nowMs: number, leaseDeadlineMs: number): boolean {
  return nowMs >= leaseDeadlineMs;
}

export const DLQ_ALERT_THRESHOLD = 1; // any DLQ entry is alert-worthy (observability contract)
