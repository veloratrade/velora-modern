// SEC-03 — the login-history HTTP contract.
//
// The history exists to be REVIEWED, so this battery drives the endpoint the way
// a reviewer would and asserts the things that would make it either useless or
// dangerous if wrong:
//
//   * authorization is enforced server-side (`users.view`), not by hiding a link:
//     a plain `user` token cannot read anyone's history, including their own;
//   * a caller WITHOUT the sensitive-audit standing gets rows with the raw
//     address fields ABSENT from the response body (not null, not hidden in the
//     client) — Legacy's own rule, applied consistently;
//   * a caller WITH it (super_admin, or the System Owner whose stored role may be
//     `admin`) receives them;
//   * the contract details Legacy defined are preserved: 404 for a missing target
//     (never an empty history), a closed `result` vocabulary, bounded pagination.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listen } from "./server.js";
import { AuthService } from "../auth/authService.js";
import { LogMailProvider } from "../mail/logMailProvider.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { MemoryAuthEventStore } from "../auth/memoryAuthEventStore.js";
import { VeloraHasher } from "../auth/hashing.js";
import { JwtService } from "../auth/jwt.js";
import { AdminUserService } from "../auth/adminUserService.js";
import { MemoryAuditStore } from "../auth/memoryAuditStore.js";
import type { AuthEventStore } from "../auth/authEventStore.js";

const SECRET = "login-history-routes-test-secret-0123456789"; // test-only
const NOW = new Date("2026-10-04T12:00:00.000Z");

interface Envelope<T = unknown> {
  status: string;
  data: T;
  error: { code: string; message: string; details?: Record<string, string> } | null;
}

interface HistoryBody {
  events: {
    id: string;
    eventType: string;
    result: string;
    reason: string | null;
    createdAt: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }[];
  pagination: { total: number; page: number; perPage: number; hasMore: boolean };
}

function tokenFor(sub: string, role: string): string {
  return JwtService.create(SECRET).sign({ sub, role }, 900);
}

async function withServer(
  fn: (base: string, store: MemoryUserStore, events: MemoryAuthEventStore) => Promise<void>,
  opts: { events?: AuthEventStore } = {},
): Promise<void> {
  const userStore = new MemoryUserStore();
  const events = new MemoryAuthEventStore();
  const auth = new AuthService({
    store: userStore,
    hasher: new VeloraHasher(),
    jwt: JwtService.create(SECRET),
    mail: new LogMailProvider(),
    authEvents: opts.events ?? events,
  });
  const adminUsers = new AdminUserService({
    store: userStore,
    now: () => NOW,
    getSystemOwnerUserId: async () => null,
    audit: new MemoryAuditStore(),
  });
  const app = createApp({
    allowedOrigins: ["https://veloratrade.ir"],
    checks: { database: async () => "ok" as const },
    auth,
    adminUsers,
    authEvents: opts.events ?? events,
  });
  const port = await listen(app);
  try {
    await fn(`http://127.0.0.1:${port}`, userStore, events);
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

async function get(base: string, path: string, token?: string) {
  const res = await fetch(`${base}${path}`, {
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as Envelope };
}

async function seed(store: MemoryUserStore, email: string) {
  const u = await store.createUser({
    email,
    passwordHash: "not-used-here",
    fullName: "Target User",
    timezone: "UTC",
    locale: "fa",
    now: new Date("2026-10-01T00:00:00.000Z"),
  });
  await store.updateUserStatus(u.id, "active", new Date("2026-10-01T00:00:00.000Z"));
  return u;
}

test("SEC-03: reading a user's history requires authentication and users.view", async () => {
  await withServer(async (base, store) => {
    const target = await seed(store, "target@velora.test");

    // No token at all.
    assert.equal((await get(base, `/api/v1/admin/users/${target.id}/login-history`)).status, 401);

    // A normal user — even asking for their OWN history — is refused: this is an
    // administrative surface, and the token alone never authorizes.
    const userTok = tokenFor(target.id, "user");
    const asUser = await get(base, `/api/v1/admin/users/${target.id}/login-history`, userTok);
    assert.equal(asUser.status, 403);
    assert.equal(asUser.body.error?.code, "FORBIDDEN");

    // The holder of users.view (an admin) is allowed.
    const admin = await seed(store, "admin@velora.test");
    const adminTok = tokenFor(admin.id, "admin");
    assert.equal((await get(base, `/api/v1/admin/users/${target.id}/login-history`, adminTok)).status, 200);
  });
});

test("SEC-03: the raw address fields are absent for an admin and present for super_admin", async () => {
  await withServer(async (base, store, events) => {
    const target = await seed(store, "target@velora.test");
    const admin = await seed(store, "admin@velora.test");
    const owner = await seed(store, "owner@velora.test");

    await events.record({
      userId: target.id,
      eventType: "login",
      result: "failure",
      reason: "INVALID_CREDENTIALS",
      ipAddress: "203.0.113.9",
      userAgent: "Mozilla/5.0 (probe)",
      occurredAt: new Date("2026-10-04T09:30:00.000Z"),
    });
    await events.record({
      userId: target.id,
      eventType: "signup",
      result: "success",
      occurredAt: new Date("2026-10-01T08:00:00.000Z"),
    });

    const asAdmin = await get(base, `/api/v1/admin/users/${target.id}/login-history`, tokenFor(admin.id, "admin"));
    assert.equal(asAdmin.status, 200);
    const adminBody = asAdmin.body.data as HistoryBody;
    assert.equal(adminBody.pagination.total, 2);
    // Newest first, and the row shape is the contract's.
    assert.equal(adminBody.events[0]!.result, "failure");
    assert.equal(adminBody.events[0]!.reason, "INVALID_CREDENTIALS");
    assert.equal(adminBody.events[0]!.createdAt, "2026-10-04T09:30:00.000Z");
    assert.equal(adminBody.events[1]!.eventType, "signup");
    for (const e of adminBody.events) {
      assert.equal("ipAddress" in e, false, "an admin must not receive the raw address at all");
      assert.equal("userAgent" in e, false, "an admin must not receive the raw user agent at all");
    }

    const asSuper = await get(
      base,
      `/api/v1/admin/users/${target.id}/login-history`,
      tokenFor(owner.id, "super_admin"),
    );
    const superBody = asSuper.body.data as HistoryBody;
    assert.equal(superBody.events[0]!.ipAddress, "203.0.113.9");
    assert.equal(superBody.events[0]!.userAgent, "Mozilla/5.0 (probe)");
  });
});

test("SEC-03: a missing user is a 404, an invalid filter is a validation error, pagination is bounded", async () => {
  await withServer(async (base, store) => {
    const admin = await seed(store, "admin@velora.test");
    const tok = tokenFor(admin.id, "admin");
    const target = await seed(store, "target@velora.test");

    const missing = await get(base, "/api/v1/admin/users/999999/login-history", tok);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error?.code, "USER_NOT_FOUND");

    const badFilter = await get(base, `/api/v1/admin/users/${target.id}/login-history?result=maybe`, tok);
    assert.equal(badFilter.status, 400);
    assert.equal(badFilter.body.error?.details?.result, "INVALID_CHOICE");

    // Legacy's clamp: per_page is capped at 100 rather than honoured blindly.
    const capped = await get(base, `/api/v1/admin/users/${target.id}/login-history?perPage=5000&page=0`, tok);
    assert.equal(capped.status, 200);
    const body = capped.body.data as HistoryBody;
    assert.equal(body.pagination.perPage, 100);
    assert.equal(body.pagination.page, 1);
  });
});

test("SEC-03: the result filter narrows the history without changing the total contract", async () => {
  await withServer(async (base, store, events) => {
    const target = await seed(store, "target@velora.test");
    const admin = await seed(store, "admin@velora.test");
    const tok = tokenFor(admin.id, "admin");

    await events.record({ userId: target.id, eventType: "login", result: "success" });
    await events.record({ userId: target.id, eventType: "login", result: "failure", reason: "INVALID_CREDENTIALS" });
    await events.record({ userId: target.id, eventType: "login", result: "failure", reason: "ACCOUNT_INACTIVE" });

    const all = (await get(base, `/api/v1/admin/users/${target.id}/login-history`, tok)).body.data as HistoryBody;
    assert.equal(all.pagination.total, 3);

    const failures = (await get(base, `/api/v1/admin/users/${target.id}/login-history?result=failure`, tok)).body.data as HistoryBody;
    assert.equal(failures.pagination.total, 2);
    assert.ok(failures.events.every((e) => e.result === "failure"));

    const successes = (await get(base, `/api/v1/admin/users/${target.id}/login-history?result=success`, tok)).body.data as HistoryBody;
    assert.equal(successes.pagination.total, 1);
  });
});

test("SEC-03: with no history store configured the route fails closed, not empty", async () => {
  const store = new MemoryUserStore();
  const auth = new AuthService({
    store,
    hasher: new VeloraHasher(),
    jwt: JwtService.create(SECRET),
    mail: new LogMailProvider(),
  });
  const app = createApp({
    allowedOrigins: ["https://veloratrade.ir"],
    checks: { database: async () => "ok" as const },
    auth,
    adminUsers: new AdminUserService({
      store,
      now: () => NOW,
      getSystemOwnerUserId: async () => null,
      audit: new MemoryAuditStore(),
    }),
    // authEvents deliberately absent
  });
  const port = await listen(app);
  try {
    const admin = await seed(store, "admin@velora.test");
    const res = await get(
      `http://127.0.0.1:${port}`,
      `/api/v1/admin/users/${admin.id}/login-history`,
      tokenFor(admin.id, "admin"),
    );
    assert.equal(res.status, 503);
    assert.equal(res.body.error?.code, "SERVICE_UNAVAILABLE");
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
});
