// C-22 real-PostgreSQL evidence. Excluded from `npm test` by the *.pg.test.ts
// convention (tools/run-tests.mjs); run explicitly with DATABASE_URL set.
//
// Proves against a REAL PostgreSQL server what PGlite/in-memory cannot:
// ciphertext genuinely at rest in a bytea column, the database-level
// constraints, owner isolation in SQL, and tamper detection after a round trip.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Pool } from "pg";
import { createEngine, migrate } from "../migrate.ts";
import { PgCredentialStore } from "../../apps/api/src/credentials/pgCredentialStore.js";
import { PgUserStore } from "../../apps/api/src/auth/pgUserStore.js";
import {
  MasterKey,
  MASTER_KEY_BYTES,
  CredentialDecryptionError,
} from "../../apps/api/src/credentials/credentialCrypto.js";
import { CredentialAlreadyExistsError } from "../../apps/api/src/credentials/credentialStore.js";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const URL = process.env.DATABASE_URL;
const NOW = new Date("2026-04-01T09:00:00.000Z");
const SECRET = "metaapi-token-REAL-PG-7b21";

test("C-22 real PostgreSQL: encrypted credential storage", { skip: URL === undefined }, async (t) => {
  // Bring an EMPTY database up to schema exactly like the sibling PG harnesses,
  // so this suite does not silently depend on a pre-migrated database.
  const engine = await createEngine(URL); // migration runner's real-pg branch
  await migrate(engine, MIGRATIONS);
  await engine.close();

  const pool = new Pool({ connectionString: URL });
  const key = MasterKey.fromBase64(randomBytes(MASTER_KEY_BYTES).toString("base64"));
  const store = new PgCredentialStore(pool, key);
  const users = new PgUserStore(pool);
  t.after(async () => {
    await pool.end();
  });

  await pool.query("DELETE FROM user_credentials");
  await pool.query("DELETE FROM users");
  const a = await users.createUser({
    email: "a@velora.ir", passwordHash: "x", fullName: "A", locale: "en", timezone: "UTC", now: NOW,
  });
  const b = await users.createUser({
    email: "b@velora.ir", passwordHash: "x", fullName: "B", locale: "en", timezone: "UTC", now: NOW,
  });

  let credId = "";

  await t.test("create stores ciphertext and returns metadata only", async () => {
    const rec = await store.create({ userId: a.id, provider: "METAAPI", secret: SECRET, now: NOW });
    credId = rec.id;
    assert.equal(rec.userId, a.id);
    assert.equal(rec.keyVersion, 1);
    assert.deepEqual(
      Object.keys(rec).sort(),
      ["createdAt", "id", "keyVersion", "provider", "updatedAt", "userId"],
    );
  });

  await t.test("the raw database row contains NO plaintext", async () => {
    const { rows } = await pool.query(
      "SELECT iv, auth_tag, secret_ciphertext, algorithm, enc_version, key_version FROM user_credentials WHERE id = $1",
      [credId],
    );
    const r = rows[0] as {
      iv: Buffer; auth_tag: Buffer; secret_ciphertext: Buffer; algorithm: string;
    };
    assert.equal(r.algorithm, "aes-256-gcm");
    assert.equal(r.iv.length, 12);
    assert.equal(r.auth_tag.length, 16);
    assert.equal(r.secret_ciphertext.includes(Buffer.from(SECRET, "utf8")), false);
    assert.equal(r.secret_ciphertext.toString("utf8").includes(SECRET), false);
    // Whole-row text search: the secret appears nowhere in the table.
    const { rows: hits } = await pool.query(
      "SELECT count(*)::int AS n FROM user_credentials WHERE encode(secret_ciphertext,'escape') LIKE $1",
      [`%${SECRET}%`],
    );
    assert.equal((hits[0] as { n: number }).n, 0);
  });

  await t.test("reveal decrypts for the owner only", async () => {
    assert.equal(await store.reveal(credId, a.id), SECRET);
    assert.equal(await store.reveal(credId, b.id), null, "cross-user reveal must return null");
    assert.equal(await store.findById(credId, b.id), null);
    assert.deepEqual(await store.list(b.id), []);
  });

  await t.test("a wrong master key cannot decrypt the stored row", async () => {
    const wrong = new PgCredentialStore(
      pool,
      MasterKey.fromBase64(randomBytes(MASTER_KEY_BYTES).toString("base64")),
    );
    await assert.rejects(wrong.reveal(credId, a.id), CredentialDecryptionError);
  });

  await t.test("tampering with the stored ciphertext is detected", async () => {
    const { rows } = await pool.query("SELECT secret_ciphertext FROM user_credentials WHERE id=$1", [credId]);
    const orig = (rows[0] as { secret_ciphertext: Buffer }).secret_ciphertext;
    const tampered = Buffer.from(orig);
    tampered[0] = tampered[0]! ^ 0xff;
    await pool.query("UPDATE user_credentials SET secret_ciphertext=$1 WHERE id=$2", [tampered, credId]);
    await assert.rejects(store.reveal(credId, a.id), CredentialDecryptionError);
    await pool.query("UPDATE user_credentials SET secret_ciphertext=$1 WHERE id=$2", [orig, credId]);
    assert.equal(await store.reveal(credId, a.id), SECRET);
  });

  await t.test("database constraints hold", async () => {
    // (user, provider) uniqueness through the adapter.
    await assert.rejects(
      store.create({ userId: a.id, provider: "METAAPI", secret: "other", now: NOW }),
      CredentialAlreadyExistsError,
    );
    // Raw constraint checks.
    const expectFail = async (sql: string, params: unknown[], needle: string) => {
      await assert.rejects(pool.query(sql, params), (e: unknown) => String(e).includes(needle));
    };
    await expectFail(
      "INSERT INTO user_credentials (user_id,provider,key_version,iv,auth_tag,secret_ciphertext) VALUES ($1,'UNKNOWN',1,$2,$3,$4)",
      [a.id, Buffer.alloc(12), Buffer.alloc(16), Buffer.from("x")],
      "user_credentials_provider_check",
    );
    await expectFail(
      "INSERT INTO user_credentials (user_id,provider,key_version,iv,auth_tag,secret_ciphertext) VALUES ($1,'METAAPI',1,$2,$3,$4)",
      [a.id, Buffer.alloc(8), Buffer.alloc(16), Buffer.from("x")],
      "user_credentials_iv_check",
    );
    await expectFail(
      "INSERT INTO user_credentials (user_id,provider,key_version,iv,auth_tag,secret_ciphertext) VALUES ($1,'METAAPI',1,$2,$3,$4)",
      [a.id, Buffer.alloc(12), Buffer.alloc(4), Buffer.from("x")],
      "user_credentials_auth_tag_check",
    );
    await expectFail(
      "INSERT INTO user_credentials (user_id,provider,key_version,iv,auth_tag,secret_ciphertext) VALUES ($1,'METAAPI',1,$2,$3,$4)",
      [a.id, Buffer.alloc(12), Buffer.alloc(16), Buffer.alloc(0)],
      "user_credentials_secret_ciphertext_check",
    );
    // FK: an unknown owner is rejected.
    await expectFail(
      "INSERT INTO user_credentials (user_id,provider,key_version,iv,auth_tag,secret_ciphertext) VALUES (999999,'METAAPI',1,$1,$2,$3)",
      [Buffer.alloc(12), Buffer.alloc(16), Buffer.from("x")],
      "user_credentials_user_id_fkey",
    );
    // ON DELETE RESTRICT: a user holding a credential cannot be deleted.
    await expectFail("DELETE FROM users WHERE id=$1", [a.id], "user_credentials_user_id_fkey");
  });

  await t.test("nonce reuse under one key is rejected by the database", async () => {
    const { rows } = await pool.query("SELECT iv FROM user_credentials WHERE id=$1", [credId]);
    const iv = (rows[0] as { iv: Buffer }).iv;
    await assert.rejects(
      pool.query(
        "INSERT INTO user_credentials (user_id,provider,key_version,iv,auth_tag,secret_ciphertext) VALUES ($1,'METAAPI',1,$2,$3,$4)",
        [b.id, iv, Buffer.alloc(16), Buffer.from("y")],
      ),
      (e: unknown) => String(e).includes("user_credentials_nonce_unique"),
    );
  });

  await t.test("delete is owner-scoped and removes the ciphertext", async () => {
    assert.equal(await store.delete(credId, b.id), false, "non-owner delete must not remove");
    assert.equal(await store.delete(credId, a.id), true);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM user_credentials WHERE id=$1", [credId]);
    assert.equal((rows[0] as { n: number }).n, 0);
  });
});
