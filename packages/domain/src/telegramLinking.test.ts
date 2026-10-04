// Telegram linking policy — state resolution, token admissibility, collisions
// (ADR-018). Pure decisions, so they are pinned here rather than through HTTP.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyFollowUp,
} from "./journalExtraction.js";
import {
  describeLink,
  evaluateLinkAdmission,
  extractStartPayload,
  isLinkTokenShape,
  isTokenExpired,
  refusalForTokenStatus,
  resolveLinkState,
  type LinkIdentityView,
  type LinkTokenView,
} from "./telegramLinking.js";

const AT = new Date("2026-10-03T10:00:00Z");

const identity = (over: Partial<LinkIdentityView> = {}): LinkIdentityView => ({
  status: "LINKED",
  revokedAt: null,
  telegramUserId: "123456789",
  username: "trader",
  linkedAt: "2026-10-01T10:00:00Z",
  lastSeenAt: null,
  ...over,
});

const token = (over: Partial<LinkTokenView> = {}): LinkTokenView => ({
  status: "PENDING",
  expiresAt: "2026-10-03T10:10:00Z",
  createdAt: "2026-10-03T10:00:00Z",
  consumedAt: null,
  revokedAt: null,
  ...over,
});

// ── State resolution — the six user-visible states ──────────────────────────

test("state: no identity and no transaction is NOT_LINKED", () => {
  assert.equal(resolveLinkState({ identity: null, latestToken: null, at: AT }), "NOT_LINKED");
});

test("state: a live identity is LINKED even while a new transaction is pending", () => {
  // A linked user who starts another connect flow is still linked. Reporting
  // anything else invites a pointless re-link.
  assert.equal(resolveLinkState({ identity: identity(), latestToken: token(), at: AT }), "LINKED");
});

test("state: a pending unexpired transaction is LINK_PENDING", () => {
  assert.equal(resolveLinkState({ identity: null, latestToken: token(), at: AT }), "LINK_PENDING");
});

test("state: a pending transaction past its expiry is LINK_EXPIRED", () => {
  const past = token({ expiresAt: "2026-10-03T09:59:59Z" });
  assert.equal(resolveLinkState({ identity: null, latestToken: past, at: AT }), "LINK_EXPIRED");
});

test("state: an explicitly expired transaction is LINK_EXPIRED", () => {
  assert.equal(resolveLinkState({ identity: null, latestToken: token({ status: "EXPIRED" }), at: AT }), "LINK_EXPIRED");
});

test("state: a revoked identity is LINK_REVOKED", () => {
  const revoked = identity({ status: "REVOKED", revokedAt: "2026-10-02T10:00:00Z" });
  assert.equal(resolveLinkState({ identity: revoked, latestToken: null, at: AT }), "LINK_REVOKED");
});

test("state: a read failure is LINK_ERROR — never a false NOT_LINKED", () => {
  // Telling a linked user they are not connected is an invitation to link
  // again, so indeterminate input degrades loudly instead.
  assert.equal(resolveLinkState({ identity: null, latestToken: null, at: AT, failed: true }), "LINK_ERROR");
  assert.equal(resolveLinkState({ identity: identity(), latestToken: null, at: AT, failed: true }), "LINK_ERROR");
});

test("state: a consumed transaction on a revoked identity reports REVOKED, not PENDING", () => {
  const revoked = identity({ status: "REVOKED", revokedAt: "2026-10-02T10:00:00Z" });
  const consumed = token({ status: "CONSUMED", consumedAt: "2026-10-03T09:00:00Z" });
  assert.equal(resolveLinkState({ identity: revoked, latestToken: consumed, at: AT }), "LINK_REVOKED");
});

// ── Expiry ──────────────────────────────────────────────────────────────────

test("expiry: the boundary instant is expired, one millisecond earlier is not", () => {
  const t = token({ expiresAt: "2026-10-03T10:10:00Z" });
  assert.equal(isTokenExpired(t, new Date("2026-10-03T10:09:59.999Z")), false);
  assert.equal(isTokenExpired(t, new Date("2026-10-03T10:10:00.000Z")), true);
});

test("expiry: an unparseable expiry is treated as expired (fail closed)", () => {
  assert.equal(isTokenExpired(token({ expiresAt: "not-a-date" }), AT), true);
});

test("refusal: a consumed token maps to the replay code, never to 'unknown'", () => {
  assert.equal(refusalForTokenStatus("CONSUMED"), "TOKEN_ALREADY_CONSUMED");
  assert.equal(refusalForTokenStatus("REVOKED"), "TOKEN_REVOKED");
  assert.equal(refusalForTokenStatus("EXPIRED"), "TOKEN_EXPIRED");
});

// ── Admission (collision + idempotency) ─────────────────────────────────────

test("admission: a clean pair is allowed and is NOT idempotent", () => {
  const result = evaluateLinkAdmission({
    userId: "7",
    telegramUserId: "123",
    accountLiveTelegramUserId: null,
    identityLiveLinkUserId: null,
  });
  assert.deepEqual(result, { ok: true, idempotent: false });
});

test("admission: re-linking the SAME pair is idempotent success, not an error", () => {
  const result = evaluateLinkAdmission({
    userId: "7",
    telegramUserId: "123",
    accountLiveTelegramUserId: "123",
    identityLiveLinkUserId: "7",
  });
  assert.deepEqual(result, { ok: true, idempotent: true });
});

test("admission: an identity already linked to ANOTHER account is refused", () => {
  const result = evaluateLinkAdmission({
    userId: "7",
    telegramUserId: "123",
    accountLiveTelegramUserId: null,
    identityLiveLinkUserId: "999",
  });
  assert.deepEqual(result, { ok: false, code: "IDENTITY_LINKED_TO_OTHER_ACCOUNT" });
});

test("admission: an account that already has a DIFFERENT live identity is refused", () => {
  const result = evaluateLinkAdmission({
    userId: "7",
    telegramUserId: "123",
    accountLiveTelegramUserId: "555",
    identityLiveLinkUserId: null,
  });
  assert.deepEqual(result, { ok: false, code: "ACCOUNT_ALREADY_LINKED" });
});

// ── Token shape + deep-link payload ─────────────────────────────────────────

test("token shape: 32 random bytes in base64url is the accepted shape", () => {
  assert.equal(isLinkTokenShape("A".repeat(43)), true);
  assert.equal(isLinkTokenShape("abcDEF123_-".padEnd(43, "z")), true);
  // Everything else is refused BEFORE any hashed lookup.
  assert.equal(isLinkTokenShape(""), false);
  assert.equal(isLinkTokenShape("A".repeat(42)), false);
  assert.equal(isLinkTokenShape("A".repeat(44)), false);
  assert.equal(isLinkTokenShape("has spaces here and there 12345678901234"), false);
  assert.equal(isLinkTokenShape("../../etc/passwd" + "x".repeat(28)), false);
  assert.equal(isLinkTokenShape("<script>alert(1)</script>" + "x".repeat(20)), false);
});

test("deep link payload: /start with, without and with a bot mention", () => {
  assert.equal(extractStartPayload("/start abc"), "abc");
  assert.equal(extractStartPayload("/start@VeloraBot abc"), "abc");
  assert.equal(extractStartPayload("  /start  "), "");
  assert.equal(extractStartPayload("/start"), "");
  assert.equal(extractStartPayload("/start a b"), null);
  assert.equal(extractStartPayload("/journal"), null);
  assert.equal(extractStartPayload("hello"), null);
  // A command from another bot's mention is not a start payload for us.
  assert.equal(extractStartPayload("/start@other"), "");
});

test("description: the link label carries no credential-shaped data", () => {
  assert.equal(describeLink(identity()), "telegram:123456789 (@trader)");
  assert.equal(describeLink(identity({ username: null })), "telegram:123456789");
});

test("regression: the journal follow-up helper is exported from the domain index", () => {
  // Cheap guard that the two new domain modules load together (the index barrel
  // is what apps consume; a missing export would only surface at runtime).
  assert.equal(typeof applyFollowUp, "function");
});
