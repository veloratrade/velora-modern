// C-34 — append-only security audit trail.
//
// Covers the eleven behaviours required for this phase: one record per
// successful privileged action, NO record for any rejected one, the existing
// protections still intact, immutability through the application layer, the
// absence of secret material, and transactional correctness.
import test from "node:test";
import assert from "node:assert/strict";
import { VeloraHasher } from "./hashing.js";
import { MemoryUserStore } from "./memoryUserStore.js";
import { MemoryOwnershipStore } from "./memoryOwnershipStore.js";
import { MemoryAuditStore } from "./memoryAuditStore.js";
import { AdminUserService } from "./adminUserService.js";
import { OwnershipService, OWNERSHIP_CLAIM_CONFIRMATION } from "./ownershipService.js";
import { AuthError } from "./authService.js";
import type { AuditEntry, AuditRecord, AuditStore, AuditTx } from "./auditStore.js";
import type { AppRoleName } from "./userStore.js";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const PASSWORD = "Correct-Horse-9!";

/** An audit store whose append always fails — for the rollback proof (11). */
class FailingAuditStore implements AuditStore {
  calls = 0;
  async append(): Promise<AuditRecord> {
    this.calls += 1;
    throw new Error("audit backend unavailable");
  }
  async list(): Promise<readonly AuditRecord[]> {
    return [];
  }
}

async function seedUser(
  store: MemoryUserStore,
  email: string,
  role: AppRoleName,
  opts: { status?: string; verified?: boolean } = {},
): Promise<string> {
  const hasher = new VeloraHasher();
  const u = await store.createUser({
    email,
    passwordHash: await hasher.hash(PASSWORD),
    fullName: email.split("@")[0]!,
    locale: "en",
    timezone: "UTC",
    now: NOW,
  });
  if (role !== "user") await store.updateUserRole(u.id, role, NOW);
  if (opts.status !== undefined) await store.updateUserStatus(u.id, opts.status, NOW);
  if (opts.verified === true) await store.markEmailVerified(u.id, NOW);
  return u.id;
}

function adminHarness(audit: AuditStore = new MemoryAuditStore()) {
  const store = new MemoryUserStore();
  const owner = new MemoryOwnershipStore();
  const service = new AdminUserService({
    store,
    now: () => NOW,
    getSystemOwnerUserId: async () => (await owner.getOwnership())?.ownerUserId ?? null,
    audit,
  });
  return { store, owner, service, audit };
}

function ownershipHarness(audit: AuditStore = new MemoryAuditStore()) {
  const users = new MemoryUserStore();
  const ownership = new MemoryOwnershipStore();
  const service = new OwnershipService({
    ownership,
    users,
    hasher: new VeloraHasher(),
    now: () => NOW,
    audit,
  });
  return { users, ownership, service, audit };
}

// --------------------------------------------------------------------------
// 1. Successful System Owner claim produces exactly one audit record.
// --------------------------------------------------------------------------
test("C-34/1: a successful ownership claim writes exactly one OWNERSHIP_CLAIMED record", async () => {
  const h = ownershipHarness();
  const actorId = await seedUser(h.users, "owner@velora.ir", "admin", { verified: true });

  await h.service.claim({
    actorId,
    password: PASSWORD,
    confirm: OWNERSHIP_CLAIM_CONFIRMATION,
    requestId: "req-claim-1",
  });

  const records = await h.audit.list();
  assert.equal(records.length, 1);
  const r = records[0]!;
  assert.equal(r.action, "OWNERSHIP_CLAIMED");
  assert.equal(r.actorUserId, actorId); // server-derived identity, not client input
  assert.equal(r.targetUserId, actorId); // self-claim
  assert.equal(r.beforeState, null);
  assert.equal(r.afterState, "claimed");
  assert.equal(r.outcome, "success");
  assert.equal(r.requestId, "req-claim-1");
  assert.equal(r.occurredAt, NOW.toISOString());
});

// --------------------------------------------------------------------------
// 2. A failed / duplicate claim creates NO successful ownership event.
// --------------------------------------------------------------------------
test("C-34/2: rejected claims (duplicate, wrong password, bad confirm) write no audit record", async () => {
  const h = ownershipHarness();
  const first = await seedUser(h.users, "first@velora.ir", "admin", { verified: true });
  const second = await seedUser(h.users, "second@velora.ir", "admin", { verified: true });

  await h.service.claim({ actorId: first, password: PASSWORD, confirm: OWNERSHIP_CLAIM_CONFIRMATION });
  assert.equal((await h.audit.list()).length, 1);

  // Duplicate claim by another eligible admin → 409, no new record.
  await assert.rejects(
    h.service.claim({ actorId: second, password: PASSWORD, confirm: OWNERSHIP_CLAIM_CONFIRMATION }),
    (e: unknown) => e instanceof AuthError && e.code === "OWNERSHIP_ALREADY_CLAIMED",
  );

  const records = await h.audit.list();
  assert.equal(records.length, 1, "the duplicate claim must not add an event");
  assert.equal(records[0]!.actorUserId, first);

  // A fresh installation: wrong password and wrong confirmation phrase.
  const h2 = ownershipHarness();
  const admin = await seedUser(h2.users, "admin@velora.ir", "admin", { verified: true });
  await assert.rejects(
    h2.service.claim({ actorId: admin, password: "wrong-password", confirm: OWNERSHIP_CLAIM_CONFIRMATION }),
    (e: unknown) => e instanceof AuthError && e.code === "INVALID_CREDENTIALS",
  );
  await assert.rejects(
    h2.service.claim({ actorId: admin, password: PASSWORD, confirm: "claim it" }),
    (e: unknown) => e instanceof AuthError,
  );
  // An ineligible (unverified) admin.
  const unverified = await seedUser(h2.users, "unverified@velora.ir", "admin");
  await assert.rejects(
    h2.service.claim({ actorId: unverified, password: PASSWORD, confirm: OWNERSHIP_CLAIM_CONFIRMATION }),
    (e: unknown) => e instanceof AuthError && e.code === "OWNERSHIP_CLAIM_FORBIDDEN",
  );
  assert.deepEqual(await h2.audit.list(), [], "no failed claim may be recorded as success");
  assert.equal(await h2.ownership.getOwnership(), null);
});

// --------------------------------------------------------------------------
// 3. Successful role change records actor, target, old and new role.
// --------------------------------------------------------------------------
test("C-34/3: a successful role change writes exactly one USER_ROLE_CHANGED record", async () => {
  const h = adminHarness();
  const actor = await seedUser(h.store, "sa@velora.ir", "super_admin");
  const target = await seedUser(h.store, "target@velora.ir", "user");

  await h.service.setRole(target, "admin", { id: actor, role: "super_admin", requestId: "req-role-1" });

  const records = await h.audit.list();
  assert.equal(records.length, 1);
  const r = records[0]!;
  assert.equal(r.action, "USER_ROLE_CHANGED");
  assert.equal(r.actorUserId, actor);
  assert.equal(r.targetUserId, target);
  assert.equal(r.beforeState, "user"); // old value
  assert.equal(r.afterState, "admin"); // new value
  assert.equal(r.outcome, "success");
  assert.equal(r.requestId, "req-role-1");
});

// --------------------------------------------------------------------------
// 4. A rejected role mutation records nothing.
// --------------------------------------------------------------------------
test("C-34/4: rejected role mutations write no audit record", async () => {
  const h = adminHarness();
  const actor = await seedUser(h.store, "sa@velora.ir", "super_admin");
  const peer = await seedUser(h.store, "peer@velora.ir", "super_admin");
  const target = await seedUser(h.store, "target@velora.ir", "user");
  const admin = await seedUser(h.store, "admin@velora.ir", "admin");

  // Self-action.
  await assert.rejects(
    h.service.setRole(actor, "admin", { id: actor, role: "super_admin" }),
    (e: unknown) => e instanceof AuthError && e.code === "SELF_ACTION_DENIED",
  );
  // Super-admin peer protection.
  await assert.rejects(
    h.service.setRole(peer, "user", { id: actor, role: "super_admin" }),
    (e: unknown) => e instanceof AuthError && e.code === "SUPER_ADMIN_PEER_PROTECTED",
  );
  // Invalid role value.
  await assert.rejects(
    h.service.setRole(target, "root" as AppRoleName, { id: actor, role: "super_admin" }),
    (e: unknown) => e instanceof AuthError && e.code === "INVALID_ROLE",
  );
  // Unknown target.
  await assert.rejects(
    h.service.setRole("999999", "admin", { id: actor, role: "super_admin" }),
    (e: unknown) => e instanceof AuthError && e.code === "USER_NOT_FOUND",
  );
  // Privilege escalation by a non-super-admin actor.
  await assert.rejects(
    h.service.setRole(target, "super_admin", { id: admin, role: "admin" }),
    (e: unknown) => e instanceof AuthError,
  );

  assert.deepEqual(await h.audit.list(), []);
});

// --------------------------------------------------------------------------
// 5. Successful status change records actor, target, old and new status.
// --------------------------------------------------------------------------
test("C-34/5: a successful status change writes exactly one USER_STATUS_CHANGED record", async () => {
  const h = adminHarness();
  const actor = await seedUser(h.store, "admin@velora.ir", "admin");
  const target = await seedUser(h.store, "target@velora.ir", "user");

  const res = await h.service.setStatus(target, "suspended", { id: actor, role: "admin", requestId: "req-status-1" });
  assert.equal(res.sessionsRevoked, true); // E: session-revocation semantics preserved

  const records = await h.audit.list();
  assert.equal(records.length, 1);
  const r = records[0]!;
  assert.equal(r.action, "USER_STATUS_CHANGED");
  assert.equal(r.actorUserId, actor);
  assert.equal(r.targetUserId, target);
  assert.equal(r.beforeState, "active");
  assert.equal(r.afterState, "suspended");
  assert.equal(r.requestId, "req-status-1");

  // Reactivation is also recorded, with the reversed transition.
  await h.service.setStatus(target, "active", { id: actor, role: "admin" });
  const after = await h.audit.list();
  assert.equal(after.length, 2);
  assert.equal(after[0]!.beforeState, "suspended"); // newest first
  assert.equal(after[0]!.afterState, "active");
});

// --------------------------------------------------------------------------
// 6. A rejected status mutation records nothing.
// --------------------------------------------------------------------------
test("C-34/6: rejected status mutations write no audit record", async () => {
  const h = adminHarness();
  const actor = await seedUser(h.store, "admin@velora.ir", "admin");
  const sa = await seedUser(h.store, "sa@velora.ir", "super_admin");
  const target = await seedUser(h.store, "target@velora.ir", "user");

  await assert.rejects(
    h.service.setStatus(actor, "suspended", { id: actor, role: "admin" }),
    (e: unknown) => e instanceof AuthError && e.code === "SELF_ACTION_DENIED",
  );
  await assert.rejects(
    h.service.setStatus(sa, "suspended", { id: actor, role: "admin" }),
    (e: unknown) => e instanceof AuthError && e.code === "PRIVILEGED_TARGET",
  );
  await assert.rejects(
    h.service.setStatus(target, "deleted", { id: actor, role: "admin" }),
    (e: unknown) => e instanceof AuthError && e.code === "INVALID_STATUS",
  );
  await assert.rejects(
    h.service.setStatus("999999", "suspended", { id: actor, role: "admin" }),
    (e: unknown) => e instanceof AuthError && e.code === "USER_NOT_FOUND",
  );

  assert.deepEqual(await h.audit.list(), []);
});

// --------------------------------------------------------------------------
// 7. System Owner protection is intact, and produces no audit record.
// --------------------------------------------------------------------------
test("C-34/7: System Owner immutability still holds and logs nothing", async () => {
  const h = adminHarness();
  const sa = await seedUser(h.store, "sa@velora.ir", "super_admin");
  const ownerId = await seedUser(h.store, "owner@velora.ir", "admin", { verified: true });
  await h.owner.claimOwnership({
    ownerUserId: ownerId,
    claimedByUserId: ownerId,
    claimedIp: null,
    claimedUserAgent: null,
    now: NOW,
  });

  await assert.rejects(
    h.service.setRole(ownerId, "user", { id: sa, role: "super_admin" }),
    (e: unknown) => e instanceof AuthError && e.code === "SYSTEM_OWNER_PROTECTED",
  );
  await assert.rejects(
    h.service.setStatus(ownerId, "suspended", { id: sa, role: "super_admin" }),
    (e: unknown) => e instanceof AuthError && e.code === "SYSTEM_OWNER_PROTECTED",
  );

  assert.deepEqual(await h.audit.list(), []);
  const stillOwner = await h.store.findUserById(ownerId);
  assert.equal(stillOwner!.role, "admin");
  assert.equal(stillOwner!.status, "active");
});

// --------------------------------------------------------------------------
// 8. Super Admin peer protection is intact, and produces no audit record.
// --------------------------------------------------------------------------
test("C-34/8: super-admin peer protection still holds and logs nothing", async () => {
  const h = adminHarness();
  const sa = await seedUser(h.store, "sa1@velora.ir", "super_admin");
  const peer = await seedUser(h.store, "sa2@velora.ir", "super_admin");

  await assert.rejects(
    h.service.setRole(peer, "user", { id: sa, role: "super_admin" }),
    (e: unknown) => e instanceof AuthError && e.code === "SUPER_ADMIN_PEER_PROTECTED",
  );
  await assert.rejects(
    h.service.setStatus(peer, "suspended", { id: sa, role: "super_admin" }),
    (e: unknown) => e instanceof AuthError && e.code === "SUPER_ADMIN_PEER_PROTECTED",
  );

  assert.deepEqual(await h.audit.list(), []);
  assert.equal((await h.store.findUserById(peer))!.role, "super_admin");
  assert.equal((await h.store.findUserById(peer))!.status, "active");
});

// --------------------------------------------------------------------------
// 9. Audit records cannot be modified through the application layer.
// --------------------------------------------------------------------------
test("C-34/9: the audit trail is append-only from the application layer", async () => {
  const h = adminHarness();
  const actor = await seedUser(h.store, "sa@velora.ir", "super_admin");
  const target = await seedUser(h.store, "target@velora.ir", "user");
  await h.service.setRole(target, "admin", { id: actor, role: "super_admin" });

  // The port exposes no mutation surface at all: append + list only.
  const surface = new Set<string>();
  let proto: object | null = h.audit as object;
  while (proto !== null && proto !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(proto)) surface.add(k);
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  for (const forbidden of ["update", "delete", "remove", "clear", "truncate", "purge", "set"]) {
    assert.equal(surface.has(forbidden), false, `AuditStore must not expose ${forbidden}()`);
  }

  // A returned record is frozen, so a caller cannot rewrite history in place.
  const before = await h.audit.list();
  const record = before[0]!;
  assert.equal(Object.isFrozen(record), true);
  assert.throws(() => {
    (record as { action: string }).action = "TAMPERED";
  }, TypeError);

  // Mutating the returned ARRAY must not affect stored state either.
  (before as AuditRecord[]).length = 0;
  const after = await h.audit.list();
  assert.equal(after.length, 1);
  assert.equal(after[0]!.action, "USER_ROLE_CHANGED");
  assert.equal(after[0]!.afterState, "admin");
});

// --------------------------------------------------------------------------
// 10. No secret material ever reaches an audit record.
// --------------------------------------------------------------------------
test("C-34/10: audit records never contain passwords, hashes or tokens", async () => {
  const captured: AuditEntry[] = [];
  const recorder: AuditStore = {
    async append(entry: AuditEntry, _tx?: AuditTx) {
      captured.push(entry);
      return {
        id: String(captured.length),
        action: entry.action,
        actorUserId: entry.actorUserId,
        targetUserId: entry.targetUserId,
        beforeState: entry.beforeState,
        afterState: entry.afterState,
        outcome: "success" as const,
        requestId: entry.requestId,
        occurredAt: entry.occurredAt.toISOString(),
      };
    },
    async list() {
      return [];
    },
  };

  // Ownership claim: the service re-authenticates with the real password.
  const oh = ownershipHarness(recorder);
  const ownerId = await seedUser(oh.users, "owner@velora.ir", "admin", { verified: true });
  await oh.service.claim({ actorId: ownerId, password: PASSWORD, confirm: OWNERSHIP_CLAIM_CONFIRMATION });

  // Role and status changes.
  const ah = adminHarness(recorder);
  const actor = await seedUser(ah.store, "sa@velora.ir", "super_admin");
  const target = await seedUser(ah.store, "target@velora.ir", "user");
  await ah.service.setRole(target, "admin", { id: actor, role: "super_admin" });
  await ah.service.setStatus(target, "suspended", { id: actor, role: "super_admin" });

  assert.equal(captured.length, 3);

  const storedHash = (await oh.users.findUserById(ownerId))!.passwordHash;
  const allowedStates = new Set([null, "claimed", "user", "admin", "active", "suspended"]);

  for (const entry of captured) {
    const blob = JSON.stringify(entry);
    assert.equal(blob.includes(PASSWORD), false, "raw password must never be recorded");
    assert.equal(blob.includes(storedHash), false, "password hash must never be recorded");
    assert.equal(/\$argon2|\$2[aby]\$|bearer |authorization/i.test(blob), false);
    assert.equal(/token|secret|api[_-]?key|passwordHash/i.test(blob), false);
    // before/after carry ONLY low-cardinality lifecycle values.
    assert.equal(allowedStates.has(entry.beforeState), true, `unexpected beforeState ${entry.beforeState}`);
    assert.equal(allowedStates.has(entry.afterState), true, `unexpected afterState ${entry.afterState}`);
    // The record shape itself is closed: no free-form payload field exists.
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["action", "actorUserId", "afterState", "beforeState", "occurredAt", "requestId", "targetUserId"],
    );
  }
});

// --------------------------------------------------------------------------
// 11. Transactional correctness: a failing audit write rolls the mutation back.
// --------------------------------------------------------------------------
test("C-34/11: a failed audit write prevents the privileged mutation from committing", async () => {
  // Role change.
  const failing = new FailingAuditStore();
  const h = adminHarness(failing);
  const actor = await seedUser(h.store, "sa@velora.ir", "super_admin");
  const target = await seedUser(h.store, "target@velora.ir", "user");

  await assert.rejects(
    h.service.setRole(target, "admin", { id: actor, role: "super_admin" }),
    /audit backend unavailable/,
    "the audit failure must propagate, never be swallowed",
  );
  assert.equal(failing.calls, 1);
  assert.equal(
    (await h.store.findUserById(target))!.role,
    "user",
    "the role change must NOT commit when its audit row could not be written",
  );

  // Status change.
  const failing2 = new FailingAuditStore();
  const h2 = adminHarness(failing2);
  const actor2 = await seedUser(h2.store, "sa@velora.ir", "super_admin");
  const target2 = await seedUser(h2.store, "target@velora.ir", "user");
  await assert.rejects(
    h2.service.setStatus(target2, "suspended", { id: actor2, role: "super_admin" }),
    /audit backend unavailable/,
  );
  assert.equal((await h2.store.findUserById(target2))!.status, "active");

  // Ownership claim: the installation must remain unclaimed.
  const failing3 = new FailingAuditStore();
  const oh = ownershipHarness(failing3);
  const admin = await seedUser(oh.users, "owner@velora.ir", "admin", { verified: true });
  await assert.rejects(
    oh.service.claim({ actorId: admin, password: PASSWORD, confirm: OWNERSHIP_CLAIM_CONFIRMATION }),
    /audit backend unavailable/,
  );
  assert.equal(
    await oh.ownership.getOwnership(),
    null,
    "ownership must remain unclaimed when the audit row could not be written",
  );
});
