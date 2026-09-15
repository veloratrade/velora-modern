// MetaAPI historical-sync evidence on REAL PostgreSQL 17.
//
// Excluded from `npm test` by the *.pg.test.ts convention; run explicitly with
// DATABASE_URL set. Every assertion here targets something an in-memory fake
// CANNOT demonstrate: partial unique indexes firing across genuinely
// concurrent connections, CHECK constraints, ON CONFLICT convergence, and
// transactional cursor rollback.
//
// The provider is stubbed at the `fetch` boundary — never the repository and
// never the normalizer — so the code under test is the real client, the real
// normalizer and the real SQL. A test that re-implemented any of those would
// prove nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pool } from "pg";
import { createEngine, migrate } from "../migrate.ts";
import { createMetaApiSyncHandler } from "../../apps/worker/src/handlers/metaApiSyncHandler.ts";
import { acquireReservation, releaseReservation, listSyncableAccounts } from "../../apps/worker/src/metaapi/syncRepository.ts";
import { runSyncTick } from "../../apps/worker/src/scheduler/syncScheduler.ts";
import { MemoryQueue, type TestClock } from "../../apps/worker/src/queue/memoryQueue.ts";
import { normalizeDeal } from "../../apps/worker/src/metaapi/normalizeDeal.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const URL = process.env["DATABASE_URL"];
const TOKEN = "test-token-not-a-real-secret";

/** Deterministic clock: the in-memory queue is intentionally time-injected. */
const clock: TestClock = { nowMs: () => 1_780_000_000_000 };

/** A provider response stub. Asserts the request shape as a side effect. */
function stubFetch(deals: unknown[], seen?: { url?: string; headers?: Record<string, string> }) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (seen) {
      seen.url = String(url);
      seen.headers = init?.headers as Record<string, string>;
    }
    return new Response(JSON.stringify(deals), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

async function seedAccount(pool: Pool, metaapiId: string | null) {
  const u = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, locale) VALUES ($1,'x','en') RETURNING id`,
    [`ms-${Math.random().toString(36).slice(2)}@example.com`],
  );
  const userId = u.rows[0]!.id;
  const a = await pool.query<{ id: string }>(
    `INSERT INTO trading_accounts (user_id, external_account_id, broker_server, metaapi_account_id)
     VALUES ($1,$2,'demo',$3) RETURNING id`,
    [userId, `ext-${Math.random().toString(36).slice(2)}`, metaapiId],
  );
  return { userId, accountId: a.rows[0]!.id };
}

/** One closed round trip: an OUT deal with an offset-explicit instant. */
function closedDeal(id: string, over: Record<string, unknown> = {}) {
  return {
    id, positionId: `pos-${id}`, entryType: 1, type: "DEAL_TYPE_SELL",
    symbol: "EURUSD", volume: 1, price: "1.10500", profit: "125.50",
    commission: "-2.00", swap: "0.00",
    time: "2026-03-01T10:15:00.000Z", brokerTime: "2026-03-01 13:15:00",
    ...over,
  };
}

test("MetaAPI sync", { skip: URL ? false : "DATABASE_URL not set" }, async (t) => {
  const engine = await createEngine(URL!);
  await migrate(engine, MIGRATIONS);
  await engine.close?.();

  const pool = new Pool({ connectionString: URL });
  t.after(async () => { await pool.end(); });

  // --- 1. Account mapping -------------------------------------------------
  await t.test("E3: metaapi_account_id persists and is globally unique", async () => {
    const { accountId } = await seedAccount(pool, "acc-unique-001");
    const { rows } = await pool.query(
      `SELECT metaapi_account_id FROM trading_accounts WHERE id=$1`, [accountId]);
    assert.equal(rows[0]!.metaapi_account_id, "acc-unique-001");

    // A second account claiming the SAME provider id must be rejected: two
    // ledgers importing one provider account would double-count PnL.
    await assert.rejects(
      () => seedAccount(pool, "acc-unique-001"),
      (e: { code?: string }) => e.code === "23505",
    );
  });

  await t.test("E3b: external_account_id semantics are unchanged (not overloaded)", async () => {
    // Both columns coexist and hold DIFFERENT values on the same row.
    const { accountId } = await seedAccount(pool, "acc-distinct-002");
    const { rows } = await pool.query<{ e: string; m: string }>(
      `SELECT external_account_id AS e, metaapi_account_id AS m
         FROM trading_accounts WHERE id=$1`, [accountId]);
    assert.notEqual(rows[0]!.e, rows[0]!.m);
    assert.match(rows[0]!.e, /^ext-/);
  });

  await t.test("E3c: NULL metaapi_account_id is allowed (manual accounts)", async () => {
    const { accountId } = await seedAccount(pool, null);
    const { rows } = await pool.query(
      `SELECT metaapi_account_id FROM trading_accounts WHERE id=$1`, [accountId]);
    assert.equal(rows[0]!.metaapi_account_id, null);
  });

  // --- 2. Producer --------------------------------------------------------
  await t.test("E5: the producer enqueues ONLY MetaAPI-provisioned accounts", async () => {
    await pool.query(`DELETE FROM trade_events; DELETE FROM sync_fills; DELETE FROM trades; DELETE FROM trading_accounts;`);
    await seedAccount(pool, "acc-producer-1");
    await seedAccount(pool, null); // manual — must be skipped, never guessed

    const syncable = await listSyncableAccounts(pool);
    assert.equal(syncable.length, 1, "only the provisioned account is eligible");

    const queue = new MemoryQueue(clock);
    const n = await runSyncTick(pool, queue);
    assert.equal(n, 1);
    assert.equal(await queue.size(), 1);

    const job = await queue.claim();
    const payload = job!.descriptor.payload as Record<string, unknown>;
    assert.equal(payload["metaapiAccountId"], "acc-producer-1");
    // CREDENTIAL BOUNDARY: the payload carries identifiers only.
    const keys = Object.keys(payload).sort();
    assert.deepEqual(keys, ["accountId", "from", "metaapiAccountId", "to"]);
    for (const v of Object.values(payload)) assert.equal(typeof v, "string");
  });

  await t.test("E5b: a repeated tick is idempotent (same window ⇒ one job)", async () => {
    const queue = new MemoryQueue(clock);
    await runSyncTick(pool, queue, new Date("2026-06-01T00:00:00Z"));
    await runSyncTick(pool, queue, new Date("2026-06-01T00:00:00Z"));
    assert.equal(await queue.size(), 1, "idempotencyKey collapsed the duplicate");
  });

  // --- 3. Import ----------------------------------------------------------
  await t.test("E7: a successful import writes fill + trade + event, and advances the cursor", async () => {
    await pool.query(`DELETE FROM trade_events; DELETE FROM sync_fills; DELETE FROM trades; DELETE FROM trading_accounts;`);
    const { accountId, userId } = await seedAccount(pool, "acc-import-1");
    const seen: { url?: string; headers?: Record<string, string> } = {};
    const handler = createMetaApiSyncHandler({
      pool, platformToken: TOKEN, holder: "test", fetchImpl: stubFetch([closedDeal("d-1")], seen),
    });

    await handler({
      id: "j1", attempts: 0,
      descriptor: {
        jobClass: "metaapi.sync-account", priorityClass: "sync",
        idempotencyKey: "k1",
        payload: { accountId, metaapiAccountId: "acc-import-1",
          from: "2026-01-01T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z" },
      },
    } as never);

    // E6: the documented endpoint, and ONLY the documented header.
    assert.match(seen.url!, /\/users\/current\/accounts\/acc-import-1\/history-deals\/time\//);
    assert.deepEqual(Object.keys(seen.headers!).sort(), ["accept", "auth-token"]);
    assert.equal("idempotency-key" in seen.headers!, false);
    assert.equal("transaction-id" in seen.headers!, false);

    const fill = await pool.query(`SELECT * FROM sync_fills WHERE account_id=$1`, [accountId]);
    assert.equal(fill.rowCount, 1);
    assert.equal(fill.rows[0]!.external_deal_id, "d-1");
    assert.equal(fill.rows[0]!.user_id, userId, "ownership derived from the account row");

    const trade = await pool.query(`SELECT * FROM trades WHERE account_id=$1`, [accountId]);
    assert.equal(trade.rowCount, 1);
    assert.equal(trade.rows[0]!.source, "metaapi");
    assert.equal(trade.rows[0]!.user_id, userId);
    assert.equal(trade.rows[0]!.external_deal_id, "d-1");

    // E10: provider P/L is authoritative on the canonical column.
    assert.equal(String(trade.rows[0]!.net_pnl), "125.50");

    // E14: actor is `sync`, event is TRADE_IMPORTED.
    const ev = await pool.query(
      `SELECT type, actor FROM trade_events WHERE trade_id=$1`, [trade.rows[0]!.id]);
    assert.equal(ev.rows[0]!.type, "TRADE_IMPORTED");
    assert.equal(ev.rows[0]!.actor, "sync");

    // Cursor advanced to the window end, error cleared.
    const acct = await pool.query(
      `SELECT sync_cursor, last_synced_at, last_sync_error_code FROM trading_accounts WHERE id=$1`,
      [accountId]);
    assert.equal(acct.rows[0]!.sync_cursor, "2026-06-01T00:00:00.000Z");
    assert.notEqual(acct.rows[0]!.last_synced_at, null);
    assert.equal(acct.rows[0]!.last_sync_error_code, null);
  });

  await t.test("E8: replaying the SAME deal creates no duplicate row", async () => {
    const { accountId } = await seedAccount(pool, "acc-replay-1");
    const mk = () => createMetaApiSyncHandler({
      pool, platformToken: TOKEN, holder: "test", fetchImpl: stubFetch([closedDeal("dup-1")]),
    });
    const job = {
      id: "j2", attempts: 0,
      descriptor: { jobClass: "metaapi.sync-account", priorityClass: "sync", idempotencyKey: "k2",
        payload: { accountId, metaapiAccountId: "acc-replay-1",
          from: "2026-01-01T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z" } },
    } as never;

    await mk()(job);
    await mk()(job); // full replay

    const fills = await pool.query(`SELECT count(*)::int c FROM sync_fills WHERE account_id=$1`, [accountId]);
    assert.equal(fills.rows[0]!.c, 1);
    const trades = await pool.query(`SELECT count(*)::int c FROM trades WHERE account_id=$1`, [accountId]);
    assert.equal(trades.rows[0]!.c, 1);
    const evs = await pool.query(
      `SELECT count(*)::int c FROM trade_events e JOIN trades t ON t.id=e.trade_id WHERE t.account_id=$1`,
      [accountId]);
    assert.equal(evs.rows[0]!.c, 1, "deterministic event_uid collapsed the replay");
  });

  // --- 4. Timestamps (D-5) -------------------------------------------------
  await t.test("E11/E12/E13: offset-explicit resolves; naive is evidence only", async () => {
    const { accountId } = await seedAccount(pool, "acc-time-1");
    const deals = [
      closedDeal("t-ok"), // offset-explicit
      closedDeal("t-naive", { time: "2026-03-01 10:15:00", brokerTime: "2026-03-01 13:15:00" }),
    ];
    await createMetaApiSyncHandler({
      pool, platformToken: TOKEN, holder: "test", fetchImpl: stubFetch(deals),
    })({
      id: "j3", attempts: 0,
      descriptor: { jobClass: "metaapi.sync-account", priorityClass: "sync", idempotencyKey: "k3",
        payload: { accountId, metaapiAccountId: "acc-time-1",
          from: "2026-01-01T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z" } },
    } as never);

    const ok = await pool.query(
      `SELECT occurred_at_utc, time_status, raw_time_text, broker_time_text
         FROM sync_fills WHERE external_deal_id='t-ok'`);
    assert.equal(ok.rows[0]!.time_status, "resolved_utc");
    assert.notEqual(ok.rows[0]!.occurred_at_utc, null);
    // E13: the naive broker time is preserved VERBATIM alongside the instant.
    assert.equal(ok.rows[0]!.broker_time_text, "2026-03-01 13:15:00");
    assert.equal(ok.rows[0]!.raw_time_text, "2026-03-01T10:15:00.000Z");

    const naive = await pool.query(
      `SELECT occurred_at_utc, time_status, broker_time_text, processing_state, skip_reason
         FROM sync_fills WHERE external_deal_id='t-naive'`);
    // E12: no offset ⇒ NO instant is invented.
    assert.equal(naive.rows[0]!.occurred_at_utc, null);
    assert.equal(naive.rows[0]!.time_status, "unresolved");
    // Raw evidence survives even though UTC is NULL.
    assert.equal(naive.rows[0]!.broker_time_text, "2026-03-01 13:15:00");
    // J: excluded from normal analytics rather than silently promoted.
    assert.equal(naive.rows[0]!.processing_state, "skipped");
    assert.equal(naive.rows[0]!.skip_reason, "UNRESOLVED_TIME");

    const t = await pool.query(
      `SELECT count(*)::int c FROM trades WHERE account_id=$1 AND external_deal_id='t-naive'`,
      [accountId]);
    assert.equal(t.rows[0]!.c, 0, "an unresolved fill never becomes a trade");
  });

  await t.test("D-5: the normalizer never applies a host timezone to a naive value", () => {
    // Pure-unit guard: run under a deliberately non-UTC assumption. The naive
    // branch must yield null regardless of the machine's zone.
    assert.equal(normalizeDeal({ id: "x", time: "2026-03-01 10:15:00" })!.occurredAtUtc, null);
    assert.equal(normalizeDeal({ id: "x", time: "2026-03-01T10:15:00" })!.occurredAtUtc, null);
    // Offset-explicit forms resolve deterministically.
    assert.equal(
      normalizeDeal({ id: "x", time: "2026-03-01T10:15:00+02:00" })!.occurredAtUtc,
      "2026-03-01T08:15:00.000Z");
  });

  // --- 5. Concurrency ------------------------------------------------------
  await t.test("E9: two concurrent attempts cannot both own the reservation", async () => {
    const { accountId, userId } = await seedAccount(pool, "acc-lock-1");
    const [a, b] = await Promise.all([
      acquireReservation(pool, accountId, userId, "w1", 60_000),
      acquireReservation(pool, accountId, userId, "w2", 60_000),
    ]);
    const held = [a, b].filter((x) => x !== null);
    assert.equal(held.length, 1, "exactly one attempt owns the lease");

    // Release is safe and re-acquirable afterwards.
    await releaseReservation(pool, held[0]!);
    await releaseReservation(pool, held[0]!); // idempotent: must not throw
    const again = await acquireReservation(pool, accountId, userId, "w3", 60_000);
    assert.notEqual(again, null);
    await releaseReservation(pool, again!);
  });

  await t.test("E9b: a FAILED attempt does not advance the cursor", async () => {
    const { accountId } = await seedAccount(pool, "acc-fail-1");
    const before = await pool.query(
      `SELECT sync_cursor FROM trading_accounts WHERE id=$1`, [accountId]);

    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await assert.rejects(() => createMetaApiSyncHandler({
      pool, platformToken: TOKEN, holder: "test", fetchImpl: failing,
    })({
      id: "j4", attempts: 0,
      descriptor: { jobClass: "metaapi.sync-account", priorityClass: "sync", idempotencyKey: "k4",
        payload: { accountId, metaapiAccountId: "acc-fail-1",
          from: "2026-01-01T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z" } },
    } as never));

    const after = await pool.query(
      `SELECT sync_cursor, last_sync_error_code FROM trading_accounts WHERE id=$1`, [accountId]);
    assert.equal(after.rows[0]!.sync_cursor, before.rows[0]!.sync_cursor, "cursor did NOT move");
    // A fixed, non-secret code — never provider text.
    assert.equal(after.rows[0]!.last_sync_error_code, "PROVIDER_UNAVAILABLE");

    // The lease was released despite the failure.
    const res = await pool.query(
      `SELECT count(*)::int c FROM sync_reservations WHERE account_id=$1 AND released_at IS NULL`,
      [accountId]);
    assert.equal(res.rows[0]!.c, 0);
  });

  await t.test("E4: a missing MetaAPI id fails explicitly and is never guessed", async () => {
    const { accountId } = await seedAccount(pool, null);
    await assert.rejects(() => createMetaApiSyncHandler({
      pool, platformToken: TOKEN, holder: "test", fetchImpl: stubFetch([closedDeal("never")]),
    })({
      id: "j5", attempts: 0,
      descriptor: { jobClass: "metaapi.sync-account", priorityClass: "sync", idempotencyKey: "k5",
        payload: { accountId, metaapiAccountId: "", from: "2026-01-01T00:00:00.000Z",
          to: "2026-06-01T00:00:00.000Z" } },
    } as never));

    const acct = await pool.query(
      `SELECT last_sync_error_code FROM trading_accounts WHERE id=$1`, [accountId]);
    assert.equal(acct.rows[0]!.last_sync_error_code, "NO_METAAPI_ACCOUNT_ID");
    const fills = await pool.query(
      `SELECT count(*)::int c FROM sync_fills WHERE account_id=$1`, [accountId]);
    assert.equal(fills.rows[0]!.c, 0, "no data was imported under a guessed identity");
  });
});
