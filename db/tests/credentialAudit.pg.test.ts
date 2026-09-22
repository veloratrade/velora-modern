// B-3 real-PostgreSQL evidence — credential lifecycle audit, transactionally.
//
// Excluded from `npm test` by the *.pg.test.ts convention; run explicitly with
// PG_TEST_URL pointing at a database with all 11 migrations applied.
//
// This proves against a REAL server what an in-memory store cannot: that the
// credential mutation and its audit row share ONE transaction, so a failing
// audit INSERT leaves the database with no partial state. The rollback tests
// inspect the DATABASE afterwards, not a mock.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { withTransaction } from "../../apps/api/src/persistence/pg.js";
import { PgUserStore } from "../../apps/api/src/auth/pgUserStore.js";
import { PgAuditStore } from "../../apps/api/src/auth/pgAuditStore.js";
import { PgOwnershipStore } from "../../apps/api/src/auth/pgOwnershipStore.js";
import { PgCredentialStore } from "../../apps/api/src/credentials/pgCredentialStore.js";
import { CredentialService } from "../../apps/api/src/credentials/credentialService.js";
import { MasterKey, MASTER_KEY_BYTES } from "../../apps/api/src/credentials/credentialCrypto.js";
import type { AuditEntry, AuditStore, AuditTx } from "../../apps/api/src/auth/auditStore.js";
import { prepareDatabase, resetSchema } from "./support/pgTestDb.ts";

// CONNECTION CONVENTION (pass 2): the evidence workflow exports DATABASE_URL.
// This battery originally read only PG_TEST_URL, so in CI it SKIPPED SILENTLY
// while reporting success — three real-PG batteries were dormant. DATABASE_URL
// is now the primary source; PG_TEST_URL is still honoured as an explicit
// override (some environments point it at a pre-provisioned database).
const URL = process.env.DATABASE_URL ?? process.env.PG_TEST_URL;
const NOW = new Date("2026-07-01T11:00:00.000Z");
const SECRET = "metaapi-token-b3-91c4ff02-DO-NOT-LEAK";

test("B-3 real PostgreSQL: credential lifecycle audit is transactional", { skip: URL === undefined }, async (t) => {
  const pool = new Pool({ connectionString: URL });
  const users = new PgUserStore(pool);
  const audit = new PgAuditStore(pool);
  const key = MasterKey.fromBase64(randomBytes(MASTER_KEY_BYTES).toString("base64"));
  const store = new PgCredentialStore(pool, key);
  const svc = new CredentialService({ store, audit, now: () => NOW });

  t.after(async () => {
    await pool.end();
  });

  // ISOLATION AND DETERMINISM (pass 2). The hand-written DELETE order assumed a
  // database where nothing else referenced `users`; as soon as any other battery
  // had run, `DELETE FROM users` failed with 23503 (trades_user_id_fkey) and the
  // whole file failed.
  //
  // prepareDatabase() APPLIES THE MIGRATIONS and then truncates every application
  // table (resetting identity, which this battery's fixed fixtures depend on). The
  // migration half is not optional here: an earlier revision of this fix called
  // resetSchema() alone, which on a FRESH database finds no tables, resets
  // nothing, and then fails with 42P01 `relation "users" does not exist` — a
  // battery that only worked because some other battery had migrated first.
  await (await prepareDatabase(URL as string)).close();
  await resetSchema(pool);
  const owner = await users.createUser({
    email: "b3-owner@velora.ir", passwordHash: "x", fullName: "Owner",
    locale: "en", timezone: "UTC", now: NOW,
  });
  const other = await users.createUser({
    email: "b3-other@velora.ir", passwordHash: "x", fullName: "Other",
    locale: "en", timezone: "UTC", now: NOW,
  });

  const countCreds = async (): Promise<number> =>
    Number((await pool.query("SELECT count(*)::int AS n FROM user_credentials")).rows[0].n);
  const auditRows = async (action: string): Promise<Array<Record<string, unknown>>> =>
    (await pool.query("SELECT * FROM audit_log WHERE action = $1 ORDER BY id", [action])).rows;

  await t.test("CREATE commits the credential and exactly one audit row", async () => {
    const rec = await svc.createCredential(
      { id: owner.id, requestId: "req-pg-create" },
      { provider: "METAAPI", secret: SECRET },
    );
    assert.equal(await countCreds(), 1);

    const rows = await auditRows("CREDENTIAL_CREATED");
    assert.equal(rows.length, 1, "exactly one CREDENTIAL_CREATED");
    const r = rows[0]!;
    assert.equal(String(r.actor_user_id), owner.id);
    assert.equal(String(r.target_user_id), owner.id);
    assert.equal(String(r.credential_id), rec.id);
    assert.equal(r.provider, "METAAPI");
    assert.equal(r.request_id, "req-pg-create");
    assert.equal(r.outcome, "success");
    assert.equal(r.before_state, null);
    assert.equal(r.after_state, null);
  });

  await t.test("DELETE removes the credential, leaves one audit row, history survives", async () => {
    const rows0 = await auditRows("CREDENTIAL_CREATED");
    const credId = String(rows0[0]!.credential_id);

    await svc.deleteCredential({ id: owner.id, requestId: "req-pg-delete" }, credId);
    assert.equal(await countCreds(), 0, "credential hard-deleted");

    const rows = await auditRows("CREDENTIAL_DELETED");
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.equal(String(r.credential_id), credId);
    assert.equal(r.provider, "METAAPI", "provider captured from the deleted row");
    assert.equal(r.request_id, "req-pg-delete");
    assert.equal(r.outcome, "success");

    // The trail outlives the credential (no FK, B-2 decision).
    const survived = await pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE credential_id = $1", [credId]);
    assert.equal(survived.rows[0].n, 2, "both create and delete rows remain");
  });

  await t.test("ROLLBACK: a failing audit INSERT undoes the credential CREATE", async () => {
    await pool.query("DELETE FROM audit_log");
    await pool.query("DELETE FROM user_credentials");

    // A real PgAuditStore whose INSERT is guaranteed to fail INSIDE the
    // transaction: an unsupported action violates the 0011 CHECK constraint.
    // This is a genuine database error, not a mocked throw.
    const badAudit: AuditStore = {
      append: (entry: AuditEntry, tx?: AuditTx) =>
        audit.append({ ...entry, action: "NOT_A_REAL_ACTION" as AuditEntry["action"] }, tx),
      list: () => audit.list(),
    };
    const svcBad = new CredentialService({ store, audit: badAudit, now: () => NOW });

    await assert.rejects(
      () => svcBad.createCredential({ id: owner.id }, { provider: "METAAPI", secret: SECRET }),
      "the CHECK violation must propagate",
    );

    // THE PROOF: the database has no credential and no audit row.
    assert.equal(await countCreds(), 0, "credential INSERT must have rolled back");
    const all = await pool.query("SELECT count(*)::int AS n FROM audit_log");
    assert.equal(all.rows[0].n, 0, "no audit row either");
  });

  await t.test("ROLLBACK: a failing audit INSERT undoes the credential DELETE", async () => {
    await pool.query("DELETE FROM audit_log");
    await pool.query("DELETE FROM user_credentials");

    const rec = await svc.createCredential({ id: owner.id }, { provider: "METAAPI", secret: SECRET });
    assert.equal(await countCreds(), 1);

    const badAudit: AuditStore = {
      append: (entry: AuditEntry, tx?: AuditTx) =>
        audit.append({ ...entry, action: "NOT_A_REAL_ACTION" as AuditEntry["action"] }, tx),
      list: () => audit.list(),
    };
    const svcBad = new CredentialService({ store, audit: badAudit, now: () => NOW });

    await assert.rejects(() => svcBad.deleteCredential({ id: owner.id }, rec.id));

    // THE PROOF: the credential is still in the database.
    assert.equal(await countCreds(), 1, "the DELETE must have rolled back");
    const still = await pool.query("SELECT id FROM user_credentials WHERE id = $1", [rec.id]);
    assert.equal(still.rows.length, 1, "the same credential row survived");
  });

  await t.test("a REAL System Owner cannot reach another user's credential", async () => {
    await pool.query("DELETE FROM audit_log");
    await pool.query("DELETE FROM user_credentials");
    const rec = await svc.createCredential({ id: owner.id }, { provider: "METAAPI", secret: SECRET });
    const before = Number((await pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n);

    // Claim installation ownership for `other` — this is the real System Owner
    // of the installation, the highest authority the system has.
    const ownership = new PgOwnershipStore(pool);
    await ownership.claimOwnership({
      ownerUserId: other.id, claimedByUserId: other.id,
      claimedIp: null, claimedUserAgent: null, now: NOW,
    });
    const claimed = await ownership.getOwnership();
    assert.equal(claimed?.ownerUserId, other.id, "System Owner really is claimed");

    // Even so, the credential is unreachable: ownership is structural, and the
    // service exposes no parameter through which any authority could name a
    // different owner.
    await assert.rejects(() => svc.deleteCredential({ id: other.id }, rec.id), /Credential not found/);
    assert.deepEqual(await svc.listCredentials({ id: other.id }), [], "not even visible");

    assert.equal(await countCreds(), 1, "the owner's credential is untouched");
    const after = Number((await pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n);
    assert.equal(after, before, "a denied delete writes no audit row");
  });

  await t.test("a rejected duplicate CREATE leaves no audit row and no new credential", async () => {
    await pool.query("DELETE FROM audit_log");
    await pool.query("DELETE FROM user_credentials");
    const first = await svc.createCredential({ id: owner.id }, { provider: "METAAPI", secret: SECRET });
    const after1 = Number((await pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n);
    assert.equal(after1, 1);

    // The (user_id, provider) uniqueness constraint rejects this.
    await assert.rejects(
      () => svc.createCredential({ id: owner.id }, { provider: "METAAPI", secret: "second-secret" }),
    );

    assert.equal(await countCreds(), 1, "still exactly one credential");
    const rows = await pool.query("SELECT id FROM user_credentials");
    assert.equal(String(rows.rows[0].id), first.id, "the ORIGINAL credential is unchanged");
    const after2 = Number((await pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n);
    assert.equal(after2, 1, "the rejected duplicate added NO audit row");
  });

  await t.test("the audit row is written on the SAME connection as the mutation", async () => {
    await pool.query("DELETE FROM audit_log");
    await pool.query("DELETE FROM user_credentials");

    // The strongest available proof of "one transaction": from inside the
    // audit callback, the not-yet-committed credential INSERT must be VISIBLE.
    // Under READ COMMITTED a different connection cannot see an uncommitted
    // row, so this can only succeed if the audit shares the mutation's
    // transaction.
    let sawPendingRow: number | null = null;
    let receivedTx = false;
    const probingAudit: AuditStore = {
      append: async (entry: AuditEntry, tx?: AuditTx) => {
        receivedTx = tx !== undefined;
        if (tx !== undefined) {
          const rows = await tx("SELECT count(*)::int AS n FROM user_credentials WHERE id = $1", [
            entry.credentialId,
          ]);
          sawPendingRow = Number((rows[0] as { n: number }).n);
        }
        await audit.append(entry, tx);
      },
      list: () => audit.list(),
    };
    const svcProbe = new CredentialService({ store, audit: probingAudit, now: () => NOW });
    await svcProbe.createCredential({ id: owner.id }, { provider: "METAAPI", secret: SECRET });

    assert.equal(receivedTx, true, "audit must receive the mutation's transaction, not undefined");
    assert.equal(sawPendingRow, 1, "audit must see the uncommitted credential — same transaction");
  });

  await t.test("PgAuditStore honours the transaction: a rollback discards the audit row", async () => {
    await pool.query("DELETE FROM audit_log");

    // If append() ignored its tx argument and used the pool, this row would
    // survive the rollback.
    await assert.rejects(() =>
      withTransaction(pool, async (q) => {
        await audit.append(
          {
            action: "CREDENTIAL_CREATED", actorUserId: owner.id, targetUserId: owner.id,
            beforeState: null, afterState: null, outcome: "success",
            credentialId: "1", provider: "METAAPI", requestId: "req-rollback", occurredAt: NOW,
          },
          q,
        );
        throw new Error("deliberate abort");
      }),
    );

    const n = Number((await pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n);
    assert.equal(n, 0, "the audit row must be rolled back with its transaction");
  });

  await t.test("no secret material is stored anywhere in audit_log", async () => {
    const dump = JSON.stringify((await pool.query("SELECT * FROM audit_log")).rows);
    assert.equal(dump.includes(SECRET), false, "plaintext must never reach the audit trail");
  });
});
