// System Owner authority and immutability at the HTTP boundary.
//
// Proves the server resolves ownership from AUTHORITATIVE STORAGE: a validly
// signed token carrying systemOwner=true or an elevated role grants nothing
// when the installation ownership record says otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listen } from "./server.js";
import { AuthService } from "../auth/authService.js";
import { LogMailProvider } from "../mail/logMailProvider.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { MemoryOwnershipStore } from "../auth/memoryOwnershipStore.js";
import { VeloraHasher } from "../auth/hashing.js";
import { JwtService } from "../auth/jwt.js";
import { AdminUserService } from "../auth/adminUserService.js";
import { TradeService } from "../trades/tradeService.js";
import { MemoryTradeStore } from "../trades/memoryTradeStore.js";
import { OwnershipService } from "../auth/ownershipService.js";
import { PERMISSIONS } from "@velora/contracts";
import type { AppRoleName } from "../auth/userStore.js";

const SECRET = "system-owner-routes-secret-0123456789ab"; // test-only
const NOW = new Date("2026-09-14T12:00:00.000Z");

interface Envelope<T = unknown> {
  status: string;
  data: T;
  error: { code: string; message: string } | null;
}

const sign = (claims: Record<string, string | number | boolean>): string =>
  JwtService.create(SECRET).sign(claims as { sub: string }, 900);

async function withServer(
  fn: (
    base: string,
    ctx: { users: MemoryUserStore; ownership: MemoryOwnershipStore; trades: TradeService },
  ) => Promise<void>,
): Promise<void> {
  const users = new MemoryUserStore();
  const ownershipStore = new MemoryOwnershipStore();
  const hasher = new VeloraHasher();
  const auth = new AuthService({ store: users, hasher, jwt: JwtService.create(SECRET),
  mail: new LogMailProvider(), // explicit offline outbox — never a silent no-op
  });
  const ownership = new OwnershipService({
    ownership: ownershipStore,
    users,
    hasher,
    now: () => NOW,
  });
  // Wired exactly as the composition root wires it.
  const adminUsers = new AdminUserService({
    store: users,
    now: () => NOW,
    getSystemOwnerUserId: async () => (await ownershipStore.getOwnership())?.ownerUserId ?? null,
  });
  // REAL trades capability: the IDOR test must exercise the actual trade
  // authorization path, not a fail-closed 503.
  const tradeStore = new MemoryTradeStore();
  const trades = new TradeService({
    store: tradeStore,
    getUserTimezone: async () => "UTC",
    verifyAccountOwnership: async () => false,
  });
  const app = createApp({
    allowedOrigins: ["https://veloratrade.ir"],
    checks: { database: async () => "ok" as const },
    auth,
    adminUsers,
    ownership,
    trades,
  });
  const port = await listen(app);
  try {
    await fn(`http://127.0.0.1:${port}`, { users, ownership: ownershipStore, trades });
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

async function seed(
  users: MemoryUserStore,
  email: string,
  role: AppRoleName = "user",
): Promise<string> {
  const u = await users.createUser({
    email,
    passwordHash: `hash-for-${email}`,
    fullName: "N",
    timezone: "UTC",
    locale: "en",
    now: NOW,
  });
  if (role !== "user") await users.updateUserRole(u.id, role, NOW);
  await users.markEmailVerified(u.id, NOW);
  return u.id;
}

async function claimFor(owner: MemoryOwnershipStore, userId: string): Promise<void> {
  await owner.claimOwnership({
    ownerUserId: userId,
    claimedByUserId: userId,
    claimedIp: null,
    claimedUserAgent: null,
    now: NOW,
  });
}

const hdrs = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  origin: "https://veloratrade.ir",
  "content-type": "application/json",
});

test("H1: the owner reaches a super_admin-only route while stored role is admin", async () => {
  await withServer(async (base, { users, ownership }) => {
    const ownerId = await seed(users, "owner@example.com", "admin");
    await claimFor(ownership, ownerId);
    const target = await seed(users, "t@example.com", "user");

    // users.change_role is super_admin-only in ordinary RBAC; an ordinary admin
    // is refused, but the owner is not.
    const plainAdmin = await seed(users, "adm@example.com", "admin");
    const refused = await fetch(`${base}/api/v1/admin/users/${target}/role`, {
      method: "PATCH",
      headers: hdrs(sign({ sub: plainAdmin, role: "admin" })),
      body: JSON.stringify({ role: "admin" }),
    });
    assert.equal(refused.status, 403);

    const allowed = await fetch(`${base}/api/v1/admin/users/${target}/role`, {
      method: "PATCH",
      headers: hdrs(sign({ sub: ownerId, role: "admin" })),
      body: JSON.stringify({ role: "admin" }),
    });
    assert.equal(allowed.status, 200);
    assert.equal((await users.findUserById(target))!.role, "admin");
  });
});

test("H2: the owner may read the RBAC matrix (super_admin-only) as an admin", async () => {
  await withServer(async (base, { users, ownership }) => {
    const ownerId = await seed(users, "owner@example.com", "admin");
    await claimFor(ownership, ownerId);
    const res = await fetch(`${base}/api/v1/admin/rbac/matrix`, {
      headers: hdrs(sign({ sub: ownerId, role: "admin" })),
    });
    assert.equal(res.status, 200);
  });
});

test("H3: /rbac/self reports owner authority and the FULL permission set", async () => {
  await withServer(async (base, { users, ownership }) => {
    const ownerId = await seed(users, "owner@example.com", "admin");
    await claimFor(ownership, ownerId);
    const res = await fetch(`${base}/api/v1/admin/rbac/self`, {
      headers: hdrs(sign({ sub: ownerId, role: "admin" })),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Envelope<{
      role: string;
      isSystemOwner: boolean;
      permissions: string[];
    }>;
    assert.equal(body.data.role, "admin", "stored RBAC role is unchanged");
    assert.equal(body.data.isSystemOwner, true);
    assert.deepEqual([...body.data.permissions].sort(), [...PERMISSIONS].sort());
  });
});

test("H4: a FORGED systemOwner claim in a VALID token grants nothing", async () => {
  await withServer(async (base, { users, ownership }) => {
    const ownerId = await seed(users, "owner@example.com", "admin");
    await claimFor(ownership, ownerId);
    const attacker = await seed(users, "attacker@example.com", "admin");

    // Correctly signed token, but the ownership claim is a lie.
    const token = sign({ sub: attacker, role: "admin", systemOwner: true, isSystemOwner: true });
    const res = await fetch(`${base}/api/v1/admin/rbac/matrix`, { headers: hdrs(token) });
    assert.equal(res.status, 403);
    const body = (await res.json()) as Envelope;
    assert.equal(body.error?.code, "FORBIDDEN");

    // And /rbac/self reports them as a non-owner.
    const self = await fetch(`${base}/api/v1/admin/rbac/self`, { headers: hdrs(token) });
    const selfBody = (await self.json()) as Envelope<{ isSystemOwner: boolean }>;
    assert.equal(selfBody.data.isSystemOwner, false);
  });
});

test("H5: a stale token claiming super_admin cannot suspend the owner", async () => {
  await withServer(async (base, { users, ownership }) => {
    const ownerId = await seed(users, "owner@example.com", "admin");
    await claimFor(ownership, ownerId);
    const sup = await seed(users, "sup@example.com", "super_admin");

    const res = await fetch(`${base}/api/v1/admin/users/${ownerId}/status`, {
      method: "PATCH",
      headers: hdrs(sign({ sub: sup, role: "super_admin" })),
      body: JSON.stringify({ status: "suspended" }),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as Envelope).error?.code, "SYSTEM_OWNER_PROTECTED");
    assert.equal((await users.findUserById(ownerId))!.status, "active");
  });
});

test("H6: a Super Admin cannot demote the owner over HTTP", async () => {
  await withServer(async (base, { users, ownership }) => {
    const ownerId = await seed(users, "owner@example.com", "admin");
    await claimFor(ownership, ownerId);
    const sup = await seed(users, "sup@example.com", "super_admin");
    const res = await fetch(`${base}/api/v1/admin/users/${ownerId}/role`, {
      method: "PATCH",
      headers: hdrs(sign({ sub: sup, role: "super_admin" })),
      body: JSON.stringify({ role: "user" }),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as Envelope).error?.code, "SYSTEM_OWNER_PROTECTED");
    assert.equal((await users.findUserById(ownerId))!.role, "admin");
  });
});

test("H7: a plain User cannot modify the owner (403 FORBIDDEN at the guard)", async () => {
  await withServer(async (base, { users, ownership }) => {
    const ownerId = await seed(users, "owner@example.com", "admin");
    await claimFor(ownership, ownerId);
    const plain = await seed(users, "plain@example.com", "user");
    const res = await fetch(`${base}/api/v1/admin/users/${ownerId}/status`, {
      method: "PATCH",
      headers: hdrs(sign({ sub: plain, role: "user" })),
      body: JSON.stringify({ status: "suspended" }),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as Envelope).error?.code, "FORBIDDEN");
    assert.equal((await users.findUserById(ownerId))!.status, "active");
  });
});

test("H8: ownership is installation-scoped — one record, bound to the owner", async () => {
  await withServer(async (base, { users, ownership }) => {
    const ownerId = await seed(users, "owner@example.com", "admin");
    await claimFor(ownership, ownerId);
    const other = await seed(users, "other@example.com", "admin");

    // A second claim is impossible, so no second owner can appear.
    const res = await fetch(`${base}/api/v1/admin/ownership/claim`, {
      method: "POST",
      headers: hdrs(sign({ sub: other, role: "admin" })),
      body: JSON.stringify({ password: "x", confirm: "CLAIM SYSTEM OWNERSHIP" }),
    });
    assert.equal(res.status, 409);
    const record = await ownership.getOwnership();
    assert.equal(record!.ownerUserId, ownerId, "ownership stays bound to the original owner");
  });
});

test("H9: owner authority does NOT bypass per-user data ownership boundaries", async () => {
  // Full authority is the highest APPLICATION authority, NOT an IDOR bypass.
  // This exercises the REAL trade authorization path: a trade genuinely owned
  // by another user is created through TradeService, then requested by the
  // System Owner over HTTP. The application's ownership-boundary contract is a
  // non-disclosing 404 (tradeService.getTrade -> findActiveByIdForUser -> null
  // -> notFoundTrade), and the owner must receive exactly that.
  await withServer(async (base, { users, ownership, trades }) => {
    const ownerId = await seed(users, "owner@example.com", "admin");
    await claimFor(ownership, ownerId);
    const victimId = await seed(users, "victim@example.com", "user");

    // A real trade belonging to the victim.
    const created = (await trades.createTrade(victimId, {
      // Field names match the established trade contract (see tradeRoutes.test).
      symbol: "EURUSD",
      direction: "buy",
      entryPrice: "1.1000",
      exitPrice: "1.1050",
      volume: "1.0",
      contractSize: "100000",
      openTime: "2026-09-10 10:00:00",
      closeTime: "2026-09-10 12:00:00",
    })) as { trade?: { id?: string }; id?: string };
    const tradeId = String(created.trade?.id ?? created.id);
    assert.ok(tradeId !== "undefined", "fixture must create a real trade");

    // Sanity: the victim CAN read their own trade, so the route is live and the
    // 404 below is an authorization outcome, not a misconfigured fixture.
    const ownRead = await fetch(`${base}/api/v1/trades/${tradeId}`, {
      headers: hdrs(sign({ sub: victimId, role: "user" })),
    });
    assert.equal(ownRead.status, 200, "owner-of-record must be able to read it");

    // The System Owner requests another user's trade.
    const res = await fetch(`${base}/api/v1/trades/${tradeId}`, {
      headers: hdrs(sign({ sub: ownerId, role: "admin" })),
    });
    assert.equal(res.status, 404, "owner authority must NOT widen data scope");
    const body = (await res.json()) as Envelope;
    assert.equal(body.error?.code, "NOT_FOUND");
    // Non-disclosing: the response must not leak the trade's contents.
    const raw = JSON.stringify(body);
    assert.equal(raw.includes("EURUSD"), false, "must not disclose the trade");

    // The same holds for a mutating route: no write access either.
    const del = await fetch(`${base}/api/v1/trades/${tradeId}`, {
      method: "DELETE",
      headers: hdrs(sign({ sub: ownerId, role: "admin" })),
    });
    assert.equal(del.status, 404, "owner must not be able to delete another user's trade");
    // And the victim's trade is still intact and readable by its real owner.
    const after = await fetch(`${base}/api/v1/trades/${tradeId}`, {
      headers: hdrs(sign({ sub: victimId, role: "user" })),
    });
    assert.equal(after.status, 200, "the victim's trade must be untouched");
  });
});

test("H10: with ownership unclaimed, ordinary RBAC is entirely unchanged", async () => {
  await withServer(async (base, { users }) => {
    const adm = await seed(users, "adm@example.com", "admin");
    // No ownership claimed: an ordinary admin is still refused the matrix.
    const res = await fetch(`${base}/api/v1/admin/rbac/matrix`, {
      headers: hdrs(sign({ sub: adm, role: "admin" })),
    });
    assert.equal(res.status, 403);
    const self = await fetch(`${base}/api/v1/admin/rbac/self`, {
      headers: hdrs(sign({ sub: adm, role: "admin" })),
    });
    const body = (await self.json()) as Envelope<{ isSystemOwner: boolean }>;
    assert.equal(body.data.isSystemOwner, false);
  });
});
