// Telegram ↔ Velora account linking (ADR-018) — the security core.
//
// THE HANDSHAKE, IN ORDER, AND WHY EACH STEP EXISTS
//   1. An AUTHENTICATED Velora user asks to connect Telegram. The server mints
//      32 random bytes, stores ONLY their SHA-256, and returns a deep link. The
//      raw token exists in exactly two places afterwards: the user's clipboard
//      and Telegram's own payload. It is never persisted and never logged.
//   2. The user opens the deep link. The bot hands the payload to this service.
//   3. The token's SHAPE is checked first (a cheap guard), then its HASH is
//      consumed by ONE atomic conditional UPDATE. Consumption is single-use,
//      expiry-enforcing and race-safe because the winner is decided by the
//      engine, not by this code.
//   4. Only after a successful consumption are the two collision rules
//      evaluated: one live Telegram identity per Velora account, and one Velora
//      account per Telegram identity. A refusal is a distinct, non-disclosing
//      code.
//   5. The link is written, the consumed transaction is bound to the identity,
//      and the attempt is audited.
//
// WHAT IS DELIBERATELY IMPOSSIBLE HERE
//   * Resolving a Velora account from a username, display name or bio — the
//     stable numeric id is the only identity, and the link is explicit.
//   * Accepting a token that was not issued by `startLinking` for a real user.
//   * Using a token twice, or using an expired one, or racing two deliveries.
//   * Logging the token: every log line and audit row in this file carries
//     identifiers, never credentials.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  evaluateLinkAdmission,
  isLinkTokenShape,
  refusalForTokenStatus,
  resolveLinkState,
  type LinkRefusalCode,
} from "@velora/domain";
import { telegramDeepLink, TELEGRAM_LINK_TOKEN_TTL_SECONDS, type TelegramLinkState } from "@velora/contracts";
import type { AuditStore } from "../auth/auditStore.js";
import type { TelegramIdentityRecord, TelegramStore } from "./telegramStore.js";

/** Raised for a refusal the WEB surface must render as a typed HTTP error. */
export class TelegramLinkError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TelegramLinkError";
  }
}

export interface TelegramIdentitySummary {
  /** Masked: the last four digits only. The full id is not needed to render "connected". */
  readonly maskedTelegramUserId: string;
  readonly username: string | null;
  readonly linkedAt: string;
  readonly lastSeenAt: string | null;
}

export interface TelegramStatusView {
  readonly state: TelegramLinkState;
  readonly identity: TelegramIdentitySummary | null;
  readonly pendingExpiresAt: string | null;
}

export type CompletionResult =
  | { readonly ok: true; readonly userId: string; readonly alreadyLinked: boolean }
  | { readonly ok: false; readonly code: LinkRefusalCode };

export interface TelegramLinkServiceDeps {
  readonly store: TelegramStore;
  readonly audit: AuditStore;
  /**
   * The bot's public username, read through a thunk so a rotation (or an
   * unconfigured deployment) takes effect without a restart.
   */
  readonly botUsername: () => string | null;
  readonly now?: () => Date;
  readonly tokenTtlSeconds?: number;
  /** Injectable for deterministic tests. Production always uses the default. */
  readonly randomToken?: () => string;
}

/** Mask a Telegram user id for display: `123456789` → `••••6789`. */
export function maskTelegramUserId(telegramUserId: string): string {
  const tail = telegramUserId.slice(-4);
  return `••••${tail}`;
}

export class TelegramLinkService {
  private readonly now: () => Date;
  private readonly ttlSeconds: number;
  private readonly randomToken: () => string;

  constructor(private readonly deps: TelegramLinkServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.ttlSeconds = deps.tokenTtlSeconds ?? TELEGRAM_LINK_TOKEN_TTL_SECONDS;
    this.randomToken = deps.randomToken ?? (() => randomBytes(32).toString("base64url"));
  }

  /**
   * Begin a linking transaction for an AUTHENTICATED Velora user.
   *
   * The user id comes from the verified bearer token at the route layer; this
   * method never accepts a user id from a request body.
   */
  async startLinking(userId: string, requestId: string | null): Promise<{ deepLink: string; expiresAt: string; token: string }> {
    const botUsername = this.deps.botUsername();
    if (botUsername === null) {
      // No bot username means no deep link can exist. Refusing is the only
      // honest answer; inventing a destination would send the user nowhere.
      throw new TelegramLinkError(503, "TELEGRAM_NOT_CONFIGURED", "Telegram linking is not configured.");
    }

    const at = this.now();
    const token = this.randomToken();
    const expiresAt = new Date(at.getTime() + this.ttlSeconds * 1000);
    await this.deps.store.createLinkToken({
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      at,
    });
    await this.deps.audit.append({
      action: "TELEGRAM_LINK_STARTED",
      actorUserId: userId,
      targetUserId: userId,
      beforeState: null,
      afterState: "PENDING",
      requestId,
      occurredAt: at,
      provider: "TELEGRAM",
    });

    // The deep link (not the bare token) is what the UI renders: it is a single
    // click, and it keeps the token inside Telegram's own payload rather than in
    // a visible query string. `token` is returned for renderer flexibility and
    // must never be logged.
    return { deepLink: telegramDeepLink(botUsername, token), expiresAt: expiresAt.toISOString(), token };
  }

  /**
   * Complete a linking handshake from a Telegram `/start <payload>` (or a
   * linking message). Called from the bot path, where the only trusted inputs
   * are the Telegram-supplied identity and the presented payload.
   */
  async completeFromPayload(input: {
    readonly payload: string;
    readonly telegramUserId: string;
    readonly username: string | null;
    readonly requestId: string | null;
  }): Promise<CompletionResult> {
    const at = this.now();
    const payload = input.payload.trim();
    if (!isLinkTokenShape(payload)) {
      // Junk, a truncated paste, or an attempt to offer a crafted value. No
      // lookup is performed and — deliberately — nothing is audited: there is no
      // authenticated actor to attribute it to (0009 requires a non-null actor),
      // and writing an attributable row for unauthenticated noise would let
      // anyone fill the security trail.
      return { ok: false, code: "TOKEN_UNKNOWN" };
    }

    const consumption = await this.deps.store.consumeLinkToken({
      tokenHash: hashToken(payload),
      telegramUserId: input.telegramUserId,
      at,
    });
    if (!consumption.ok) {
      if (consumption.reason === "UNKNOWN") return { ok: false, code: "TOKEN_UNKNOWN" };
      return { ok: false, code: refusalForTokenStatus(consumption.reason === "EXPIRED" ? "EXPIRED" : consumption.reason === "CONSUMED" ? "CONSUMED" : "REVOKED") };
    }
    const userId = consumption.userId;

    // Collision rules, evaluated only after the token was actually spent.
    const [accountLive, identityLive, latestForAccount] = await Promise.all([
      this.deps.store.findLiveIdentityByUserId(userId),
      this.deps.store.findLiveIdentityByTelegramUserId(input.telegramUserId),
      this.deps.store.findLatestIdentityByUserId(userId),
    ]);
    void latestForAccount;

    const admission = evaluateLinkAdmission({
      userId,
      telegramUserId: input.telegramUserId,
      accountLiveTelegramUserId: accountLive === null ? null : accountLive.telegramUserId,
      identityLiveLinkUserId: identityLive === null ? null : identityLive.userId,
    });

    if (!admission.ok) {
      await this.deps.audit.append({
        action: "TELEGRAM_LINK_FAILED",
        actorUserId: userId,
        targetUserId: userId,
        beforeState: "PENDING",
        afterState: admission.code,
        requestId: input.requestId,
        occurredAt: at,
        provider: "TELEGRAM",
      });
      return { ok: false, code: admission.code };
    }

    if (admission.idempotent) {
      // Already linked to this very account. The token was legitimately spent on
      // a no-op, which is success from the user's point of view.
      await this.deps.audit.append({
        action: "TELEGRAM_LINK_COMPLETED",
        actorUserId: userId,
        targetUserId: userId,
        beforeState: "LINKED",
        afterState: "LINKED",
        requestId: input.requestId,
        occurredAt: at,
        provider: "TELEGRAM",
      });
      return { ok: true, userId, alreadyLinked: true };
    }

    const inserted = await this.deps.store.insertLiveIdentity({
      userId,
      telegramUserId: input.telegramUserId,
      username: input.username,
      at,
    });
    if (!inserted.ok) {
      // Lost a race against a concurrent link. Report the true reason rather than
      // a generic failure, and mint no link.
      const code: LinkRefusalCode = inserted.reason === "IDENTITY_TAKEN" ? "IDENTITY_LINKED_TO_OTHER_ACCOUNT" : "ACCOUNT_ALREADY_LINKED";
      await this.deps.audit.append({
        action: "TELEGRAM_LINK_FAILED",
        actorUserId: userId,
        targetUserId: userId,
        beforeState: "PENDING",
        afterState: code,
        requestId: input.requestId,
        occurredAt: at,
        provider: "TELEGRAM",
      });
      return { ok: false, code };
    }

    await this.deps.store.attachConsumedIdentity(consumption.tokenId, inserted.identity.id);
    await this.deps.audit.append({
      action: "TELEGRAM_LINK_COMPLETED",
      actorUserId: userId,
      targetUserId: userId,
      beforeState: "PENDING",
      afterState: "LINKED",
      requestId: input.requestId,
      occurredAt: at,
      provider: "TELEGRAM",
    });
    return { ok: true, userId, alreadyLinked: false };
  }

  /**
   * Revoke the caller's own Telegram link.
   *
   * Ownership is enforced by the store's `(user_id, identity_id)` predicate, so
   * a user cannot unlink somebody else even with a guessed identity id, and the
   * status filter makes a second unlink a clean NOT_LINKED rather than a silent
   * success.
   */
  async unlink(userId: string, requestId: string | null): Promise<{ revokedTelegramUserId: string | null }> {
    const at = this.now();
    const live = await this.deps.store.findLiveIdentityByUserId(userId);
    if (live === null) {
      throw new TelegramLinkError(409, "NOT_LINKED", "No Telegram account is connected.");
    }
    const revoked = await this.deps.store.revokeIdentity(userId, live.id, at);
    if (!revoked) throw new TelegramLinkError(409, "NOT_LINKED", "No Telegram account is connected.");
    await this.deps.audit.append({
      action: "TELEGRAM_UNLINKED",
      actorUserId: userId,
      targetUserId: userId,
      beforeState: "LINKED",
      afterState: "REVOKED",
      requestId,
      occurredAt: at,
      provider: "TELEGRAM",
    });
    return { revokedTelegramUserId: live.telegramUserId };
  }

  /** The connection view the web application renders. */
  async status(userId: string): Promise<TelegramStatusView> {
    const at = this.now();
    try {
      const [live, latest, token] = await Promise.all([
        this.deps.store.findLiveIdentityByUserId(userId),
        this.deps.store.findLatestIdentityByUserId(userId),
        this.deps.store.findLatestTokenByUserId(userId),
      ]);
      const state = resolveLinkState({
        identity: latest === null ? null : toView(latest),
        latestToken:
          token === null
            ? null
            : {
                status: token.status,
                expiresAt: token.expiresAt,
                createdAt: token.createdAt,
                consumedAt: token.consumedAt,
                revokedAt: token.revokedAt,
              },
        at,
      });
      return {
        state,
        identity:
          live === null
            ? null
            : {
                maskedTelegramUserId: maskTelegramUserId(live.telegramUserId),
                username: live.username,
                linkedAt: live.linkedAt,
                lastSeenAt: live.lastSeenAt,
              },
        pendingExpiresAt: state === "LINK_PENDING" && token !== null ? token.expiresAt : null,
      };
    } catch {
      // A storage failure must NOT be reported as NOT_LINKED (see resolveLinkState).
      return { state: "LINK_ERROR", identity: null, pendingExpiresAt: null };
    }
  }

  /**
   * The AUTHORIZATION BRIDGE: Telegram identity → Velora user.
   *
   * Every bot action resolves its owner through this method and never through
   * anything the message contains. A message cannot name a user id, so a
   * message cannot escalate.
   */
  async resolveUserId(telegramUserId: string): Promise<string | null> {
    const identity = await this.deps.store.findLiveIdentityByTelegramUserId(telegramUserId);
    return identity === null ? null : identity.userId;
  }

  /** Record inbound activity. Observability only — this is not a session. */
  async touch(identityId: string): Promise<void> {
    await this.deps.store.touchIdentity(identityId, this.now()).catch(() => undefined);
  }
}

/** SHA-256 of the raw token. The only form that is ever stored. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two token hashes.
 *
 * Only used where a hash is compared outside SQL. The database equality check in
 * `consumeLinkToken` is the primary mechanism; this exists so any future caller
 * has a safe primitive rather than reaching for `===`.
 */
export function tokenHashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function toView(identity: TelegramIdentityRecord): {
  status: "LINKED" | "REVOKED";
  revokedAt: string | null;
  telegramUserId: string;
  username: string | null;
  linkedAt: string;
  lastSeenAt: string | null;
} {
  return {
    status: identity.status,
    revokedAt: identity.revokedAt,
    telegramUserId: identity.telegramUserId,
    username: identity.username,
    linkedAt: identity.linkedAt,
    lastSeenAt: identity.lastSeenAt,
  };
}
