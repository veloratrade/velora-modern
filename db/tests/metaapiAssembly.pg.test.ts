// MetaAPI POSITION ASSEMBLY reconciliation evidence on REAL PostgreSQL.
//
// MG-METAAPI-ASSEMBLY (audit §9.2 — "the largest behavioural divergence"):
// Legacy assembles ONE closed-position trade per positionId from the durable
// fill ledger (MetaApiService::reconcileAccount + MetaApiDealAssembler,
// VERIFIED @ edede31). This battery proves the Modern port's reconciliation
// semantics against a real database — the things an in-memory fake cannot
// demonstrate: the UNIQUE (account_id, external_deal_id) pos-key convergence,
// cross-batch completion, the sync_position_state machine (received →
// aggregated | skipped, and the re-open on a later fill), and concurrent
// import safety.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pool } from "pg";
import { createMetaApiSyncHandler } from "../../apps/worker/src/handlers/metaApiSyncHandler.ts";
import { prepareDatabase, resetSchema } from "./support/pgTestDb.ts";

const URL = process.env.DATABASE_URL;
const TOKEN = "test-token-not-a-real-secret";

function stubFetch(deals: unknown[]) {
  return (async () =>
    new Response(JSON.stringify(deals), {
      status: 200, headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

async function seedAccount(pool: Pool, metaapiId: string) {
  const u = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, locale) VALUES ($1,'x','en') RETURNING id`,
    [`ma-${Math.random().toString(36).slice(2)}@example.com`],
  );
  const userId = u.rows[0]!.id;
  const a = await pool.query<{ id: string }>(
    `INSERT INTO trading_accounts (user_id, external_account_id, broker_server, metaapi_account_id)
     VALUES ($1,$2,'demo',$3) RETURNING id`,
    [userId, `ext-${Math.random().toString(36).slice(2)}`, metaapiId],
  );
  return { userId, accountId: a.rows[0]!.id };
}

function deal(id: string, over: Record<string, unknown>) {
  return {
    id, symbol: "EURUSD", commission: "0", swap: "0", profit: "0",
    ...over,
  };
}

/** IN leg helper. */
function inDeal(id: string, positionId: string, over: Record<string, unknown> = {}) {
  return deal(id, {
    positionId, entryType: 0, type: "DEAL_TYPE_BUY", volume: 1, price: "1.10000",
    time: "2026-03-01T10:00:00.000Z", brokerTime: "2026-03-01 13:00:00",
    ...over,
  });
}

/** OUT leg helper. */
function outDeal(id: string, positionId: string, over: Record<string, unknown> = {}) {
  return deal(id, {
    positionId, entryType: 1, type: "DEAL_TYPE_SELL", volume: 1, price: "1.10500",
    time: "2026-03-01T11:00:00.000Z", brokerTime: "2026-03-01 14:00:00",
    ...over,
  });
}

function runHandler(pool: Pool, accountId: string, metaapiId: string, deals: unknown[], n: number) {
  return createMetaApiSyncHandler({
    pool, platformToken: TOKEN, holder: "test", fetchImpl: stubFetch(deals),
  })({
    id: `j${n}`, attempts: 0,
    descriptor: {
      jobClass: "metaapi.sync-account", priorityClass: "sync", idempotencyKey: `k${n}`,
      payload: { accountId, metaapiAccountId: metaapiId,
        from: "2026-01-01T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z" },
    },
  } as never);
}

test("MetaAPI position assembly", { skip: URL ? false : "DATABASE_URL not set" }, async (t) => {
  // Migrations first (fresh cluster safe), then a clean slate.
  const prepared = await prepareDatabase(URL!);
  const pool = prepared.pool;
  t.after(async () => { await pool.end(); });
  await resetSchema(pool);

  await t.test("cross-batch completion: IN in batch 1, OUT in batch 2 → ONE position trade", async () => {
    const { accountId } = await seedAccount(pool, "asm-cross");
    // Batch 1: only the open leg.
    await runHandler(pool, accountId, "asm-cross", [
      inDeal("c-in", "P1", { profit: "-1" }),
    ], 1);
    let trades = await pool.query(`SELECT * FROM trades WHERE account_id=$1`, [accountId]);
    assert.equal(trades.rowCount, 0, "an open position never emits a half-trade");
    let st = await pool.query(`SELECT state FROM sync_position_state WHERE account_id=$1 AND position_id='P1'`, [accountId]);
    assert.equal(st.rows[0]!.state, "received", "position_still_open is repairable");

    // Batch 2: the close leg arrives → the position assembles from BOTH fills.
    await runHandler(pool, accountId, "asm-cross", [
      outDeal("c-out", "P1", { profit: "101", commission: "-3", swap: "-0.5" }),
    ], 2);
    trades = await pool.query(`SELECT * FROM trades WHERE account_id=$1`, [accountId]);
    assert.equal(trades.rowCount, 1);
    assert.equal(trades.rows[0]!.external_deal_id, "pos-P1");
    // Financials span BOTH batches' fills: -1 + 101 = 100.
    assert.equal(String(trades.rows[0]!.net_pnl), "100.00");
    assert.equal(String(trades.rows[0]!.commission), "-3.00");
    assert.equal(String(trades.rows[0]!.swap), "-0.50");
    st = await pool.query(`SELECT state, trade_id FROM sync_position_state WHERE account_id=$1 AND position_id='P1'`, [accountId]);
    assert.equal(st.rows[0]!.state, "aggregated");
    assert.equal(String(st.rows[0]!.trade_id), String(trades.rows[0]!.id));
  });

  await t.test("scaled-in + partial close through the real SQL path: VWAP both sides, Σ-IN volume", async () => {
    const { accountId } = await seedAccount(pool, "asm-vwap");
    await runHandler(pool, accountId, "asm-vwap", [
      inDeal("v-i1", "P2", { volume: 0.5, price: "1.1000", time: "2026-03-01T10:00:00.000Z" }),
      inDeal("v-i2", "P2", { volume: 0.5, price: "1.1200", time: "2026-03-01T10:05:00.000Z" }),
      outDeal("v-o1", "P2", { volume: 0.4, price: "1.1200", time: "2026-03-01T11:00:00.000Z" }),
    ], 1);
    // 0.4 OUT < 1.0 IN → still open; no trade yet.
    assert.equal((await pool.query(`SELECT count(*)::int c FROM trades WHERE account_id=$1`, [accountId])).rows[0]!.c, 0);

    await runHandler(pool, accountId, "asm-vwap", [
      outDeal("v-o2", "P2", { volume: 0.6, price: "1.1400", time: "2026-03-01T12:00:00.000Z" }),
    ], 2);
    const trade = (await pool.query(`SELECT * FROM trades WHERE account_id=$1`, [accountId])).rows[0]!;
    assert.equal(trade.external_deal_id, "pos-P2");
    assert.equal(String(trade.entry_price), "1.11000000", "VWAP of the two IN fills");
    assert.equal(String(trade.exit_price), "1.13200000", "VWAP of the two OUT fills");
    assert.equal(String(trade.volume), "1.00000000", "volume = Σ IN");
    assert.equal(new Date(trade.occurred_open_at_utc).toISOString(), "2026-03-01T10:00:00.000Z", "earliest IN");
    assert.equal(new Date(trade.occurred_close_at_utc).toISOString(), "2026-03-01T12:00:00.000Z", "LATEST OUT");
  });

  await t.test("terminal skips are durable: close_before_open and unknown_direction", async () => {
    const { accountId } = await seedAccount(pool, "asm-terminal");
    await runHandler(pool, accountId, "asm-terminal", [
      // close (11:00 listed first) is BEFORE open (12:00) → terminal.
      outDeal("t-o1", "P3", { time: "2026-03-01T11:00:00.000Z" }),
      inDeal("t-i1", "P3", { time: "2026-03-01T12:00:00.000Z" }),
      // no usable direction on the IN side → terminal.
      outDeal("t-o2", "P4"),
      inDeal("t-i2", "P4", { type: "DEAL_TYPE_BALANCE" }),
    ], 1);

    const states = await pool.query(
      `SELECT position_id, state, skip_reason FROM sync_position_state WHERE account_id=$1 ORDER BY position_id`, [accountId]);
    const byPid = new Map(states.rows.map((r) => [r.position_id, r]));
    assert.equal(byPid.get("P3")!.state, "skipped");
    assert.equal(byPid.get("P3")!.skip_reason, "close_before_open");
    assert.equal(byPid.get("P4")!.state, "skipped");
    assert.equal(byPid.get("P4")!.skip_reason, "unknown_direction");
    assert.equal((await pool.query(`SELECT count(*)::int c FROM trades WHERE account_id=$1`, [accountId])).rows[0]!.c, 0);

    // And they are NOT re-assessed: a second sync touching the account leaves
    // them skipped (Legacy pendingPositionIds semantics).
    await runHandler(pool, accountId, "asm-terminal", [
      inDeal("t-i9", "P9"), outDeal("t-o9", "P9"),
    ], 2);
    const after = await pool.query(
      `SELECT assessed_at FROM sync_position_state WHERE account_id=$1 AND position_id='P3'`, [accountId]);
    const p9 = await pool.query(`SELECT state FROM sync_position_state WHERE account_id=$1 AND position_id='P9'`, [accountId]);
    assert.equal(p9.rows[0]!.state, "aggregated", "the new position assembled");
    assert.notEqual(after.rows[0]!.assessed_at, null);
    const still = await pool.query(
      `SELECT state, skip_reason FROM sync_position_state WHERE account_id=$1 AND position_id='P3'`, [accountId]);
    assert.equal(still.rows[0]!.state, "skipped", "terminal stays terminal");
  });

  await t.test("a LATER fill re-opens an aggregated position and re-assessment converges (no duplicate)", async () => {
    const { accountId } = await seedAccount(pool, "asm-reopen");
    await runHandler(pool, accountId, "asm-reopen", [
      inDeal("r-in", "P5"), outDeal("r-out", "P5", { profit: "50" }),
    ], 1);
    assert.equal((await pool.query(`SELECT count(*)::int c FROM trades WHERE account_id=$1`, [accountId])).rows[0]!.c, 1);
    assert.equal((await pool.query(`SELECT count(*)::int c FROM trade_events e JOIN trades t ON t.id=e.trade_id WHERE t.account_id=$1`, [accountId])).rows[0]!.c, 1);

    // A late-arriving fill for the SAME position re-opens it.
    await runHandler(pool, accountId, "asm-reopen", [
      outDeal("r-out2", "P5", { volume: 0.0, profit: "10", time: "2026-03-01T11:30:00.000Z" }),
    ], 2);
    const st = await pool.query(`SELECT state FROM sync_position_state WHERE account_id=$1 AND position_id='P5'`, [accountId]);
    assert.equal(st.rows[0]!.state, "aggregated", "re-assessed and re-aggregated");
    // OD-M-PA-2: DO NOTHING convergence — exactly ONE trade, ONE event.
    assert.equal((await pool.query(`SELECT count(*)::int c FROM trades WHERE account_id=$1`, [accountId])).rows[0]!.c, 1);
    assert.equal((await pool.query(`SELECT count(*)::int c FROM trade_events e JOIN trades t ON t.id=e.trade_id WHERE t.account_id=$1`, [accountId])).rows[0]!.c, 1);
  });

  await t.test("a lone OUT fill is repairable (missing_open_fill), never a half-trade", async () => {
    const { accountId } = await seedAccount(pool, "asm-lone");
    await runHandler(pool, accountId, "asm-lone", [outDeal("l-1", "P6")], 1);
    assert.equal((await pool.query(`SELECT count(*)::int c FROM trades WHERE account_id=$1`, [accountId])).rows[0]!.c, 0);
    const st = await pool.query(`SELECT state, skip_reason FROM sync_position_state WHERE account_id=$1 AND position_id='P6'`, [accountId]);
    assert.equal(st.rows[0]!.state, "received");
    assert.equal(st.rows[0]!.skip_reason, null, "no terminal reason recorded for a repairable position");
  });

  await t.test("keyless and balance deals are ledgered as evidence but never assessed", async () => {
    const { accountId } = await seedAccount(pool, "asm-keyless");
    await runHandler(pool, accountId, "asm-keyless", [
      outDeal("k-1", "P7"),
      // Keyless trade fill (no positionId): ledgered evidence, never assessed.
      deal("k-2", {
        entryType: 1, type: "DEAL_TYPE_SELL", volume: 1, price: "1.10500",
        time: "2026-03-01T11:00:00.000Z", brokerTime: "2026-03-01 14:00:00",
      }),
      // Balance deal WITH a position id: not a trade fill.
      deal("k-3", { positionId: "P8", entryType: 2, type: "DEAL_TYPE_BALANCE", profit: "500" }),
    ], 1);
    // k-2 without a positionId:
    const keyless = (await pool.query(`SELECT position_id FROM sync_fills WHERE account_id=$1 AND external_deal_id='k-2'`, [accountId])).rows[0]!;
    assert.equal(keyless.position_id, null);
    const states = await pool.query(`SELECT position_id FROM sync_position_state WHERE account_id=$1`, [accountId]);
    const pids = states.rows.map((r) => r.position_id);
    assert.ok(pids.includes("P7"), "the trade fill with a position id IS pending");
    assert.ok(!pids.includes("P8"), "the balance deal never opens an assessment");
    assert.equal((await pool.query(`SELECT count(*)::int c FROM trades WHERE account_id=$1`, [accountId])).rows[0]!.c, 0);
  });

  await t.test("self-healing: ledgered fills with NO state row (pre-0029 data) are assessed on the next sync", async () => {
    const { userId, accountId } = await seedAccount(pool, "asm-heal");
    // Simulate the per-fill era: fills ledgered by the OLD importBatch, no
    // sync_position_state rows at all. (Direct SQL is the honest way to
    // reproduce data that predates the table.)
    for (const [id, entry, price, profit, t] of [
      ["h-in", "in", "1.10000", "0", "2026-03-01T10:00:00.000Z"],
      ["h-out", "out", "1.10600", "66.25", "2026-03-01T11:00:00.000Z"],
    ] as const) {
      await pool.query(
        `INSERT INTO sync_fills
           (account_id, user_id, external_deal_id, position_id, entry_type, direction, symbol,
            volume, price, profit, commission, swap, occurred_at_utc, raw_time_text,
            broker_time_text, time_status, ingestion_source, processing_state)
         VALUES ($1,$2,$3,'HEAL',$4,'buy','EURUSD','1',$5,$6,'0','0',$7::timestamptz,$8,
                 '2026-03-01 13:00:00','resolved_utc','historical','received')`,
        [accountId, userId, id, entry, price, profit, t, t],
      );
    }
    assert.equal((await pool.query(`SELECT count(*)::int c FROM sync_position_state WHERE account_id=$1`, [accountId])).rows[0]!.c, 0);

    // A sync whose batch is EMPTY still reconciles the ledger (the pending
    // question is answered from the FILLS, not the state table).
    await runHandler(pool, accountId, "asm-heal", [], 1);
    const trade = (await pool.query(`SELECT * FROM trades WHERE account_id=$1`, [accountId])).rows[0]!;
    assert.equal(trade.external_deal_id, "pos-HEAL");
    assert.equal(String(trade.net_pnl), "66.25");
    const st = (await pool.query(
      `SELECT state, trade_id FROM sync_position_state WHERE account_id=$1 AND position_id='HEAL'`, [accountId])).rows[0]!;
    assert.equal(st.state, "aggregated");
    assert.equal(String(st.trade_id), String(trade.id));
  });

  await t.test("concurrent imports of the same position converge to exactly one trade", async () => {
    const { accountId } = await seedAccount(pool, "asm-race");
    // Two handler instances racing on the SAME account+position. In production
    // the reservation serializes them, but the DATABASE must guarantee
    // convergence even if the lease is bypassed — the properties the UNIQUE
    // constraints own.
    const mk = () => createMetaApiSyncHandler({
      pool, platformToken: TOKEN, holder: "race", fetchImpl: stubFetch([
        inDeal("z-in", "PZ"), outDeal("z-out", "PZ", { profit: "7" }),
      ]),
    });
    const job = {
      id: "jr", attempts: 0,
      descriptor: { jobClass: "metaapi.sync-account", priorityClass: "sync", idempotencyKey: "kr",
        payload: { accountId, metaapiAccountId: "asm-race",
          from: "2026-01-01T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z" } },
    } as never;
    const results = await Promise.allSettled([mk()(job), mk()(job)]);
    // At most one holds the reservation; the other fails RESERVATION_HELD —
    // OR both ran and the database converged. Either way: ONE trade.
    const trades = await pool.query(`SELECT * FROM trades WHERE account_id=$1`, [accountId]);
    assert.equal(trades.rowCount, 1, "exactly one position trade no matter the interleaving");
    if (trades.rowCount === 1) {
      assert.equal(trades.rows[0]!.external_deal_id, "pos-PZ");
    }
    const evs = await pool.query(
      `SELECT count(*)::int c FROM trade_events e JOIN trades t ON t.id=e.trade_id WHERE t.account_id=$1`, [accountId]);
    assert.equal(evs.rows[0]!.c, 1, "exactly one TRADE_IMPORTED event");
    // The loser must be the classified RESERVATION_HELD rejection (or, if the
    // lease ever allows both, the database still converges — both assertions
    // above already proved that).
    assert.ok(results.every((r) => r.status === "fulfilled"
      || (r.status === "rejected"
        && ((r.reason as { code?: string })?.code === "RESERVATION_HELD"
          || /RESERVATION_HELD|already being synced/.test(String((r.reason as Error)?.message))))));
  });
});
