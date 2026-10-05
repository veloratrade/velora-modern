// Admin console HTTP surface — the whole capability over a real socket.
//
// WHAT THIS FILE IS EVIDENCE FOR. Everything below runs through the REAL kernel
// (`createApp` + `listen`) with real bearer verification; only the storage
// adapters are doubles. The properties asserted here are decided at the ROUTE
// layer, which is exactly why they cannot be proven by a service test:
//
//   1. ANONYMOUS IS 401 AND A PLAIN USER IS 403 ON EVERY PATH — reads included.
//      An operator surface that leaks platform-wide counts to any logged-in user
//      is a disclosure bug even if each individual field looks harmless.
//   2. EACH ROUTE CARRIES THE LEGACY PERMISSION, not `admin.panel.access` as a
//      blanket: an `admin` reaches overview/analytics/health/audit/users, and
//      `audit.view_sensitive` (super_admin only, Legacy Role.php line 118) is the
//      ONLY difference between them on the sensitive fields.
//   3. THE SENSITIVE FIELDS ARE OMITTED FROM THE BODY for a caller who may not
//      see them — not nulled — so the response cannot be mistaken for "the
//      address was not recorded" (the SEC-03 shape).
//   4. THE MUTATIONS ARE OWNED BY AdminUserService: the console does not restate
//      the pair-rules, and this file proves they still run — self-action denied,
//      owner protected, privileged target refused for a plain admin.
//   5. A MISSING USER IS A 404, never an empty list: "this account has no
//      sessions" and "there is no such account" are different facts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listen } from "../kernel/server.js";
import { AuthService } from "../auth/authService.js";
import { JwtService } from "../auth/jwt.js";
import { VeloraHasher } from "../auth/hashing.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { MemoryAuditStore } from "../auth/memoryAuditStore.js";
import { LogMailProvider } from "../mail/logMailProvider.js";
import { FixedWindowRateLimiter } from "../ratelimits/rateLimiter.js";
import { MemoryRateLimitStore } from "../ratelimits/memoryRateLimitStore.js";
import { AdminUserService } from "../auth/adminUserService.js";
import { OwnershipService } from "../auth/ownershipService.js";
import { MemoryOwnershipStore } from "../auth/memoryOwnershipStore.js";
import { AdminConsoleService } from "./adminConsoleService.js";
import { MemoryAdminConsoleStore } from "./adminConsoleStore.js";
import type { AdminConsoleCapability } from "./adminConsoleRoutes.js";

const JWT_SECRET = "admin-console-routes-test-secret-0123456789ab";

interface Envelope<T = Record<string, unknown>> {
  status: string;
  data: T;
  error: { code: string; message: string; details?: Record<string, string> } | null;
  timestamp: string;
}

interface Harness {
  readonly base: string;
  readonly store: MemoryUserStore;
  readonly audit: MemoryAuditStore;
  /** Claim the installation for a user id (writes the real ownership row). */
  readonly claim: (userId: string) => Promise<void>;
}

async function withServer(
  fn: (h: Harness, tokens: { alice: string; bob: string; admin: string; superAdmin: string; owner: string }) => Promise<void>,
  options: { readonly console?: MemoryAdminConsoleStore; readonly withConsole?: boolean } = {},
): Promise<void> {
  const verificationTokens: string[] = [];
  const store = new MemoryUserStore();
  const audit = new MemoryAuditStore();
  const auth = new AuthService({
    store,
    hasher: new VeloraHasher(),
    jwt: JwtService.create(JWT_SECRET),
    generateVerificationToken: () => {
      const t = `console-verification-${Math.random().toString(36).slice(2)}-0123456789`;
      verificationTokens.push(t);
      return t;
    },
    mail: new LogMailProvider(),
  });

  // Ownership is a REAL OwnershipService over a REAL store, exactly as the
  // composition root wires it. The System Owner case below therefore exercises
  // the production code path — ownership resolved from authoritative storage —
  // and not a special header, a role, or a test-only branch.
  const ownershipStore = new MemoryOwnershipStore();
  const ownership = new OwnershipService({
    ownership: ownershipStore,
    users: store,
    hasher: new VeloraHasher(),
    audit,
  });
  const users = new AdminUserService({
    store,
    audit,
    getSystemOwnerUserId: async () => (await ownershipStore.getOwnership())?.ownerUserId ?? null,
  });

  const withConsole = options.withConsole !== false;
  const capability: AdminConsoleCapability | undefined = withConsole
    ? {
        users,
        console: new AdminConsoleService({
          store: options.console ?? new MemoryAdminConsoleStore(),
          users,
        }),
      }
    : undefined;

  const app = createApp({
    allowedOrigins: ["https://app.velora.example"],
    checks: { database: async () => "ok" as const },
    auth,
    adminUsers: users,
    ownership,
    ...(capability !== undefined ? { adminConsole: capability } : {}),
    rateLimiter: new FixedWindowRateLimiter(new MemoryRateLimitStore()),
  });
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;

  async function login(email: string, role: "user" | "admin" | "super_admin" = "user"): Promise<string> {
    await fetch(`${base}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "a-strong-password-123" }),
    });
    await fetch(`${base}/api/v1/auth/verify-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: verificationTokens.shift() }),
    });
    if (role !== "user") {
      const user = await store.findUserByEmail(email);
      assert.ok(user !== null);
      await store.updateUserRole(user.id, role, new Date());
    }
    const res = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "a-strong-password-123" }),
    });
    assert.equal(res.status, 200);
    return ((await res.json()) as Envelope<{ tokens: { accessToken: string } }>).data.tokens.accessToken;
  }

  try {
    const alice = await login("console-alice@velora.example");
    const bob = await login("console-bob@velora.example");
    const admin = await login("console-admin@velora.example", "admin");
    const superAdmin = await login("console-super@velora.example", "super_admin");
    const owner = await login("console-owner@velora.example", "admin");
    const ownerUser = await store.findUserByEmail("console-owner@velora.example");
    assert.ok(ownerUser !== null);
    // The owner's stored role stays `admin` on purpose: the point of the test is
    // that OWNERSHIP (not the role) is what unlocks the sensitive view.
    await ownershipStore.claimOwnership({
      ownerUserId: ownerUser.id,
      claimedByUserId: ownerUser.id,
      claimedIp: null,
      claimedUserAgent: null,
      now: new Date(),
    });

    await fn(
      {
        base,
        store,
        audit,
        claim: async (userId: string): Promise<void> => {
          await ownershipStore.claimOwnership({
            ownerUserId: userId,
            claimedByUserId: userId,
            claimedIp: null,
            claimedUserAgent: null,
            now: new Date(),
          });
        },
      },
      { alice, bob, admin, superAdmin, owner },
    );
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

const bearer = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

const READ_PATHS = [
  "/api/v1/admin/overview",
  "/api/v1/admin/analytics/users",
  "/api/v1/admin/analytics/trading",
  "/api/v1/admin/system/health",
  "/api/v1/admin/security/signups",
  "/api/v1/admin/security/logins",
  "/api/v1/admin/trades",
  "/api/v1/admin/trading-accounts",
  "/api/v1/admin/users/1/sessions",
  "/api/v1/admin/users/1/devices",
  "/api/v1/admin/users/1/accounts",
  "/api/v1/admin/users/1/trades",
];

// ── Authentication and authorization ────────────────────────────────────────

test("AUTH: every console read refuses an anonymous caller with 401", async () => {
  await withServer(async ({ base }) => {
    for (const path of READ_PATHS) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 401, path);
      assert.equal(((await res.json()) as Envelope).error?.code, "UNAUTHENTICATED");
    }
  });
});

test("AUTH: the console mutations refuse an anonymous caller with 401", async () => {
  await withServer(async ({ base }) => {
    for (const path of [
      "/api/v1/admin/users/1/session-revocations",
      "/api/v1/admin/users/1/email-verification",
    ]) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(res.status, 401, path);
    }
  });
});

test("AUTHZ: a plain user reaches NO console route (the platform is not public data)", async () => {
  await withServer(async ({ base }, { alice }) => {
    for (const path of READ_PATHS) {
      const res = await fetch(`${base}${path}`, { headers: bearer(alice) });
      assert.equal(res.status, 403, path);
      assert.equal(((await res.json()) as Envelope).error?.code, "FORBIDDEN");
    }
    const revoke = await fetch(`${base}/api/v1/admin/users/1/session-revocations`, {
      method: "POST",
      headers: bearer(alice),
      body: "{}",
    });
    assert.equal(revoke.status, 403);
    const verify = await fetch(`${base}/api/v1/admin/users/1/email-verification`, {
      method: "POST",
      headers: bearer(alice),
      body: "{}",
    });
    assert.equal(verify.status, 403);
  });
});

test("AUTHZ: an admin reaches the reads (Legacy grants every one of them to `admin`)", async () => {
  const consoleStore = new MemoryAdminConsoleStore({
    health: {
      databaseLatencyMs: 1,
      appliedMigrations: 27,
      migrationHead: "0027_admin_console.sql",
      expectedMigrations: 27,
      tables: 44,
      rateLimitBuckets: 0,
      auditRows: 0,
      authEvents: 0,
      processUptimeSeconds: 12,
      nodeVersion: "v22.0.0",
    },
  });
  await withServer(
    async ({ base }, { admin }) => {
      for (const path of READ_PATHS) {
        const res = await fetch(`${base}${path}`, { headers: bearer(admin) });
        assert.equal(res.status, 200, `${path} → ${res.status}`);
      }
    },
    { console: consoleStore },
  );
});

test("CAPABILITY: with no console wired, every console route answers 503 rather than degrading", async () => {
  await withServer(
    async ({ base }, { admin }) => {
      for (const path of READ_PATHS) {
        const res = await fetch(`${base}${path}`, { headers: bearer(admin) });
        assert.equal(res.status, 503, path);
        assert.equal(((await res.json()) as Envelope).error?.code, "SERVICE_UNAVAILABLE");
      }
    },
    { withConsole: false },
  );
});

// ── The sensitive-field rule ────────────────────────────────────────────────

test("SENSITIVE: an admin gets no ip/user-agent; a super_admin gets them; a plain user gets neither the fields nor the route", async () => {
  const row = {
    id: "1",
    occurredAt: "2026-10-04T10:00:00.000Z",
    userId: "2",
    email: "someone@velora.example",
    eventType: "login",
    result: "success",
    reason: null,
    ipAddress: "203.0.113.7",
    userAgent: "Mozilla/5.0 (test)",
  };
  await withServer(
    async ({ base }, { admin, superAdmin }) => {
      const asAdmin = await fetch(`${base}/api/v1/admin/security/logins`, { headers: bearer(admin) });
      assert.equal(asAdmin.status, 200);
      const adminRow = ((await asAdmin.json()) as Envelope<{ items: Record<string, unknown>[]; sensitive: boolean }>).data;
      assert.equal(adminRow.sensitive, false);
      assert.equal("ipAddress" in adminRow.items[0]!, false, "an admin must not receive the raw address");
      assert.equal("userAgent" in adminRow.items[0]!, false);

      const asSuper = await fetch(`${base}/api/v1/admin/security/logins`, { headers: bearer(superAdmin) });
      const superData = ((await asSuper.json()) as Envelope<{ items: Record<string, unknown>[]; sensitive: boolean }>).data;
      assert.equal(superData.sensitive, true);
      assert.equal(superData.items[0]!["ipAddress"], "203.0.113.7");
      assert.equal(superData.items[0]!["userAgent"], "Mozilla/5.0 (test)");
    },
    { console: new MemoryAdminConsoleStore({ security: { items: [row], total: 1 } }) },
  );
});

test("SENSITIVE: the per-user session list omits the fields for an admin and includes them for a super_admin", async () => {
  await withServer(async ({ base, store }, { admin, superAdmin }) => {
    const target = await store.findUserByEmail("console-bob@velora.example");
    assert.ok(target !== null);
    await store.createSession({
      userId: target.id,
      refreshTokenHash: "hash-1-" + Math.random().toString(36).slice(2),
      accessTokenHash: "access-1",
      ipAddress: "198.51.100.9",
      userAgent: "curl/8",
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
    });

    const asAdmin = await fetch(`${base}/api/v1/admin/users/${target.id}/sessions`, { headers: bearer(admin) });
    assert.equal(asAdmin.status, 200);
    const adminData = ((await asAdmin.json()) as Envelope<{ items: Record<string, unknown>[]; sensitive: boolean }>).data;
    assert.equal(adminData.sensitive, false);
    // The login session this test performed also appears (the list is the whole
    // session history, revoked or not) — the assertion is about the FIELDS of the
    // sessions we seeded, so find them rather than assuming a count.
    const adminSeeded = adminData.items.filter((s) => "ipAddress" in s || "userAgent" in s);
    assert.equal(adminSeeded.length, 0, "an admin receives no raw network identity on any row");

    const asSuper = await fetch(`${base}/api/v1/admin/users/${target.id}/sessions`, { headers: bearer(superAdmin) });
    const superData = ((await asSuper.json()) as Envelope<{ items: Record<string, unknown>[]; sensitive: boolean }>).data;
    const seeded = superData.items.find((s) => s["userAgent"] === "curl/8");
    assert.ok(seeded !== undefined, "the seeded session must be listed");
    assert.equal(seeded["ipAddress"], "198.51.100.9");
  });
});

test("SENSITIVE: the System Owner sees the raw address without holding a super_admin role", async () => {
  const row = {
    id: "1",
    occurredAt: "2026-10-04T10:00:00.000Z",
    userId: "2",
    email: "someone@velora.example",
    eventType: "signup",
    result: "success",
    reason: null,
    ipAddress: "203.0.113.7",
    userAgent: "UA",
  };
  await withServer(
    async ({ base }, { owner }) => {
      const res = await fetch(`${base}/api/v1/admin/security/signups`, { headers: bearer(owner) });
      const data = ((await res.json()) as Envelope<{ items: Record<string, unknown>[]; sensitive: boolean }>).data;
      assert.equal(data.sensitive, true, "ownership satisfies every permission, including this one");
      assert.equal(data.items[0]!["ipAddress"], "203.0.113.7");
    },
    { console: new MemoryAdminConsoleStore({ security: { items: [row], total: 1 } }) },
  );
});

// ── Validation and shape ────────────────────────────────────────────────────

test("VALIDATION: ranges, paging, filters and unknown ids are rejected with a 4XX and a named field", async () => {
  await withServer(async ({ base, store }, { admin }) => {
    const t = bearer(admin);
    // A REAL id for the per-user cases: existence is checked BEFORE pagination
    // (an unknown user is a 404, never a 422 dressed up as one), so the paging
    // assertions must address a user who exists.
    const bob = await store.findUserByEmail("console-bob@velora.example");
    assert.ok(bob !== null);
    const cases: [string, number, Record<string, string>][] = [
      ["/api/v1/admin/analytics/users?range=nonsense", 422, { allowed: "today,7d,30d,90d,all" }],
      ["/api/v1/admin/analytics/users?from=notadate", 422, { from: "must be an ISO-8601 instant" }],
      ["/api/v1/admin/analytics/users?from=2026-10-04&to=2026-01-01", 422, { from: "2026-10-04T00:00:00.000Z" }],
      ["/api/v1/admin/analytics/users?from=2020-01-01&to=2026-10-04", 422, { maxDays: "366" }],
      ["/api/v1/admin/security/logins?result=maybe", 422, { result: "must be 'success' or 'failure'" }],
      ["/api/v1/admin/trades?status=HALF", 422, { status: "must be 'OPEN' or 'CLOSED'" }],
      ["/api/v1/admin/trades?userId=abc", 422, { userId: "must be a numeric id" }],
      ["/api/v1/admin/trading-accounts?syncStatus=MAYBE", 422, {}],
      [`/api/v1/admin/users/${bob.id}/trades?perPage=1000`, 422, { perPage: "1..100" }],
      [`/api/v1/admin/users/${bob.id}/trades?page=0`, 422, { page: "must be >= 1" }],
    ];
    for (const [path, status, details] of cases) {
      const res = await fetch(`${base}${path}`, { headers: t });
      assert.equal(res.status, status, `${path} → ${res.status}`);
      const body = (await res.json()) as Envelope;
      for (const [key, value] of Object.entries(details)) {
        assert.equal(String(body.error?.details?.[key]), value, `${path} ${key}`);
      }
    }
  });
});

test("VALIDATION: an unknown user is a 404 on every per-user read — never an empty list", async () => {
  await withServer(async ({ base }, { admin }) => {
    for (const path of [
      "/api/v1/admin/users/no-such-id/sessions",
      "/api/v1/admin/users/no-such-id/devices",
      "/api/v1/admin/users/no-such-id/accounts",
      "/api/v1/admin/users/no-such-id/trades",
    ]) {
      const res = await fetch(`${base}${path}`, { headers: bearer(admin) });
      assert.equal(res.status, 404, path);
      assert.equal(((await res.json()) as Envelope).error?.code, "USER_NOT_FOUND");
    }
  });
});

test("METHOD: an owned read path refuses a write with 405 (never a silent 404)", async () => {
  await withServer(async ({ base }, { admin }) => {
    const res = await fetch(`${base}/api/v1/admin/overview`, {
      method: "POST",
      headers: bearer(admin),
      body: "{}",
    });
    assert.equal(res.status, 405);
  });
});

// ── The mutations, and the guards they inherit ──────────────────────────────

test("REVOKE: revoking every session of a user ends them, reports the count, and audits the act", async () => {
  await withServer(async ({ base, store, audit }, { bob, admin }) => {
    const target = await store.findUserByEmail("console-bob@velora.example");
    assert.ok(target !== null);
    for (let i = 0; i < 2; i += 1) {
      await store.createSession({
        userId: target.id,
        refreshTokenHash: `hash-${i}-` + Math.random().toString(36).slice(2),
        accessTokenHash: `access-${i}`,
        ipAddress: null,
        userAgent: null,
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(),
      });
    }

    const liveBefore = (await store.listSessions(target.id, 50, 0)).items.filter((s) => s.revokedAt === null).length;
    assert.ok(liveBefore >= 2, "the fixture must have live sessions to revoke");

    const res = await fetch(`${base}/api/v1/admin/users/${target.id}/session-revocations`, {
      method: "POST",
      headers: bearer(admin),
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const data = ((await res.json()) as Envelope<{ revoked: number; scope: string }>).data;
    // The reported number is the store's own count of what was LIVE — not a
    // guess, and not the total row count. (Test logins add a session too.)
    assert.deepEqual(data, { revoked: liveBefore, scope: "all" });

    const sessions = await store.listSessions(target.id, 10, 0);
    assert.equal(sessions.items.filter((s) => s.revokedAt === null).length, 0, "every session is revoked");

    const entries = (await audit.list()).filter((e) => e.action === "USER_SESSIONS_REVOKED");
    assert.equal(entries.length, 1, "exactly one audit row for one revoke operation");
    assert.equal(entries[0]!.targetUserId, target.id);
    assert.equal(entries[0]!.beforeState, `live:${liveBefore}`);
    assert.equal(entries[0]!.afterState, "live:0");

    // The user's own access token is unaffected (it is a stateless 15-minute
    // JWT); what ends is the ability to RENEW. That is the existing mechanism
    // suspension already relies on, and the console does not invent a new one.
    const stillReads = await fetch(`${base}/api/v1/auth/me`, { headers: bearer(bob) });
    assert.equal(stillReads.status, 200);
  });
});

test("REVOKE: a single session is revocable by id, and a foreign or already-revoked id is a 404", async () => {
  await withServer(async ({ base, store }, { admin }) => {
    const target = await store.findUserByEmail("console-bob@velora.example");
    const other = await store.findUserByEmail("console-alice@velora.example");
    assert.ok(target !== null && other !== null);
    const session = await store.createSession({
      userId: target.id,
      refreshTokenHash: "single-" + Math.random().toString(36).slice(2),
      accessTokenHash: "access-single",
      ipAddress: null,
      userAgent: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
    });

    const ok = await fetch(`${base}/api/v1/admin/users/${target.id}/session-revocations`, {
      method: "POST",
      headers: bearer(admin),
      body: JSON.stringify({ sessionId: session.id }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(
      ((await ok.json()) as Envelope<{ revoked: number; scope: string; sessionId: string }>).data,
      { revoked: 1, scope: "session", sessionId: session.id },
    );

    // Revoking it again is a 404 (nothing left to revoke), and so is asking for a
    // session that belongs to a DIFFERENT user under this user's path — the
    // user_id predicate in the UPDATE is what makes that unactionable.
    for (const body of [{ sessionId: session.id }, { sessionId: "999999" }]) {
      const again = await fetch(`${base}/api/v1/admin/users/${target.id}/session-revocations`, {
        method: "POST",
        headers: bearer(admin),
        body: JSON.stringify(body),
      });
      assert.equal(again.status, 404, JSON.stringify(body));
      assert.equal(((await again.json()) as Envelope).error?.code, "SESSION_NOT_FOUND");
    }
    const foreign = await fetch(`${base}/api/v1/admin/users/${other.id}/session-revocations`, {
      method: "POST",
      headers: bearer(admin),
      body: JSON.stringify({ sessionId: session.id }),
    });
    assert.equal(foreign.status, 404);

    // A non-numeric id must not become a database error: it is a 404 too.
    const junk = await fetch(`${base}/api/v1/admin/users/${target.id}/session-revocations`, {
      method: "POST",
      headers: bearer(admin),
      body: JSON.stringify({ sessionId: "not-a-number" }),
    });
    assert.equal(junk.status, 404);
  });
});

test("GUARDS: an admin cannot revoke a privileged target's sessions, cannot act on themselves, and cannot touch the owner", async () => {
  await withServer(async ({ base, store }, { admin, superAdmin }) => {
    const adminSelf = await store.findUserByEmail("console-admin@velora.example");
    const superTarget = await store.findUserByEmail("console-super@velora.example");
    const ownerTarget = await store.findUserByEmail("console-owner@velora.example");
    const plain = await store.findUserByEmail("console-alice@velora.example");
    assert.ok(adminSelf && superTarget && ownerTarget && plain);

    const self = await fetch(`${base}/api/v1/admin/users/${adminSelf.id}/session-revocations`, {
      method: "POST",
      headers: bearer(admin),
      body: "{}",
    });
    assert.equal(self.status, 403);
    assert.equal(((await self.json()) as Envelope).error?.code, "SELF_ACTION_DENIED");

    const privileged = await fetch(`${base}/api/v1/admin/users/${superTarget.id}/session-revocations`, {
      method: "POST",
      headers: bearer(admin),
      body: "{}",
    });
    assert.equal(privileged.status, 403);
    assert.equal(((await privileged.json()) as Envelope).error?.code, "PRIVILEGED_TARGET");

    const owner = await fetch(`${base}/api/v1/admin/users/${ownerTarget.id}/session-revocations`, {
      method: "POST",
      headers: bearer(superAdmin),
      body: "{}",
    });
    assert.equal(owner.status, 403, "even a super_admin may not sign the owner out");
    assert.equal(((await owner.json()) as Envelope).error?.code, "SYSTEM_OWNER_PROTECTED");

    // The legitimate case still works, so the guards are not simply refusing all.
    const plainOk = await fetch(`${base}/api/v1/admin/users/${plain.id}/session-revocations`, {
      method: "POST",
      headers: bearer(admin),
      body: "{}",
    });
    assert.equal(plainOk.status, 200);
  });
});

test("VERIFY: admin-triggered verification flips the account once, audits it, and is idempotent afterwards", async () => {
  await withServer(async ({ base, store, audit }, { admin }) => {
    // An UNVERIFIED account, seeded straight into the store.
    //
    // Deliberately NOT created through POST /auth/register: that route is
    // throttled (auth:register), and six registrations in one test file would
    // make this test pass or fail depending on the harness's login count — a
    // rate limit is a property of the auth surface, not of this capability. The
    // subject here is the ADMIN verification endpoint, so the fixture is the row
    // it operates on.
    const created = await store.createUser({
      email: "console-unverified@velora.example",
      passwordHash: "not-a-real-hash",
      fullName: "Unverified Person",
      timezone: "UTC",
      locale: "fa",
      now: new Date(),
    });
    assert.equal(created.emailVerifiedAt, null);

    const first = await fetch(`${base}/api/v1/admin/users/${created.id}/email-verification`, {
      method: "POST",
      headers: bearer(admin),
      body: "{}",
    });
    assert.equal(first.status, 200);
    const firstData = ((await first.json()) as Envelope<{ changed: boolean; user: { emailVerifiedAt: string | null } }>).data;
    assert.equal(firstData.changed, true);
    assert.notEqual(firstData.user.emailVerifiedAt, null);

    const second = await fetch(`${base}/api/v1/admin/users/${created.id}/email-verification`, {
      method: "POST",
      headers: bearer(admin),
      body: "{}",
    });
    const secondData = ((await second.json()) as Envelope<{ changed: boolean }>).data;
    assert.equal(secondData.changed, false, "a second call claims no change");
    assert.equal(
      (await audit.list()).filter((e) => e.action === "USER_EMAIL_VERIFIED").length,
      1,
      "only the GRANT is audited, not the redundant call",
    );

    const missing = await fetch(`${base}/api/v1/admin/users/999999/email-verification`, {
      method: "POST",
      headers: bearer(admin),
      body: "{}",
    });
    assert.equal(missing.status, 404);
  });
});

test("VERIFY: a plain user cannot call it at all, and an admin cannot verify a privileged target", async () => {
  await withServer(async ({ base, store }, { alice, admin }) => {
    const superTarget = await store.findUserByEmail("console-super@velora.example");
    assert.ok(superTarget !== null);
    const asUser = await fetch(`${base}/api/v1/admin/users/${superTarget.id}/email-verification`, {
      method: "POST",
      headers: bearer(alice),
      body: "{}",
    });
    assert.equal(asUser.status, 403);

    const asAdmin = await fetch(`${base}/api/v1/admin/users/${superTarget.id}/email-verification`, {
      method: "POST",
      headers: bearer(admin),
      body: "{}",
    });
    assert.equal(asAdmin.status, 403);
    assert.equal(((await asAdmin.json()) as Envelope).error?.code, "PRIVILEGED_TARGET");
  });
});

test("SHAPE: the overview, health and analytics envelopes are the documented ones", async () => {
  await withServer(async ({ base }, { admin }) => {
    const t = bearer(admin);
    const overview = ((await (await fetch(`${base}/api/v1/admin/overview`, { headers: t })).json()) as Envelope<Record<string, unknown>>).data;
    assert.deepEqual(
      Object.keys(overview).sort(),
      ["subscriptions", "support", "telegram", "trading", "users"],
      "the dashboard is GROUPED: a flat bag of numbers cannot be localized or reasoned about",
    );

    const health = ((await (await fetch(`${base}/api/v1/admin/system/health`, { headers: t })).json()) as Envelope<{
      overall: string;
      components: { key: string; status: string; detail: string | null }[];
      facts: Record<string, unknown>;
    }>).data;
    const keys = health.components.map((c) => c.key);
    assert.deepEqual(keys, [
      "database",
      "migrations",
      "api",
      "rate_limiter",
      "worker",
      "email",
      "ai_provider",
      "metaapi",
      "n8n_relay",
    ]);
    // Every not-yet-built component states a REASON; none of them is green.
    for (const component of health.components.filter((c) => c.status === "not_applicable")) {
      assert.ok(
        component.detail !== null && component.detail.length > 10,
        `${component.key} must say WHY it is not applicable`,
      );
    }
    assert.equal(typeof health.facts["appliedMigrations"], "number");

    const analytics = ((await (await fetch(`${base}/api/v1/admin/analytics/trading?range=7d`, { headers: t })).json()) as Envelope<{
      range: { preset: string };
      totals: Record<string, unknown>;
    }>).data;
    assert.equal(analytics.range.preset, "7d");
    assert.equal(typeof analytics.totals["netPnl"], "string", "money stays a string (ADR-001)");
  });
});
