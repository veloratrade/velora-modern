// Billing routes — v1.0.
//   GET  /api/v1/subscriptions/me        (authenticated)
//   POST /api/v1/subscriptions/checkout  (authenticated; provider-gated)
//   POST /api/v1/webhooks/stripe         (signature-authenticated, no bearer)
//
// ============================================================
// STRIPE SIGNATURE VERIFICATION — natively implemented
// ============================================================
// The provider's scheme is documented and needs no SDK: the header
// `Stripe-Signature` carries `t=<epoch seconds>` and one or more `v1=<hex>`
// values; the signed payload is `<t>.<rawBody>`; the digest is HMAC-SHA256 with
// the endpoint's signing secret; the timestamp must be recent (default
// tolerance 300 s). Implemented here over the RAW bytes, with a timing-safe
// comparison, and — critically — the raw bytes are read exactly once.
//
// ============================================================
// THE CHECKOUT ROUTE IS PROVIDER-GATED, NOT FAKED
// ============================================================
// Creating a Checkout Session requires a live provider credential. There is no
// safe stub for "take a payment": a stub that returns a success URL would be a
// fabrication with money-shaped consequences. Without `STRIPE_SECRET_KEY` the
// route answers 503 BILLING_NOT_CONFIGURED and the webhook ingestion path stays
// fully testable on its own (it needs only the signing secret). Reported as
// PARTIALLY_IMPLEMENTED + OWNER_DECISION_REQUIRED in the migration report.
import { fail, ok } from "@velora/contracts";
import { checkFreshness, hmacHex, signaturesMatch } from "../webhooks/signature.js";
import { PLAN_FREE, SubscriptionService, type SubscriptionStore } from "./subscriptionService.js";
import { capabilityAbsent, unauthenticated, validation } from "../routes/responses.js";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";

const CHECKOUT = "/api/v1/subscriptions/checkout";
const ME = "/api/v1/subscriptions/me";
const STRIPE_WEBHOOK = "/api/v1/webhooks/stripe";

/** Provider tolerance for a delivery timestamp (seconds). */
export const STRIPE_TOLERANCE_MS = 5 * 60 * 1000;

export interface StripeSignatureVerdict {
  readonly ok: boolean;
  readonly reason?: "malformed" | "no-v1" | "mismatch" | "stale";
}

/**
 * Verify a `Stripe-Signature` header against the raw body.
 *
 * Exported so the scheme can be unit-tested directly against fixtures produced
 * by the documented algorithm, with no network and no SDK.
 */
export function verifyStripeSignature(
  header: string | null,
  rawBody: Buffer,
  secret: string,
  now: Date,
): StripeSignatureVerdict {
  if (header === null || header.trim() === "") return { ok: false, reason: "malformed" };
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === undefined || value === undefined) continue;
    if (key.trim() === "t") timestamp = value.trim();
    if (key.trim() === "v1") signatures.push(value.trim().toLowerCase());
  }
  if (timestamp === null || signatures.length === 0) {
    return { ok: false, reason: timestamp === null ? "malformed" : "no-v1" };
  }
  const expected = hmacHex(`${timestamp}.${rawBody.toString("utf8")}`, secret);
  if (!signatures.some((s) => signaturesMatch(expected, s))) return { ok: false, reason: "mismatch" };
  const freshness = checkFreshness(timestamp, now, STRIPE_TOLERANCE_MS);
  if (!freshness.ok) return { ok: false, reason: "stale" };
  return { ok: true };
}

function service(ctx: ExtendedRouteContext): SubscriptionService | null {
  const store: SubscriptionStore | null = ctx.config.subscriptions ?? null;
  if (store === null) return null;
  return new SubscriptionService(store, process.env);
}

export async function handleBillingRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  if (ctx.path === STRIPE_WEBHOOK) {
    if (ctx.method !== "POST") {
      return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId), headers: { Allow: "POST" } };
    }
    const store = ctx.config.subscriptions ?? null;
    if (store === null) return capabilityAbsent(ctx, "billing");
    const secret = (process.env["STRIPE_WEBHOOK_SECRET"] ?? "").trim();
    if (secret === "") {
      // Fail-closed: an unsigned provider event is never trusted, and the
      // absence of the secret is a configuration fact, not a 200.
      return { status: 503, body: fail("BILLING_NOT_CONFIGURED", "Billing webhook is not configured.", ctx.requestId) };
    }
    let raw: Buffer;
    try {
      raw = await ctx.readRawBody(ctx.req);
    } catch {
      return { status: 413, body: fail("PAYLOAD_TOO_LARGE", "Payload too large.", ctx.requestId) };
    }
    const header = Array.isArray(ctx.req.headers["stripe-signature"])
      ? (ctx.req.headers["stripe-signature"][0] ?? null)
      : (ctx.req.headers["stripe-signature"] ?? null);
    const verdict = verifyStripeSignature(header, raw, secret, new Date());
    if (!verdict.ok) {
      // 400 with a bounded reason (the reason is diagnostic, never the secret
      // and never the presented signature).
      return { status: 400, body: fail("SIGNATURE_INVALID", `Invalid signature (${verdict.reason ?? "unknown"}).`, ctx.requestId) };
    }
    let event: { type?: unknown; data?: unknown };
    try {
      event = JSON.parse(raw.toString("utf8")) as { type?: unknown; data?: unknown };
    } catch {
      return { status: 422, body: fail("INVALID_WEBHOOK_PAYLOAD", "Invalid webhook JSON.", ctx.requestId) };
    }
    if (typeof event.type !== "string" || event.data === null || typeof event.data !== "object") {
      return { status: 422, body: fail("INVALID_WEBHOOK_PAYLOAD", "Invalid webhook payload.", ctx.requestId) };
    }
    const result = await new SubscriptionService(store, process.env).apply({
      type: event.type,
      data: event.data as Record<string, unknown>,
    });
    // Unknown event types are acknowledged: the provider must not retry them
    // forever, and the effect is visible in the response body.
    return { status: 200, body: ok({ received: true, handled: result.handled, action: result.action }) };
  }

  if (ctx.path !== ME && ctx.path !== CHECKOUT) return null;
  const svc = service(ctx);
  if (svc === null) return capabilityAbsent(ctx, "billing");
  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);

  if (ctx.path === ME) {
    if (ctx.method !== "GET") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
    // The response distinguishes the EFFECTIVE plan (`plan`, read from
    // users.plan — the entitlement input) from the PURCHASED plan recorded on
    // the subscription row. A cancelled user must not be shown an active plan.
    const current = await svc.current(claims.sub);
    return {
      status: 200,
      body: ok({
        plan: current.plan,
        entitled: current.entitled,
        purchasedPlan: current.subscription?.plan ?? PLAN_FREE,
        subscription: current.subscription,
      }),
    };
  }

  if (ctx.method !== "POST") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
  const secretKey = (process.env["STRIPE_SECRET_KEY"] ?? "").trim();
  if (secretKey === "") {
    return {
      status: 503,
      body: fail("BILLING_NOT_CONFIGURED", "Billing is not configured on this deployment.", ctx.requestId),
    };
  }
  const body = await ctx.readBody(ctx.req);
  const interval = body["interval"] === "year" ? "year" : body["interval"] === "month" ? "month" : null;
  if (interval === null) return validation(ctx, { interval: "must be month or year" });
  // A live Checkout Session is created by the provider SDK against the live
  // credential; wiring it is a deployment step, not a migration step, so this
  // branch reports the honest state instead of fabricating a session URL.
  return {
    status: 503,
    body: fail("BILLING_NOT_CONFIGURED", "Checkout session creation is not implemented in this deployment.", ctx.requestId),
  };
}
