// TRD-06 manual sync — REAL PostgreSQL evidence.
//
// Excluded from `npm test` by the *.pg.test.ts convention; run explicitly with
// DATABASE_URL set (tools/run-pg-batteries.sh).
//
// WHY THIS NEEDS A REAL SERVER. The two things worth proving here are exactly
// the things an in-memory double cannot show:
//   1. `PgManualSyncStore` reads the columns the service's decision depends on
//      (`metaapi_account_id`, `sync_cursor`) with the ownership predicate
//      applied in SQL — including a NULL cursor and a foreign user;
//   2. the durable "awaiting sync" marker is a CONDITIONAL update, and the
//      condition (`NOT IN ('SYNCING','CONNECTED')`) is enforced by the engine,
//      not by the test: a duplicate request must not drag a working account
//      backwards, and the value written must satisfy the 0004 CHECK constraint.
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { prepareDatabase } from "./support/pgTestDb.ts";
import { PgManualSyncStore } from "../../apps/api/src/accounts/manualSyncService.ts";
import { makeSyncPendingMarker } from "../../apps/api/src/accounts/syncPending.ts";
import { ManualSyncService } from "../../apps/api/src/accounts/manualSyncService.ts";
import { poolQuery } from "../../apps/api/src/persistence/pg.ts";

const URL = process.env["DATABASE_URL"];

async function seedAccount(
  pool: Pool,
  syncStatus: string,
  linked = true,
  syncCursor: string | null = null,
): Promise<{ userId: string; accountId: string; metaapiAccountId: string | null }> {
  const suffix = Math.random().toString(36).slice(2);
  // `trading_accounts_metaapi_unique` makes the provider id a real unique key,
  // so each seeded account needs its own — the same constraint that guarantees
  // one MetaAPI account belongs to one Velora account.
  const metaapiAccountId = linked ? `acct-${suffix}` : null;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, locale) VALUES ($1, 'x', 'en') RETURNING id`,
    [`trd06-${suffix}@example.com`],
  );
  const userId = u.rows[0]!.id;
  const a = await pool.query<{ id: string }>(
    `INSERT INTO trading_accounts (user_id, external_account_id, broker_server, sync_status, metaapi_account_id, sync_cursor)
     VALUES ($1, $2, 'demo', $3, $4, $5) RETURNING id`,
    [userId, `ext-${suffix}`, syncStatus, metaapiAccountId, syncCursor],
  );
  return { userId, accountId: a.rows[0]!.id, metaapiAccountId };
}

test("TRD-06 manual sync on real PostgreSQL", { skip: URL ? false : "DATABASE_URL not set" }, async (t) => {
  const db = await prepareDatabase(URL!);
  const { pool } = db;
  t.after(async () => {
    await db.close();
  });
  const q = poolQuery(pool);

  await t.test("the store reads the provider link and cursor, scoped by owner", async () => {
    const store = new PgManualSyncStore(q);
    const { userId, accountId, metaapiAccountId } = await seedAccount(pool, "DISCONNECTED", true, "2026-10-01T00:00:00.000Z");

    const mine = await store.findForUser(accountId, userId);
    assert.ok(mine !== null);
    assert.equal(mine.metaapiAccountId, metaapiAccountId);
    assert.equal(mine.syncCursor, "2026-10-01T00:00:00.000Z", "a timestamptz must come back as an ISO instant");

    // A different user asking for the SAME id gets nothing — the ownership
    // predicate is in the SQL, so it cannot be forgotten by a caller.
    const foreign = await store.findForUser(accountId, "999999");
    assert.equal(foreign, null);

    // A manual account (no provider id) is a legitimate row with a NULL link.
    const manual = await seedAccount(pool, "DISCONNECTED", false);
    const manualRow = await store.findForUser(manual.accountId, manual.userId);
    assert.equal(manualRow?.metaapiAccountId, null, "NULL must survive the mapping as null, not 'null'");
    assert.equal(manualRow?.syncCursor, null);
  });

  await t.test("the pending marker writes CONNECTING and never drags a working account back", async () => {
    const markSyncPending = makeSyncPendingMarker(q);

    for (const state of ["DISCONNECTED", "CONNECTING", "ERROR"]) {
      const { accountId } = await seedAccount(pool, state);
      await markSyncPending(accountId);
      const { rows } = await pool.query<{ sync_status: string }>(
        `SELECT sync_status FROM trading_accounts WHERE id = $1`,
        [accountId],
      );
      assert.equal(rows[0]!.sync_status, "CONNECTING", `${state} must become CONNECTING (the 0004 vocabulary)`);
    }

    for (const state of ["SYNCING", "CONNECTED"]) {
      const { accountId } = await seedAccount(pool, state);
      await markSyncPending(accountId);
      const { rows } = await pool.query<{ sync_status: string }>(
        `SELECT sync_status FROM trading_accounts WHERE id = $1`,
        [accountId],
      );
      assert.equal(rows[0]!.sync_status, state, `${state} is progress the worker made; a request must not undo it`);
    }

    // An unknown id is a no-op, not an error: the service has already resolved
    // ownership, and a row deleted between the read and the write must not turn
    // a legitimate request into a 500.
    await markSyncPending("999999999");
  });

  await t.test("a queued request leaves the account awaiting sync, and an unlinked account writes nothing", async () => {
    const { accountId, userId } = await seedAccount(pool, "CONNECTED", true, "2026-10-01T00:00:00.000Z");
    const dispatches: { from: string; to: string }[] = [];
    const service = new ManualSyncService({
      store: new PgManualSyncStore(q),
      markSyncPending: makeSyncPendingMarker(q),
      trigger: {
        requestSync: async (r) => {
          dispatches.push({ from: r.from, to: r.to });
          return true;
        },
      },
      now: () => new Date("2026-10-04T12:00:00.000Z"),
    });

    const result = await service.request(accountId, userId);
    assert.equal(result.kind, "queued");
    assert.deepEqual(dispatches, [{ from: "2026-10-01T00:00:00.000Z", to: "2026-10-04T12:00:00.000Z" }]);

    const { rows } = await pool.query<{ sync_status: string; updated_at: Date }>(
      `SELECT sync_status, updated_at FROM trading_accounts WHERE id = $1`,
      [accountId],
    );
    assert.equal(rows[0]!.sync_status, "CONNECTED", "a duplicate request must not undo the worker's state");

    // The request is against the OWNER's account only: the same call by another
    // user is not-found and touches nothing.
    const other = await service.request(accountId, "999999");
    assert.equal(other.kind, "not-found");

    const manualAccount = await seedAccount(pool, "DISCONNECTED", false);
    const manualAccountResult = await service.request(manualAccount.accountId, manualAccount.userId);
    assert.equal(manualAccountResult.kind, "not-metaapi");
    const after = await pool.query<{ sync_status: string }>(
      `SELECT sync_status FROM trading_accounts WHERE id = $1`,
      [manualAccount.accountId],
    );
    assert.equal(after.rows[0]!.sync_status, "DISCONNECTED", "an unconsumable job must not mark the account");
  });
});
