// Telegram HTTP surface (ADR-018) — the web-app half of the client.
//
// TWO SURFACES, ONE MODULE, AND WHY THAT IS NOT A COMPROMISE
//   * `POST /api/v1/webhooks/telegram` — UNAUTHENTICATED BY BEARER, authenticated
//     by Telegram's `X-Telegram-Bot-Api-Secret-Token`. It never reads the kernel's
//     bearer claims and never resolves a user; it hands raw bytes to the pipeline.
//   * `/api/v1/telegram/*` — AUTHENTICATED, user-scoped, bearer-only. Identity is
//     `claims.sub` in every case. No route here accepts a user id, an account id
//     or a Telegram id from the client: the ONLY way a Telegram identity becomes
//     a Velora user is the linking handshake, server-side.
// The registry in `extendedRoutes.ts` is a flat list of handlers, and splitting
// the ingress into its own file purely to sit earlier in that list would add a
// module without changing what runs. What matters — which surface authenticates
// how — is visible in the routing table below and is asserted by tests.
//
// EVERY MUTATION IS AUDITED AND RATE-LIMITED. Linking is an account-affecting
// privilege change; it writes `TELEGRAM_LINK_STARTED` / `TELEGRAM_LINK_COMPLETED`
// / `TELEGRAM_LINK_FAILED` / `TELEGRAM_UNLINKED` / `TELEGRAM_CHANNEL_BOUND` /
// `TELEGRAM_CHANNEL_UNBOUND` into the SAME `audit_log` every other privileged
// action uses (0023 §7).
//
// ABSENCE IS A CAPABILITY STATE, NOT AN ERROR. With no bot token the whole
// Telegram surface answers 503 and `/ready` stays green: the web product is
// unaffected, exactly as a missing MetaAPI token behaves (ADR-014 §5).
import { fail, ok, TELEGRAM_CHANNEL_PATH, TELEGRAM_LINK_START_PATH, TELEGRAM_LINK_UNLINK_PATH, TELEGRAM_STATUS_PATH, TELEGRAM_WEBHOOK_PATH } from "@velora/contracts";
import { capabilityAbsent, notFound, unauthenticated } from "../routes/responses.js";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";
import type { TelegramChannelRecord, TelegramStore } from "./telegramStore.js";
import type { TelegramLinkService } from "./telegramLinkService.js";
import type { TelegramUpdatePipeline } from "./telegramUpdatePipeline.js";
import { webhookSecretMatches, type TelegramResolution } from "./telegramConfig.js";
import type { RateLimiter } from "../ratelimits/rateLimiter.js";
import type { AuditStore } from "../auth/auditStore.js";

/**
 * The largest bytes accepted on the webhook ingress.
 *
 * 256 KiB is ~50x the largest plausible Telegram update and still small enough
 * that a hostile caller holding the secret cannot make the process allocate
 * meaningfully. Telegram's own Bot API caps `getUpdates` payloads far below this.
 */
export const TELEGRAM_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

/**
 * Everything the HTTP surface needs, assembled once in `server-main.ts`.
 *
 * `config` is a THUNK because the environment is read at call time: a rotated
 * secret takes effect without a restart, and the resolution is never captured in
 * a module-scope binding that could outlive its validity.
 */
export interface TelegramCapability {
  readonly config: () => TelegramResolution;
  readonly links: TelegramLinkService;
  readonly store: TelegramStore;
  readonly pipeline: TelegramUpdatePipeline;
  /** Shared, deployment-wide limiter store (never a per-process counter). */
  readonly limiter: RateLimiter;
  readonly audit: AuditStore;
  readonly log: (event: Record<string, unknown>) => void;
}

function capability(ctx: ExtendedRouteContext): TelegramCapability | null {
  return ctx.config.telegram ?? null;
}

export async function handleTelegramRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  if (ctx.path === TELEGRAM_WEBHOOK_PATH) return handleWebhookIngress(ctx);
  if (ctx.path === TELEGRAM_STATUS_PATH) return handleStatus(ctx);
  if (ctx.path === TELEGRAM_LINK_START_PATH) return handleLinkStart(ctx);
  if (ctx.path === TELEGRAM_LINK_UNLINK_PATH) return handleUnlink(ctx);
  if (ctx.path === TELEGRAM_CHANNEL_PATH) return handleChannel(ctx);
  return null;
}

// ── Ingress ─────────────────────────────────────────────────────────────────

/**
 * Telegram webhook delivery.
 *
 * ORDER OF CHECKS IS THE SECURITY PROPERTY:
 *   1. capability present (no secret ⇒ 503, never an unverified accept);
 *   2. secret token verified in CONSTANT TIME, before the body is even read;
 *   3. payload validated against the frozen schema;
 *   4. claimed (idempotency), then answered 200 while the work continues.
 *
 * WHY 200 BEFORE THE WORK FINISHES. Telegram retries any delivery that is not
 * answered quickly, and downloading a voice note plus calling a model does not
 * fit in that budget. The claim taken in step 4 is what makes the early answer
 * safe: a retry of the same `update_id` is recognised as a duplicate instead of
 * creating a second journal entry.
 *
 * STATUS CODES ARE PART OF THE CONTRACT:
 *   200 — accepted, or a duplicate we have already handled (both are "delivered")
 *   401 — the secret token was missing or wrong (an attacker, or a misconfigured
 *         endpoint; never processed, never logged with the presented value)
 *   400 — not a parseable Telegram update
 *   409 — this deployment's consumer is the poller: refusing here is what stops
 *         TWO consumers from processing one stream
 *   503 — Telegram is not configured on this installation
 */
async function handleWebhookIngress(ctx: ExtendedRouteContext): Promise<RouteResult> {
  if (ctx.method !== "POST") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId), headers: { Allow: "POST" } };

  const cap = capability(ctx);
  const resolution = cap?.config() ?? null;
  if (cap === null || resolution === null || !resolution.configured) {
    return { status: 503, body: fail("TELEGRAM_NOT_CONFIGURED", "Telegram is not configured.", ctx.requestId) };
  }
  if (resolution.updateMode === "polling") {
    // One consumer per stream. This deployment consumes by polling, so a
    // delivery arriving by webhook must NOT also be processed.
    return { status: 409, body: fail("TELEGRAM_MODE_CONFLICT", "This deployment consumes Telegram updates by polling.", ctx.requestId) };
  }
  if (resolution.updateMode !== "webhook") {
    return { status: 503, body: fail("TELEGRAM_UPDATES_OFF", "Telegram update consumption is disabled.", ctx.requestId) };
  }
  const expected = resolution.webhookSecret?.reveal() ?? null;
  const presented = ctx.req.headers["x-telegram-bot-api-secret-token"];
  const presentedValue = Array.isArray(presented) ? presented[0] : presented;
  if (expected === null || !webhookSecretMatches(expected, presentedValue ?? null)) {
    cap.log({ level: "warn", event: "telegram.webhook_unauthorized", requestId: ctx.requestId });
    return { status: 401, body: fail("UNAUTHENTICATED", "Unauthenticated.", ctx.requestId) };
  }

  // A TIGHTER CAP THAN THE JSON DEFAULT, because a Telegram update is small by
  // construction: the schema accepts a message, a caption and file REFERENCES,
  // never file bytes. The kernel's 1 MiB default would let a caller who knows the
  // secret make this process buffer far more than any real delivery ever contains.
  // The response mirrors the kernel's own oversized-body contract (400 +
  // VALIDATION_FAILED, `BodyParseError` mapping in kernel/server.ts) rather than
  // inventing a new error code for one route.
  let raw: Buffer;
  try {
    raw = await ctx.readRawBody(ctx.req, TELEGRAM_WEBHOOK_MAX_BODY_BYTES);
  } catch (err) {
    cap.log({ level: "warn", event: "telegram_webhook_body_rejected", requestId: ctx.requestId, code: err instanceof Error ? err.name : "UNKNOWN" });
    return { status: 400, body: fail("VALIDATION_FAILED", "request body too large", ctx.requestId) };
  }
  const result = await cap.pipeline.acceptDeferred(raw, "webhook");
  switch (result.status) {
    case "accepted":
      return { status: 200, body: ok({ accepted: true }) };
    case "duplicate":
      // Delivered, already handled. Answering anything else would make Telegram
      // retry forever.
      return { status: 200, body: ok({ accepted: false, duplicate: true }) };
    case "malformed":
      // Telegram itself always sends a well-formed update, so this is a foreign
      // caller: refuse it rather than pretend it was accepted.
      return { status: 400, body: fail("VALIDATION_FAILED", "Malformed update.", ctx.requestId, { reason: result.reason }) };
    case "wrong_consumer":
      return { status: 409, body: fail("TELEGRAM_MODE_CONFLICT", "This deployment does not consume updates by webhook.", ctx.requestId) };
  }
}

// ── Authenticated surface ───────────────────────────────────────────────────

/** Shared preamble: capability, bearer identity, per-user rate limit. */
async function authenticated(
  ctx: ExtendedRouteContext,
  operation: "telegram:link-start" | "telegram:channel",
): Promise<{ cap: TelegramCapability; userId: string } | RouteResult> {
  const cap = capability(ctx);
  const resolution = cap?.config() ?? null;
  if (cap === null || resolution === null || !resolution.configured) return capabilityAbsent(ctx, "Telegram");

  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);
  const userId = claims.sub; // server-verified; never a client-supplied id

  // Throttled by USER, not by IP: a shared office NAT must not throttle a
  // colleague, and a leaked token must not be usable as an amplification path.
  const decision = await cap.limiter.hit(operation, `user:${userId}`);
  if (!decision.allowed) {
    return {
      status: 429,
      body: fail("RATE_LIMITED", "Too many requests.", ctx.requestId, { retryAfterSec: decision.retryAfterSec }),
      headers: { "Retry-After": String(decision.retryAfterSec) },
    };
  }
  return { cap, userId };
}

/**
 * `GET /api/v1/telegram/status` — what the Settings screen renders.
 *
 * Reports the FULL state vocabulary the UI has to distinguish — including the
 * error state — and never leaks the raw Telegram user id (only its last four
 * digits). "Not linked", "pending", "expired", "revoked" and "read failure" are
 * different screens with different actions; collapsing them would make the UI
 * guess.
 */
async function handleStatus(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  if (ctx.method !== "GET") return null;
  const cap = capability(ctx);
  const resolution = cap?.config() ?? null;
  if (cap === null || resolution === null || !resolution.configured) return capabilityAbsent(ctx, "Telegram");
  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);

  const status = await cap.links.status(claims.sub);
  const channel = await cap.store.findActiveChannel(claims.sub);
  return {
    status: 200,
    body: ok({
      // Safe to expose: a username is public by construction, the id is masked.
      bot: { username: resolution.botUsername, deepLinkAvailable: resolution.linkingConfigured },
      updateMode: resolution.updateMode,
      state: status.state,
      identity: status.identity,
      pendingLinkExpiresAt: status.pendingExpiresAt,
      channel: channel === null ? null : channelSummary(channel),
    }),
  };
}

/**
 * `POST /api/v1/telegram/link/start` — mint the one-time deep link.
 *
 * Returns the link and its expiry so the UI can show a countdown; the token is
 * opaque and single-use, and nothing about the account travels in it.
 */
async function handleLinkStart(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  if (ctx.method !== "POST") return null;
  const gate = await authenticated(ctx, "telegram:link-start");
  if ("status" in gate) return gate;

  const resolution = gate.cap.config();
  if (!resolution.linkingConfigured || resolution.botUsername === null) {
    // The bot exists but cannot build a link (no username or no public app URL):
    // say which capability is missing instead of returning a broken URL.
    return { status: 503, body: fail("TELEGRAM_LINKING_UNAVAILABLE", "Telegram linking is not configured.", ctx.requestId) };
  }
  try {
    const result = await gate.cap.links.startLinking(gate.userId, ctx.requestId);
    return { status: 200, body: ok({ deepLink: result.deepLink, expiresAt: result.expiresAt }) };
  } catch (err) {
    // A refusal here is an account-state conflict (already linked), not a server
    // fault — the service's own typed error carries the precise code.
    const code = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "LINK_START_FAILED";
    const status = err instanceof Error && "status" in err ? Number((err as { status: unknown }).status) : 500;
    gate.cap.log({ level: "warn", event: "telegram.link_start_failed", code });
    return { status: status >= 400 && status < 500 ? status : 500, body: fail(code, "Could not start Telegram linking.", ctx.requestId) };
  }
}

/** `POST /api/v1/telegram/link/unlink` — revoke this account's live link. */
async function handleUnlink(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  if (ctx.method !== "POST") return null;
  const cap = capability(ctx);
  const resolution = cap?.config() ?? null;
  if (cap === null || resolution === null || !resolution.configured) return capabilityAbsent(ctx, "Telegram");
  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);

  try {
    const result = await cap.links.unlink(claims.sub, ctx.requestId);
    return { status: 200, body: ok({ unlinked: result.revokedTelegramUserId !== null }) };
  } catch (err) {
    // NOT_LINKED is a 409, not a server fault: the caller asked to remove a
    // connection that does not exist, and the answer must say so rather than
    // surfacing a 500. Anything genuinely unexpected still becomes a 500.
    const code = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "UNLINK_FAILED";
    const status = err instanceof Error && "status" in err ? Number((err as { status: unknown }).status) : 500;
    return { status: status >= 400 && status < 500 ? status : 500, body: fail(code, "Could not remove the Telegram connection.", ctx.requestId) };
  }
}

/**
 * `GET`/`DELETE /api/v1/telegram/channel` — the optional journal mirror.
 *
 * There is deliberately NO POST here: a channel is bound from Telegram by
 * `/channel <chat id>`, because binding requires the server to verify with the
 * Bot API that the bot is a member with posting rights. Accepting a chat id from
 * a web form and trusting it would be exactly the "assume the client told the
 * truth" mistake this design avoids. Unbinding, by contrast, only ever removes
 * something the caller owns.
 */
async function handleChannel(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  if (ctx.method !== "GET" && ctx.method !== "DELETE") return null;
  const cap = capability(ctx);
  const resolution = cap?.config() ?? null;
  if (cap === null || resolution === null || !resolution.configured) return capabilityAbsent(ctx, "Telegram");
  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);

  if (ctx.method === "DELETE") {
    const gate = await authenticated(ctx, "telegram:channel");
    if ("status" in gate) return gate;
    const channel = await cap.store.findActiveChannel(claims.sub);
    if (channel === null) return notFound(ctx, "No active Telegram channel.");
    const revoked = await cap.store.revokeChannel(claims.sub, channel.chatId, new Date());
    if (!revoked) return notFound(ctx, "No active Telegram channel.");
    await cap.audit.append({
      action: "TELEGRAM_CHANNEL_UNBOUND",
      actorUserId: claims.sub,
      targetUserId: claims.sub, // self-service: the actor IS the owner
      beforeState: channel.status,
      afterState: "REVOKED",
      outcome: "success",
      provider: "TELEGRAM",
      requestId: ctx.requestId,
      occurredAt: new Date(),
    });
    return { status: 200, body: ok({ channel: null }) };
  }

  const channel = await cap.store.findActiveChannel(claims.sub);
  return { status: 200, body: ok({ channel: channel === null ? null : channelSummary(channel) }) };
}

/** The channel shape the UI may see. Never the raw chat id beyond its title. */
function channelSummary(channel: TelegramChannelRecord): Record<string, unknown> {
  return {
    title: channel.title,
    chatType: channel.chatType,
    status: channel.status,
    canPost: channel.canPost,
    verifiedAt: channel.verifiedAt,
  };
}
