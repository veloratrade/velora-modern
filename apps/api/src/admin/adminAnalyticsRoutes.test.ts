// Admin analytics remaining 4 endpoints — HTTP surface (Phase 9).
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

const JWT_SECRET = "admin-analytics-routes-test-0123456789ab-test-secret-aaaa";

type Envelope<T = Record<string, unknown>> = {
  status: string;
  data: T;
  error: { code: string; message: string; details?: Record<string, string> } | null;
  timestamp: string;
};

async function withServer(
  fn: (base: string, tokens: { user: string; admin: string; superAdmin: string }) => Promise<void>,
  opts: { console?: MemoryAdminConsoleStore; withConsole?: boolean } = {},
): Promise<void> {
  const verificationTokens: string[] = [];
  const store = new MemoryUserStore();
  const audit = new MemoryAuditStore();
  const auth = new AuthService({
    store,
    hasher: new VeloraHasher(),
    jwt: JwtService.create(JWT_SECRET),
    generateVerificationToken: () => {
      const t = `tok-${Math.random().toString(36).slice(2)}-0123456789`;
      verificationTokens.push(t);
      return t;
    },
    mail: new LogMailProvider(),
  });
  const ownershipStore = new MemoryOwnershipStore();
  const ownership = new OwnershipService({ ownership: ownershipStore, users: store, hasher: new VeloraHasher(), audit });
  const users = new AdminUserService({ store, audit, getSystemOwnerUserId: async () => (await ownershipStore.getOwnership())?.ownerUserId ?? null });
  const withConsole = opts.withConsole !== false;
  const capability: AdminConsoleCapability | undefined = withConsole
    ? { users, console: new AdminConsoleService({ store: opts.console ?? new MemoryAdminConsoleStore(), users }) }
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
  async function closeServer(): Promise<void> {
    await new Promise<void>((r) => app.close(() => r()));
  }
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
      const u = await store.findUserByEmail(email);
      assert.ok(u !== null);
      await store.updateUserRole(u.id, role, new Date());
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
    const user = await login("ana-user@velora.example", "user");
    const admin = await login("ana-admin@velora.example", "admin");
    const superAdmin = await login("ana-super@velora.example", "super_admin");
    await fn(base, { user, admin, superAdmin });
  } finally {
    await closeServer();
  }
}

const PATHS = [
  "/api/v1/admin/analytics/overview",
  "/api/v1/admin/analytics/ai",
  "/api/v1/admin/analytics/operations",
  "/api/v1/admin/analytics/revenue",
] as const;

for (const path of PATHS) {
  test(`${path} — anonymous is 401`, async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 401);
    });
  });

  test(`${path} — plain user is 403`, async () => {
    await withServer(async (base, t) => {
      const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${t.user}` } });
      assert.equal(res.status, 403);
    });
  });

  test(`${path} — admin is 200`, async () => {
    await withServer(async (base, t) => {
      const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${t.admin}` } });
      assert.equal(res.status, 200);
      const body = (await res.json()) as Envelope;
      assert.equal(body.status, "success");
    });
  });

  test(`${path} — capability absent is 503`, async () => {
    await withServer(async (base, t) => {
      const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${t.admin}` } });
      assert.equal(res.status, 503);
    }, { withConsole: false });
  });
}

test("GET /api/v1/admin/analytics/revenue — always unavailable, not zeroed", async () => {
  await withServer(async (base, t) => {
    const res = await fetch(`${base}/api/v1/admin/analytics/revenue`, { headers: { authorization: `Bearer ${t.admin}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Envelope<{ available: boolean; reason: string; note: string; metrics: Record<string, { available: boolean; reason: string }> }>;
    assert.equal((body.data as unknown as { available: boolean }).available, false);
    assert.equal((body.data as unknown as { reason: string }).reason, "NO_BILLING_SOURCE");
  });
});

test("GET /api/v1/admin/analytics/ai — invalid range is 422", async () => {
  await withServer(async (base, t) => {
    const res = await fetch(`${base}/api/v1/admin/analytics/ai?range=bogus`, { headers: { authorization: `Bearer ${t.admin}` } });
    assert.equal(res.status, 422);
  });
});

test("GET /api/v1/admin/analytics/overview — range=all returns revenue unavailable", async () => {
  await withServer(async (base, t) => {
    const res = await fetch(`${base}/api/v1/admin/analytics/overview?range=all`, { headers: { authorization: `Bearer ${t.admin}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Envelope<{ revenue: { available: boolean } }>;
    assert.equal((body.data as unknown as { revenue: { available: boolean } }).revenue.available, false);
  });
});
