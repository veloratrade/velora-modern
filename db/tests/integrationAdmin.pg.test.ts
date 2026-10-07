// Real-PostgreSQL battery for Phase 8 — admin-managed integrations (MetaAPI, Email).
//
// WHAT ONLY A REAL ENGINE CAN PROVE HERE:
//   1. VOCABULARIES ARE CLOSED. 0031 CHECKs secret keys, setting keys and
//      setting values (METAAPI_BASE_URL https, MAIL_DRIVER, MAIL_PORT).
//   2. ENVELOPE SURVIVES BYTEA. AES-256-GCM envelope via credentialCrypto must
//      round-trip byte-identical through BYTEA and decrypt to original.
//   3. NONCE UNIQUENESS. Same key_version+iv must be refused.
//   4. FK. updated_by must reference a real users row.

import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareDatabase } from "./support/pgTestDb.ts";
import { PgIntegrationStore } from "../../apps/api/src/integrations/integrationStore.ts";
import { MasterKey, encryptCredential, decryptCredential } from "../../apps/api/src/credentials/credentialCrypto.ts";
import type { QueryFn } from "../../apps/api/src/persistence/pg.ts";

const PG_URL = process.env.DATABASE_URL;
const SKIP = PG_URL === undefined ? "DATABASE_URL not set — real-PG battery" : false;

const qWrap = (pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }): QueryFn =>
  (async (sql: string, params?: unknown[]) => (await pool.query(sql, params as unknown[] | undefined)).rows) as unknown as QueryFn;

function isPgRejection(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === "23514" || code === "23505" || code === "23503" || code === "23502" || code === "22001";
}

let seq = 0;
async function setup(): Promise<{ pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }; q: QueryFn; store: PgIntegrationStore; userId: string; cleanup: () => Promise<void> }> {
  const prepared = await prepareDatabase(PG_URL as string);
  const pool = prepared.pool as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
  const q = qWrap(pool);
  seq += 1;
  const email = `int-pg-${Date.now()}-${seq}@velora.test`;
  const rows = await q(`INSERT INTO users (email, password_hash, locale, timezone, role, email_verified_at) VALUES ($1, 'x', 'fa', 'Asia/Tehran', 'user', now()) RETURNING id::text AS id`, [email]);
  const userId = String(rows[0]!["id"]);
  return {
    pool, q, store: new PgIntegrationStore(pool as never), userId,
    cleanup: async () => {
      await q(`DELETE FROM integration_platform_secrets WHERE true`);
      await q(`DELETE FROM integration_settings WHERE true`);
      await q(`DELETE FROM users WHERE id = $1`, [userId]);
      await prepared.close();
    },
  };
}

test("PG-INT: 0031 tables exist with expected columns", { skip: SKIP }, async () => {
  const ctx = await setup();
  try {
    const tables = await ctx.q(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('integration_platform_secrets','integration_settings') ORDER BY table_name`);
    assert.equal(tables.length, 2);
  } finally { await ctx.cleanup(); }
});

test("PG-INT: secret key vocabulary is closed", { skip: SKIP }, async () => {
  const ctx = await setup();
  try {
    await assert.rejects(
      () => ctx.q(`INSERT INTO integration_platform_secrets (secret_key, key_version, iv, auth_tag, secret_ciphertext) VALUES ('BAD_KEY', 1, '\\x000000000000000000000000', '\\x00000000000000000000000000000000', '\\x01')`),
      isPgRejection,
    );
  } finally { await ctx.cleanup(); }
});

test("PG-INT: setting vocabularies are closed (MAIL_DRIVER, METAAPI_BASE_URL, MAIL_PORT)", { skip: SKIP }, async () => {
  const ctx = await setup();
  try {
    await assert.rejects(() => ctx.q(`INSERT INTO integration_settings (setting_key, setting_value) VALUES ('MAIL_DRIVER', 'bad')`), isPgRejection);
    await assert.rejects(() => ctx.q(`INSERT INTO integration_settings (setting_key, setting_value) VALUES ('METAAPI_BASE_URL', 'http://insecure')`), isPgRejection);
    await assert.rejects(() => ctx.q(`INSERT INTO integration_settings (setting_key, setting_value) VALUES ('MAIL_PORT', '99999x')`), isPgRejection);
  } finally { await ctx.cleanup(); }
});

test("PG-INT: envelope round-trips through BYTEA and decrypts", { skip: SKIP }, async () => {
  const ctx = await setup();
  try {
    const key = MasterKey.fromBase64(Buffer.alloc(32, 8).toString("base64"), 1);
    const plaintext = "metaapi-token-1234567890";
    const envelope = encryptCredential(plaintext, key);
    await ctx.store.writeSecret("METAAPI_TOKEN", envelope, ctx.userId);
    const read = await ctx.store.readSecret("METAAPI_TOKEN");
    assert.ok(read !== null);
    assert.equal(decryptCredential(read!, key), plaintext);
    // same envelope to same key does an UPDATE (ON CONFLICT) — allowed
    await ctx.store.writeSecret("METAAPI_TOKEN", envelope, ctx.userId);
    // but same iv+key_version on a DIFFERENT key must be refused (nonce uniqueness)
    await assert.rejects(() => ctx.store.writeSecret("RESEND_API_KEY", envelope, ctx.userId), isPgRejection);
    // a different iv is allowed (new envelope)
    const envelope2 = encryptCredential("other-token-xyz", key);
    await ctx.store.writeSecret("METAAPI_TOKEN", envelope2, ctx.userId);
    const read2 = await ctx.store.readSecret("METAAPI_TOKEN");
    assert.equal(decryptCredential(read2!, key), "other-token-xyz");
  } finally { await ctx.cleanup(); }
});

test("PG-INT: settings upsert and delete", { skip: SKIP }, async () => {
  const ctx = await setup();
  try {
    await ctx.store.setSetting("METAAPI_BASE_URL", "https://api.metaapi.cloud", ctx.userId);
    assert.equal(await ctx.store.setting("METAAPI_BASE_URL"), "https://api.metaapi.cloud");
    await ctx.store.setSetting("METAAPI_BASE_URL", "https://custom.example.com", ctx.userId);
    assert.equal(await ctx.store.setting("METAAPI_BASE_URL"), "https://custom.example.com");
    assert.equal(await ctx.store.deleteSetting("METAAPI_BASE_URL"), true);
    assert.equal(await ctx.store.setting("METAAPI_BASE_URL"), null);
  } finally { await ctx.cleanup(); }
});

test("PG-INT: updated_by FK — invalid user is refused", { skip: SKIP }, async () => {
  const ctx = await setup();
  try {
    const key = MasterKey.fromBase64(Buffer.alloc(32, 8).toString("base64"), 1);
    const env = encryptCredential("x", key);
    // Direct SQL with bad updated_by should fail FK
    await assert.rejects(
      () => ctx.q(`INSERT INTO integration_platform_secrets (secret_key, key_version, iv, auth_tag, secret_ciphertext, updated_by) VALUES ('RESEND_API_KEY', 1, '\\x0102030405060708090a0b0c', '\\x0102030405060708090a0b0c0d0e0f10', '\\x01', 9999999)`),
      isPgRejection,
    );
  } finally { await ctx.cleanup(); }
});

test("PG-INT: secretKeysPresent and hasSecret", { skip: SKIP }, async () => {
  const ctx = await setup();
  try {
    const key = MasterKey.fromBase64(Buffer.alloc(32, 8).toString("base64"), 1);
    assert.deepEqual(await ctx.store.secretKeysPresent(), []);
    await ctx.store.writeSecret("RESEND_API_KEY", encryptCredential("re_12345678901234567890", key), ctx.userId);
    assert.deepEqual(await ctx.store.secretKeysPresent(), ["RESEND_API_KEY"]);
    assert.equal(await ctx.store.hasSecret("RESEND_API_KEY"), true);
    assert.equal(await ctx.store.hasSecret("SMTP_PASSWORD"), false);
  } finally { await ctx.cleanup(); }
});
