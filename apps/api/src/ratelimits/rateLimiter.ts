// Fixed-window rate limiter — PHP dispatch-level throttle port (Phase C
// increment 7, CAP-PLAT-02). Policies come from the frozen C-14 contract
// (RATE_LIMIT_DEFAULTS — single source, PHP-verified values); window
// mechanics (store upsert + decision + Retry-After) come from PHP
// Core/RateLimiter.php via the pure domain logic.
import { RATE_LIMIT_DEFAULTS, type RateLimitKey } from "@velora/contracts";
import { evaluateRateLimit, type RateLimitDecision, type RateLimitStore } from "@velora/domain";

export interface RateLimiter {
  /** Count one attempt for the route key from this client IP and decide. */
  hit(routeKey: RateLimitKey, ip: string): Promise<RateLimitDecision>;
}

export class FixedWindowRateLimiter implements RateLimiter {
  constructor(
    private readonly store: RateLimitStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async hit(routeKey: RateLimitKey, ip: string): Promise<RateLimitDecision> {
    const policy = RATE_LIMIT_DEFAULTS[routeKey];
    const bucket = `${routeKey}|${ip}`; // PHP bucket shape: "{op}|{ip}"
    const nowMs = this.now();
    const state = await this.store.hit(bucket, { windowSec: policy.windowSec }, nowMs);
    return evaluateRateLimit(state, policy, nowMs);
  }
}
