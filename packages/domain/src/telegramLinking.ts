// Telegram account-linking policy — pure decisions (ADR-018).
//
// WHY THIS IS IN packages/domain
//   "Is this link usable?", "what should the user be told they are?", and "may
//   this Telegram identity be attached to this account?" are business rules, not
//   transport concerns. They must hold identically for the web route, the bot
//   handler and the tests, and they must be provable without a database.
//
// THE INVARIANTS THIS FILE ENCODES
//   1. A token is usable only while PENDING and unexpired. Everything else —
//      unknown, consumed, revoked, expired — is a REFUSAL with its own code, so
//      the failure is diagnosable without ever disclosing whether some other
//      account's token exists.
//   2. Usage is consumed atomically by the STORE (a conditional UPDATE); this
//      module only decides whether the attempt is even admissible. There is no
//      check-then-use sequence any caller could reorder into a race.
//   3. A Velora account has at most one live Telegram identity, and a Telegram
//      identity belongs to at most one Velora account. Re-linking the SAME pair
//      is idempotent success, not an error — the user did nothing wrong.
import type { TelegramLinkState } from "@velora/contracts";

/** The observable state of a Telegram identity, as the database stores it. */
export interface LinkIdentityView {
  readonly status: "LINKED" | "REVOKED";
  readonly revokedAt: string | null;
  readonly telegramUserId: string;
  readonly username: string | null;
  readonly linkedAt: string;
  readonly lastSeenAt: string | null;
}

/** The observable state of a one-time linking transaction. */
export interface LinkTokenView {
  readonly status: "PENDING" | "CONSUMED" | "EXPIRED" | "REVOKED";
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
}

/**
 * Resolve what the USER should be told.
 *
 * ORDER IS THE DECISION. A live link outranks a pending transaction (a linked
 * user who starts another connect flow is still linked, and telling them
 * otherwise would invite a pointless re-link), and every indeterminate input —
 * including a read failure — becomes `LINK_ERROR` rather than a false
 * `NOT_LINKED`. Reporting "not connected" to a connected user is a security
 * hazard, not a cosmetic one: it is an invitation to link again.
 */
export function resolveLinkState(input: {
  readonly identity: LinkIdentityView | null;
  readonly latestToken: LinkTokenView | null;
  readonly at: Date;
  readonly failed?: boolean;
}): TelegramLinkState {
  if (input.failed === true) return "LINK_ERROR";
  if (input.identity !== null && input.identity.status === "LINKED") return "LINKED";

  const token = input.latestToken;
  if (token !== null) {
    if (token.status === "PENDING") {
      return isTokenExpired(token, input.at) ? "LINK_EXPIRED" : "LINK_PENDING";
    }
    if (token.status === "EXPIRED") return "LINK_EXPIRED";
  }

  if (input.identity !== null && input.identity.status === "REVOKED") return "LINK_REVOKED";
  return "NOT_LINKED";
}

/** A pending transaction is usable only strictly before its expiry instant. */
export function isTokenExpired(token: LinkTokenView, at: Date): boolean {
  const expires = Date.parse(token.expiresAt);
  if (Number.isNaN(expires)) return true; // unparseable expiry is not a licence to proceed
  return at.getTime() >= expires;
}

/** Reasons a linking attempt may be refused. Stable, non-disclosing codes. */
export const LINK_REFUSAL_CODES = [
  /** No such token. Also returned for a well-formed token that never existed. */
  "TOKEN_UNKNOWN",
  /** Past its expiry instant. */
  "TOKEN_EXPIRED",
  /** Already spent — the replay case, and the race loser's case. */
  "TOKEN_ALREADY_CONSUMED",
  /** Revoked by the user (a newer flow superseded it, or an explicit cancel). */
  "TOKEN_REVOKED",
  /** This Telegram identity is already linked to a DIFFERENT Velora account. */
  "IDENTITY_LINKED_TO_OTHER_ACCOUNT",
  /** This Velora account already has a DIFFERENT live Telegram identity. */
  "ACCOUNT_ALREADY_LINKED",
  /** Nothing to unlink: the identity is not linked to this account. */
  "NOT_LINKED",
  /** The token is well-formed but not admissible for this operation. */
  "TOKEN_NOT_USABLE",
] as const;
export type LinkRefusalCode = (typeof LINK_REFUSAL_CODES)[number];

/** Map a stored token status onto its refusal code (for the non-usable cases). */
export function refusalForTokenStatus(status: LinkTokenView["status"]): LinkRefusalCode {
  switch (status) {
    case "CONSUMED":
      return "TOKEN_ALREADY_CONSUMED";
    case "REVOKED":
      return "TOKEN_REVOKED";
    case "EXPIRED":
      return "TOKEN_EXPIRED";
    case "PENDING":
      return "TOKEN_NOT_USABLE";
  }
}

/**
 * Whether a link may be created for this (account, Telegram identity) pair.
 *
 * `sameAccount` is compared on the STABLE numeric id, never on a username: a
 * username can be transferred between humans, so treating it as identity would
 * hand one person's journal to another.
 */
export function evaluateLinkAdmission(input: {
  readonly userId: string;
  readonly telegramUserId: string;
  /** The Telegram user id of THIS account's live identity, or null when none. */
  readonly accountLiveTelegramUserId: string | null;
  /** The Velora user id owning this Telegram identity's live link, or null. */
  readonly identityLiveLinkUserId: string | null;
}): { readonly ok: true; readonly idempotent: boolean } | { readonly ok: false; readonly code: LinkRefusalCode } {
  // Order matters: the idempotent case is checked first, because "already linked
  // to you" would otherwise trip the account-is-linked rule below and turn a
  // harmless repeat into an error.
  if (input.accountLiveTelegramUserId !== null && input.accountLiveTelegramUserId === input.telegramUserId) {
    return { ok: true, idempotent: true };
  }
  if (input.identityLiveLinkUserId !== null && input.identityLiveLinkUserId !== input.userId) {
    return { ok: false, code: "IDENTITY_LINKED_TO_OTHER_ACCOUNT" };
  }
  if (input.accountLiveTelegramUserId !== null) {
    return { ok: false, code: "ACCOUNT_ALREADY_LINKED" };
  }
  return { ok: true, idempotent: false };
}

/**
 * Shape check for an opaque linking token.
 *
 * The bot receives whatever the deep link contains, including junk, so the
 * shape is rejected BEFORE any database lookup: a 43-character base64url string
 * is what 32 random bytes produce, and anything else cannot be a token this
 * system issued. This is a cheap guard, never a substitute for the hashed
 * lookup — the hash comparison is what actually authenticates the token.
 */
export function isLinkTokenShape(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** True when the presented string is a plausible Telegram bot deep-link payload. */
export function extractStartPayload(text: string): string | null {
  const match = /^\/start(?:@[A-Za-z0-9_]{3,32})?(?:\s+(\S+))?$/.exec(text.trim());
  if (match === null) return null;
  const payload = match[1];
  return payload === undefined ? "" : payload;
}

/** A one-line, non-sensitive description of a link for the UI/logs. */
export function describeLink(identity: LinkIdentityView): string {
  const handle = identity.username === null ? "" : ` (@${identity.username})`;
  return `telegram:${identity.telegramUserId}${handle}`;
}
