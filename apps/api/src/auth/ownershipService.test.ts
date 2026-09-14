// System Owner bootstrap — service-level lifecycle and security tests.
//
// Covers the one-time claim invariant, the eligibility preconditions, and the
// guarantee that ownership can never be obtained through a client-supplied
// field or a stale token role.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MemoryUserStore } from "./memoryUserStore.js";
import { MemoryOwnershipStore } from "./memoryOwnershipStore.js";
import { VeloraHasher } from "./hashing.js";
import { AuthError } from "./authService.js";
import {
  OwnershipService,
  OWNERSHIP_CLAIM_CONFIRMATION,
} from "./ownershipService.js";
import type { AppRoleName } from "./userStore.js";

const NOW = new Date("2026-09-14T12:00:00.000Z");
const PASSWORD = "correct horse battery staple 9";

interface Fixture {
  users: MemoryUserStore;
  ownership: MemoryOwnershipStore;
  svc: OwnershipService;
}

async function fixture(): Promise<Fixture> {
  const users = new MemoryUserStore();
  const ownership = new MemoryOwnershipStore();
  const svc = new OwnershipService({
    ownership,
    users,
    hasher: new VeloraHasher(),
    now: () => NOW,
  });
  return { users, ownership, svc };
}

/** Seeds a user; verified+active by default, mirroring a real bootstrap admin. */
async function seed(
  users: MemoryUserStore,
  email: string,
  role: AppRoleName = "admin",
  opts: { verified?: boolean; status?: string } = {},
): Promise<string> {
  const hasher = new VeloraHasher();
  const u = await users.createUser({
    email,
    passwordHash: await hasher.hash(PASSWORD),
    fullName: "Bootstrap Admin",
    timezone: "UTC",
    locale: "en",
    now: NOW,
  });
  if (role !== "user") await users.updateUserRole(u.id, role, NOW);
  if (opts.verified !== false) await users.markEmailVerified(u.id, NOW);
  if (opts.status !== undefined) await users.updateUserStatus(u.id, opts.status, NOW);
  return u.id;
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

const claimArgs = (actorId: string): Parameters<OwnershipService["claim"]>[0] => ({
  actorId,
  password: PASSWORD,
  confirm: OWNERSHIP_CLAIM_CONFIRMATION,
});

describe("System Owner — bootstrap claim", () => {
  test("O1: an initial authorized Admin can claim System Ownership", async () => {
    const { users, svc } = await fixture();
    const adminId = await seed(users, "admin@example.com", "admin");

    const before = await svc.status();
    assert.equal(before.claimed, false);
    assert.equal(before.ownerUserId, null);

    const result = await svc.claim(claimArgs(adminId));
    assert.equal(result.ownerUserId, adminId);
    assert.equal(result.claimedAt, NOW.toISOString());

    const after = await svc.status();
    assert.equal(after.claimed, true);
    assert.equal(after.ownerUserId, adminId);
  });

  test("O2: the claim is EXPLICIT — a missing/incorrect confirmation is rejected", async () => {
    const { users, svc } = await fixture();
    const adminId = await seed(users, "admin@example.com", "admin");
    for (const bad of ["", "yes", "claim system ownership", "CLAIM OWNERSHIP"]) {
      const err = await expectError(() =>
        svc.claim({ actorId: adminId, password: PASSWORD, confirm: bad }),
      );
      assert.equal(err.status, 400);
      assert.equal(err.code, "CONFIRMATION_REQUIRED");
    }
    assert.equal((await svc.status()).claimed, false);
  });

  test("O3: normal registration does NOT create ownership (no first-user rule)", async () => {
    const { users, svc } = await fixture();
    // Three registrations, including the very first row in the store.
    await seed(users, "first@example.com", "user");
    await seed(users, "second@example.com", "user");
    await seed(users, "third@example.com", "admin");
    assert.equal((await svc.status()).claimed, false, "registration must never claim ownership");
  });

  test("O4: after bootstrap, another Admin cannot claim ownership", async () => {
    const { users, svc } = await fixture();
    const first = await seed(users, "admin1@example.com", "admin");
    const second = await seed(users, "admin2@example.com", "admin");
    await svc.claim(claimArgs(first));

    const err = await expectError(() => svc.claim(claimArgs(second)));
    assert.equal(err.status, 409);
    assert.equal(err.code, "OWNERSHIP_ALREADY_CLAIMED");
    // Ownership is unchanged — still the original owner.
    assert.equal((await svc.status()).ownerUserId, first);
  });

  test("O5: a Super Admin cannot claim ownership after bootstrap", async () => {
    const { users, svc } = await fixture();
    const first = await seed(users, "admin@example.com", "admin");
    const superId = await seed(users, "super@example.com", "super_admin");
    await svc.claim(claimArgs(first));

    const err = await expectError(() => svc.claim(claimArgs(superId)));
    assert.equal(err.status, 409);
    assert.equal(err.code, "OWNERSHIP_ALREADY_CLAIMED");
    assert.equal((await svc.status()).ownerUserId, first);
  });

  test("O5b: a Super Admin cannot claim ownership even BEFORE bootstrap", async () => {
    // Bootstrap is reserved for the initial administrator (role exactly 'admin').
    const { users, svc } = await fixture();
    const superId = await seed(users, "super@example.com", "super_admin");
    const err = await expectError(() => svc.claim(claimArgs(superId)));
    assert.equal(err.status, 403);
    assert.equal(err.code, "OWNERSHIP_CLAIM_FORBIDDEN");
    assert.equal((await svc.status()).claimed, false);
  });

  test("O6: a plain User cannot claim ownership", async () => {
    const { users, svc } = await fixture();
    const userId = await seed(users, "user@example.com", "user");
    const err = await expectError(() => svc.claim(claimArgs(userId)));
    assert.equal(err.status, 403);
    assert.equal(err.code, "OWNERSHIP_CLAIM_FORBIDDEN");
    assert.equal((await svc.status()).claimed, false);
  });

  test("O7: ownership requires correct password re-authentication", async () => {
    const { users, svc } = await fixture();
    const adminId = await seed(users, "admin@example.com", "admin");
    const err = await expectError(() =>
      svc.claim({
        actorId: adminId,
        password: "wrong-password",
        confirm: OWNERSHIP_CLAIM_CONFIRMATION,
      }),
    );
    assert.equal(err.status, 401);
    assert.equal(err.code, "INVALID_CREDENTIALS");
    assert.equal((await svc.status()).claimed, false);
  });

  test("O8: the claim cannot be performed twice by the SAME admin", async () => {
    const { users, svc } = await fixture();
    const adminId = await seed(users, "admin@example.com", "admin");
    await svc.claim(claimArgs(adminId));
    const err = await expectError(() => svc.claim(claimArgs(adminId)));
    assert.equal(err.status, 409);
    assert.equal(err.code, "OWNERSHIP_ALREADY_CLAIMED");
  });

  test("O9: a suspended or unverified admin cannot claim ownership", async () => {
    const a = await fixture();
    const suspended = await seed(a.users, "susp@example.com", "admin", { status: "suspended" });
    const e1 = await expectError(() => a.svc.claim(claimArgs(suspended)));
    assert.equal(e1.code, "OWNERSHIP_CLAIM_FORBIDDEN");

    const b = await fixture();
    const unverified = await seed(b.users, "unver@example.com", "admin", { verified: false });
    const e2 = await expectError(() => b.svc.claim(claimArgs(unverified)));
    assert.equal(e2.code, "OWNERSHIP_CLAIM_FORBIDDEN");
    assert.equal((await b.svc.status()).claimed, false);
  });

  test("O10: an unknown actor id is rejected as unauthenticated", async () => {
    const { svc } = await fixture();
    const err = await expectError(() => svc.claim(claimArgs("no-such-user")));
    assert.equal(err.status, 401);
    assert.equal(err.code, "UNAUTHENTICATED");
  });

  test("O11: concurrent claims — exactly ONE succeeds", async () => {
    const { users, svc } = await fixture();
    const a = await seed(users, "a@example.com", "admin");
    const b = await seed(users, "b@example.com", "admin");
    const c = await seed(users, "c@example.com", "admin");
    const results = await Promise.allSettled([
      svc.claim(claimArgs(a)),
      svc.claim(claimArgs(b)),
      svc.claim(claimArgs(c)),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    assert.equal(ok.length, 1, "exactly one concurrent claim may succeed");
    for (const r of results.filter((x) => x.status === "rejected")) {
      const reason = (r as PromiseRejectedResult).reason as AuthError;
      assert.equal(reason.code, "OWNERSHIP_ALREADY_CLAIMED");
    }
    // The stored owner is the one that succeeded.
    const winner = (ok[0] as PromiseFulfilledResult<{ ownerUserId: string }>).value;
    assert.equal((await svc.status()).ownerUserId, winner.ownerUserId);
  });

  test("O12: the claim never mutates the acting user's role", async () => {
    // Ownership is installation state, NOT a role promotion. The claimant stays
    // an `admin` in the RBAC model.
    const { users, svc } = await fixture();
    const adminId = await seed(users, "admin@example.com", "admin");
    await svc.claim(claimArgs(adminId));
    const after = await users.findUserById(adminId);
    assert.equal(after!.role, "admin", "ownership must not change the RBAC role");
  });

  test("O13: ownership status never exposes a secret", async () => {
    const { users, svc } = await fixture();
    const adminId = await seed(users, "admin@example.com", "admin");
    await svc.claim(claimArgs(adminId));
    const serialized = JSON.stringify(await svc.status());
    assert.equal(serialized.includes(PASSWORD), false);
    assert.equal(serialized.includes("$argon2"), false);
    assert.equal(serialized.includes("passwordHash"), false);
  });
});
