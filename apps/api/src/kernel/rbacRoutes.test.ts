// Phase 3B-3 — application RBAC enforcement over real HTTP (OD-9).
//
// Proves the guard actually enforces at the server boundary: role comes only
// from a signature-verified token, client-supplied role is ignored, admin
// cannot reach super_admin operations, and ownership semantics are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listen } from "./server.js";
import { AuthService } from "../auth/authService.js";
import { LogMailProvider } from "../mail/logMailProvider.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { VeloraHasher } from "../auth/hashing.js";
import { JwtService } from "../auth/jwt.js";
import { TradeService } from "../trades/tradeService.js";
import { MemoryTradeStore } from "../trades/memoryTradeStore.js";

const SECRET = "rbac-routes-test-secret-0123456789abcdef"; // test-only

interface Envelope<T = unknown> {
  status: string;
  data: T;
  error: { code: string; message: string } | null;
  timestamp: string;
}

/**
 * Mints access tokens directly with the SAME secret the server verifies with.
 * This is how a legitimate token for an elevated role is produced without a
 * role-management endpoint (which is Phase 3B-4, deliberately not built here).
 */
function tokenFor(sub: string, role: string): string {
  return JwtService.create(SECRET).sign({ sub, role }, 900);
}

async function withServer(
  fn: (base: string, ctx: { userStore: MemoryUserStore; tradeStore: MemoryTradeStore }) => Promise<void>,
): Promise<void> {
  const userStore = new MemoryUserStore();
  const tradeStore = new MemoryTradeStore();
  const auth = new AuthService({
    store: userStore,
    hasher: new VeloraHasher(),
    jwt: JwtService.create(SECRET),
    mail: new LogMailProvider(), // explicit offline outbox — never a silent no-op
  });
  const trades = new TradeService({
    store: tradeStore,
    getUserTimezone: async () => "UTC",
    verifyAccountOwnership: async () => false,
  });
  const app = createApp({
    allowedOrigins: ["https://veloratrade.ir"],
    checks: { database: async () => "ok" as const },
    auth, trades,
  });
  const port = await listen(app);
  try {
    await fn(`http://127.0.0.1:${port}`, { userStore, tradeStore });
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

const get = (base: string, path: string, token?: string): Promise<Response> =>
  fetch(`${base}${path}`, token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } });

// ---------------------------------------------------------------------------
// Authentication boundary
// ---------------------------------------------------------------------------

test("RBAC: unauthenticated => 401 on every guarded route", async () => {
  await withServer(async (base) => {
    for (const path of ["/api/v1/admin/rbac/self", "/api/v1/admin/rbac/matrix"]) {
      const res = await get(base, path);
      assert.equal(res.status, 401, path);
      assert.equal(((await res.json()) as Envelope<null>).error?.code, "UNAUTHENTICATED");
    }
  });
});

test("RBAC: a token signed with the WRONG secret is rejected (401, not 403)", async () => {
  await withServer(async (base) => {
    const forged = JwtService.create("an-entirely-different-secret-0123456789ab").sign(
      { sub: "1", role: "super_admin" }, 900,
    );
    const res = await get(base, "/api/v1/admin/rbac/matrix", forged);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as Envelope<null>).error?.code, "UNAUTHENTICATED");
  });
});

// ---------------------------------------------------------------------------
// Role enforcement
// ---------------------------------------------------------------------------

test("RBAC: user role => 200 on self, 403 on the super_admin matrix", async () => {
  await withServer(async (base) => {
    const t = tokenFor("1", "user");

    const self = await get(base, "/api/v1/admin/rbac/self", t);
    assert.equal(self.status, 200);
    const body = (await self.json()) as Envelope<{ role: string; permissions: string[] }>;
    assert.equal(body.data.role, "user");
    assert.deepEqual(body.data.permissions, ["rbac.self.view"]);

    const matrix = await get(base, "/api/v1/admin/rbac/matrix", t);
    assert.equal(matrix.status, 403);
    assert.equal(((await matrix.json()) as Envelope<null>).error?.code, "FORBIDDEN");
  });
});

test("RBAC: admin role => panel access, but STILL 403 on the super_admin matrix", async () => {
  await withServer(async (base) => {
    const t = tokenFor("2", "admin");

    const self = await get(base, "/api/v1/admin/rbac/self", t);
    assert.equal(self.status, 200);
    const body = (await self.json()) as Envelope<{ role: string; permissions: string[] }>;
    assert.equal(body.data.role, "admin");
    assert.ok(body.data.permissions.includes("admin.panel.access"));

    const matrix = await get(base, "/api/v1/admin/rbac/matrix", t);
    assert.equal(matrix.status, 403, "admin must NOT reach a super_admin-only operation");
  });
});

test("RBAC: super_admin role => 200 on the matrix, and it is a superset of admin", async () => {
  await withServer(async (base) => {
    const res = await get(base, "/api/v1/admin/rbac/matrix", tokenFor("3", "super_admin"));
    assert.equal(res.status, 200);
    const { data } = (await res.json()) as Envelope<{ roles: string[]; permissions: Record<string, string[]> }>;
    assert.deepEqual(data.roles, ["user", "admin", "super_admin"]);
    for (const p of data.permissions.admin!) {
      assert.ok(data.permissions.super_admin!.includes(p), `super_admin must retain ${p}`);
    }
  });
});

// ---------------------------------------------------------------------------
// The attack surface: client-supplied role must never be trusted
// ---------------------------------------------------------------------------

test("RBAC: client-supplied role via headers/query/body is IGNORED", async () => {
  await withServer(async (base) => {
    const userToken = tokenFor("4", "user");

    // Every channel a client controls, all claiming super_admin.
    const attempts: Array<[string, RequestInit]> = [
      ["X-Role header", { headers: { Authorization: `Bearer ${userToken}`, "X-Role": "super_admin" } }],
      ["X-User-Role header", { headers: { Authorization: `Bearer ${userToken}`, "X-User-Role": "super_admin" } }],
      ["role header", { headers: { Authorization: `Bearer ${userToken}`, role: "super_admin" } }],
    ];
    for (const [label, init] of attempts) {
      const res = await fetch(`${base}/api/v1/admin/rbac/matrix`, init);
      assert.equal(res.status, 403, `${label} must not escalate`);
    }

    // Query string.
    const q = await get(base, "/api/v1/admin/rbac/matrix?role=super_admin", userToken);
    assert.equal(q.status, 403, "query param must not escalate");

    // And the effective role reported back is still 'user'.
    const self = await fetch(`${base}/api/v1/admin/rbac/self?role=super_admin`, {
      headers: { Authorization: `Bearer ${userToken}`, "X-Role": "super_admin" },
    });
    assert.equal(((await self.json()) as Envelope<{ role: string }>).data.role, "user");
  });
});

test("RBAC: an UNKNOWN role inside a validly-signed token fails closed to user", async () => {
  await withServer(async (base) => {
    for (const bogus of ["root", "owner", "SUPER_ADMIN", "superadmin", "", "velora_owner"]) {
      const t = tokenFor("5", bogus);
      const matrix = await get(base, "/api/v1/admin/rbac/matrix", t);
      assert.equal(matrix.status, 403, `role '${bogus}' must not grant the matrix`);

      const self = await get(base, "/api/v1/admin/rbac/self", t);
      assert.equal(self.status, 200);
      assert.equal(
        ((await self.json()) as Envelope<{ role: string }>).data.role, "user",
        `role '${bogus}' must degrade to user`,
      );
    }
  });
});

test("RBAC: a token with NO role claim degrades to user (not to admin)", async () => {
  await withServer(async (base) => {
    const t = JwtService.create(SECRET).sign({ sub: "6" }, 900);
    const self = await get(base, "/api/v1/admin/rbac/self", t);
    assert.equal(self.status, 200);
    assert.equal(((await self.json()) as Envelope<{ role: string }>).data.role, "user");
    assert.equal((await get(base, "/api/v1/admin/rbac/matrix", t)).status, 403);
  });
});

// ---------------------------------------------------------------------------
// RBAC must not disturb ownership (they answer different questions)
// ---------------------------------------------------------------------------

test("RBAC: elevated roles do NOT bypass trade ownership (still a non-disclosing 404)", async () => {
  await withServer(async (base) => {
    const ownerToken = tokenFor("100", "user");
    const created = await fetch(`${base}/api/v1/trades`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        symbol: "EURUSD", direction: "buy", entryPrice: "1.1000", exitPrice: "1.1050",
        volume: "1.0", contractSize: "100000", commission: "5.00", swap: "1.50",
        openTime: "2026-09-10 10:00:00", closeTime: "2026-09-10 12:00:00",
      }),
    });
    assert.equal(created.status, 201);
    const id = ((await created.json()) as Envelope<{ id: string }>).data.id;

    // Ownership is NOT an RBAC question: admin/super_admin are still not the
    // owner, so they get the existing non-disclosing 404 — never 403, and
    // certainly never the record.
    for (const role of ["admin", "super_admin"]) {
      const res = await get(base, `/api/v1/trades/${id}`, tokenFor("200", role));
      assert.equal(res.status, 404, `${role} must not read another user's trade`);
      assert.equal(((await res.json()) as Envelope<null>).error?.code, "NOT_FOUND");
    }

    // The owner still reads their own trade.
    assert.equal((await get(base, `/api/v1/trades/${id}`, ownerToken)).status, 200);
  });
});

test("RBAC: guarded routes fail CLOSED (503) when auth is not configured", async () => {
  const app = createApp({
    allowedOrigins: ["https://veloratrade.ir"],
    checks: { database: async () => "ok" as const },
  });
  const port = await listen(app);
  try {
    for (const path of ["/api/v1/admin/rbac/self", "/api/v1/admin/rbac/matrix"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.status, 503, path);
      assert.equal(((await res.json()) as Envelope<null>).error?.code, "SERVICE_UNAVAILABLE");
    }
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
});
