// Password reset + verification resend — Phase 3B-1 unit evidence.
//
// Uses the REAL crypto stack (VeloraHasher + JwtService) with the in-memory
// UserStore and the log MailPort, so token/session behavior is exercised for
// real while nothing leaves the process.
//
// Security properties under test (owner-approved contract):
//   - no account enumeration on forgot-password or resend-verification
//   - reset token: single-use, TTL-bounded, hash-stored (raw never persisted)
//   - successful reset revokes ALL sessions
//   - distinct token failures: 400 invalid / 410 expired / 409 reused

import { test } from "node:test";
import assert from "node:assert/strict";

import { AuthService, AuthError, PASSWORD_RESET_TOKEN_TTL_MS } from "./authService.js";
import { MemoryUserStore } from "./memoryUserStore.js";
import { VeloraHasher } from "./hashing.js";
import { JwtService } from "./jwt.js";
import { LogMailProvider } from "../mail/logMailProvider.js";

const SECRET = "password-reset-unit-test-secret-0123456789abcdef";
const PASSWORD = "a-strong-password-123";
const NEW_PASSWORD = "an-even-stronger-password-456";

interface Harness {
  store: MemoryUserStore;
  service: AuthService;
  mail: LogMailProvider;
  tokens: string[];
  setNow: (d: Date) => void;
}

let counter = 0;

function makeService(start = new Date("2026-09-14T10:00:00Z")): Harness {
  const store = new MemoryUserStore();
  const mail = new LogMailProvider();
  const tokens: string[] = [];
  let current = start;
  const now = (): Date => current;

  const service = new AuthService({
    store,
    hasher: new VeloraHasher(),
    jwt: JwtService.create(SECRET, { now: () => Math.floor(now().getTime() / 1000) }),
    now,
    mail,
    appOrigin: "https://app.velora.example",
    generateVerificationToken: () => {
      const t = `deterministic-reset-token-${++counter}-0123456789abcdef`;
      tokens.push(t);
      return t;
    },
  });

  return { store, service, mail, tokens, setNow: (d) => { current = d; } };
}

async function verifiedUser(h: Harness, email = "user@velora.example"): Promise<void> {
  await h.service.register({ email, password: PASSWORD });
  const token = h.tokens.shift();
  assert.ok(token !== undefined);
  await h.service.verifyEmail(token);
  h.mail.clear();
}

// --- forgot-password: anti-enumeration --------------------------------------

test("FORGOT: known address → uniform success and an email is dispatched", async () => {
  const h = makeService();
  await verifiedUser(h);

  const res = await h.service.forgotPassword({ email: "user@velora.example" });

  assert.deepEqual(res, {
    requested: true,
    messageKey: "auth.passwordResetRequested",
    params: {},
  });
  assert.equal(h.mail.outbox.length, 1);
  assert.ok(h.mail.lastTo("user@velora.example")!.text.includes("/reset-password#token="));
});

test("FORGOT: UNKNOWN address → byte-identical response, NO email (no enumeration)", async () => {
  const h = makeService();
  await verifiedUser(h);
  const known = await h.service.forgotPassword({ email: "user@velora.example" });
  h.mail.clear();

  const unknown = await h.service.forgotPassword({ email: "nobody@velora.example" });

  assert.deepEqual(unknown, known); // responses must be indistinguishable
  assert.equal(h.mail.outbox.length, 0);
});

test("FORGOT: mail transport failure is NOT observable (would leak existence)", async () => {
  const h = makeService();
  await verifiedUser(h);
  // A provider that always throws must not change the response.
  const throwing = {
    name: "throwing",
    send: async (): Promise<never> => {
      throw new Error("provider down");
    },
  };
  const svc = new AuthService({
    store: h.store,
    hasher: new VeloraHasher(),
    jwt: JwtService.create(SECRET),
    mail: throwing,
    appOrigin: "https://app.velora.example",
  });

  const res = await svc.forgotPassword({ email: "user@velora.example" });
  assert.equal(res.requested, true);
});

test("FORGOT: email is case-insensitive and the raw token is never stored", async () => {
  const h = makeService();
  await verifiedUser(h);

  await h.service.forgotPassword({ email: "  USER@VELORA.EXAMPLE  " });
  const raw = h.tokens.at(-1)!;

  // Only the sha256 hash may be persisted.
  assert.equal(await h.store.findPasswordResetByTokenHash(raw), null);
  const { createHash } = await import("node:crypto");
  const hashed = createHash("sha256").update(raw).digest("hex");
  assert.ok((await h.store.findPasswordResetByTokenHash(hashed)) !== null);
});

test("FORGOT: a second request supersedes the first token", async () => {
  const h = makeService();
  await verifiedUser(h);

  await h.service.forgotPassword({ email: "user@velora.example" });
  const first = h.tokens.at(-1)!;
  await h.service.forgotPassword({ email: "user@velora.example" });
  const second = h.tokens.at(-1)!;

  await assert.rejects(
    () => h.service.resetPassword({ token: first, newPassword: NEW_PASSWORD }),
    (e: unknown) => e instanceof AuthError && e.status === 400 && e.code === "INVALID_TOKEN",
  );
  await h.service.resetPassword({ token: second, newPassword: NEW_PASSWORD });
});

// --- reset-password ---------------------------------------------------------

test("RESET: valid token → password changed, new password works, old fails", async () => {
  const h = makeService();
  await verifiedUser(h);
  await h.service.forgotPassword({ email: "user@velora.example" });
  const token = h.tokens.at(-1)!;

  const res = await h.service.resetPassword({ token, newPassword: NEW_PASSWORD });
  assert.deepEqual(res, { reset: true, messageKey: "auth.passwordReset", params: {} });

  const okLogin = await h.service.login({ email: "user@velora.example", password: NEW_PASSWORD });
  assert.ok(okLogin.accessToken.length > 0);
  await assert.rejects(() =>
    h.service.login({ email: "user@velora.example", password: PASSWORD }),
  );
});

test("RESET: token is SINGLE-USE → replay is 409 TOKEN_ALREADY_USED", async () => {
  const h = makeService();
  await verifiedUser(h);
  await h.service.forgotPassword({ email: "user@velora.example" });
  const token = h.tokens.at(-1)!;

  await h.service.resetPassword({ token, newPassword: NEW_PASSWORD });

  await assert.rejects(
    () => h.service.resetPassword({ token, newPassword: "yet-another-password-789" }),
    (e: unknown) => e instanceof AuthError && e.status === 409 && e.code === "TOKEN_ALREADY_USED",
  );
});

test("RESET: expired token → 410 TOKEN_EXPIRED", async () => {
  const start = new Date("2026-09-14T10:00:00Z");
  const h = makeService(start);
  await verifiedUser(h);
  await h.service.forgotPassword({ email: "user@velora.example" });
  const token = h.tokens.at(-1)!;

  h.setNow(new Date(start.getTime() + PASSWORD_RESET_TOKEN_TTL_MS + 1000));

  await assert.rejects(
    () => h.service.resetPassword({ token, newPassword: NEW_PASSWORD }),
    (e: unknown) => e instanceof AuthError && e.status === 410 && e.code === "TOKEN_EXPIRED",
  );
});

test("RESET: token valid right up to the TTL boundary", async () => {
  const start = new Date("2026-09-14T10:00:00Z");
  const h = makeService(start);
  await verifiedUser(h);
  await h.service.forgotPassword({ email: "user@velora.example" });
  const token = h.tokens.at(-1)!;

  h.setNow(new Date(start.getTime() + PASSWORD_RESET_TOKEN_TTL_MS - 1000));
  await h.service.resetPassword({ token, newPassword: NEW_PASSWORD });
});

test("RESET: unknown/garbage token → 400 INVALID_TOKEN", async () => {
  const h = makeService();
  await verifiedUser(h);
  await assert.rejects(
    () => h.service.resetPassword({ token: "not-a-real-token-00000000", newPassword: NEW_PASSWORD }),
    (e: unknown) => e instanceof AuthError && e.status === 400 && e.code === "INVALID_TOKEN",
  );
});

test("RESET: weak password rejected and the token stays UNCONSUMED", async () => {
  const h = makeService();
  await verifiedUser(h);
  await h.service.forgotPassword({ email: "user@velora.example" });
  const token = h.tokens.at(-1)!;

  await assert.rejects(
    () => h.service.resetPassword({ token, newPassword: "short" }),
    (e: unknown) => e instanceof AuthError && e.status === 400 && e.code === "VALIDATION_FAILED",
  );
  // A rejected attempt must not burn the token.
  await h.service.resetPassword({ token, newPassword: NEW_PASSWORD });
});

test("RESET: SUCCESS revokes every active session", async () => {
  const h = makeService();
  await verifiedUser(h);
  const s1 = await h.service.login({ email: "user@velora.example", password: PASSWORD });
  const s2 = await h.service.login({ email: "user@velora.example", password: PASSWORD });

  await h.service.forgotPassword({ email: "user@velora.example" });
  await h.service.resetPassword({ token: h.tokens.at(-1)!, newPassword: NEW_PASSWORD });

  for (const s of [s1, s2]) {
    await assert.rejects(
      () => h.service.refresh(s.refreshToken, {}),
      "refresh must fail after a password reset",
    );
  }
});

// --- resend verification ----------------------------------------------------

test("RESEND: unverified user → email dispatched, uniform response", async () => {
  const h = makeService();
  await h.service.register({ email: "pending@velora.example", password: PASSWORD });
  h.mail.clear();
  h.setNow(new Date("2026-09-14T10:05:00Z")); // clear the 60s retry interval

  const res = await h.service.resendVerification({ email: "pending@velora.example" });

  assert.deepEqual(res, { requested: true, messageKey: "auth.verificationResent", params: {} });
  assert.equal(h.mail.outbox.length, 1);
  assert.ok(h.mail.lastTo("pending@velora.example")!.text.includes("/verify-email#token="));
});

test("RESEND: unknown address → uniform response, NO email (no enumeration)", async () => {
  const h = makeService();
  const res = await h.service.resendVerification({ email: "nobody@velora.example" });
  assert.deepEqual(res, { requested: true, messageKey: "auth.verificationResent", params: {} });
  assert.equal(h.mail.outbox.length, 0);
});

test("RESEND: ALREADY VERIFIED → uniform response, NO email (no status leak)", async () => {
  const h = makeService();
  await verifiedUser(h, "done@velora.example");

  const res = await h.service.resendVerification({ email: "done@velora.example" });

  assert.deepEqual(res, { requested: true, messageKey: "auth.verificationResent", params: {} });
  assert.equal(h.mail.outbox.length, 0);
});

test("RESEND: 60s retry interval is enforced", async () => {
  const start = new Date("2026-09-14T10:00:00Z");
  const h = makeService(start);
  await h.service.register({ email: "pending@velora.example", password: PASSWORD });

  h.setNow(new Date(start.getTime() + 30_000)); // < 60s
  await assert.rejects(
    () => h.service.resendVerification({ email: "pending@velora.example" }),
    (e: unknown) => e instanceof AuthError && e.code === "VERIFICATION_RETRY_DELAY",
  );
});

/**
 * DEFECT-3B1-1 (PRE-EXISTING, documented — not introduced by Phase 3B-1).
 *
 * VERIFICATION_MAX_PER_DAY (3) is currently UNREACHABLE. Both the pre-existing
 * register path (authService.ts, register()) and this resend path call
 * `deleteVerifications(userId)` immediately before `createVerification(...)`,
 * so at most ONE verification row ever exists per user and
 * `countVerificationsSince(user, -24h)` can never exceed 1.
 *
 * This test asserts the behavior that ACTUALLY occurs, so the suite tells the
 * truth rather than an aspiration. It is deliberately NOT "fixed" here:
 * repairing it means changing the pre-existing register/token-retention
 * semantics, which is outside the approved Phase 3B-1 scope (§10) and is
 * reported as a blocker instead.
 *
 * Security note: resend abuse is still bounded — the owner-approved 4/hour
 * dispatch-level limit (auth:resend-verification, OD-14) is enforced in the
 * router, and the 60s retry interval below is enforced and effective.
 */
test("RESEND: DEFECT-3B1-1 — per-24h cap is unreachable (delete-then-create)", async () => {
  const start = new Date("2026-09-14T10:00:00Z");
  const h = makeService(start);
  await h.service.register({ email: "pending@velora.example", password: PASSWORD });

  // Four issuances well past the cap of 3: none is rejected today.
  for (let i = 1; i <= 4; i += 1) {
    h.setNow(new Date(start.getTime() + i * 120_000));
    await h.service.resendVerification({ email: "pending@velora.example" });
  }

  const dayAgo = new Date(start.getTime() - 86_400 * 1000);
  const user = await h.store.findUserByEmail("pending@velora.example");
  assert.equal(
    await h.store.countVerificationsSince(user!.id, dayAgo),
    1,
    "only one verification row survives — this is why the cap cannot trigger",
  );
});

test("RESEND: the newly issued token actually verifies the account", async () => {
  const start = new Date("2026-09-14T10:00:00Z");
  const h = makeService(start);
  await h.service.register({ email: "pending@velora.example", password: PASSWORD });
  h.setNow(new Date(start.getTime() + 120_000));

  await h.service.resendVerification({ email: "pending@velora.example" });
  const token = h.tokens.at(-1)!;

  const v = await h.service.verifyEmail(token);
  assert.equal(v.verified, true);
  assert.equal(v.alreadyVerified, false);
});
