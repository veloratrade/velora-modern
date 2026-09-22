// C-34 real-PostgreSQL evidence. Excluded from `npm test` by the *.pg.test.ts
// convention (tools/run-tests.mjs); run explicitly with PG_TEST_URL set.
//
// This proves against a REAL PostgreSQL server what PGlite cannot: that the
// audit row and the privileged mutation share one transaction, and that a
// failing audit write rolls the mutation back.
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { PgUserStore } from "../../apps/api/src/auth/pgUserStore.js";
import { PgAuditStore } from "../../apps/api/src/auth/pgAuditStore.js";
import { PgOwnershipStore } from "../../apps/api/src/auth/pgOwnershipStore.js";
import { prepareDatabase, resetSchema } from "./support/pgTestDb.ts";

// CONNECTION CONVENTION (pass 2): the evidence workflow exports DATABASE_URL.
// This battery originally read only PG_TEST_URL, so in CI it SKIPPED SILENTLY
// while reporting success — three real-PG batteries were dormant. DATABASE_URL
// is now the primary source; PG_TEST_URL is still honoured as an explicit
// override (some environments point it at a pre-provisioned database).
const URL = process.env.DATABASE_URL ?? process.env.PG_TEST_URL;
const NOW = new Date("2026-03-01T12:00:00.000Z");

test("C-34 real PostgreSQL: transactional audit + append-only", { skip: URL === undefined }, async (t) => {
  const pool = new Pool({ connectionString: URL });
  const users = new PgUserStore(pool);
  const audit = new PgAuditStore(pool);
  const ownership = new PgOwnershipStore(pool);
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
  const actor = await users.createUser({
    email: "actor@velora.ir", passwordHash: "x", fullName: "Actor",
    locale: "en", timezone: "UTC", now: NOW,
  });
  const target = await users.createUser({
    email: "target@velora.ir", passwordHash: "x", fullName: "Target",
    locale: "en", timezone: "UTC", now: NOW,
  });

  await t.test("role change + audit row commit together", async () => {
    const updated = await users.updateUserRole(target.id, "admin", NOW, (tx) =>
      audit.append({
        action: "USER_ROLE_CHANGED", actorUserId: actor.id, targetUserId: target.id,
        beforeState: "user", afterState: "admin", requestId: "req-pg-1", occurredAt: NOW,
      }, tx).then(() => undefined),
    );
    assert.equal(updated!.role, "admin");
    const rows = await audit.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.action, "USER_ROLE_CHANGED");
    assert.equal(rows[0]!.beforeState, "user");
    assert.equal(rows[0]!.afterState, "admin");
    assert.equal(rows[0]!.requestId, "req-pg-1");
  });

  await t.test("a failing audit write ROLLS BACK the role change (real BEGIN/ROLLBACK)", async () => {
    await assert.rejects(
      users.updateUserRole(target.id, "super_admin", NOW, async () => {
        throw new Error("audit backend unavailable");
      }),
      /audit backend unavailable/,
    );
    const after = await users.findUserById(target.id);
    assert.equal(after!.role, "admin", "the UPDATE must have been rolled back");
    assert.equal((await audit.list()).length, 1, "no extra audit row");
  });

  await t.test("a failing audit write ROLLS BACK the status change", async () => {
    await assert.rejects(
      users.updateUserStatus(target.id, "suspended", NOW, async () => {
        throw new Error("audit backend unavailable");
      }),
      /audit backend unavailable/,
    );
    assert.equal((await users.findUserById(target.id))!.status, "active");
  });

  await t.test("a failing audit write ROLLS BACK the ownership claim", async () => {
    await assert.rejects(
      ownership.claimOwnership(
        { ownerUserId: actor.id, claimedByUserId: actor.id, claimedIp: null, claimedUserAgent: null, now: NOW },
        async () => { throw new Error("audit backend unavailable"); },
      ),
      /audit backend unavailable/,
    );
    assert.equal(await ownership.getOwnership(), null, "ownership must remain unclaimed");
    assert.equal((await audit.list()).length, 1);
  });

  await t.test("a successful claim commits claim + audit row together", async () => {
    await ownership.claimOwnership(
      { ownerUserId: actor.id, claimedByUserId: actor.id, claimedIp: null, claimedUserAgent: null, now: NOW },
      (tx) => audit.append({
        action: "OWNERSHIP_CLAIMED", actorUserId: actor.id, targetUserId: actor.id,
        beforeState: null, afterState: "claimed", requestId: "req-pg-2", occurredAt: NOW,
      }, tx).then(() => undefined),
    );
    assert.notEqual(await ownership.getOwnership(), null);
    const rows = await audit.list();
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.action, "OWNERSHIP_CLAIMED");
  });
});
