// Phase 3B-4 — administrative user management: service-level guards.
//
// These tests pin the ACTOR/TARGET pair-rules that a permission bit cannot
// express. Route-level permission checks are covered separately in
// adminUserRoutes.test.ts; both layers must hold independently.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MemoryUserStore } from "./memoryUserStore.js";
import { AuthError } from "./authService.js";
import {
  AdminUserService,
  toAdminUser,
  isUserStatus,
  isPrivilegedRole,
  USER_STATUSES,
  ADMIN_USER_PAGE_SIZE_MAX,
} from "./adminUserService.js";
import type { AppRole } from "@velora/contracts";
import type { UserRecord } from "./userStore.js";

const NOW = new Date("2026-09-14T12:00:00.000Z");

async function seed(
  store: MemoryUserStore,
  email: string,
  role: AppRole = "user",
  status = "active",
): Promise<UserRecord> {
  const u = await store.createUser({
    email,
    passwordHash: `hash-for-${email}`,
    fullName: `Name ${email}`,
    timezone: "UTC",
    locale: "en",
    now: NOW,
  });
  // createUser always mints role=user/status=active; elevate via the port so the
  // fixture uses the same code path the admin surface does.
  let out = u;
  if (role !== "user") out = (await store.updateUserRole(u.id, role, NOW))!;
  if (status !== "active") out = (await store.updateUserStatus(u.id, status, NOW))!;
  return out;
}

function makeService(store: MemoryUserStore): AdminUserService {
  return new AdminUserService({
    store,
    now: () => NOW,
    // No ownership is claimed in this suite: the resolver is stated EXPLICITLY
    // rather than omitted, so owner protection is deliberately inert here and
    // cannot be lost by accident elsewhere.
    getSystemOwnerUserId: async () => null,
  });
}

/**
 * COMPILE-TIME PROOF (Gap 1): owner protection cannot be silently disabled by
 * forgetting to wire the resolver. `getSystemOwnerUserId` is a REQUIRED member
 * of AdminUserServiceDeps, so omitting it is a type error (TS2345/TS2741) — the
 * build fails rather than the service degrading into a no-op guard at runtime.
 *
 * If the dependency is ever made optional again, `@ts-expect-error` below
 * becomes an UNUSED directive and `npm run typecheck` fails. This assertion is
 * therefore self-policing in both directions.
 */
function _ownerResolverIsRequiredAtCompileTime(store: MemoryUserStore): void {
  // @ts-expect-error - getSystemOwnerUserId is required; omitting it must not compile.
  void new AdminUserService({ store, now: () => NOW });
}
void _ownerResolverIsRequiredAtCompileTime;

async function expectError(fn: () => Promise<unknown>): Promise<AuthError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof AuthError, `expected AuthError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected the call to throw");
}

describe("3B-4 admin user service — safe projection", () => {
  test("A1: the admin projection NEVER contains passwordHash", async () => {
    const store = new MemoryUserStore();
    const user = await seed(store, "leak@example.com");
    assert.equal(user.passwordHash, "hash-for-leak@example.com"); // present on the record
    const view = toAdminUser(user);
    assert.equal("passwordHash" in view, false);
    // Serialized form must not contain the hash anywhere, under any key.
    assert.equal(JSON.stringify(view).includes("hash-for-"), false);
  });

  test("A2: projection exposes exactly the agreed field set", () => {
    const view = toAdminUser({
      id: "1",
      email: "a@b.c",
      passwordHash: "SECRET",
      fullName: "A",
      timezone: "UTC",
      locale: "en",
      role: "admin",
      plan: "free",
      status: "active",
      emailVerifiedAt: null,
      aiConsentAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepEqual(Object.keys(view).sort(), [
      "createdAt",
      "email",
      "emailVerifiedAt",
      "fullName",
      "id",
      "locale",
      "plan",
      "role",
      "status",
      "timezone",
      "updatedAt",
    ]);
  });

  test("A3: a corrupt stored role degrades to `user` in the projection", () => {
    const view = toAdminUser({
      id: "1",
      email: "a@b.c",
      passwordHash: "x",
      fullName: "A",
      timezone: "UTC",
      locale: "en",
      role: "root" as unknown as AppRole,
      plan: "free",
      status: "active",
      emailVerifiedAt: null,
      aiConsentAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(view.role, "user");
  });
});

describe("3B-4 admin user service — setRole guards", () => {
  test("B1: an actor cannot change their OWN role (self-escalation blocked)", async () => {
    const store = new MemoryUserStore();
    const actor = await seed(store, "super@example.com", "super_admin");
    const err = await expectError(() =>
      makeService(store).setRole(actor.id, "user", { id: actor.id, role: "super_admin" }),
    );
    assert.equal(err.status, 403);
    assert.equal(err.code, "SELF_ACTION_DENIED");
    // and nothing changed
    assert.equal((await store.findUserById(actor.id))!.role, "super_admin");
  });

  test("B2: an admin may NOT change a privileged user's role", async () => {
    const store = new MemoryUserStore();
    const actor = await seed(store, "admin@example.com", "admin");
    const target = await seed(store, "other-admin@example.com", "admin");
    const err = await expectError(() =>
      makeService(store).setRole(target.id, "user", { id: actor.id, role: "admin" }),
    );
    assert.equal(err.status, 403);
    assert.equal(err.code, "PRIVILEGED_TARGET");
    assert.equal((await store.findUserById(target.id))!.role, "admin");
  });

  test("B3: an admin may NOT grant an admin-level role (escalation denied)", async () => {
    const store = new MemoryUserStore();
    const actor = await seed(store, "admin@example.com", "admin");
    const target = await seed(store, "plain@example.com", "user");
    const err = await expectError(() =>
      makeService(store).setRole(target.id, "admin", { id: actor.id, role: "admin" }),
    );
    assert.equal(err.status, 403);
    assert.equal(err.code, "PRIVILEGE_ESCALATION_DENIED");
    assert.equal((await store.findUserById(target.id))!.role, "user");
  });

  test("B4: a super_admin CAN promote a plain user, and sessions are revoked", async () => {
    const store = new MemoryUserStore();
    const actor = await seed(store, "super@example.com", "super_admin");
    const target = await seed(store, "plain@example.com", "user");
    await store.createSession({
      userId: target.id,
      refreshTokenHash: "rth",
      accessTokenHash: "ath",
      ipAddress: null,
      userAgent: null,
      expiresAt: new Date("2026-10-14T12:00:00.000Z"),
      createdAt: NOW,
    });
    const res = await makeService(store).setRole(target.id, "admin", {
      id: actor.id,
      role: "super_admin",
    });
    assert.equal(res.user.role, "admin");
    assert.equal(res.sessionsRevoked, true);
    // The revoked session can no longer be used to refresh.
    const session = await store.findSessionByRefreshTokenHash("rth");
    assert.ok(session === null || session.revokedAt !== null);
  });

  test("B5: an unknown role value is rejected before any lookup", async () => {
    const store = new MemoryUserStore();
    const actor = await seed(store, "super@example.com", "super_admin");
    const target = await seed(store, "plain@example.com", "user");
    for (const bad of ["root", "SUPER_ADMIN", "", "owner", "velora_owner"]) {
      const err = await expectError(() =>
        makeService(store).setRole(target.id, bad, { id: actor.id, role: "super_admin" }),
      );
      assert.equal(err.status, 400);
      assert.equal(err.code, "INVALID_ROLE");
    }
    assert.equal((await store.findUserById(target.id))!.role, "user");
  });

  test("B6: unknown target => 404 USER_NOT_FOUND (no id enumeration)", async () => {
    const store = new MemoryUserStore();
    const actor = await seed(store, "super@example.com", "super_admin");
    const err = await expectError(() =>
      makeService(store).setRole("does-not-exist", "admin", {
        id: actor.id,
        role: "super_admin",
      }),
    );
    assert.equal(err.status, 404);
    assert.equal(err.code, "USER_NOT_FOUND");
  });

  test("B7: a no-op role change does NOT revoke the target's sessions", async () => {
    const store = new MemoryUserStore();
    const actor = await seed(store, "super@example.com", "super_admin");
    const target = await seed(store, "admin2@example.com", "admin");
    const res = await makeService(store).setRole(target.id, "admin", {
      id: actor.id,
      role: "super_admin",
    });
    assert.equal(res.user.role, "admin");
    assert.equal(res.sessionsRevoked, false);
  });

  test("B8: demotion of an admin by a super_admin succeeds", async () => {
    const store = new MemoryUserStore();
    const actor = await seed(store, "super@example.com", "super_admin");
    const target = await seed(store, "admin@example.com", "admin");
    const res = await makeService(store).setRole(target.id, "user", {
      id: actor.id,
      role: "super_admin",
    });
    assert.equal(res.user.role, "user");
    assert.equal(res.sessionsRevoked, true);
  });
});

describe("3B-4 admin user service — setStatus guards", () => {
  test("C1: an actor cannot suspend themselves", async () => {
    const store = new MemoryUserStore();
    const actor = await seed(store, "admin@example.com", "admin");
    const err = await expectError(() =>
      makeService(store).setStatus(actor.id, "suspended", { id: actor.id, role: "admin" }),
    );
    assert.equal(err.status, 403);
    assert.equal(err.code, "SELF_ACTION_DENIED");
    assert.equal((await store.findUserById(actor.id))!.status, "active");
  });

  test("C2: an admin may NOT suspend a privileged user", async () => {
    const store = new MemoryUserStore();
    const actor = await seed(store, "admin@example.com", "admin");
    const target = await seed(store, "super@example.com", "super_admin");
    const err = await expectError(() =>
      makeService(store).setStatus(target.id, "suspended", { id: actor.id, role: "admin" }),
    );
    assert.equal(err.status, 403);
    assert.equal(err.code, "PRIVILEGED_TARGET");
    assert.equal((await store.findUserById(target.id))!.status, "active");
  });

  test("C3: suspending a plain user revokes their sessions immediately", async () => {
    const store = new MemoryUserStore();
    const actor = await seed(store, "admin@example.com", "admin");
    const target = await seed(store, "plain@example.com", "user");
    await store.createSession({
      userId: target.id,
      refreshTokenHash: "rth-2",
      accessTokenHash: "ath",
      ipAddress: null,
      userAgent: null,
      expiresAt: new Date("2026-10-14T12:00:00.000Z"),
      createdAt: NOW,
    });
    const res = await makeService(store).setStatus(target.id, "suspended", {
      id: actor.id,
      role: "admin",
    });
    assert.equal(res.user.status, "suspended");
    assert.equal(res.sessionsRevoked, true);
    const session = await store.findSessionByRefreshTokenHash("rth-2");
    assert.ok(session === null || session.revokedAt !== null);
  });

  test("C4: reactivation succeeds and does NOT revoke sessions", async () => {
    const store = new MemoryUserStore();
    const actor = await seed(store, "admin@example.com", "admin");
    const target = await seed(store, "plain@example.com", "user", "suspended");
    const res = await makeService(store).setStatus(target.id, "active", {
      id: actor.id,
      role: "admin",
    });
    assert.equal(res.user.status, "active");
    assert.equal(res.sessionsRevoked, false);
  });

  test("C5: only 'active' and 'suspended' are accepted (Legacy enum parity)", async () => {
    const store = new MemoryUserStore();
    const actor = await seed(store, "admin@example.com", "admin");
    const target = await seed(store, "plain@example.com", "user");
    for (const bad of ["deleted", "banned", "Active", "", "pending"]) {
      const err = await expectError(() =>
        makeService(store).setStatus(target.id, bad, { id: actor.id, role: "admin" }),
      );
      assert.equal(err.status, 400);
      assert.equal(err.code, "INVALID_STATUS");
    }
    assert.deepEqual([...USER_STATUSES], ["active", "suspended"]);
    assert.equal(isUserStatus("suspended"), true);
    assert.equal(isUserStatus("deleted"), false);
  });

  test("C6: a suspended user is rejected by the existing auth gate (end-to-end meaning)", async () => {
    // The status column is already load-bearing: authService rejects login and
    // refresh when status !== "active". This asserts the value this service
    // writes is exactly the value that gate tests for.
    const store = new MemoryUserStore();
    const actor = await seed(store, "admin@example.com", "admin");
    const target = await seed(store, "plain@example.com", "user");
    await makeService(store).setStatus(target.id, "suspended", { id: actor.id, role: "admin" });
    const stored = await store.findUserById(target.id);
    assert.notEqual(stored!.status, "active");
  });
});

describe("3B-4 admin user service — listing", () => {
  test("D1: lists newest-first with total, and never leaks a hash", async () => {
    const store = new MemoryUserStore();
    await seed(store, "a@example.com");
    await seed(store, "b@example.com");
    await seed(store, "c@example.com");
    const page = await makeService(store).listUsers({});
    assert.equal(page.total, 3);
    assert.equal(page.items.length, 3);
    assert.equal(page.page, 1);
    assert.equal(page.perPage, 25);
    assert.equal(JSON.stringify(page).includes("hash-for-"), false);
  });

  test("D2: search matches email and full name, case-insensitively", async () => {
    const store = new MemoryUserStore();
    await seed(store, "alice@example.com");
    await seed(store, "bob@example.com");
    const svc = makeService(store);
    assert.equal((await svc.listUsers({ search: "ALICE" })).total, 1);
    assert.equal((await svc.listUsers({ search: "Name bob@" })).total, 1);
    assert.equal((await svc.listUsers({ search: "nobody" })).total, 0);
  });

  test("D3: role and status filters are exact and validated", async () => {
    const store = new MemoryUserStore();
    await seed(store, "u@example.com");
    await seed(store, "a@example.com", "admin");
    await seed(store, "s@example.com", "user", "suspended");
    const svc = makeService(store);
    assert.equal((await svc.listUsers({ role: "admin" })).total, 1);
    assert.equal((await svc.listUsers({ status: "suspended" })).total, 1);
    const err = await expectError(() => svc.listUsers({ role: "root" }));
    assert.equal(err.code, "INVALID_ROLE");
    const err2 = await expectError(() => svc.listUsers({ status: "deleted" }));
    assert.equal(err2.code, "INVALID_STATUS");
  });

  test("D4: pagination is clamped (no unbounded page size, no page 0)", async () => {
    const store = new MemoryUserStore();
    for (let i = 0; i < 5; i += 1) await seed(store, `u${i}@example.com`);
    const svc = makeService(store);
    const huge = await svc.listUsers({ perPage: 10_000 });
    assert.equal(huge.perPage, ADMIN_USER_PAGE_SIZE_MAX);
    const zero = await svc.listUsers({ page: 0, perPage: 0 });
    assert.equal(zero.page, 1);
    assert.equal(zero.perPage, 1);
    const p2 = await svc.listUsers({ page: 2, perPage: 2 });
    assert.equal(p2.items.length, 2);
    assert.equal(p2.total, 5);
  });

  test("D5: getUser returns the safe projection; unknown id => 404", async () => {
    const store = new MemoryUserStore();
    const u = await seed(store, "one@example.com");
    const svc = makeService(store);
    assert.equal((await svc.getUser(u.id)).email, "one@example.com");
    const err = await expectError(() => svc.getUser("nope"));
    assert.equal(err.status, 404);
    assert.equal(err.code, "USER_NOT_FOUND");
  });

  test("D6: isPrivilegedRole covers exactly the admin-level roles", () => {
    assert.equal(isPrivilegedRole("admin"), true);
    assert.equal(isPrivilegedRole("super_admin"), true);
    assert.equal(isPrivilegedRole("user"), false);
    assert.equal(isPrivilegedRole("root"), false);
  });
});
