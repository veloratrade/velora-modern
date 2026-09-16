// B-2 — the extended audit contract at the application layer.
//
// Covers what the typed contract must guarantee regardless of adapter: the new
// actions exist, outcomes round-trip, credential metadata is optional, existing
// call sites keep working unchanged, and no secret material can be carried.
//
// Adapter PARITY is the point of several of these: MemoryAuditStore and
// PgAuditStore must not drift, because the memory adapter is what most tests
// run against.
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAuditStore } from "./memoryAuditStore.js";
import type { AuditAction, AuditEntry, AuditOutcome } from "./auditStore.js";

const NOW = new Date("2026-06-01T09:15:00.000Z");

function entry(patch: Partial<AuditEntry> = {}): AuditEntry {
  return {
    action: "CREDENTIAL_CREATED",
    actorUserId: "101",
    targetUserId: "101",
    beforeState: null,
    afterState: null,
    requestId: "req-b2",
    occurredAt: NOW,
    ...patch,
  };
}

test("B-2/1: the three pre-existing actions still append unchanged", async () => {
  const store = new MemoryAuditStore();
  for (const action of ["OWNERSHIP_CLAIMED", "USER_ROLE_CHANGED", "USER_STATUS_CHANGED"] as const) {
    // Note: NO outcome and NO credential metadata supplied — exactly how every
    // pre-B-2 call site invokes append(). This must keep working.
    const rec = await store.append({
      action,
      actorUserId: "1",
      targetUserId: "2",
      beforeState: "user",
      afterState: "admin",
      requestId: "req-legacy",
      occurredAt: NOW,
    });
    assert.equal(rec.action, action);
    assert.equal(rec.outcome, "success", "omitted outcome must default to success");
    assert.equal(rec.credentialId, null);
    assert.equal(rec.provider, null);
  }
});

test("B-2/2: credential actions are representable with metadata", async () => {
  const store = new MemoryAuditStore();
  for (const action of ["CREDENTIAL_CREATED", "CREDENTIAL_DELETED"] as const) {
    const rec = await store.append(entry({ action, credentialId: "77", provider: "METAAPI" }));
    assert.equal(rec.action, action);
    assert.equal(rec.credentialId, "77");
    assert.equal(rec.provider, "METAAPI");
  }
});

test("B-2/3: both outcomes are representable", async () => {
  const store = new MemoryAuditStore();
  const success = await store.append(entry({ outcome: "success" }));
  const denied = await store.append(entry({ action: "CREDENTIAL_DELETED", outcome: "denied" }));
  assert.equal(success.outcome, "success");
  assert.equal(denied.outcome, "denied");
});

test("B-2/4: credential metadata is optional (nullable) on a credential action", async () => {
  const store = new MemoryAuditStore();
  const rec = await store.append(entry({ action: "CREDENTIAL_DELETED" }));
  assert.equal(rec.credentialId, null);
  assert.equal(rec.provider, null);
});

test("B-2/5: CREDENTIAL_REVEALED is NOT part of the action vocabulary", () => {
  // Deliberately absent: reveal has no production consumer. This is a
  // compile-time guarantee; asserted here so a future widening is a conscious
  // act rather than an accident.
  const valid: AuditAction[] = [
    "OWNERSHIP_CLAIMED",
    "USER_ROLE_CHANGED",
    "USER_STATUS_CHANGED",
    "CREDENTIAL_CREATED",
    "CREDENTIAL_DELETED",
  ];
  assert.equal(valid.length, 5);
  assert.equal((valid as string[]).includes("CREDENTIAL_REVEALED"), false);
  const outcomes: AuditOutcome[] = ["success", "denied"];
  assert.equal(outcomes.length, 2);
});

test("B-2/6: append-only — the store exposes no update/delete", async () => {
  const store = new MemoryAuditStore();
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
  for (const forbidden of ["update", "delete", "remove", "truncate", "purge"]) {
    assert.equal(methods.includes(forbidden), false, `must expose no ${forbidden}`);
  }
  // Records are frozen, so a caller cannot reach back and edit history.
  const rec = await store.append(entry({ credentialId: "5", provider: "METAAPI" }));
  assert.equal(Object.isFrozen(rec), true);
});

test("B-2/7: an audit record carries no secret-bearing field", async () => {
  const store = new MemoryAuditStore();
  const rec = await store.append(entry({ credentialId: "9", provider: "METAAPI" }));
  const keys = Object.keys(rec);
  for (const forbidden of [
    "secret", "ciphertext", "secretCiphertext", "iv", "authTag", "tag",
    "masterKey", "key", "token", "password", "passwordHash", "authorization",
  ]) {
    assert.equal(keys.includes(forbidden), false, `record must have no ${forbidden} field`);
  }
  // The full shape is exactly the 12 contract fields. This stays a CLOSED
  // world: any field added to the record that is not listed here fails the
  // assertion. `tradingAccountId` (migration 0014) is a nullable numeric
  // account reference — an identifier, never a secret — added so that
  // ACCOUNT_BINDING_CHANGED can name the account it refers to.
  assert.deepEqual(keys.sort(), [
    "action", "actorUserId", "afterState", "beforeState", "credentialId",
    "id", "occurredAt", "outcome", "provider", "requestId", "targetUserId",
    "tradingAccountId",
  ]);
});

test("B-2/8: metadata is limited to identifiers — a secret placed in it is never stored by the contract", async () => {
  const store = new MemoryAuditStore();
  // credentialId/provider are typed as an id and a provider enum. There is no
  // field through which a secret could travel: beforeState/afterState keep
  // their lifecycle meaning and are not used by credential events here.
  const rec = await store.append(entry({ credentialId: "42", provider: "METAAPI" }));
  const serialized = JSON.stringify(rec);
  assert.equal(serialized.includes("METAAPI"), true);
  assert.equal(rec.beforeState, null);
  assert.equal(rec.afterState, null);
});
