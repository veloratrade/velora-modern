// B-2 real-PostgreSQL evidence — the audit contract extended by migration 0011.
//
// Excluded from `npm test` by the *.pg.test.ts convention
// (tools/run-tests.mjs); run explicitly with PG_TEST_URL set against a database
// that has all 11 migrations applied.
//
// This proves against a REAL server what PGlite cannot: the exact CHECK
// constraint behaviour, that credential_id carries NO foreign key, and that the
// append-only privilege grid is unchanged by the new columns.
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { PgUserStore } from "../../apps/api/src/auth/pgUserStore.js";
import { PgAuditStore } from "../../apps/api/src/auth/pgAuditStore.js";
import { resetSchema } from "./support/pgTestDb.ts";

// CONNECTION CONVENTION (pass 2): the evidence workflow exports DATABASE_URL.
// This battery originally read only PG_TEST_URL, so in CI it SKIPPED SILENTLY
// while reporting success — three real-PG batteries were dormant. DATABASE_URL
// is now the primary source; PG_TEST_URL is still honoured as an explicit
// override (some environments point it at a pre-provisioned database).
const URL = process.env.DATABASE_URL ?? process.env.PG_TEST_URL;
const NOW = new Date("2026-06-01T08:00:00.000Z");

/** SQLSTATE of a CHECK violation. */
const CHECK_VIOLATION = "23514";

test("B-2 real PostgreSQL: audit credential contract (0011)", { skip: URL === undefined }, async (t) => {
  const pool = new Pool({ connectionString: URL });
  const users = new PgUserStore(pool);
  const audit = new PgAuditStore(pool);
  t.after(async () => {
    await pool.end();
  });

  // ISOLATION AND DETERMINISM (pass 2). The hand-written DELETE order assumed a
  // database where nothing else referenced `users`; as soon as any other battery
  // had run, `DELETE FROM users` failed with 23503 (trades_user_id_fkey) and the
  // whole file failed. The shared reset truncates every application table (also
  // resetting identity, which this battery's fixed fixture rows depend on), so
  // the battery is repeatable in any order and against a used cluster.
  await resetSchema(pool);
  const actor = await users.createUser({
    email: "b2-actor@velora.ir", passwordHash: "x", fullName: "Actor",
    locale: "en", timezone: "UTC", now: NOW,
  });

  await t.test("the three pre-existing actions remain accepted", async () => {
    for (const action of ["OWNERSHIP_CLAIMED", "USER_ROLE_CHANGED", "USER_STATUS_CHANGED"] as const) {
      const rec = await audit.append({
        action, actorUserId: actor.id, targetUserId: actor.id,
        beforeState: null, afterState: null, requestId: "req-b2-existing", occurredAt: NOW,
      });
      assert.equal(rec.action, action);
      // Pre-B-2 call sites pass no outcome/metadata: they must default cleanly.
      assert.equal(rec.outcome, "success");
      assert.equal(rec.credentialId, null);
      assert.equal(rec.provider, null);
    }
  });

  await t.test("CREDENTIAL_CREATED and CREDENTIAL_DELETED are accepted with metadata", async () => {
    for (const action of ["CREDENTIAL_CREATED", "CREDENTIAL_DELETED"] as const) {
      const rec = await audit.append({
        action, actorUserId: actor.id, targetUserId: actor.id,
        beforeState: null, afterState: null, requestId: "req-b2-cred", occurredAt: NOW,
        credentialId: "4242", provider: "METAAPI",
      });
      assert.equal(rec.action, action);
      assert.equal(rec.credentialId, "4242");
      assert.equal(rec.provider, "METAAPI");
      assert.equal(rec.outcome, "success");
    }
  });

  await t.test("both outcomes round-trip: success and denied", async () => {
    const ok = await audit.append({
      action: "CREDENTIAL_CREATED", actorUserId: actor.id, targetUserId: actor.id,
      beforeState: null, afterState: null, requestId: "req-ok", occurredAt: NOW,
      outcome: "success", credentialId: "1", provider: "METAAPI",
    });
    assert.equal(ok.outcome, "success");

    const denied = await audit.append({
      action: "CREDENTIAL_DELETED", actorUserId: actor.id, targetUserId: actor.id,
      beforeState: null, afterState: null, requestId: "req-denied", occurredAt: NOW,
      outcome: "denied", credentialId: "2", provider: "METAAPI",
    });
    assert.equal(denied.outcome, "denied");
  });

  await t.test("credential metadata is nullable for credential actions", async () => {
    const rec = await audit.append({
      action: "CREDENTIAL_DELETED", actorUserId: actor.id, targetUserId: actor.id,
      beforeState: null, afterState: null, requestId: "req-null-meta", occurredAt: NOW,
    });
    assert.equal(rec.credentialId, null);
    assert.equal(rec.provider, null);
  });

  await t.test("invalid action / outcome / provider are rejected by the database", async () => {
    // Raw SQL: the typed contract would block these at compile time, so the
    // DATABASE must be proven to reject them independently.
    for (const [label, sql, params] of [
      ["unknown action", "INSERT INTO audit_log (action, actor_user_id) VALUES ($1,$2)", ["NOT_AN_ACTION", actor.id]],
      ["CREDENTIAL_REVEALED (deliberately not in the vocabulary)",
        "INSERT INTO audit_log (action, actor_user_id) VALUES ($1,$2)", ["CREDENTIAL_REVEALED", actor.id]],
      ["unknown outcome", "INSERT INTO audit_log (action, actor_user_id, outcome) VALUES ($1,$2,$3)",
        ["CREDENTIAL_CREATED", actor.id, "maybe"]],
      ["unknown provider", "INSERT INTO audit_log (action, actor_user_id, provider) VALUES ($1,$2,$3)",
        ["CREDENTIAL_CREATED", actor.id, "BINANCE"]],
    ] as Array<[string, string, unknown[]]>) {
      await assert.rejects(
        () => pool.query(sql, params),
        (err: unknown) => (err as { code?: string }).code === CHECK_VIOLATION,
        `${label} must raise a CHECK violation`,
      );
    }
  });

  await t.test("credential_id has NO foreign key and survives a hard delete", async () => {
    const fks = await pool.query(
      `SELECT a.attname FROM pg_constraint c
         JOIN unnest(c.conkey) k(attnum) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.conrelid = 'audit_log'::regclass AND c.contype = 'f'`,
    );
    const fkCols = fks.rows.map((r: { attname: string }) => r.attname);
    assert.equal(fkCols.includes("credential_id"), false, "credential_id must NOT be a foreign key");
    // The pre-existing user FKs are untouched.
    assert.ok(fkCols.includes("actor_user_id"));

    // A credential id that never existed is accepted — proof there is no
    // referential constraint to satisfy.
    const orphan = await audit.append({
      action: "CREDENTIAL_DELETED", actorUserId: actor.id, targetUserId: actor.id,
      beforeState: null, afterState: null, requestId: "req-orphan", occurredAt: NOW,
      credentialId: "999999999", provider: "METAAPI",
    });
    assert.equal(orphan.credentialId, "999999999");

    // And a real credential can be hard-deleted while its audit row remains:
    // the trail must outlive the credential.
    const ins = await pool.query(
      `INSERT INTO user_credentials
         (user_id, provider, key_version, iv, auth_tag, secret_ciphertext)
       VALUES ($1,'METAAPI',1,
               decode('0102030405060708090a0b0c','hex'),
               decode('0102030405060708090a0b0c0d0e0f10','hex'),
               decode('deadbeef','hex'))
       RETURNING id`,
      [actor.id],
    );
    const credId = String((ins.rows[0] as { id: string | number }).id);
    await audit.append({
      action: "CREDENTIAL_CREATED", actorUserId: actor.id, targetUserId: actor.id,
      beforeState: null, afterState: null, requestId: "req-survive", occurredAt: NOW,
      credentialId: credId, provider: "METAAPI",
    });
    await pool.query("DELETE FROM user_credentials WHERE id = $1", [credId]);
    // Scoped by request_id: user_credentials.id is an identity sequence that is
    // NOT reset when rows are deleted between runs, so a bare credential_id
    // match could collide with a row written by an earlier subtest.
    const after = await pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE credential_id = $1 AND request_id = $2",
      [credId, "req-survive"],
    );
    assert.equal((after.rows[0] as { n: number }).n, 1, "audit history must survive credential deletion");
  });

  await t.test("no secret-bearing column exists on audit_log", async () => {
    const cols = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_log'",
    );
    const names = cols.rows.map((r: { column_name: string }) => r.column_name);
    for (const forbidden of [
      "secret", "secret_ciphertext", "ciphertext", "iv", "auth_tag", "authtag",
      "master_key", "key", "token", "password",
    ]) {
      assert.equal(names.includes(forbidden), false, `audit_log must have no ${forbidden} column`);
    }
    // Exactly the 9 original columns, the 2 added by 0011, and the 1 added by
    // 0014 (trading_account_id). Kept as an exact count so that ANY future
    // column must come past this assertion and justify itself.
    assert.equal(names.length, 12);
    assert.equal(names.includes("trading_account_id"), true,
      "0014 adds a nullable account reference — an identifier, never a secret");
  });

  await t.test("append-only: the adapter issues no UPDATE or DELETE", async () => {
    // The port itself exposes no mutation method — an absent capability cannot
    // be called by mistake. (db/roles.sql REVOKEs the privileges as the
    // independent second layer; it is operator-applied and asserted there.)
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(audit));
    for (const forbidden of ["update", "delete", "remove", "truncate", "purge"]) {
      assert.equal(methods.includes(forbidden), false, `AuditStore must expose no ${forbidden}`);
    }
    assert.deepEqual(methods.sort(), ["append", "constructor", "list"]);
  });
});
