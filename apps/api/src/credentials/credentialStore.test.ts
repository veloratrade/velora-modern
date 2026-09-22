// C-22 — encrypted credential store.
//
// Covers the required behaviours: authenticated encryption, nonce uniqueness,
// tamper detection, fail-closed key handling, ciphertext-at-rest, owner
// isolation (including that System Owner authority grants no access), and the
// absence of plaintext from logs, errors and metadata reads.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  MasterKey,
  encryptCredential,
  decryptCredential,
  CredentialKeyError,
  CredentialDecryptionError,
  CREDENTIAL_ALGORITHM,
  CREDENTIAL_ENVELOPE_VERSION,
  MASTER_KEY_BYTES,
} from "./credentialCrypto.js";
import { resolveCredentialKey } from "./credentialConfig.js";
import { MemoryCredentialStore } from "./memoryCredentialStore.js";
import { CredentialAlreadyExistsError } from "./credentialStore.js";

const NOW = new Date("2026-04-01T09:00:00.000Z");
const SECRET = "metaapi-token-9f3b7c21-DO-NOT-LEAK";
const KEY_A = MasterKey.fromBase64(randomBytes(MASTER_KEY_BYTES).toString("base64"));
const KEY_B = MasterKey.fromBase64(randomBytes(MASTER_KEY_BYTES).toString("base64"));

const USER_A = "101";
const USER_B = "202";

function store(key: MasterKey = KEY_A): MemoryCredentialStore {
  return new MemoryCredentialStore(key);
}

// --------------------------------------------------------------------------
// 1-2. Ciphertext differs from plaintext; repeated encryption differs (nonce).
// --------------------------------------------------------------------------
test("C-22/1: encryption produces ciphertext that is not the plaintext", () => {
  const env = encryptCredential(SECRET, KEY_A);
  assert.equal(env.algorithm, CREDENTIAL_ALGORITHM);
  assert.equal(env.version, CREDENTIAL_ENVELOPE_VERSION);
  assert.equal(env.ciphertext.toString("utf8") === SECRET, false);
  assert.equal(env.ciphertext.includes(Buffer.from(SECRET, "utf8")), false);
  assert.equal(env.iv.length, 12);
  assert.equal(env.authTag.length, 16);
});

test("C-22/2+21: encrypting the same plaintext twice yields a new nonce and new ciphertext", () => {
  const a = encryptCredential(SECRET, KEY_A);
  const b = encryptCredential(SECRET, KEY_A);
  assert.equal(a.iv.equals(b.iv), false, "a fresh IV must be generated per operation");
  assert.equal(a.ciphertext.equals(b.ciphertext), false);
  assert.equal(a.authTag.equals(b.authTag), false);
  // Both still decrypt to the same secret.
  assert.equal(decryptCredential(a, KEY_A), SECRET);
  assert.equal(decryptCredential(b, KEY_A), SECRET);
});

// --------------------------------------------------------------------------
// 3-4. Correct key decrypts; wrong key fails.
// --------------------------------------------------------------------------
test("C-22/3: the correct key decrypts the credential", () => {
  assert.equal(decryptCredential(encryptCredential(SECRET, KEY_A), KEY_A), SECRET);
});

test("C-22/4: a wrong key fails decryption", () => {
  const env = encryptCredential(SECRET, KEY_A);
  assert.throws(() => decryptCredential(env, KEY_B), CredentialDecryptionError);
});

// --------------------------------------------------------------------------
// 5-7. Tampering with ciphertext, tag, IV or envelope metadata fails.
// --------------------------------------------------------------------------
test("C-22/5: tampering with the ciphertext fails authentication", () => {
  const env = encryptCredential(SECRET, KEY_A);
  const bad = Buffer.from(env.ciphertext);
  bad[0] = bad[0]! ^ 0xff;
  assert.throws(
    () => decryptCredential({ ...env, ciphertext: bad }, KEY_A),
    CredentialDecryptionError,
  );
});

test("C-22/6: tampering with the authentication tag fails", () => {
  const env = encryptCredential(SECRET, KEY_A);
  const bad = Buffer.from(env.authTag);
  bad[0] = bad[0]! ^ 0xff;
  assert.throws(
    () => decryptCredential({ ...env, authTag: bad }, KEY_A),
    CredentialDecryptionError,
  );
  // A truncated tag is rejected too.
  assert.throws(
    () => decryptCredential({ ...env, authTag: env.authTag.subarray(0, 8) }, KEY_A),
    CredentialDecryptionError,
  );
});

test("C-22/7: tampering with the IV or envelope metadata fails safely", () => {
  const env = encryptCredential(SECRET, KEY_A);
  const badIv = Buffer.from(env.iv);
  badIv[0] = badIv[0]! ^ 0xff;
  assert.throws(() => decryptCredential({ ...env, iv: badIv }, KEY_A), CredentialDecryptionError);
  // Wrong IV length.
  assert.throws(
    () => decryptCredential({ ...env, iv: env.iv.subarray(0, 8) }, KEY_A),
    CredentialDecryptionError,
  );
  // Metadata is bound into the AAD: changing it must fail, not silently work.
  assert.throws(() => decryptCredential({ ...env, version: 2 }, KEY_A), CredentialDecryptionError);
  assert.throws(
    () => decryptCredential({ ...env, keyVersion: env.keyVersion + 1 }, KEY_A),
    CredentialDecryptionError,
  );
  assert.throws(
    () => decryptCredential({ ...env, algorithm: "aes-128-gcm" as typeof CREDENTIAL_ALGORITHM }, KEY_A),
    CredentialDecryptionError,
  );
});

// --------------------------------------------------------------------------
// 8-9. Missing and invalid master keys fail closed.
// --------------------------------------------------------------------------
test("C-22/8: a missing master key fails closed (no key, no silent fallback)", () => {
  for (const env of [{}, { CREDENTIAL_MASTER_KEY: "" }, { CREDENTIAL_MASTER_KEY: "   " }]) {
    const res = resolveCredentialKey(env);
    assert.equal(res.key, null, "no key may be produced");
    assert.equal(res.findings[0]!.code, "CR-001");
  }
  assert.throws(() => MasterKey.fromBase64(undefined), CredentialKeyError);
});

test("C-22/9: an invalid master key fails closed", () => {
  const tooShort = randomBytes(16).toString("base64");
  const tooLong = randomBytes(48).toString("base64");
  const allZero = Buffer.alloc(32).toString("base64");
  for (const bad of [tooShort, tooLong, allZero, "not base64!!", "zzzz~~~~"]) {
    const res = resolveCredentialKey({ CREDENTIAL_MASTER_KEY: bad });
    assert.equal(res.key, null, `must reject ${bad.slice(0, 12)}`);
    assert.equal(res.findings[0]!.code, "CR-002");
  }
  // An invalid key VERSION is rejected separately.
  for (const v of ["0", "-1", "abc", "1.5"]) {
    const res = resolveCredentialKey({
      CREDENTIAL_MASTER_KEY: randomBytes(32).toString("base64"),
      CREDENTIAL_MASTER_KEY_VERSION: v,
    });
    assert.equal(res.key, null);
    assert.equal(res.findings[0]!.code, "CR-003");
  }
  // A valid key resolves.
  const ok = resolveCredentialKey({ CREDENTIAL_MASTER_KEY: randomBytes(32).toString("base64") });
  assert.notEqual(ok.key, null);
  assert.deepEqual(ok.findings, []);
});

// --------------------------------------------------------------------------
// 10. Plaintext never appears in the stored row.
// --------------------------------------------------------------------------
test("C-22/10: the stored row contains ciphertext only — never the plaintext", async () => {
  const s = store();
  const rec = await s.create({ userId: USER_A, provider: "METAAPI", secret: SECRET, now: NOW });
  const env = s.rawEnvelope(rec.id)!;
  // Nothing in the persisted envelope contains the secret, in any encoding.
  for (const buf of [env.ciphertext, env.iv, env.authTag]) {
    assert.equal(buf.includes(Buffer.from(SECRET, "utf8")), false);
    assert.equal(buf.toString("utf8").includes(SECRET), false);
    assert.equal(buf.toString("base64").includes(Buffer.from(SECRET).toString("base64")), false);
  }
  // The full serialized row carries no plaintext either.
  assert.equal(JSON.stringify(env).includes(SECRET), false);
  assert.equal(JSON.stringify(rec).includes(SECRET), false);
});

// --------------------------------------------------------------------------
// 11-12. Plaintext never reaches logs or error messages.
// --------------------------------------------------------------------------
test("C-22/11: no plaintext or key material reaches application logs", async () => {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.warn = console.log;
  console.error = console.log;
  try {
    const s = store();
    const rec = await s.create({ userId: USER_A, provider: "METAAPI", secret: SECRET, now: NOW });
    await s.list(USER_A);
    await s.reveal(rec.id, USER_A);
    await s.delete(rec.id, USER_A);
    try {
      decryptCredential(encryptCredential(SECRET, KEY_A), KEY_B);
    } catch {
      /* expected */
    }
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
  const blob = lines.join("\n");
  assert.equal(blob.includes(SECRET), false, "the secret must never be logged");
  assert.equal(blob.includes(KEY_A.material().toString("base64")), false, "key must never be logged");
});

test("C-22/12: thrown errors never contain plaintext, key material or ciphertext", () => {
  const env = encryptCredential(SECRET, KEY_A);
  const errors: Error[] = [];
  try {
    decryptCredential(env, KEY_B);
  } catch (e) {
    errors.push(e as Error);
  }
  try {
    MasterKey.fromBase64("tooshort");
  } catch (e) {
    errors.push(e as Error);
  }
  try {
    encryptCredential("", KEY_A);
  } catch (e) {
    errors.push(e as Error);
  }
  assert.equal(errors.length, 3);
  for (const e of errors) {
    const text = `${e.name}: ${e.message}\n${e.stack ?? ""}`;
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes(KEY_A.material().toString("base64")), false);
    assert.equal(text.includes(env.ciphertext.toString("base64")), false);
    assert.equal(text.includes("tooshort"), false, "errors must not echo the supplied value");
  }
  // The decryption error is uniform: it does not say WHY (no oracle).
  assert.equal(errors[0]!.message, "Credential could not be decrypted.");
  // Key material is never serialized, even by accident.
  assert.equal(JSON.stringify({ k: KEY_A }), '{"k":"[redacted]"}');
  assert.equal(`${KEY_A}`, "[redacted MasterKey]");
});

// --------------------------------------------------------------------------
// 13. Metadata operations never return decrypted secrets.
// --------------------------------------------------------------------------
test("C-22/13: list and findById return metadata only, never a secret", async () => {
  const s = store();
  const rec = await s.create({ userId: USER_A, provider: "METAAPI", secret: SECRET, now: NOW });

  const listed = await s.list(USER_A);
  assert.equal(listed.length, 1);
  const found = (await s.findById(rec.id, USER_A))!;

  for (const view of [listed[0]!, found, rec]) {
    assert.deepEqual(
      Object.keys(view).sort(),
      ["createdAt", "id", "keyVersion", "provider", "updatedAt", "userId"],
      "metadata shape must expose no secret, ciphertext, iv or tag field",
    );
    assert.equal(JSON.stringify(view).includes(SECRET), false);
  }
  // reveal() is the ONLY way to obtain plaintext.
  assert.equal(await s.reveal(rec.id, USER_A), SECRET);
});

// --------------------------------------------------------------------------
// 14-15. Owner isolation, including System Owner.
// --------------------------------------------------------------------------
test("C-22/14: user A cannot read, reveal or delete user B's credential", async () => {
  const s = store();
  const b = await s.create({ userId: USER_B, provider: "METAAPI", secret: SECRET, now: NOW });

  assert.equal(await s.findById(b.id, USER_A), null);
  assert.equal(await s.reveal(b.id, USER_A), null, "cross-user reveal must return null");
  assert.equal(await s.delete(b.id, USER_A), false, "cross-user delete must not remove the row");
  assert.deepEqual(await s.list(USER_A), []);
  // B's credential is untouched and still readable by B.
  assert.equal(await s.reveal(b.id, USER_B), SECRET);
});

test("C-22/15: System Owner authority does not bypass credential ownership", async () => {
  // The port has NO administrative accessor: every method requires the owner's
  // id, so there is no API through which an admin/System Owner could read
  // another user's secret. Ownership is the only rule, by construction.
  const s = store();
  const b = await s.create({ userId: USER_B, provider: "METAAPI", secret: SECRET, now: NOW });

  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(s));
  for (const forbidden of ["findByIdAsAdmin", "revealAny", "listAll", "adminReveal", "findAny"]) {
    assert.equal(methods.includes(forbidden), false, `no administrative bypass named ${forbidden}`);
  }
  // A System Owner acting with their OWN id gets nothing belonging to user B.
  const systemOwnerId = "1";
  assert.equal(await s.findById(b.id, systemOwnerId), null);
  assert.equal(await s.reveal(b.id, systemOwnerId), null);
  assert.equal(await s.delete(b.id, systemOwnerId), false);
  assert.deepEqual(await s.list(systemOwnerId), []);
});

// --------------------------------------------------------------------------
// 16-18. Association, revocation, uniqueness constraint.
// --------------------------------------------------------------------------
test("C-22/16: a credential is associated with the supplied owner", async () => {
  const s = store();
  const rec = await s.create({ userId: USER_A, provider: "METAAPI", secret: SECRET, now: NOW });
  assert.equal(rec.userId, USER_A);
  assert.equal(rec.provider, "METAAPI");
  assert.equal(rec.keyVersion, 1);
  assert.equal(rec.createdAt, NOW.toISOString());
  assert.equal((await s.list(USER_A))[0]!.id, rec.id);
});

test("C-22/17: revocation is owner-scoped and permanently removes the secret", async () => {
  const s = store();
  const rec = await s.create({ userId: USER_A, provider: "METAAPI", secret: SECRET, now: NOW });
  assert.equal(await s.delete(rec.id, USER_A), true);
  assert.equal(await s.findById(rec.id, USER_A), null);
  assert.equal(await s.reveal(rec.id, USER_A), null);
  assert.deepEqual(await s.list(USER_A), []);
  assert.equal(s.rawEnvelope(rec.id), undefined, "no recoverable ciphertext may remain");
  // Deleting again is a safe no-op.
  assert.equal(await s.delete(rec.id, USER_A), false);
});

test("C-22/18: one credential per (user, provider); replacement is explicit", async () => {
  const s = store();
  await s.create({ userId: USER_A, provider: "METAAPI", secret: SECRET, now: NOW });
  await assert.rejects(
    s.create({ userId: USER_A, provider: "METAAPI", secret: "another", now: NOW }),
    CredentialAlreadyExistsError,
  );
  // A different user may hold their own credential for the same provider.
  const b = await s.create({ userId: USER_B, provider: "METAAPI", secret: "b-secret", now: NOW });
  assert.equal(await s.reveal(b.id, USER_B), "b-secret");
});

// --------------------------------------------------------------------------
// 20. Dependency reconstruction (restart) can still decrypt.
// --------------------------------------------------------------------------
test("C-22/20: a rebuilt store with the same configured key decrypts existing rows", async () => {
  const keyB64 = randomBytes(MASTER_KEY_BYTES).toString("base64");
  const first = resolveCredentialKey({ CREDENTIAL_MASTER_KEY: keyB64 }).key!;
  const env = encryptCredential(SECRET, first);

  // Simulate a restart: the key object is reconstructed from the same env var.
  const second = resolveCredentialKey({ CREDENTIAL_MASTER_KEY: keyB64 }).key!;
  assert.equal(first.equals(second), true);
  assert.equal(decryptCredential(env, second), SECRET, "a restart must not orphan credentials");

  // A DIFFERENT key (as a startup-generated one would be) cannot read it —
  // which is exactly why the key is never auto-generated.
  const regenerated = MasterKey.fromBase64(randomBytes(MASTER_KEY_BYTES).toString("base64"));
  assert.throws(() => decryptCredential(env, regenerated), CredentialDecryptionError);
});
