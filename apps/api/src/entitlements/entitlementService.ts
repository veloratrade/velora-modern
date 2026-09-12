// EntitlementService — Phase C increment 6 (matrix row 14, PORT).
// Remote evidence: src/modules/entitlements/entitlement.service.ts + unit
// (170-line matrix) + integration (228-line) suites. Service-only module —
// NO routes, NO table (the plan lives on `users`, migration 0002); consumed
// by the accounts capability and, later, Phase G tiers.
//
// Contract (Remote-verified):
//  - getPlanQuota: normalize (lowercase, trim, default 'free'); 'pro'|
//    'enterprise' → unlimited; EVERYTHING ELSE — including unknown plan
//    strings — fails closed to free/1 (SAFE-FAIL CLOSED, unit-tested).
//  - getUserPlan: user lookup; missing user or null plan → 'free'; store
//    failure → 503 SERVICE_UNAVAILABLE — the Fail-Closed Security Invariant:
//    never silently fall back to 'free' (Remote "Blocker A").
//  - checkTradingAccountEntitlement: under quota → {allowed, limit,
//    currentCount}; over → 429 ACCOUNT_QUOTA_EXCEEDED, messageKey
//    'errors.accounts.quotaExceeded', details {plan, currentCount, maxAllowed}.
//
// Concurrency note (evidence-honest): Remote enforces the quota atomically in
// a DB transaction with a user row lock in production, and serializes its
// in-memory test path with a per-user mutex. Local ports the per-user mutex
// (process-local; see AccountService) — real-PostgreSQL transaction/row-lock
// guarantees remain Phase D and are NOT claimed here.

export interface PlanQuota {
  readonly plan: string;
  readonly maxTradingAccounts: number;
  readonly isUnlimited: boolean;
}

export class EntitlementError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "EntitlementError";
  }
}

const QUOTA_MESSAGE_KEY = "errors.accounts.quotaExceeded";

export function getPlanQuota(planInput: string | undefined | null): PlanQuota {
  const plan = (planInput ?? "free").toLowerCase().trim();
  if (plan === "pro" || plan === "enterprise") {
    return { plan, maxTradingAccounts: Number.POSITIVE_INFINITY, isUnlimited: true };
  }
  // SAFE-FAIL CLOSED: any unknown/unsupported plan string → free quota.
  return { plan: "free", maxTradingAccounts: 1, isUnlimited: false };
}

export interface EntitlementServiceDeps {
  /** User lookup for the plan (UserStore.findUserById shape). Throws on store failure. */
  readonly findUserById: (userId: string) => Promise<{ plan: string | null } | null>;
}

export class EntitlementService {
  constructor(private readonly deps: EntitlementServiceDeps) {}

  /**
   * The user's commercial plan, normalized. Missing user / null plan → 'free'.
   * Fail-Closed Security Invariant (Remote Blocker A): a store failure throws
   * 503 SERVICE_UNAVAILABLE — it NEVER silently degrades to 'free'.
   */
  async getUserPlan(userId: string): Promise<string> {
    let user: { plan: string | null } | null;
    try {
      user = await this.deps.findUserById(userId);
    } catch {
      throw new EntitlementError(503, "SERVICE_UNAVAILABLE", "Service unavailable.");
    }
    if (user === null || user.plan === null || user.plan === "") {
      return "free";
    }
    return user.plan.toLowerCase().trim();
  }

  /**
   * Trading-account entitlement check (Remote checkTradingAccountEntitlement).
   * Over quota → 429 ACCOUNT_QUOTA_EXCEEDED with the Remote-verified details
   * (Local convention: the Remote top-level messageKey is embedded in details —
   * the envelope error-object shape is the frozen C-10 contract and its exact
   * fields remain OD-3 fixture-pending).
   */
  checkTradingAccountEntitlement(
    userId: string,
    currentAccountCount: number,
    planInput?: string | null,
  ): { allowed: boolean; limit: number; currentCount: number } {
    void userId; // ownership context is enforced by the calling capability
    const quota = getPlanQuota(planInput);
    if (!quota.isUnlimited && currentAccountCount >= quota.maxTradingAccounts) {
      throw new EntitlementError(
        429,
        "ACCOUNT_QUOTA_EXCEEDED",
        `Trading account quota exceeded. Free plan allows up to ${quota.maxTradingAccounts} trading account.`,
        {
          messageKey: QUOTA_MESSAGE_KEY,
          plan: quota.plan,
          currentCount: currentAccountCount,
          maxAllowed: quota.maxTradingAccounts,
        },
      );
    }
    return { allowed: true, limit: quota.maxTradingAccounts, currentCount: currentAccountCount };
  }
}
