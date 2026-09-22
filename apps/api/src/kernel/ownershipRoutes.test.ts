// System Owner bootstrap over real HTTP.
//
// Proves the claim is server-side: the caller's ROLE is re-read from storage,
// so a stale or forged JWT role cannot grant ownership, and client-supplied
// role / ownerUserId / system_owner body fields are ignored entirely.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listen } from "./server.js";
import { AuthService } from "../auth/authService.js";
import { LogMailProvider } from "../mail/logMailProvider.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { MemoryOwnershipStore } from "../auth/memoryOwnershipStore.js";
import { VeloraHasher } from "../auth/hashing.js";
import { JwtService } from "../auth/jwt.js";
import { OwnershipService, OWNERSHIP_CLAIM_CONFIRMATION } from "../auth/ownershipService.js";
import { AdminUserService } from "../auth/adminUserService.js";
import type { AppRoleName } from "../auth/userStore.js";
import { MemoryAuditStore } from "../auth/memoryAuditStore.js";

const SECRET = "ownership-routes-test-secret-0123456789"; // test-only
const NOW = new Date("2026-09-14T12:00:00.000Z");
const PASSWORD = "correct horse battery staple 9";

interface Envelope<T = unknown> {
  status: string;
  data: T;
  error: { code: string; message: string } | null;
}

function tokenFor(sub: string, role: string): string {
  return JwtService.create(SECRET).sign({ sub, role }, 900);
}

async function withServer(
  fn: (
    base: string,
    ctx: { users: MemoryUserStore; ownership: MemoryOwnershipStore },
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
    audit: new MemoryAuditStore(),
  });
  const adminUsers = new AdminUserService({
    store: users,
    now: () => NOW,
    // Wired to the REAL ownership store, exactly as the composition root does,
    // so owner protection is live for whatever these tests claim.
    getSystemOwnerUserId: async () => (await ownershipStore.getOwnership())?.ownerUserId ?? null,
    audit: new MemoryAuditStore(),
  });
  const app = createApp({
    allowedOrigins: ["https://veloratrade.ir"],
    checks: { database: async () => "ok" as const },
    auth,
    adminUsers,
    ownership,
  });
  const port = await listen(app);
  try {
    await fn(`http://127.0.0.1:${port}`, { users, ownership: ownershipStore });
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

async function seed(
  users: MemoryUserStore,
  email: string,
  role: AppRoleName = "admin",
): Promise<string> {
  const u = await users.createUser({
    email,
    passwordHash: await new VeloraHasher().hash(PASSWORD),
    fullName: "Admin",
    timezone: "UTC",
    locale: "en",
    now: NOW,
  });
  if (role !== "user") await users.updateUserRole(u.id, role, NOW);
  await users.markEmailVerified(u.id, NOW);
  return u.id;
}

const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  origin: "https://veloratrade.ir",
  "content-type": "application/json",
});

test("W1: an authorized Admin can claim ownership over HTTP (201)", async () => {
  await withServer(async (base, { users }) => {
    const adminId = await seed(users, "admin@example.com", "admin");
    const res = await fetch(`${base}/api/v1/admin/ownership/claim`, {
      method: "POST",
      headers: headers(tokenFor(adminId, "admin")),
      body: JSON.stringify({ password: PASSWORD, confirm: OWNERSHIP_CLAIM_CONFIRMATION }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as Envelope<{ ownerUserId: string }>;
    assert.equal(body.status, "success");
    assert.equal(body.data.ownerUserId, adminId);
  });
});

test("W2: unauthenticated claim is rejected (401)", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/admin/ownership/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://veloratrade.ir" },
      body: JSON.stringify({ password: PASSWORD, confirm: OWNERSHIP_CLAIM_CONFIRMATION }),
    });
    assert.equal(res.status, 401);
  });
});

test("W3: a STALE/FORGED token role cannot grant ownership — role is read from storage", async () => {
  await withServer(async (base, { users, ownership }) => {
    // A plain USER holding a validly-signed token that claims super_admin
    // (e.g. a stale token issued before a demotion).
    const userId = await seed(users, "user@example.com", "user");
    const res = await fetch(`${base}/api/v1/admin/ownership/claim`, {
      method: "POST",
      headers: headers(tokenFor(userId, "super_admin")),
      body: JSON.stringify({ password: PASSWORD, confirm: OWNERSHIP_CLAIM_CONFIRMATION }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as Envelope;
    assert.equal(body.error?.code, "OWNERSHIP_CLAIM_FORBIDDEN");
    assert.equal(await ownership.getOwnership(), null);
  });
});

test("W4: client-supplied role / ownership body fields are ignored", async () => {
  await withServer(async (base, { users, ownership }) => {
    const userId = await seed(users, "user@example.com", "user");
    const res = await fetch(`${base}/api/v1/admin/ownership/claim`, {
      method: "POST",
      headers: { ...headers(tokenFor(userId, "user")), "x-role": "system_owner" },
      body: JSON.stringify({
        password: PASSWORD,
        confirm: OWNERSHIP_CLAIM_CONFIRMATION,
        role: "system_owner",
        ownerUserId: userId,
        system_owner: true,
        ownership_claimed: false,
      }),
    });
    assert.equal(res.status, 403);
    assert.equal(await ownership.getOwnership(), null);
    // The user's RBAC role is untouched.
    assert.equal((await users.findUserById(userId))!.role, "user");
  });
});

test("W5: after bootstrap, a second claim fails even for a Super Admin (409)", async () => {
  await withServer(async (base, { users }) => {
    const adminId = await seed(users, "admin@example.com", "admin");
    const superId = await seed(users, "super@example.com", "super_admin");
    const first = await fetch(`${base}/api/v1/admin/ownership/claim`, {
      method: "POST",
      headers: headers(tokenFor(adminId, "admin")),
      body: JSON.stringify({ password: PASSWORD, confirm: OWNERSHIP_CLAIM_CONFIRMATION }),
    });
    assert.equal(first.status, 201);

    for (const [id, role] of [
      [superId, "super_admin"],
      [adminId, "admin"],
    ] as const) {
      const res = await fetch(`${base}/api/v1/admin/ownership/claim`, {
        method: "POST",
        headers: headers(tokenFor(id, role)),
        body: JSON.stringify({ password: PASSWORD, confirm: OWNERSHIP_CLAIM_CONFIRMATION }),
      });
      assert.equal(res.status, 409);
      const body = (await res.json()) as Envelope;
      assert.equal(body.error?.code, "OWNERSHIP_ALREADY_CLAIMED");
    }
  });
});

test("W6: a wrong password is rejected (401) and ownership stays unclaimed", async () => {
  await withServer(async (base, { users, ownership }) => {
    const adminId = await seed(users, "admin@example.com", "admin");
    const res = await fetch(`${base}/api/v1/admin/ownership/claim`, {
      method: "POST",
      headers: headers(tokenFor(adminId, "admin")),
      body: JSON.stringify({ password: "nope", confirm: OWNERSHIP_CLAIM_CONFIRMATION }),
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json() as Envelope).error?.code, "INVALID_CREDENTIALS");
    assert.equal(await ownership.getOwnership(), null);
  });
});

test("W7: ownership status reports claimed/unclaimed and leaks nothing", async () => {
  await withServer(async (base, { users }) => {
    const adminId = await seed(users, "admin@example.com", "admin");
    const t = tokenFor(adminId, "admin");

    const before = await fetch(`${base}/api/v1/admin/ownership/status`, { headers: headers(t) });
    assert.equal(before.status, 200);
    assert.equal(((await before.json()) as Envelope<{ claimed: boolean }>).data.claimed, false);

    await fetch(`${base}/api/v1/admin/ownership/claim`, {
      method: "POST",
      headers: headers(t),
      body: JSON.stringify({ password: PASSWORD, confirm: OWNERSHIP_CLAIM_CONFIRMATION }),
    });

    const after = await fetch(`${base}/api/v1/admin/ownership/status`, { headers: headers(t) });
    const raw = await after.text();
    assert.equal(raw.includes(PASSWORD), false);
    assert.equal(raw.includes("passwordHash"), false);
    assert.equal((JSON.parse(raw) as Envelope<{ claimed: boolean }>).data.claimed, true);
  });
});

test("W8: ownership cannot be obtained through the role endpoint", async () => {
  // The role route only accepts user|admin|super_admin; 'system_owner' is not a
  // role and can never be assigned.
  await withServer(async (base, { users, ownership }) => {
    const superId = await seed(users, "super@example.com", "super_admin");
    const targetId = await seed(users, "target@example.com", "user");
    const res = await fetch(`${base}/api/v1/admin/users/${targetId}/role`, {
      method: "PATCH",
      headers: headers(tokenFor(superId, "super_admin")),
      body: JSON.stringify({ role: "system_owner" }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as Envelope).error?.code, "INVALID_ROLE");
    assert.equal((await users.findUserById(targetId))!.role, "user");
    assert.equal(await ownership.getOwnership(), null);
  });
});

test("W9: Super Admin peer protection is enforced over HTTP", async () => {
  await withServer(async (base, { users }) => {
    const a = await seed(users, "a@example.com", "super_admin");
    const b = await seed(users, "b@example.com", "super_admin");
    for (const [path, payload] of [
      [`/api/v1/admin/users/${b}/role`, { role: "user" }],
      [`/api/v1/admin/users/${b}/status`, { status: "suspended" }],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method: "PATCH",
        headers: headers(tokenFor(a, "super_admin")),
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as Envelope).error?.code, "SUPER_ADMIN_PEER_PROTECTED");
    }
    const after = await users.findUserById(b);
    assert.equal(after!.role, "super_admin");
    assert.equal(after!.status, "active");
  });
});
