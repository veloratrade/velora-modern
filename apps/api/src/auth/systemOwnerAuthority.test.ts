// System Owner — full authority and immutable access (service level).
//
// Two distinct properties are proven here:
//   1. AUTHORITY  — the owner satisfies every permission, including permissions
//      that do not exist yet, even though their stored RBAC role is `admin`.
//   2. IMMUTABILITY — no ordinary actor can suspend, demote or otherwise
//      disable the owner through user management.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MemoryUserStore } from "./memoryUserStore.js";
import { MemoryOwnershipStore } from "./memoryOwnershipStore.js";
import { AuthError } from "./authService.js";
import { AdminUserService } from "./adminUserService.js";
import {
  canAct,
  authorityPermissions,
  can,
  PERMISSIONS,
  type AuthorityContext,
  type AppRole,
  type Permission,
} from "@velora/contracts";
import type { AppRoleName } from "./userStore.js";
import { MemoryAuditStore } from "./memoryAuditStore.js";

const NOW = new Date("2026-09-14T12:00:00.000Z");

async function seed(
  store: MemoryUserStore,
  email: string,
  role: AppRoleName = "user",
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

/** Service wired exactly as production wires it: owner read from storage. */
function svcWithOwner(store: MemoryUserStore, owner: MemoryOwnershipStore): AdminUserService {
  return new AdminUserService({
    store,
    now: () => NOW,
    getSystemOwnerUserId: async () => (await owner.getOwnership())?.ownerUserId ?? null,
    audit: new MemoryAuditStore(),
  });
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

async function expectError(fn: () => Promise<unknown>): Promise<AuthError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof AuthError, `expected AuthError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected the call to throw");
}

const actor = (
  id: string,
  role: AppRole,
  isSystemOwner = false,
): { id: string; role: AppRole; isSystemOwner: boolean } => ({ id, role, isSystemOwner });

async function seedSession(store: MemoryUserStore, userId: string, hash: string): Promise<void> {
  await store.createSession({
    userId,
    refreshTokenHash: hash,
    accessTokenHash: `a-${hash}`,
    ipAddress: null,
    userAgent: null,
    expiresAt: new Date("2026-10-14T12:00:00.000Z"),
    createdAt: NOW,
  });
}

describe("System Owner — full authority", () => {
  test("A1: the owner satisfies EVERY defined permission", () => {
    const owner: AuthorityContext = { role: "admin", isSystemOwner: true };
    for (const p of PERMISSIONS) {
      assert.equal(canAct(owner, p), true, `owner must hold ${p}`);
    }
    assert.deepEqual([...authorityPermissions(owner)], [...PERMISSIONS]);
  });

  test("A2: owner authority works while the stored RBAC role is only `admin`", () => {
    const owner: AuthorityContext = { role: "admin", isSystemOwner: true };
    const plainAdmin: AuthorityContext = { role: "admin", isSystemOwner: false };
    // users.change_role is super_admin-only in ordinary RBAC.
    assert.equal(can("admin", "users.change_role"), false);
    assert.equal(canAct(plainAdmin, "users.change_role"), false);
    assert.equal(canAct(owner, "users.change_role"), true);
    // rbac.matrix.view likewise.
    assert.equal(canAct(owner, "rbac.matrix.view"), true);
  });

  test("A3: a FUTURE permission cannot accidentally exclude the owner", () => {
    // Simulates a capability added in a later phase that nobody remembered to
    // grant to the owner. Ownership is not an enumerated list, so it still holds.
    const future = "billing.refund.issue" as unknown as Permission;
    const owner: AuthorityContext = { role: "admin", isSystemOwner: true };
    assert.equal(canAct(owner, future), true);
    // ...while ordinary roles correctly do NOT hold it.
    assert.equal(canAct({ role: "super_admin", isSystemOwner: false }, future), false);
    assert.equal(canAct({ role: "admin", isSystemOwner: false }, future), false);
    assert.equal(canAct({ role: "user", isSystemOwner: false }, future), false);
  });

  test("A4: full authority is NOT an authentication bypass", () => {
    assert.equal(canAct(null, "users.view"), false);
    assert.equal(canAct(undefined, "users.view"), false);
  });

  test("A5: ordinary roles are unchanged by the owner-aware predicate", () => {
    for (const role of ["user", "admin", "super_admin"] as const) {
      for (const p of PERMISSIONS) {
        assert.equal(
          canAct({ role, isSystemOwner: false }, p),
          can(role, p),
          `${role}/${p} must match ordinary RBAC exactly`,
        );
      }
    }
  });

  test("A6: a non-owner cannot self-declare ownership in the context type", () => {
    // The context is built server-side; a false flag simply yields ordinary RBAC.
    assert.equal(canAct({ role: "user", isSystemOwner: false }, "admin.panel.access"), false);
  });
});

describe("System Owner — immutability", () => {
  test("B1: a Super Admin cannot SUSPEND the owner", async () => {
    const store = new MemoryUserStore();
    const owner = new MemoryOwnershipStore();
    const ownerId = await seed(store, "owner@example.com", "admin");
    await claimFor(owner, ownerId);
    const sup = await seed(store, "sup@example.com", "super_admin");
    await seedSession(store, ownerId, "owner-session");

    const err = await expectError(() =>
      svcWithOwner(store, owner).setStatus(ownerId, "suspended", actor(sup, "super_admin")),
    );
    assert.equal(err.status, 403);
    assert.equal(err.code, "SYSTEM_OWNER_PROTECTED");
    // Target unmutated, and no session was revoked.
    assert.equal((await store.findUserById(ownerId))!.status, "active");
    const s = await store.findSessionByRefreshTokenHash("owner-session");
    assert.equal(s !== null && s.revokedAt === null, true);
  });

  test("B2: a Super Admin cannot DEMOTE the owner", async () => {
    const store = new MemoryUserStore();
    const owner = new MemoryOwnershipStore();
    const ownerId = await seed(store, "owner@example.com", "admin");
    await claimFor(owner, ownerId);
    const sup = await seed(store, "sup@example.com", "super_admin");

    const err = await expectError(() =>
      svcWithOwner(store, owner).setRole(ownerId, "user", actor(sup, "super_admin")),
    );
    assert.equal(err.code, "SYSTEM_OWNER_PROTECTED");
    assert.equal((await store.findUserById(ownerId))!.role, "admin");
  });

  test("B3: a plain Admin cannot modify the owner", async () => {
    const store = new MemoryUserStore();
    const owner = new MemoryOwnershipStore();
    const ownerId = await seed(store, "owner@example.com", "admin");
    await claimFor(owner, ownerId);
    const adm = await seed(store, "adm@example.com", "admin");
    const svc = svcWithOwner(store, owner);

    assert.equal(
      (await expectError(() => svc.setRole(ownerId, "user", actor(adm, "admin")))).code,
      "SYSTEM_OWNER_PROTECTED",
    );
    assert.equal(
      (await expectError(() => svc.setStatus(ownerId, "suspended", actor(adm, "admin")))).code,
      "SYSTEM_OWNER_PROTECTED",
    );
  });

  test("B4: the owner is protected even when their role IS super_admin", async () => {
    const store = new MemoryUserStore();
    const owner = new MemoryOwnershipStore();
    const ownerId = await seed(store, "owner@example.com", "super_admin");
    await claimFor(owner, ownerId);
    const sup = await seed(store, "sup@example.com", "super_admin");
    const err = await expectError(() =>
      svcWithOwner(store, owner).setStatus(ownerId, "suspended", actor(sup, "super_admin")),
    );
    // Owner protection is checked BEFORE peer protection, so the more specific
    // reason is reported.
    assert.equal(err.code, "SYSTEM_OWNER_PROTECTED");
  });

  test("B5: even another owner-authority actor cannot disable the owner here", async () => {
    // Full authority is not a licence to break a safety invariant: this route
    // simply cannot disable the owner, whoever calls it.
    const store = new MemoryUserStore();
    const owner = new MemoryOwnershipStore();
    const ownerId = await seed(store, "owner@example.com", "admin");
    await claimFor(owner, ownerId);
    const other = await seed(store, "other@example.com", "super_admin");
    const err = await expectError(() =>
      svcWithOwner(store, owner).setStatus(ownerId, "suspended", actor(other, "super_admin", true)),
    );
    assert.equal(err.code, "SYSTEM_OWNER_PROTECTED");
  });

  test("B6: ownership is resolved from STORAGE, not from the actor context", async () => {
    const store = new MemoryUserStore();
    const owner = new MemoryOwnershipStore();
    const realOwner = await seed(store, "owner@example.com", "admin");
    await claimFor(owner, realOwner);
    const victim = await seed(store, "victim@example.com", "user");
    const sup = await seed(store, "sup@example.com", "super_admin");
    const svc = svcWithOwner(store, owner);

    // A non-owner target is NOT protected, even if the caller claims ownership.
    const okRes = await svc.setStatus(victim, "suspended", actor(sup, "super_admin", true));
    assert.equal(okRes.user.status, "suspended");
    // The real owner remains protected regardless.
    assert.equal(
      (await expectError(() => svc.setStatus(realOwner, "suspended", actor(sup, "super_admin"))))
        .code,
      "SYSTEM_OWNER_PROTECTED",
    );
  });

  test("B7: with ownership UNCLAIMED nothing is over-protected", async () => {
    const store = new MemoryUserStore();
    const owner = new MemoryOwnershipStore();
    const adm = await seed(store, "adm@example.com", "admin");
    const sup = await seed(store, "sup@example.com", "super_admin");
    const res = await svcWithOwner(store, owner).setStatus(
      adm,
      "suspended",
      actor(sup, "super_admin"),
    );
    assert.equal(res.user.status, "suspended");
  });

  test("B8: lower-level user management is unaffected by owner protection", async () => {
    const store = new MemoryUserStore();
    const owner = new MemoryOwnershipStore();
    const ownerId = await seed(store, "owner@example.com", "admin");
    await claimFor(owner, ownerId);
    const sup = await seed(store, "sup@example.com", "super_admin");
    const plain = await seed(store, "plain@example.com", "user");
    const svc = svcWithOwner(store, owner);

    const promoted = await svc.setRole(plain, "admin", actor(sup, "super_admin"));
    assert.equal(promoted.user.role, "admin");
    const suspended = await svc.setStatus(plain, "suspended", actor(sup, "super_admin"));
    assert.equal(suspended.user.status, "suspended");
  });

  test("B9: existing invariants still hold — peer protection and self-action", async () => {
    const store = new MemoryUserStore();
    const owner = new MemoryOwnershipStore();
    const ownerId = await seed(store, "owner@example.com", "admin");
    await claimFor(owner, ownerId);
    const a = await seed(store, "a@example.com", "super_admin");
    const b = await seed(store, "b@example.com", "super_admin");
    const svc = svcWithOwner(store, owner);

    assert.equal(
      (await expectError(() => svc.setStatus(b, "suspended", actor(a, "super_admin")))).code,
      "SUPER_ADMIN_PEER_PROTECTED",
    );
    assert.equal(
      (await expectError(() => svc.setRole(a, "admin", actor(a, "super_admin")))).code,
      "SELF_ACTION_DENIED",
    );
  });

  test("B10: the owner cannot disable themselves through this surface", async () => {
    const store = new MemoryUserStore();
    const owner = new MemoryOwnershipStore();
    const ownerId = await seed(store, "owner@example.com", "admin");
    await claimFor(owner, ownerId);
    const svc = svcWithOwner(store, owner);
    // Self-action protection fires first and still applies.
    assert.equal(
      (await expectError(() => svc.setStatus(ownerId, "suspended", actor(ownerId, "admin", true))))
        .code,
      "SELF_ACTION_DENIED",
    );
  });
});
