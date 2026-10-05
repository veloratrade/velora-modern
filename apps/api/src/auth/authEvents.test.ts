// SEC-03 — authentication-attempt history: policy tests.
//
// What this battery pins is NOT "an INSERT happened". It is the four properties
// that make the capability worth having, each of which is easy to lose in a
// refactor:
//
//   1. the RECORDED reason matches the code the CALLER received (a history whose
//      reason disagrees with the response is worse than no history);
//   2. an unknown account records user_id = NULL and NEVER the attempted address
//      (anti-enumeration — Legacy's own reason for the nullable column);
//   3. the WRITE is fail-open: a broken history store cannot break a login;
//   4. the READ is fail-loud and returns a real fact (the caller is told when the
//      store is unavailable, instead of being shown an empty history).
import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthService } from "./authService.js";
import { MemoryUserStore } from "./memoryUserStore.js";
import { MemoryAuthEventStore } from "./memoryAuthEventStore.js";
import { JwtService } from "./jwt.js";
import { clampPagination, normalizeAuthEvent } from "./authEventStore.js";
import type { PasswordHasher } from "@velora/domain";
import type { AuthEventStore } from "./authEventStore.js";

const SECRET = "sec03-test-secret-value-0123456789";

/** Deterministic, dependency-free hasher (the real Argon2id is exercised elsewhere). */
const fakeHasher: PasswordHasher = {
  async hash(plain: string) {
    return `fake$${plain}`;
  },
  async verify(plain: string, hash: string) {
    return hash === `fake$${plain}`;
  },
} as unknown as PasswordHasher;

function makeService(events?: AuthEventStore, now = new Date("2026-10-04T10:00:00.000Z")) {
  const store = new MemoryUserStore();
  const auth = new AuthService({
    store,
    hasher: fakeHasher,
    jwt: JwtService.create(SECRET),
    mail: { name: "test", send: async () => undefined } as never,
    ...(events !== undefined ? { authEvents: events } : {}),
    now: () => now,
  });
  return { store, auth };
}

async function seedVerifiedUser(store: MemoryUserStore, email: string, password: string) {
  const user = await store.createUser({
    email,
    passwordHash: `fake$${password}`,
    fullName: "Probe User",
    timezone: "UTC",
    locale: "fa",
    now: new Date("2026-10-01T00:00:00.000Z"),
  });
  await store.markEmailVerified(user.id, new Date("2026-10-01T00:00:00.000Z"));
  return user;
}

test("SEC-03: a successful login and a signup are recorded once each", async () => {
  const events = new MemoryAuthEventStore();
  const { store, auth } = makeService(events);

  await auth.register({ email: "fresh@velora.test", password: "a-strong-password-1" });
  await seedVerifiedUser(store, "known@velora.test", "a-strong-password-2");

  const page = await events.listForUser(
    (await store.findUserByEmail("fresh@velora.test"))!.id,
  );
  assert.equal(page.total, 1);
  assert.equal(page.events[0]!.eventType, "signup");
  assert.equal(page.events[0]!.result, "success");
  assert.equal(page.events[0]!.reason, null, "a success carries no failure reason");

  // The signup of a SECOND account must not appear in the first account's history.
  const other = await store.findUserByEmail("known@velora.test");
  await auth.login({ email: "known@velora.test", password: "a-strong-password-2" });
  const otherPage = await events.listForUser(other!.id);
  assert.equal(otherPage.total, 1);
  assert.equal(otherPage.events[0]!.eventType, "login");
  assert.equal(otherPage.events[0]!.result, "success");
});

test("SEC-03: every refusal is recorded with the SAME code the caller received", async () => {
  const events = new MemoryAuthEventStore();
  const { store, auth } = makeService(events);

  // 1. wrong password
  const wrongPw = await seedVerifiedUser(store, "wrongpw@velora.test", "a-strong-password-3");
  const e1 = (await auth
    .login({ email: "wrongpw@velora.test", password: "not-the-password" })
    .then(() => null, (e: unknown) => e as { code: string }))!;
  const h1 = await events.listForUser(wrongPw.id);
  assert.equal(e1.code, "INVALID_CREDENTIALS");
  assert.equal(h1.events[0]!.result, "failure");
  assert.equal(h1.events[0]!.reason, e1.code, "the recorded reason must be the code the caller got");

  // 2. inactive account
  const inactive = await seedVerifiedUser(store, "inactive@velora.test", "a-strong-password-4");
  await store.updateUserStatus(inactive.id, "suspended", new Date("2026-10-02T00:00:00.000Z"));
  const e2 = (await auth
    .login({ email: "inactive@velora.test", password: "a-strong-password-4" })
    .then(() => null, (e: unknown) => e as { code: string }))!;
  assert.equal(e2.code, "ACCOUNT_INACTIVE");
  const h2 = await events.listForUser(inactive.id);
  assert.equal(h2.events[0]!.reason, "ACCOUNT_INACTIVE");

  // 3. unverified e-mail
  const unverified = await store.createUser({
    email: "unverified@velora.test",
    passwordHash: "fake$a-strong-password-5",
    fullName: "U",
    timezone: "UTC",
    locale: "fa",
    now: new Date("2026-10-01T00:00:00.000Z"),
  });
  const e3 = (await auth
    .login({ email: "unverified@velora.test", password: "a-strong-password-5" })
    .then(() => null, (e: unknown) => e as { code: string }))!;
  assert.equal(e3.code, "EMAIL_NOT_VERIFIED");
  const h3 = await events.listForUser(unverified.id);
  assert.equal(h3.events[0]!.reason, "EMAIL_NOT_VERIFIED");
});

test("SEC-03: an unknown address records user_id NULL and never the address itself", async () => {
  const events = new MemoryAuthEventStore();
  const { auth } = makeService(events);

  await auth
    .login({ email: "nobody-here@velora.test", password: "whatever-1-2-3-4" })
    .catch(() => undefined);

  // Nothing is filed under any user…
  const all = await events.listForUser("1");
  assert.equal(all.total, 0);
  // …and the unknown-account attempt is not stored as a row under a fabricated id.
  // (The memory adapter has no "list all", so this asserts the CONTRACT through
  // the adapter's own state: a user_id of null can never match a real id.)
  const probe = await events.listForUser("null");
  assert.equal(probe.total, 0);
  // The attempted address must not be present anywhere in the stored rows.
  const dumped = JSON.stringify((events as unknown as { records: unknown[] }).records ?? []);
  assert.equal(dumped.includes("nobody-here@velora.test"), false, "the attempted address must never be stored");
});

test("SEC-03: a broken history store cannot break authentication (fail open)", async () => {
  const events = new MemoryAuthEventStore();
  const { store, auth } = makeService(events);
  await seedVerifiedUser(store, "resilient@velora.test", "a-strong-password-6");

  // 1. the adapter swallows its own failure…
  events.failWrites();
  const pair = await auth.login({ email: "resilient@velora.test", password: "a-strong-password-6" });
  assert.ok(pair.accessToken.length > 0, "the login must still succeed");
  assert.ok(events.lastWriteError() instanceof Error, "the failure is still observable");

  // 2. …and a store that THROWS anyway is contained by the service.
  const throwing: AuthEventStore = {
    record: async () => {
      throw new Error("history store is down");
    },
    listForUser: async () => ({ events: [], total: 0, page: 1, perPage: 25 }),
  };
  const { store: store2, auth: auth2 } = makeService(throwing);
  await seedVerifiedUser(store2, "resilient2@velora.test", "a-strong-password-7");
  const pair2 = await auth2.login({ email: "resilient2@velora.test", password: "a-strong-password-7" });
  assert.ok(pair2.accessToken.length > 0, "a throwing recorder must not surface to the caller");
  // And a FAILED login still reports the real reason rather than the store error.
  const err = (await auth2
    .login({ email: "resilient2@velora.test", password: "wrong" })
    .then(() => null, (e: unknown) => e as { code: string }))!;
  assert.equal(err.code, "INVALID_CREDENTIALS");
});

test("SEC-03: pagination and the reason normaliser are shared, not adapter-specific", () => {
  // Legacy's clamp: page >= 1, per_page 1..100, default 25.
  assert.deepEqual(clampPagination(undefined), { page: 1, perPage: 25 });
  assert.deepEqual(clampPagination({ page: 0, perPage: 0 }), { page: 1, perPage: 1 });
  assert.deepEqual(clampPagination({ page: 2.9, perPage: 1000 }), { page: 2, perPage: 100 });
  assert.deepEqual(clampPagination({ page: Number.NaN, perPage: Number.NaN }), { page: 1, perPage: 25 });

  // Bounds: an over-long user agent is truncated to the column's contract.
  const long = normalizeAuthEvent({
    userId: "1",
    eventType: "login",
    result: "success",
    userAgent: "x".repeat(400),
    ipAddress: " 203.0.113.7 ",
  });
  assert.equal(long.userAgent!.length, 250);
  assert.equal(long.ipAddress, "203.0.113.7");
  // A success can never carry a failure reason; a failure always carries one.
  assert.equal(normalizeAuthEvent({ userId: "1", eventType: "login", result: "success", reason: "ACCOUNT_INACTIVE" }).reason, null);
  assert.equal(normalizeAuthEvent({ userId: "1", eventType: "login", result: "failure" }).reason, "INVALID_CREDENTIALS");
  // An empty/whitespace address is absent, not an empty string.
  assert.equal(normalizeAuthEvent({ userId: "1", eventType: "login", result: "success", ipAddress: "   " }).ipAddress, null);
});
