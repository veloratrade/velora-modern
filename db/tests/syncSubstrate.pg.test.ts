// D-6 sync-substrate evidence on REAL PostgreSQL. Excluded from `npm test` by
// the *.pg.test.ts convention; run explicitly with DATABASE_URL set.
//
// Every guarantee here is a DATABASE guarantee, so it is proven against a real
// server: partial unique indexes, CHECK constraints and FK behaviour are
// exactly the things an in-memory fake cannot demonstrate.
//
// The concurrency test below runs genuinely concurrent transactions on separate
// connections — a "concurrency guarantee" asserted any other way would be a
// claim, not evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pool } from "pg";
import { createEngine, migrate } from "../migrate.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const URL = process.env["DATABASE_URL"];

async function seed(pool: Pool): Promise<{ userId: string; accountId: string }> {
  const u = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, locale)
     VALUES ($1, 'x', 'en') RETURNING id`,
    [`d6-${Math.random().toString(36).slice(2)}@example.com`],
  );
  const userId = u.rows[0]!.id;
  const a = await pool.query<{ id: string }>(
    `INSERT INTO trading_accounts (user_id, external_account_id, broker_server)
     VALUES ($1, $2, 'demo') RETURNING id`,
    [userId, `ext-${Math.random().toString(36).slice(2)}`],
  );
  return { userId, accountId: a.rows[0]!.id };
}

test("D-6 sync substrate", { skip: URL ? false : "DATABASE_URL not set" }, async (t) => {
  // Fresh migration from 0001 — proves the migration applies to a clean DB.
  const engine = await createEngine(URL!);
  await migrate(engine, MIGRATIONS);
  await engine.close?.();

  const pool = new Pool({ connectionString: URL });
  t.after(async () => { await pool.end(); });

  await t.test("migration is idempotent (re-running changes nothing)", async () => {
    const e2 = await createEngine(URL!);
    await migrate(e2, MIGRATIONS); // must not throw
    await e2.close?.();
    const { rows } = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM information_schema.tables
       WHERE table_name IN ('sync_fills','sync_reservations')`,
    );
    assert.equal(rows[0]!.c, "2");
  });

  await t.test("cursor columns exist on trading_accounts and default to NULL", async () => {
    const { userId, accountId } = await seed(pool);
    void userId;
    const { rows } = await pool.query(
      `SELECT last_synced_at, sync_cursor, last_sync_error_code
       FROM trading_accounts WHERE id = $1`,
      [accountId],
    );
    // NULL means "never synced" — distinct from a zero timestamp.
    assert.equal(rows[0]!["last_synced_at"], null);
    assert.equal(rows[0]!["sync_cursor"], null);
    assert.equal(rows[0]!["last_sync_error_code"], null);
  });

  await t.test("last_sync_error_code accepts a CODE and rejects free text", async () => {
    const { accountId } = await seed(pool);
    await pool.query(`UPDATE trading_accounts SET last_sync_error_code='PROVIDER_UNAVAILABLE' WHERE id=$1`, [accountId]);
    // G-3: provider prose must never be storable here.
    await assert.rejects(
      () => pool.query(
        `UPDATE trading_accounts SET last_sync_error_code=$2 WHERE id=$1`,
        [accountId, "MetaAPI 401 investorPassword=Hunter2"],
      ),
      (e: { code?: string }) => e.code === "23514", // check_violation
    );
  });

  // --- CONCURRENCY: executed proof, not an assertion of intent --------------
  await t.test("CONCURRENT reservation: exactly one of two racing workers wins", async () => {
    const { userId, accountId } = await seed(pool);
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      const ins = `INSERT INTO sync_reservations (account_id, user_id, holder, lease_expires_at)
                   VALUES ($1, $2, $3, now() + interval '5 minutes')`;
      await a.query(ins, [accountId, userId, "worker-a"]);

      // B races for the SAME account. The partial unique index must stop it.
      // With A uncommitted, B blocks; resolve the race by committing A first.
      const bAttempt = b.query(ins, [accountId, userId, "worker-b"]);
      await a.query("COMMIT");
      await assert.rejects(
        () => bAttempt,
        (e: { code?: string }) => e.code === "23505", // unique_violation
        "the second concurrent reservation MUST be rejected by the database",
      );
      await b.query("ROLLBACK");

      const { rows } = await pool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM sync_reservations
         WHERE account_id=$1 AND released_at IS NULL`,
        [accountId],
      );
      assert.equal(rows[0]!.c, "1", "exactly one active reservation survives");
    } finally {
      a.release();
      b.release();
    }
  });

  await t.test("a released reservation frees the account for a new one", async () => {
    const { userId, accountId } = await seed(pool);
    const ins = `INSERT INTO sync_reservations (account_id, user_id, holder, lease_expires_at)
                 VALUES ($1,$2,$3, now() + interval '5 minutes') RETURNING id`;
    const first = await pool.query<{ id: string }>(ins, [accountId, userId, "w1"]);
    await pool.query(`UPDATE sync_reservations SET released_at=now() WHERE id=$1`, [first.rows[0]!.id]);
    // The partial index only constrains rows WHERE released_at IS NULL.
    await pool.query(ins, [accountId, userId, "w2"]);
    const { rows } = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM sync_reservations WHERE account_id=$1`, [accountId]);
    assert.equal(rows[0]!.c, "2", "history is retained, not overwritten");
  });

  await t.test("STALE recovery: an expired lease is reclaimable and stays visible", async () => {
    const { userId, accountId } = await seed(pool);
    const r = await pool.query<{ id: string }>(
      `INSERT INTO sync_reservations (account_id, user_id, holder, acquired_at, lease_expires_at)
       VALUES ($1,$2,'abandoned-worker', now() - interval '1 hour', now() - interval '30 minutes')
       RETURNING id`, [accountId, userId]);

    // Documented policy: reclaim = explicit UPDATE, never a DELETE.
    const reclaimed = await pool.query(
      `UPDATE sync_reservations SET released_at=now(), stale_reclaimed=true
       WHERE account_id=$1 AND released_at IS NULL AND lease_expires_at < now()
       RETURNING id`, [accountId]);
    assert.equal(reclaimed.rowCount, 1);

    await pool.query(
      `INSERT INTO sync_reservations (account_id, user_id, holder, lease_expires_at)
       VALUES ($1,$2,'recovery-worker', now() + interval '5 minutes')`, [accountId, userId]);

    const evidence = await pool.query<{ stale_reclaimed: boolean }>(
      `SELECT stale_reclaimed FROM sync_reservations WHERE id=$1`, [r.rows[0]!.id]);
    assert.equal(evidence.rows[0]!.stale_reclaimed, true, "abandonment remains auditable");
  });

  await t.test("a lease that expires before it is acquired is rejected", async () => {
    const { userId, accountId } = await seed(pool);
    await assert.rejects(
      () => pool.query(
        `INSERT INTO sync_reservations (account_id, user_id, holder, acquired_at, lease_expires_at)
         VALUES ($1,$2,'w', now(), now() - interval '1 minute')`, [accountId, userId]),
      (e: { code?: string }) => e.code === "23514",
    );
  });

  // --- IDEMPOTENCY ----------------------------------------------------------
  await t.test("IDEMPOTENCY: the same provider deal cannot be imported twice", async () => {
    const { userId, accountId } = await seed(pool);
    const ins = `INSERT INTO sync_fills (account_id, user_id, external_deal_id, symbol)
                 VALUES ($1,$2,'deal-1','XAUUSD')`;
    await pool.query(ins, [accountId, userId]);
    await assert.rejects(
      () => pool.query(ins, [accountId, userId]),
      (e: { code?: string }) => e.code === "23505",
      "a replayed provider response must NOT create a second fill",
    );
  });

  await t.test("the same provider deal id is allowed on a DIFFERENT account", async () => {
    const one = await seed(pool);
    const two = await seed(pool);
    const ins = `INSERT INTO sync_fills (account_id, user_id, external_deal_id)
                 VALUES ($1,$2,'shared-deal-id')`;
    await pool.query(ins, [one.accountId, one.userId]);
    // Idempotency is account-scoped: provider ids are not globally unique.
    await pool.query(ins, [two.accountId, two.userId]);
    const { rows } = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM sync_fills WHERE external_deal_id='shared-deal-id'`);
    assert.equal(rows[0]!.c, "2");
  });

  // --- OWNERSHIP ------------------------------------------------------------
  await t.test("OWNERSHIP: fills require real user and account references", async () => {
    const { userId } = await seed(pool);
    await assert.rejects(
      () => pool.query(
        `INSERT INTO sync_fills (account_id, user_id, external_deal_id)
         VALUES (999999999, $1, 'orphan')`, [userId]),
      (e: { code?: string }) => e.code === "23503", // FK violation
    );
  });

  await t.test("OWNERSHIP: deleting an account removes its fills and reservations", async () => {
    const { userId, accountId } = await seed(pool);
    await pool.query(
      `INSERT INTO sync_fills (account_id, user_id, external_deal_id) VALUES ($1,$2,'d')`,
      [accountId, userId]);
    await pool.query(
      `INSERT INTO sync_reservations (account_id, user_id, holder, lease_expires_at)
       VALUES ($1,$2,'w', now() + interval '5 minutes')`, [accountId, userId]);
    await pool.query(`DELETE FROM trading_accounts WHERE id=$1`, [accountId]);
    for (const tbl of ["sync_fills", "sync_reservations"]) {
      const { rows } = await pool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM ${tbl} WHERE account_id=$1`, [accountId]);
      assert.equal(rows[0]!.c, "0", `${tbl} must not outlive its account`);
    }
  });

  // --- TIMESTAMPS (TZ-M1) ---------------------------------------------------
  await t.test("TZ-M1: unresolved time must NOT carry a UTC instant", async () => {
    const { userId, accountId } = await seed(pool);
    // Guessing a UTC value for a naive brokerTime is exactly what TZ-M1 forbids.
    await assert.rejects(
      () => pool.query(
        `INSERT INTO sync_fills (account_id, user_id, external_deal_id, time_status, occurred_at_utc)
         VALUES ($1,$2,'t1','unresolved', now())`, [accountId, userId]),
      (e: { code?: string }) => e.code === "23514",
    );
    // And a resolved instant must actually be present.
    await assert.rejects(
      () => pool.query(
        `INSERT INTO sync_fills (account_id, user_id, external_deal_id, time_status, occurred_at_utc)
         VALUES ($1,$2,'t2','resolved_utc', NULL)`, [accountId, userId]),
      (e: { code?: string }) => e.code === "23514",
    );
  });

  await t.test("TZ-M1: offset-explicit time resolves; raw text is retained verbatim", async () => {
    const { userId, accountId } = await seed(pool);
    await pool.query(
      `INSERT INTO sync_fills (account_id, user_id, external_deal_id, time_status, occurred_at_utc, raw_time_text)
       VALUES ($1,$2,'t3','resolved_utc','2026-04-01T09:00:00.000Z','2026-04-01T09:00:00.000Z')`,
      [accountId, userId]);
    const { rows } = await pool.query<{ occurred_at_utc: Date; raw_time_text: string }>(
      `SELECT occurred_at_utc, raw_time_text FROM sync_fills WHERE external_deal_id='t3'`);
    assert.equal(rows[0]!.occurred_at_utc.toISOString(), "2026-04-01T09:00:00.000Z");
    assert.equal(rows[0]!.raw_time_text, "2026-04-01T09:00:00.000Z");
  });

  await t.test("no naive brokerTime column was added (that storage is D-5)", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='sync_fills'`);
    const names = rows.map((r) => r.column_name);
    assert.equal(names.includes("broker_time_text"), false, "D-5 is not authorized by D-6");
  });

  // --- QUARANTINE -----------------------------------------------------------
  await t.test("QUARANTINE: the flag persists and defaults to false", async () => {
    const { userId, accountId } = await seed(pool);
    const t1 = await pool.query<{ id: string }>(
      `INSERT INTO trades (user_id, account_id, symbol, direction, entry_price, volume, occurred_at)
       VALUES ($1,$2,'EURUSD','buy',1.1,1.0, now()) RETURNING id`, [userId, accountId]);
    const id = t1.rows[0]!.id;
    const before = await pool.query<{ quarantined: boolean }>(
      `SELECT quarantined FROM trades WHERE id=$1`, [id]);
    assert.equal(before.rows[0]!.quarantined, false, "existing rows default to not quarantined");

    await pool.query(`UPDATE trades SET quarantined=true WHERE id=$1`, [id]);
    const after = await pool.query<{ quarantined: boolean }>(
      `SELECT quarantined FROM trades WHERE id=$1`, [id]);
    assert.equal(after.rows[0]!.quarantined, true, "the domain flag now survives a write");
  });

  await t.test("A-1: TRADE_IMPORTED with actor 'sync' is accepted by the DB (no migration needed)", async () => {
    const { userId, accountId } = await seed(pool);
    const t1 = await pool.query<{ id: string }>(
      `INSERT INTO trades (user_id, account_id, symbol, direction, entry_price, volume, occurred_at)
       VALUES ($1,$2,'EURUSD','buy',1.1,1.0, now()) RETURNING id`, [userId, accountId]);
    await pool.query(
      `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload)
       VALUES ($1,$2,'TRADE_IMPORTED','sync',0,'{}'::jsonb)`,
      [`evt-${Math.random().toString(36).slice(2)}`, t1.rows[0]!.id]);
    // Confirms the A-1 finding: the CHECK constraints already permit this.
    const { rows } = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM trade_events WHERE type='TRADE_IMPORTED' AND actor='sync'`);
    assert.ok(Number(rows[0]!.c) >= 1);
  });
});
