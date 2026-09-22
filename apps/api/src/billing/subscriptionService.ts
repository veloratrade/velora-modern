// SubscriptionService — v1.0 "Commercial Launch" (Stripe $29/mo, $240/yr).
//
// ============================================================
// WHAT THIS OWNS, AND WHAT IT MUST NOT OWN
// ============================================================
// The Foundation already decided WHERE a plan lives: `entitlementService.ts`
// reads `users.plan` and maps it to a quota (`pro`/`enterprise` → unlimited,
// anything else → free, fail-closed). That decision is authoritative and is NOT
// re-litigated here.
//
// This service therefore owns exactly one thing: turning SIGNED provider events
// into `users.plan` + a `subscriptions` row. It never computes a quota, never
// invents a plan name, and never grants a paid plan from an unrecognised price
// — an unknown price id yields `free`, which is fail-closed, and the event is
// recorded so the operator can see the mismatch.
//
// ============================================================
// LEGACY REFERENCE
// ============================================================
// There is NO legacy billing to port: the Legacy `BillingController` is
// read-only and Legacy has no `subscriptions` table. Per the audit this
// capability is REIMPLEMENT (roadmap-owned), so the rules below come from the
// roadmap (plans, prices, provider) and from the provider's own documented
// event semantics — not from PHP.
//
// ============================================================
// IDEMPOTENCE AND ORDERING
// ============================================================
// Webhooks are delivered at-least-once and out of order. Every handler is
// therefore an idempotent UPSERT keyed by `provider_subscription_id` (0017's
// UNIQUE (provider, provider_subscription_id)), and `status` is written from the
// event rather than accumulated. A retry or a duplicate delivery therefore
// converges on the same state; a late-arriving older event is the one case that
// can regress state, which is why the raw event is recorded by the ingress
// (webhook_events) and is reportable.
import type { QueryFn } from "../persistence/pg.js";

export const PLAN_FREE = "free";
export const PLAN_PRO = "pro";
/** Provider plans the roadmap names, with the price env names they map from. */
export const PLAN_PRICE_ENV: Readonly<Record<string, string>> = {
  STRIPE_PRICE_PRO_MONTHLY: PLAN_PRO,
  STRIPE_PRICE_PRO_YEARLY: PLAN_PRO,
};

/** Subscription statuses the provider defines and this system stores. */
export const SUBSCRIPTION_STATUSES: readonly string[] = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "paused",
];

/** Statuses that still entitle the paid plan (a dunning period is not a downgrade). */
const ENTITLED_STATUSES: readonly string[] = ["active", "trialing", "past_due"];

export interface SubscriptionRecord {
  readonly userId: string;
  readonly plan: string;
  readonly status: string;
  readonly provider: string;
  readonly providerCustomerId: string | null;
  readonly providerSubscriptionId: string | null;
  readonly currentPeriodEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
}

export class BillingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BillingError";
  }
}

export interface SubscriptionStore {
  findForUser(userId: string): Promise<SubscriptionRecord | null>;
  /** Idempotent upsert keyed by (provider, provider_subscription_id). */
  upsert(input: {
    userId: string;
    plan: string;
    status: string;
    provider: string;
    providerCustomerId: string | null;
    providerSubscriptionId: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  }): Promise<void>;
  setUserPlan(userId: string, plan: string): Promise<void>;
  /**
   * The user's EFFECTIVE plan — `users.plan`, the single input
   * `entitlementService` reads.
   *
   * It is deliberately a separate read from `findForUser`: a `subscriptions` row
   * records what was PURCHASED (0017 forbids storing 'free' there), while
   * entitlement is what the account can actually do. After a cancellation the
   * two legitimately differ, and reporting the purchased plan would overstate a
   * cancelled user's access.
   */
  effectivePlan(userId: string): Promise<string>;
  /** Resolve the Velora user a provider customer belongs to (checkout linking). */
  findUserByCustomer(provider: string, customerId: string): Promise<string | null>;
  /** Link a provider customer to a user at checkout completion. */
  linkCustomer(input: {
    userId: string;
    provider: string;
    customerId: string;
    subscriptionId: string;
  }): Promise<void>;
}

function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

export class PgSubscriptionStore implements SubscriptionStore {
  constructor(private readonly q: QueryFn) {}

  async findForUser(userId: string): Promise<SubscriptionRecord | null> {
    const rows = await this.q(
      `SELECT user_id, plan, status, provider, provider_customer_id, provider_subscription_id,
              current_period_end, cancel_at_period_end
         FROM subscriptions
        WHERE user_id = $1
        ORDER BY (status = ANY($2::text[])) DESC, updated_at DESC
        LIMIT 1`,
      [userId, ENTITLED_STATUSES],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      userId: String(row["user_id"]),
      plan: String(row["plan"]),
      status: String(row["status"]),
      provider: String(row["provider"]),
      providerCustomerId: row["provider_customer_id"] === null ? null : String(row["provider_customer_id"]),
      providerSubscriptionId: row["provider_subscription_id"] === null ? null : String(row["provider_subscription_id"]),
      currentPeriodEnd: isoOrNull(row["current_period_end"]),
      cancelAtPeriodEnd: row["cancel_at_period_end"] === true,
    };
  }

  async upsert(input: {
    userId: string;
    plan: string;
    status: string;
    provider: string;
    providerCustomerId: string | null;
    providerSubscriptionId: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  }): Promise<void> {
    await this.q(
      `INSERT INTO subscriptions
         (user_id, plan, status, provider, provider_customer_id, provider_subscription_id,
          current_period_end, cancel_at_period_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8)
       ON CONFLICT (provider, provider_subscription_id) DO UPDATE
         SET plan = EXCLUDED.plan,
             status = EXCLUDED.status,
             provider_customer_id = EXCLUDED.provider_customer_id,
             current_period_end = EXCLUDED.current_period_end,
             cancel_at_period_end = EXCLUDED.cancel_at_period_end,
             updated_at = now()`,
      [
        input.userId,
        input.plan,
        input.status,
        input.provider,
        input.providerCustomerId,
        input.providerSubscriptionId,
        input.currentPeriodEnd,
        input.cancelAtPeriodEnd,
      ],
    );
  }

  async setUserPlan(userId: string, plan: string): Promise<void> {
    await this.q("UPDATE users SET plan = $2, updated_at = now() WHERE id = $1", [userId, plan]);
  }

  async effectivePlan(userId: string): Promise<string> {
    const rows = await this.q("SELECT plan FROM users WHERE id = $1", [userId]);
    const row = rows[0];
    // Fail-closed: an unknown user or an empty plan is FREE, never a paid plan.
    if (row === undefined) return PLAN_FREE;
    const plan = typeof row["plan"] === "string" ? row["plan"].toLowerCase().trim() : "";
    return plan === "" ? PLAN_FREE : plan;
  }

  async findUserByCustomer(provider: string, customerId: string): Promise<string | null> {
    const rows = await this.q(
      "SELECT user_id FROM subscriptions WHERE provider = $1 AND provider_customer_id = $2 LIMIT 1",
      [provider, customerId],
    );
    const row = rows[0];
    return row === undefined ? null : String(row["user_id"]);
  }

  async linkCustomer(input: {
    userId: string;
    provider: string;
    customerId: string;
    subscriptionId: string;
  }): Promise<void> {
    // WHY THE ROW IS WRITTEN WITH plan='pro' AND status='incomplete'.
    // 0017 constrains `subscriptions.plan` to ('pro','enterprise'): the table
    // records a PURCHASE, and "no purchase" is not representable in it — that is
    // what `users.plan = 'free'` means. A checkout row therefore carries the plan
    // being purchased and a non-entitling status (also allowed by the CHECK);
    // entitlement is granted only through `users.plan` once a subscription event
    // reports an entitling status. No schema change is required or proposed.
    //
    // Idempotent on (provider, provider_subscription_id) — non-null here, so the
    // UNIQUE constraint is a real conflict target.
    await this.q(
      `INSERT INTO subscriptions (user_id, plan, status, provider, provider_customer_id, provider_subscription_id)
       VALUES ($1, 'pro', 'incomplete', $2, $3, $4)
       ON CONFLICT (provider, provider_subscription_id) DO UPDATE
         SET provider_customer_id = EXCLUDED.provider_customer_id,
             updated_at = now()`,
      [input.userId, input.provider, input.customerId, input.subscriptionId],
    );
  }
}

/** In-memory double (contract-identical; not database evidence). */
export class MemorySubscriptionStore implements SubscriptionStore {
  readonly #rows = new Map<string, SubscriptionRecord>();
  readonly #customers = new Map<string, string>();
  readonly #plans = new Map<string, string>();

  async findForUser(userId: string): Promise<SubscriptionRecord | null> {
    const row = this.#rows.get(userId);
    if (row !== undefined) return row;
    const plan = this.#plans.get(userId);
    return plan === undefined
      ? null
      : {
          userId,
          plan,
          status: "none",
          provider: "stripe",
          providerCustomerId: null,
          providerSubscriptionId: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
        };
  }

  async upsert(input: {
    userId: string;
    plan: string;
    status: string;
    provider: string;
    providerCustomerId: string | null;
    providerSubscriptionId: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  }): Promise<void> {
    this.#rows.set(input.userId, { ...input });
    if (input.providerCustomerId !== null) this.#customers.set(`${input.provider}:${input.providerCustomerId}`, input.userId);
  }

  async setUserPlan(userId: string, plan: string): Promise<void> {
    this.#plans.set(userId, plan);
  }

  async effectivePlan(userId: string): Promise<string> {
    return this.#plans.get(userId) ?? PLAN_FREE;
  }

  async findUserByCustomer(provider: string, customerId: string): Promise<string | null> {
    return this.#customers.get(`${provider}:${customerId}`) ?? null;
  }

  async linkCustomer(input: {
    userId: string;
    provider: string;
    customerId: string;
    subscriptionId: string;
  }): Promise<void> {
    this.#customers.set(`${input.provider}:${input.customerId}`, input.userId);
    if (!this.#rows.has(input.userId)) {
      this.#rows.set(input.userId, {
        userId: input.userId,
        plan: PLAN_PRO,
        status: "incomplete",
        provider: input.provider,
        providerCustomerId: input.customerId,
        providerSubscriptionId: input.subscriptionId,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      });
    }
  }
}

export interface ProviderEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface ApplyResult {
  readonly handled: boolean;
  readonly action: string;
  readonly userId: string | null;
  readonly plan: string | null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function objOf(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Resolve a plan from the provider's price identifier.
 *
 * FAIL-CLOSED: an unrecognised price — including a price this deployment never
 * configured — maps to `free`. Granting `pro` on an unknown price would let a
 * misconfigured or forged-but-signed pricing change silently upgrade every user.
 */
export function planForPrice(priceId: string | null, env: Readonly<Record<string, string | undefined>>): string {
  if (priceId === null) return PLAN_FREE;
  for (const [envName, plan] of Object.entries(PLAN_PRICE_ENV)) {
    const configured = env[envName];
    if (configured !== undefined && configured !== "" && configured === priceId) return plan;
  }
  return PLAN_FREE;
}

export class SubscriptionService {
  constructor(
    private readonly store: SubscriptionStore,
    private readonly env: Readonly<Record<string, string | undefined>>,
  ) {}

  async current(
    userId: string,
  ): Promise<{
    /** EFFECTIVE plan — what the account may actually do right now. */
    plan: string;
    /** True when the stored subscription status currently entitles a paid plan. */
    entitled: boolean;
    /** The stored purchase record (`plan` here is the PURCHASED plan), or null. */
    subscription: SubscriptionRecord | null;
  }> {
    const subscription = await this.store.findForUser(userId);
    const effective = await this.store.effectivePlan(userId);
    const entitled = effective !== PLAN_FREE;
    return { plan: effective, entitled, subscription };
  }

  /**
   * Apply one provider event.
   *
   * Unknown event types are NOT failures: they are acknowledged and ignored, so
   * a provider adding an event type never produces a retry storm. Every branch
   * is idempotent.
   */
  async apply(event: ProviderEvent): Promise<ApplyResult> {
    const object = objOf(event.data["object"]);
    const customerId = strOrNull(object["customer"]);

    switch (event.type) {
      case "checkout.session.completed": {
        const metadata = objOf(object["metadata"]);
        const userId = strOrNull(metadata["user_id"]);
        const subscriptionId = strOrNull(object["subscription"]);
        if (userId === null || customerId === null) {
          return { handled: false, action: "checkout.missing-user", userId: null, plan: null };
        }
        if (subscriptionId === null) {
          // A one-off payment session is not a subscription; nothing to record.
          return { handled: false, action: "checkout.no-subscription", userId, plan: null };
        }
        await this.store.linkCustomer({ userId, provider: "stripe", customerId, subscriptionId });
        // NO entitlement is granted here: the row is 'incomplete' until the
        // subscription event reports an entitling status.
        return { handled: true, action: "checkout.linked", userId, plan: null };
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscriptionId = strOrNull(object["id"]);
        const status = strOrNull(object["status"]) ?? "incomplete";
        const metadata = objOf(object["metadata"]);
        let userId = strOrNull(metadata["user_id"]);
        if (userId === null && customerId !== null) userId = await this.store.findUserByCustomer("stripe", customerId);
        if (userId === null || subscriptionId === null) {
          return { handled: false, action: "subscription.attribution-failed", userId: null, plan: null };
        }
        const items = objOf(object["items"]);
        const data = Array.isArray(items["data"]) ? items["data"] : [];
        const firstItem = objOf(data[0]);
        const price = objOf(firstItem["price"]);
        const deleted = event.type === "customer.subscription.deleted";
        const effectiveStatus = deleted ? "canceled" : status;
        // The purchased plan is CARRIED, never downgraded in place: the row is a
        // record of what was bought (and 0017 forbids storing 'free' there).
        // Entitlement is decided separately, below, through `users.plan`.
        const current = await this.store.findForUser(userId);
        const plan = deleted
          ? (current?.plan ?? PLAN_PRO)
          : status === "unpaid" || status === "incomplete_expired"
            ? (current?.plan ?? PLAN_PRO)
            : ENTITLED_STATUSES.includes(status)
              ? planForPrice(strOrNull(price["id"]), this.env)
              : PLAN_PRO;
        if (!SUBSCRIPTION_STATUSES.includes(effectiveStatus)) {
          // A status the vocabulary does not contain is not silently stored: it
          // is reported as unhandled so the operator sees the drift.
          return { handled: false, action: `subscription.unknown-status:${effectiveStatus.slice(0, 32)}`, userId, plan: null };
        }
        await this.store.upsert({
          userId,
          plan,
          status: effectiveStatus,
          provider: "stripe",
          providerCustomerId: customerId,
          providerSubscriptionId: subscriptionId,
          currentPeriodEnd: epochToIso(object["current_period_end"]),
          cancelAtPeriodEnd: object["cancel_at_period_end"] === true,
        });
        // THE ENTITLEMENT WRITE. `users.plan` is the single input
        // `entitlementService` reads, so it is updated from the STATUS, not from
        // the stored plan column: anything that is not entitling (unpaid,
        // incomplete_expired, canceled) drops the user to free.
        const entitled = !deleted && ENTITLED_STATUSES.includes(status);
        await this.store.setUserPlan(userId, entitled ? plan : PLAN_FREE);
        return { handled: true, action: `subscription.${effectiveStatus}`, userId, plan: entitled ? plan : PLAN_FREE };
      }
      case "invoice.payment_failed": {
        // Dunning: the subscription stays entitled (past_due is in
        // ENTITLED_STATUSES) — a failed payment is not an immediate downgrade.
        // The subscription.updated event carries the authoritative status, so
        // nothing is written from the invoice itself.
        return { handled: true, action: "invoice.payment_failed.observed", userId: null, plan: null };
      }
      default:
        return { handled: false, action: `ignored:${event.type.slice(0, 48)}`, userId: null, plan: null };
    }
  }
}

/** Provider timestamps are epoch SECONDS; storage is timestamptz. */
export function epochToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}
