// Phase 3B-4 — admin user management enforced over real HTTP.
//
// The service tests cover the actor/target pair-rules. THESE tests prove the
// authorization layer holds at the server boundary: the role is taken only from
// a signature-verified token, an `admin` cannot reach the super_admin-only role
// endpoint, and no response ever carries a password hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listen } from "./server.js";
import { AuthService } from "../auth/authService.js";
import { LogMailProvider } from "../mail/logMailProvider.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { VeloraHasher } from "../auth/hashing.js";
import { JwtService } from "../auth/jwt.js";
import { AdminUserService } from "../auth/adminUserService.js";
import type { AppRole } from "@velora/contracts";

const SECRET = "admin-users-routes-test-secret-0123456789"; // test-only
const NOW = new Date("2026-09-14T12:00:00.000Z");

interface Envelope<T = unknown> {
  status: string;
  data: T;
  error: { code: string; message: string } | null;
}

function tokenFor(sub: string, role: string): string {
  return JwtService.create(SECRET).sign({ sub, role }, 900);
}

async function withServer(
  fn: (base: string, store: MemoryUserStore) => Promise<void>,
  opts: { withService?: boolean } = {},
): Promise<void> {
  const userStore = new MemoryUserStore();
  const auth = new AuthService({
    store: userStore,
    hasher: new VeloraHasher(),
    jwt: JwtService.create(SECRET),
    mail: new LogMailProvider(), // explicit offline outbox — never a silent no-op
  });
  const adminUsers = new AdminUserService({
    store: userStore,
    now: () => NOW,
    getSystemOwnerUserId: async () => null, // no ownership claimed in this suite
  });
  const app = createApp({
    allowedOrigins: ["https://veloratrade.ir"],
    checks: { database: async () => "ok" as const },
    auth,
    ...(opts.withService === false ? {} : { adminUsers }),
  });
  const port = await listen(app);
  try {
    await fn(`http://127.0.0.1:${port}`, userStore);
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

async function seed(
  store: MemoryUserStore,
  email: string,
  role: AppRole = "user",
  status = "active",
): Promise<string> {
  const u = await store.createUser({
    email,
    passwordHash: `hash-for-${email}`,
    fullName: `Name ${email}`,
    timezone: "UTC",
    locale: "en",
    now: NOW,
  });
  if (role !== "user") await store.updateUserRole(u.id, role, NOW);
  if (status !== "active") await store.updateUserStatus(u.id, status, NOW);
  return u.id;
}

const authHeaders = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  origin: "https://veloratrade.ir",
  "content-type": "application/json",
});

test("E1: GET /admin/users requires authentication (401, not 404)", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/admin/users`);
    assert.equal(res.status, 401);
    const body = (await res.json()) as Envelope;
    assert.equal(body.error?.code, "UNAUTHENTICATED");
  });
});

test("E2: a plain user is FORBIDDEN from listing users", async () => {
  await withServer(async (base, store) => {
    const id = await seed(store, "plain@example.com");
    const res = await fetch(`${base}/api/v1/admin/users`, {
      headers: authHeaders(tokenFor(id, "user")),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as Envelope;
    assert.equal(body.error?.code, "FORBIDDEN");
  });
});

test("E3: an admin CAN list users, and no password hash is ever returned", async () => {
  await withServer(async (base, store) => {
    const adminId = await seed(store, "admin@example.com", "admin");
    await seed(store, "plain@example.com");
    const res = await fetch(`${base}/api/v1/admin/users`, {
      headers: authHeaders(tokenFor(adminId, "admin")),
    });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.equal(raw.includes("hash-for-"), false);
    assert.equal(raw.includes("passwordHash"), false);
    const body = JSON.parse(raw) as Envelope<{ items: unknown[]; total: number }>;
    assert.equal(body.status, "success");
    assert.equal(body.data.total, 2);
  });
});

test("E4: an admin is FORBIDDEN from changing a role (super_admin only)", async () => {
  await withServer(async (base, store) => {
    const adminId = await seed(store, "admin@example.com", "admin");
    const targetId = await seed(store, "plain@example.com");
    const res = await fetch(`${base}/api/v1/admin/users/${targetId}/role`, {
      method: "PATCH",
      headers: authHeaders(tokenFor(adminId, "admin")),
      body: JSON.stringify({ role: "admin" }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as Envelope;
    assert.equal(body.error?.code, "FORBIDDEN");
    // and the target was NOT promoted
    assert.equal((await store.findUserById(targetId))!.role, "user");
  });
});

test("E5: a super_admin CAN change a role over HTTP", async () => {
  await withServer(async (base, store) => {
    const superId = await seed(store, "super@example.com", "super_admin");
    const targetId = await seed(store, "plain@example.com");
    const res = await fetch(`${base}/api/v1/admin/users/${targetId}/role`, {
      method: "PATCH",
      headers: authHeaders(tokenFor(superId, "super_admin")),
      body: JSON.stringify({ role: "admin" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Envelope<{
      user: { role: string };
      sessionsRevoked: boolean;
    }>;
    assert.equal(body.data.user.role, "admin");
    assert.equal(body.data.sessionsRevoked, true);
    assert.equal((await store.findUserById(targetId))!.role, "admin");
  });
});

test("E6: a FORGED role claim is ignored — the signature must verify", async () => {
  await withServer(async (base, store) => {
    const id = await seed(store, "plain@example.com");
    // Token signed with a DIFFERENT secret, claiming super_admin.
    const forged = JwtService.create("attacker-secret-0123456789abcdefzz").sign(
      { sub: id, role: "super_admin" },
      900,
    );
    const res = await fetch(`${base}/api/v1/admin/users`, {
      headers: authHeaders(forged),
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as Envelope;
    assert.equal(body.error?.code, "UNAUTHENTICATED");
  });
});

test("E7: a client-supplied role header/query cannot escalate", async () => {
  await withServer(async (base, store) => {
    const id = await seed(store, "plain@example.com");
    const res = await fetch(`${base}/api/v1/admin/users?role=super_admin`, {
      headers: { ...authHeaders(tokenFor(id, "user")), "x-role": "super_admin" },
    });
    assert.equal(res.status, 403);
  });
});

test("E8: an admin can suspend a plain user over HTTP", async () => {
  await withServer(async (base, store) => {
    const adminId = await seed(store, "admin@example.com", "admin");
    const targetId = await seed(store, "plain@example.com");
    const res = await fetch(`${base}/api/v1/admin/users/${targetId}/status`, {
      method: "PATCH",
      headers: authHeaders(tokenFor(adminId, "admin")),
      body: JSON.stringify({ status: "suspended" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Envelope<{ user: { status: string } }>;
    assert.equal(body.data.user.status, "suspended");
    assert.equal((await store.findUserById(targetId))!.status, "suspended");
  });
});

test("E9: an invalid status is rejected with 400 INVALID_STATUS", async () => {
  await withServer(async (base, store) => {
    const adminId = await seed(store, "admin@example.com", "admin");
    const targetId = await seed(store, "plain@example.com");
    const res = await fetch(`${base}/api/v1/admin/users/${targetId}/status`, {
      method: "PATCH",
      headers: authHeaders(tokenFor(adminId, "admin")),
      body: JSON.stringify({ status: "deleted" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Envelope;
    assert.equal(body.error?.code, "INVALID_STATUS");
  });
});

test("E10: self-action is blocked at the HTTP boundary too", async () => {
  await withServer(async (base, store) => {
    const superId = await seed(store, "super@example.com", "super_admin");
    const res = await fetch(`${base}/api/v1/admin/users/${superId}/role`, {
      method: "PATCH",
      headers: authHeaders(tokenFor(superId, "super_admin")),
      body: JSON.stringify({ role: "user" }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as Envelope;
    assert.equal(body.error?.code, "SELF_ACTION_DENIED");
    assert.equal((await store.findUserById(superId))!.role, "super_admin");
  });
});

test("E11: GET /admin/users/:id returns the safe projection", async () => {
  await withServer(async (base, store) => {
    const adminId = await seed(store, "admin@example.com", "admin");
    const targetId = await seed(store, "plain@example.com");
    const res = await fetch(`${base}/api/v1/admin/users/${targetId}`, {
      headers: authHeaders(tokenFor(adminId, "admin")),
    });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.equal(raw.includes("hash-for-"), false);
    const body = JSON.parse(raw) as Envelope<{ user: { email: string } }>;
    assert.equal(body.data.user.email, "plain@example.com");
  });
});

test("E12: unknown target => 404 USER_NOT_FOUND", async () => {
  await withServer(async (base, store) => {
    const adminId = await seed(store, "admin@example.com", "admin");
    const res = await fetch(`${base}/api/v1/admin/users/no-such-id`, {
      headers: authHeaders(tokenFor(adminId, "admin")),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as Envelope;
    assert.equal(body.error?.code, "USER_NOT_FOUND");
  });
});

test("E13: routes fail CLOSED (503) when the capability is not configured", async () => {
  await withServer(
    async (base, store) => {
      const adminId = await seed(store, "admin@example.com", "admin");
      const res = await fetch(`${base}/api/v1/admin/users`, {
        headers: authHeaders(tokenFor(adminId, "admin")),
      });
      assert.equal(res.status, 503);
      const body = (await res.json()) as Envelope;
      assert.equal(body.error?.code, "SERVICE_UNAVAILABLE");
    },
    { withService: false },
  );
});
