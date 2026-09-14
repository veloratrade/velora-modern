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

const URL = process.env.PG_TEST_URL;
const NOW = new Date("2026-03-01T12:00:00.000Z");

test("C-34 real PostgreSQL: transactional audit + append-only", { skip: URL === undefined }, async (t) => {
  const pool = new Pool({ connectionString: URL });
  const users = new PgUserStore(pool);
  const audit = new PgAuditStore(pool);
  const ownership = new PgOwnershipStore(pool);
  t.after(async () => {
    await pool.end();
  });

  await pool.query("DELETE FROM audit_log");
  await pool.query("DELETE FROM installation_ownership");
  await pool.query("DELETE FROM users");
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
