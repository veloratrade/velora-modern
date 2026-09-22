// Super Admin peer protection + last-active-Super-Admin invariant.
//
// These are two SEPARATE protections and are tested separately:
//   - Peer protection is about WHO may act on whom (super admins are peers).
//   - The last-active invariant is a system-wide rule that must hold no matter
//     who acts, including when the actor is the target.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MemoryUserStore } from "./memoryUserStore.js";
import { AuthError } from "./authService.js";
import { AdminUserService } from "./adminUserService.js";
import type { AppRole } from "@velora/contracts";
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

const svcFor = (store: MemoryUserStore): AdminUserService =>
  new AdminUserService({
    store,
    now: () => NOW,
    // Peer / last-admin invariants are under test here, not ownership: the
    // installation is explicitly unowned.
    getSystemOwnerUserId: async () => null,
    audit: new MemoryAuditStore(),
  });

async function expectError(fn: () => Promise<unknown>): Promise<AuthError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof AuthError, `expected AuthError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected the call to throw");
}

/** Seeds a session so "was it revoked?" is observable. */
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

async function sessionAlive(store: MemoryUserStore, hash: string): Promise<boolean> {
  const s = await store.findSessionByRefreshTokenHash(hash);
  return s !== null && s.revokedAt === null;
}

const actor = (id: string, role: AppRole): { id: string; role: AppRole } => ({ id, role });

describe("Super Admin peer protection", () => {
  test("P1: Super Admin A cannot DEMOTE Super Admin B", async () => {
    const store = new MemoryUserStore();
    const a = await seed(store, "a@example.com", "super_admin");
    const b = await seed(store, "b@example.com", "super_admin");
    await seedSession(store, b, "b-session");

    const err = await expectError(() =>
      svcFor(store).setRole(b, "user", actor(a, "super_admin")),
    );
    assert.equal(err.status, 403);
    assert.equal(err.code, "SUPER_ADMIN_PEER_PROTECTED");
    // 14: the rejected operation did not mutate the target.
    assert.equal((await store.findUserById(b))!.role, "super_admin");
    // 15: and caused no unintended session revocation.
    assert.equal(await sessionAlive(store, "b-session"), true);
  });

  test("P2: Super Admin A cannot SUSPEND Super Admin B", async () => {
    const store = new MemoryUserStore();
    const a = await seed(store, "a@example.com", "super_admin");
    const b = await seed(store, "b@example.com", "super_admin");
    await seedSession(store, b, "b-session-2");

    const err = await expectError(() =>
      svcFor(store).setStatus(b, "suspended", actor(a, "super_admin")),
    );
    assert.equal(err.status, 403);
    assert.equal(err.code, "SUPER_ADMIN_PEER_PROTECTED");
    assert.equal((await store.findUserById(b))!.status, "active");
    assert.equal(await sessionAlive(store, "b-session-2"), true);
  });

  test("P3: Super Admin A cannot revoke B's admin authority by demoting to admin", async () => {
    const store = new MemoryUserStore();
    const a = await seed(store, "a@example.com", "super_admin");
    const b = await seed(store, "b@example.com", "super_admin");
    const err = await expectError(() =>
      svcFor(store).setRole(b, "admin", actor(a, "super_admin")),
    );
    assert.equal(err.code, "SUPER_ADMIN_PEER_PROTECTED");
    assert.equal((await store.findUserById(b))!.role, "super_admin");
  });

  test("P4: peer protection holds even when the peer is SUSPENDED", async () => {
    // A suspended super admin is still a peer; reactivating or demoting them is
    // not an ordinary user-management action.
    const store = new MemoryUserStore();
    const a = await seed(store, "a@example.com", "super_admin");
    const b = await seed(store, "b@example.com", "super_admin", "suspended");
    const err = await expectError(() =>
      svcFor(store).setStatus(b, "active", actor(a, "super_admin")),
    );
    assert.equal(err.code, "SUPER_ADMIN_PEER_PROTECTED");
  });

  test("P5: a plain Admin cannot modify a Super Admin", async () => {
    const store = new MemoryUserStore();
    const adm = await seed(store, "adm@example.com", "admin");
    const sup = await seed(store, "sup@example.com", "super_admin");
    await seedSession(store, sup, "sup-session");

    const e1 = await expectError(() => svcFor(store).setRole(sup, "user", actor(adm, "admin")));
    assert.equal(e1.code, "PRIVILEGED_TARGET");
    const e2 = await expectError(() =>
      svcFor(store).setStatus(sup, "suspended", actor(adm, "admin")),
    );
    assert.equal(e2.code, "PRIVILEGED_TARGET");

    assert.equal((await store.findUserById(sup))!.role, "super_admin");
    assert.equal((await store.findUserById(sup))!.status, "active");
    assert.equal(await sessionAlive(store, "sup-session"), true);
  });

  test("P6: lower-level user management still works (no over-blocking)", async () => {
    const store = new MemoryUserStore();
    const sup = await seed(store, "sup@example.com", "super_admin");
    const adm = await seed(store, "adm@example.com", "admin");
    const usr = await seed(store, "usr@example.com", "user");
    const svc = svcFor(store);

    // super_admin manages an admin
    const r1 = await svc.setStatus(adm, "suspended", actor(sup, "super_admin"));
    assert.equal(r1.user.status, "suspended");
    // super_admin promotes a user
    const r2 = await svc.setRole(usr, "admin", actor(sup, "super_admin"));
    assert.equal(r2.user.role, "admin");
    // admin manages a plain user
    const usr2 = await seed(store, "usr2@example.com", "user");
    const r3 = await svc.setStatus(usr2, "suspended", actor(adm, "admin"));
    assert.equal(r3.user.status, "suspended");
  });
});

describe("Last active Super Admin invariant", () => {
  test("L1: the ONLY active super admin cannot demote themselves", async () => {
    // Blocked by SELF_ACTION_DENIED, which is checked before the invariant.
    const store = new MemoryUserStore();
    const a = await seed(store, "a@example.com", "super_admin");
    const err = await expectError(() =>
      svcFor(store).setRole(a, "admin", actor(a, "super_admin")),
    );
    assert.equal(err.status, 403);
    assert.equal(err.code, "SELF_ACTION_DENIED");
    assert.equal((await store.findUserById(a))!.role, "super_admin");
  });

  test("L2: the ONLY active super admin cannot suspend themselves", async () => {
    const store = new MemoryUserStore();
    const a = await seed(store, "a@example.com", "super_admin");
    const err = await expectError(() =>
      svcFor(store).setStatus(a, "suspended", actor(a, "super_admin")),
    );
    assert.equal(err.status, 403);
    assert.equal(err.code, "SELF_ACTION_DENIED");
    assert.equal((await store.findUserById(a))!.status, "active");
  });

  test("L3: the invariant counts ACTIVE super admins, not merely the role", async () => {
    // Two super admins exist, but only one is ACTIVE. Demoting the active one
    // must be rejected: a suspended super admin cannot log in, so allowing it
    // would leave the installation with no usable administrator.
    const store = new MemoryUserStore();
    await seed(store, "suspended-super@example.com", "super_admin", "suspended");
    const active = await seed(store, "active-super@example.com", "super_admin");

    // countUsersByRole (role only) would say 2 — the invariant must not use it.
    assert.equal(await store.countUsersByRole("super_admin"), 2);
    assert.equal(await store.countActiveUsersByRole("super_admin"), 1);
    assert.equal(await store.countActiveUsersByRole("super_admin", active), 0);

    // Direct proof of the invariant, bypassing peer protection by acting as the
    // system: the helper is reached whenever a caller is otherwise permitted.
    const err = await expectError(() =>
      svcFor(store).setRole(active, "admin", actor("system-actor", "super_admin")),
    );
    // Peer protection fires first for a super_admin target; both protections
    // independently refuse, which is the intended defence in depth.
    assert.equal(err.code, "SUPER_ADMIN_PEER_PROTECTED");
    assert.equal((await store.findUserById(active))!.role, "super_admin");
  });

  test("L4: countActiveUsersByRole excludes suspended accounts and the target", async () => {
    const store = new MemoryUserStore();
    const a = await seed(store, "a@example.com", "super_admin");
    const b = await seed(store, "b@example.com", "super_admin");
    await seed(store, "c@example.com", "super_admin", "suspended");
    await seed(store, "d@example.com", "admin");

    assert.equal(await store.countActiveUsersByRole("super_admin"), 2);
    assert.equal(await store.countActiveUsersByRole("super_admin", a), 1);
    assert.equal(await store.countActiveUsersByRole("super_admin", b), 1);
    assert.equal(await store.countActiveUsersByRole("admin"), 1);
  });

  test("L5: with two active super admins, neither may remove the other (peers)", async () => {
    const store = new MemoryUserStore();
    const a = await seed(store, "a@example.com", "super_admin");
    const b = await seed(store, "b@example.com", "super_admin");
    const svc = svcFor(store);
    assert.equal(
      (await expectError(() => svc.setStatus(b, "suspended", actor(a, "super_admin")))).code,
      "SUPER_ADMIN_PEER_PROTECTED",
    );
    assert.equal(
      (await expectError(() => svc.setStatus(a, "suspended", actor(b, "super_admin")))).code,
      "SUPER_ADMIN_PEER_PROTECTED",
    );
    assert.equal(await store.countActiveUsersByRole("super_admin"), 2);
  });

  test("L5b: the invariant itself rejects zero-active-super-admin DIRECTLY", async () => {
    // HONEST NOTE ON REACHABILITY: with peer protection in place, every
    // super_admin target is refused by SUPER_ADMIN_PEER_PROTECTED before the
    // invariant is consulted, and self-action is refused earlier still. The
    // invariant is therefore a DEFENCE-IN-DEPTH layer that the two supported
    // routes cannot currently reach. To prove it actually works rather than
    // assuming it, this test invokes the private helper directly: if peer
    // protection is ever relaxed, this is the layer that must still hold.
    const store = new MemoryUserStore();
    const only = await seed(store, "only@example.com", "super_admin");
    const target = (await store.findUserById(only))!;
    const svc = svcFor(store);

    // Reach the private helper explicitly (test-only introspection).
    const assertRemains = (
      svc as unknown as {
        assertSuperAdminRemains: (t: typeof target, loses: boolean) => Promise<void>;
      }
    ).assertSuperAdminRemains.bind(svc);

    // Demoting/suspending the ONLY active super admin => rejected.
    const err = await expectError(() => assertRemains(target, true));
    assert.equal(err.status, 409);
    assert.equal(err.code, "LAST_SUPER_ADMIN");

    // A change that does NOT lose an active super admin is allowed through.
    await assertRemains(target, false);

    // With a second ACTIVE super admin present, the same removal is allowed.
    await seed(store, "second@example.com", "super_admin");
    await assertRemains(target, true);

    // But if that second super admin is SUSPENDED, it is rejected again —
    // proving the count is active-aware rather than role-only.
    const store2 = new MemoryUserStore();
    const onlyActive = await seed(store2, "x@example.com", "super_admin");
    await seed(store2, "y@example.com", "super_admin", "suspended");
    const t2 = (await store2.findUserById(onlyActive))!;
    const svc2 = svcFor(store2);
    const assertRemains2 = (
      svc2 as unknown as {
        assertSuperAdminRemains: (t: typeof t2, loses: boolean) => Promise<void>;
      }
    ).assertSuperAdminRemains.bind(svc2);
    const err2 = await expectError(() => assertRemains2(t2, true));
    assert.equal(err2.code, "LAST_SUPER_ADMIN");
  });

  test("L6: the invariant cannot be reached to zero by any supported mutation", async () => {
    // Exhaustive over the supported surface with a single active super admin:
    // self-action is denied, admins are blocked, peers are blocked. There is no
    // supported call that results in zero active super admins.
    const store = new MemoryUserStore();
    const only = await seed(store, "only@example.com", "super_admin");
    const adm = await seed(store, "adm@example.com", "admin");
    const svc = svcFor(store);

    const attempts: (() => Promise<unknown>)[] = [
      () => svc.setRole(only, "user", actor(only, "super_admin")),
      () => svc.setStatus(only, "suspended", actor(only, "super_admin")),
      () => svc.setRole(only, "user", actor(adm, "admin")),
      () => svc.setStatus(only, "suspended", actor(adm, "admin")),
      () => svc.setRole(only, "admin", actor("other-super", "super_admin")),
      () => svc.setStatus(only, "suspended", actor("other-super", "super_admin")),
    ];
    for (const attempt of attempts) await expectError(attempt);

    const after = await store.findUserById(only);
    assert.equal(after!.role, "super_admin");
    assert.equal(after!.status, "active");
    assert.equal(await store.countActiveUsersByRole("super_admin"), 1);
  });
});
