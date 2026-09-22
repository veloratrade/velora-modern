// B-1 — CredentialService (application/access layer over the C-22 store).
//
// The central property under test is the OWNERSHIP INVARIANT: the owner is
// always the authenticated actor, so no caller — including a System Owner —
// can reach another user's credential, and no request field can redirect
// ownership. Also covers validation, the non-disclosing 404, and the absence
// of secret material from every returned value and every error.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MasterKey, MASTER_KEY_BYTES } from "./credentialCrypto.js";
import { MemoryCredentialStore } from "./memoryCredentialStore.js";
import { CredentialService, CredentialError } from "./credentialService.js";
import { MemoryAuditStore } from "../auth/memoryAuditStore.js";

const NOW = new Date("2026-05-02T10:30:00.000Z");
const SECRET = "metaapi-token-b1-4d9e2a77-DO-NOT-LEAK";
const KEY = MasterKey.fromBase64(randomBytes(MASTER_KEY_BYTES).toString("base64"));

const USER_A = "101";
const USER_B = "202";
const SYSTEM_OWNER = "1";

function service(): {
  svc: CredentialService;
  store: MemoryCredentialStore;
  audit: MemoryAuditStore;
} {
  const store = new MemoryCredentialStore(KEY);
  const audit = new MemoryAuditStore();
  return { svc: new CredentialService({ store, audit, now: () => NOW }), store, audit };
}

/** Deep scan of any serialized value for the plaintext secret. */
function containsSecret(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes(SECRET);
}

// --------------------------------------------------------------------------
// 1. Create — happy path, owner derived from the actor.
// --------------------------------------------------------------------------
test("B-1/1: an authenticated user can create their own credential", async () => {
  const { svc } = service();
  const rec = await svc.createCredential({ id: USER_A }, { provider: "METAAPI", secret: SECRET });

  assert.equal(rec.userId, USER_A);
  assert.equal(rec.provider, "METAAPI");
  assert.equal(rec.keyVersion, KEY.version);
  assert.equal(rec.createdAt, NOW.toISOString());
});

// --------------------------------------------------------------------------
// 2. THE CRITICAL TEST: a userId in the body cannot redirect ownership.
// --------------------------------------------------------------------------
test("B-1/2: userId is derived from the authenticated actor, never from input", async () => {
  const { svc } = service();
  // A hostile body naming another user in every plausible field shape.
  const rec = await svc.createCredential(
    { id: USER_A },
    { provider: "METAAPI", secret: SECRET, userId: USER_B, user_id: USER_B, ownerId: USER_B },
  );
  assert.equal(rec.userId, USER_A, "ownership must follow the authenticated actor");

  // And it genuinely landed in A's collection, not B's.
  assert.equal((await svc.listCredentials({ id: USER_A })).length, 1);
  assert.equal((await svc.listCredentials({ id: USER_B })).length, 0);
});

// --------------------------------------------------------------------------
// 3. List — scoped to the authenticated user.
// --------------------------------------------------------------------------
test("B-1/3: list returns only the authenticated user's credentials", async () => {
  const { svc } = service();
  await svc.createCredential({ id: USER_A }, { provider: "METAAPI", secret: SECRET });
  await svc.createCredential({ id: USER_B }, { provider: "METAAPI", secret: "other-secret" });

  const listA = await svc.listCredentials({ id: USER_A });
  assert.equal(listA.length, 1);
  assert.equal(listA[0]?.userId, USER_A);
  assert.ok(listA.every((r) => r.userId === USER_A));
});

// --------------------------------------------------------------------------
// 4-5. Delete — owner only; cross-user delete is non-disclosing.
// --------------------------------------------------------------------------
test("B-1/4: a user can delete their own credential", async () => {
  const { svc } = service();
  const rec = await svc.createCredential({ id: USER_A }, { provider: "METAAPI", secret: SECRET });

  assert.deepEqual(await svc.deleteCredential({ id: USER_A }, rec.id), { deleted: true });
  assert.equal((await svc.listCredentials({ id: USER_A })).length, 0);
});

test("B-1/5: cross-user delete is refused and does not disclose existence", async () => {
  const { svc } = service();
  const bCred = await svc.createCredential({ id: USER_B }, { provider: "METAAPI", secret: SECRET });

  // A tries to delete B's credential by id.
  const err = await svc
    .deleteCredential({ id: USER_A }, bCred.id)
    .then(() => null, (e: unknown) => e as CredentialError);

  assert.ok(err instanceof CredentialError);
  assert.equal(err.status, 404);
  assert.equal(err.code, "NOT_FOUND");

  // The 404 for someone else's credential is IDENTICAL to the 404 for an id
  // that does not exist at all — otherwise the endpoint becomes a probe.
  const missing = await svc
    .deleteCredential({ id: USER_A }, "999999")
    .then(() => null, (e: unknown) => e as CredentialError);
  assert.equal(err.message, missing?.message);
  assert.equal(err.status, missing?.status);

  // B's credential is untouched.
  assert.equal((await svc.listCredentials({ id: USER_B })).length, 1);
});

// --------------------------------------------------------------------------
// 6. System Owner isolation (ADR-016).
// --------------------------------------------------------------------------
test("B-1/6: System Owner authority grants no access to another user's credential", async () => {
  const { svc } = service();
  const bCred = await svc.createCredential({ id: USER_B }, { provider: "METAAPI", secret: SECRET });

  // The System Owner acts as THEMSELVES: the service has no parameter through
  // which elevated authority could name another owner.
  assert.deepEqual(await svc.listCredentials({ id: SYSTEM_OWNER }), []);

  const err = await svc
    .deleteCredential({ id: SYSTEM_OWNER }, bCred.id)
    .then(() => null, (e: unknown) => e as CredentialError);
  assert.equal(err?.status, 404);

  // Still there.
  assert.equal((await svc.listCredentials({ id: USER_B })).length, 1);
});

test("B-1/7: the service exposes no reveal/disclosure or admin method", async () => {
  const { svc } = service();
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(svc));
  for (const forbidden of [
    "reveal",
    "revealCredential",
    "revealAny",
    "listAll",
    "adminReveal",
    "findByIdAsAdmin",
    "getSecret",
  ]) {
    assert.equal(methods.includes(forbidden), false, `no disclosure method named ${forbidden}`);
  }
  // Exactly the three B-1 operations (plus the constructor).
  assert.deepEqual(methods.sort(), [
    "constructor",
    "createCredential",
    "deleteCredential",
    "listCredentials",
  ]);
});

// --------------------------------------------------------------------------
// 8-10. No secret material in any returned value or error.
// --------------------------------------------------------------------------
test("B-1/8: create/list/delete responses never contain secret material", async () => {
  const { svc } = service();
  const created = await svc.createCredential({ id: USER_A }, { provider: "METAAPI", secret: SECRET });
  assert.equal(containsSecret(created), false, "create response must not echo the secret");

  const listed = await svc.listCredentials({ id: USER_A });
  assert.equal(containsSecret(listed), false, "list response must not contain the secret");

  // Metadata carries no crypto material either.
  for (const field of ["secret", "ciphertext", "iv", "authTag", "tag", "key"]) {
    assert.equal(field in (created as unknown as Record<string, unknown>), false, `no ${field} field`);
  }

  const deleted = await svc.deleteCredential({ id: USER_A }, created.id);
  assert.equal(containsSecret(deleted), false, "delete response must not contain the secret");
});

test("B-1/9: validation errors never echo the submitted secret", async () => {
  const { svc } = service();
  // Invalid provider, but a VALID secret present in the body: the error must
  // describe the field without reflecting the value.
  const err = await svc
    .createCredential({ id: USER_A }, { provider: "NOT_A_PROVIDER", secret: SECRET })
    .then(() => null, (e: unknown) => e as CredentialError);

  assert.ok(err instanceof CredentialError);
  assert.equal(err.status, 400);
  assert.equal(err.code, "VALIDATION_FAILED");
  assert.equal(containsSecret(err.message), false);
  assert.equal(containsSecret(err.details), false);
  assert.equal(containsSecret({ m: err.message, d: err.details, s: String(err) }), false);
});

test("B-1/10: input validation follows existing conventions", async () => {
  const { svc } = service();
  const cases: Array<[string, unknown]> = [
    ["missing body", undefined],
    ["empty object", {}],
    ["missing provider", { secret: SECRET }],
    ["unsupported provider", { provider: "BINANCE", secret: SECRET }],
    ["missing secret", { provider: "METAAPI" }],
    ["blank secret", { provider: "METAAPI", secret: "   " }],
    ["non-string secret", { provider: "METAAPI", secret: 12345 }],
    ["oversized secret", { provider: "METAAPI", secret: "x".repeat(4097) }],
  ];
  for (const [label, body] of cases) {
    const err = await svc
      .createCredential({ id: USER_A }, body)
      .then(() => null, (e: unknown) => e as CredentialError);
    assert.ok(err instanceof CredentialError, `${label} must be rejected`);
    assert.equal(err.status, 400, `${label} → 400`);
    assert.equal(err.code, "VALIDATION_FAILED", `${label} → VALIDATION_FAILED`);
  }
  // Nothing was stored by any rejected attempt.
  assert.equal((await svc.listCredentials({ id: USER_A })).length, 0);
});

// --------------------------------------------------------------------------
// 11. Duplicate provider → 409, mapping the store's uniqueness rule.
// --------------------------------------------------------------------------
test("B-1/11: a second credential for the same provider is a 409, not an overwrite", async () => {
  const { svc } = service();
  await svc.createCredential({ id: USER_A }, { provider: "METAAPI", secret: SECRET });

  const err = await svc
    .createCredential({ id: USER_A }, { provider: "METAAPI", secret: "replacement-secret" })
    .then(() => null, (e: unknown) => e as CredentialError);

  assert.ok(err instanceof CredentialError);
  assert.equal(err.status, 409);
  assert.equal(err.code, "CREDENTIAL_EXISTS");
  assert.equal(containsSecret(err.message), false);
  // The original is intact and was not silently replaced.
  assert.equal((await svc.listCredentials({ id: USER_A })).length, 1);
});

// --------------------------------------------------------------------------
// 12. The underlying store still encrypts: ciphertext at rest, not plaintext.
// --------------------------------------------------------------------------
test("B-1/12: credentials created through the service are encrypted at rest", async () => {
  const { svc, store } = service();
  const rec = await svc.createCredential({ id: USER_A }, { provider: "METAAPI", secret: SECRET });

  // The store's own reveal (NOT exposed by the service) round-trips, proving
  // the service stored a real encrypted credential rather than bypassing crypto.
  assert.equal(await store.reveal(rec.id, USER_A), SECRET);
  // And the raw stored state holds no plaintext.
  assert.equal(containsSecret(await store.list(USER_A)), false);
});

// --------------------------------------------------------------------------
// B-3. Credential lifecycle audit emission + atomicity.
// --------------------------------------------------------------------------

/** A store wrapper that lets a test fail the audit write deterministically. */
class FailingAudit extends MemoryAuditStore {
  constructor(private readonly boom: () => boolean) {
    super();
  }
  override async append(
    ...args: Parameters<MemoryAuditStore["append"]>
  ): ReturnType<MemoryAuditStore["append"]> {
    if (this.boom()) throw new Error("audit backend unavailable");
    return super.append(...args);
  }
}

test("B-3/1: a successful create emits exactly ONE CREDENTIAL_CREATED event", async () => {
  const { svc, audit } = service();
  const rec = await svc.createCredential(
    { id: USER_A, requestId: "req-create-1" },
    { provider: "METAAPI", secret: SECRET },
  );

  const rows = await audit.list();
  assert.equal(rows.length, 1, "exactly one audit row — not zero, not two");
  const row = rows[0]!;
  assert.equal(row.action, "CREDENTIAL_CREATED");
  assert.equal(row.outcome, "success");
  assert.equal(row.actorUserId, USER_A);
  assert.equal(row.targetUserId, USER_A);
  assert.equal(row.credentialId, rec.id);
  assert.equal(row.provider, "METAAPI");
  assert.equal(row.requestId, "req-create-1");
  // Lifecycle events carry no before/after state.
  assert.equal(row.beforeState, null);
  assert.equal(row.afterState, null);
});

test("B-3/2: a successful delete emits exactly ONE CREDENTIAL_DELETED event", async () => {
  const { svc, audit } = service();
  const rec = await svc.createCredential({ id: USER_A }, { provider: "METAAPI", secret: SECRET });
  await svc.deleteCredential({ id: USER_A, requestId: "req-del-1" }, rec.id);

  const rows = await audit.list();
  assert.equal(rows.length, 2, "one create + one delete");
  const del = rows.find((r) => r.action === "CREDENTIAL_DELETED")!;
  assert.equal(del.outcome, "success");
  assert.equal(del.actorUserId, USER_A);
  assert.equal(del.targetUserId, USER_A);
  assert.equal(del.credentialId, rec.id);
  // Provider captured from the deleted row itself (hard delete).
  assert.equal(del.provider, "METAAPI");
  assert.equal(del.requestId, "req-del-1");
});

test("B-3/3: audit failure ROLLS BACK create — no credential is left behind", async () => {
  const store = new MemoryCredentialStore(KEY);
  const audit = new FailingAudit(() => true);
  const svc = new CredentialService({ store, audit, now: () => NOW });

  await assert.rejects(
    () => svc.createCredential({ id: USER_A }, { provider: "METAAPI", secret: SECRET }),
    /audit backend unavailable/,
    "the audit failure must propagate, never be swallowed",
  );
  // The whole operation failed: nothing was stored.
  assert.equal((await store.list(USER_A)).length, 0, "credential must not exist");
  assert.equal((await audit.list()).length, 0, "no audit row either");
});

test("B-3/4: audit failure ROLLS BACK delete — the credential still exists", async () => {
  const store = new MemoryCredentialStore(KEY);
  let fail = false;
  const audit = new FailingAudit(() => fail);
  const svc = new CredentialService({ store, audit, now: () => NOW });

  const rec = await svc.createCredential({ id: USER_A }, { provider: "METAAPI", secret: SECRET });
  fail = true; // only the DELETE audit fails

  await assert.rejects(
    () => svc.deleteCredential({ id: USER_A }, rec.id),
    /audit backend unavailable/,
  );
  // The credential survived the failed delete.
  const remaining = await store.list(USER_A);
  assert.equal(remaining.length, 1, "credential must still exist after rollback");
  assert.equal(remaining[0]!.id, rec.id);
});

test("B-3/5: a rejected duplicate create leaves exactly one audit row", async () => {
  const { svc, audit } = service();
  await svc.createCredential({ id: USER_A }, { provider: "METAAPI", secret: SECRET });
  await svc
    .createCredential({ id: USER_A }, { provider: "METAAPI", secret: "replacement" })
    .then(() => assert.fail("duplicate must be rejected"), () => undefined);

  const rows = await audit.list();
  assert.equal(rows.length, 1, "the rejected duplicate must not add an audit row");
});

test("B-3/6: validation failures and cross-user denials write NO audit row", async () => {
  const { svc, audit } = service();
  // Invalid input never reaches the store.
  await svc.createCredential({ id: USER_A }, { provider: "NOPE", secret: SECRET }).catch(() => undefined);
  assert.equal((await audit.list()).length, 0);

  // A cross-user delete removes nothing, so it records nothing — and still
  // returns the non-disclosing 404.
  const bCred = await svc.createCredential({ id: USER_B }, { provider: "METAAPI", secret: SECRET });
  const before = (await audit.list()).length;
  const err = await svc
    .deleteCredential({ id: USER_A }, bCred.id)
    .then(() => null, (e: unknown) => e as CredentialError);
  assert.equal(err?.status, 404);
  assert.equal((await audit.list()).length, before, "a denied delete must add no audit row");
  // And B's credential is intact.
  assert.equal((await svc.listCredentials({ id: USER_B })).length, 1);
});

test("B-3/7: System Owner cannot delete another user's credential, and nothing is audited", async () => {
  const { svc, audit } = service();
  const bCred = await svc.createCredential({ id: USER_B }, { provider: "METAAPI", secret: SECRET });
  const before = (await audit.list()).length;

  const err = await svc
    .deleteCredential({ id: SYSTEM_OWNER }, bCred.id)
    .then(() => null, (e: unknown) => e as CredentialError);
  assert.equal(err?.status, 404);
  assert.equal((await audit.list()).length, before);
  assert.equal((await svc.listCredentials({ id: USER_B })).length, 1);
});

test("B-3/8: no secret material reaches the audit trail", async () => {
  const { svc, audit } = service();
  const rec = await svc.createCredential({ id: USER_A }, { provider: "METAAPI", secret: SECRET });
  await svc.deleteCredential({ id: USER_A }, rec.id);

  const serialized = JSON.stringify(await audit.list());
  assert.equal(serialized.includes(SECRET), false, "plaintext secret must never be audited");
  for (const field of ["ciphertext", "authTag", "iv", "masterKey", "envelope"]) {
    assert.equal(serialized.includes(field), false, `audit must not carry ${field}`);
  }
});
