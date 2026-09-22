// PgTradeStore real-PostgreSQL battery — Phase D D2.
//
// EVIDENCE LABEL (Phase D policy): executes ONLY against a REAL, disposable
// PostgreSQL (DATABASE_URL — postgres-evidence workflow). Without it, every
// test is SKIPPED. This battery proves, on real PostgreSQL, the ADR-002
// ledger behaviors the direct-pg adapter implements:
//   - projection + event atomicity (same transaction)
//   - ownership isolation and tombstone semantics
//   - version CAS conflicts (TradeVersionConflictError)
//   - velora_apply_exit allocation + over-allocation → TradeOverAllocationError
//     with FULL rollback (no partial allocation/exit rows survive)
//   - exit tombstone + allocation decrement (cancelExit)
//   - NUMERIC(20,8)/(20,2) exact-string precision through the adapter (ADR-001)
//   - search filters/sort/pagination on the real planner
//   - concurrent mutations serialize correctly (FOR UPDATE + CAS + trigger)
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { prepareDatabase } from "./support/pgTestDb.ts";
import { PgTradeStore } from "../../apps/api/src/trades/pgTradeStore.ts";
import {
  TradeVersionConflictError,
  TradeOverAllocationError,
  TradeStoreError,
} from "../../apps/api/src/trades/tradeStore.ts";
import type { NewTrade, StoredTradeEvent, TradeRecord } from "../../apps/api/src/trades/tradeStore.ts";
import type { Pool } from "pg";

const PG_URL = process.env.DATABASE_URL;
const SKIP = PG_URL === undefined
  ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)"
  : false;

const T0 = new Date("2026-09-13T09:00:00.000Z");

async function harness(): Promise<{
  pool: Pool;
  store: PgTradeStore;
  owner: string;
  other: string;
  close: () => Promise<void>;
}> {
  const { Pool } = await import("pg");
  // Migrate (idempotent) and reset every application table, so the battery is
  // repeatable against a cluster previous runs have already used.
  await (await prepareDatabase(PG_URL as string)).close();
  const pool = new Pool({ connectionString: PG_URL });
  await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1,$2), ($3,$4) ON CONFLICT (email) DO NOTHING",
    ["pgtrade-owner@velora.test", "x", "pgtrade-other@velora.test", "y"],
  );
  const ids = await pool.query(
    "SELECT id, email FROM users WHERE email IN ($1, $2)",
    ["pgtrade-owner@velora.test", "pgtrade-other@velora.test"],
  );
  const byEmail = new Map<string, string>(ids.rows.map((r: { id: string; email: string }) => [r.email, String(r.id)]));
  return {
    pool,
    store: new PgTradeStore(pool),
    owner: byEmail.get("pgtrade-owner@velora.test")!,
    other: byEmail.get("pgtrade-other@velora.test")!,
    close: () => pool.end(),
  };
}

let uidCounter = 0;
const newEvent = (type: StoredTradeEvent["type"], expectedVersion: number, at: string = T0.toISOString()): StoredTradeEvent => ({
  eventUid: `pg-d2-${Date.now()}-${++uidCounter}`,
  tradeId: "",
  type,
  actor: "user",
  expectedVersion,
  payload: { probe: "pg-d2" },
  at,
});

function newTrade(userId: string, over: Partial<NewTrade> = {}): NewTrade {
  return {
    userId,
    accountId: null,
    symbol: "XAUUSD",
    direction: "buy",
    status: "CLOSED",
    entryPrice: "2350.50000000",
    exitPrice: "2361.25000000",
    volume: "1.00000000",
    contractSize: "100.00000000",
    commission: "7.00",
    swap: "-0.50",
    netPnl: "1050.00",
    rMultiple: "1.50000000",
    stopLoss: "2345.00000000",
    takeProfit: "2380.00000000",
    strategy: "breakout",
    emotion: "3",
    notes: "pg probe",
    openAtUtc: "2026-09-10T08:00:00.000Z",
    closeAtUtc: "2026-09-10T16:00:00.000Z",
    timeStatus: "resolved",
    sourceTimezone: "Asia/Tehran",
    sourceTimezoneSource: "user_config",
    sourceCalendar: "proleptic-gregorian",
    rawOpenText: null,
    rawCloseText: null,
    source: "manual",
    externalDealId: null,
    ...over,
  };
}

test("PG: createTrade inserts projection + TRADE_CREATED atomically, NUMERIC exact-string (ADR-001)", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const t = await h.store.createTrade(newTrade(h.owner), { ...newEvent("TRADE_CREATED", 0), tradeId: "0" });
    assert.match(t.id, /^\d+$/);
    assert.equal(t.version, 0);
    assert.equal(t.allocatedVolume, "0.00000000"); // NUMERIC(20,8) scale-padded string
    assert.equal(t.entryPrice, "2350.50000000");
    assert.equal(t.commission, "7.00"); // NUMERIC(20,2)
    assert.equal(t.netPnl, "1050.00");
    assert.equal(t.rMultiple, "1.50000000");
    assert.equal(t.createdAt, t.updatedAt); // same-transaction timestamps

    const events = await h.pool.query("SELECT type, actor, expected_version FROM trade_events WHERE trade_id = $1", [t.id]);
    assert.equal(events.rows.length, 1, "exactly the TRADE_CREATED event row");
    assert.equal(events.rows[0].type, "TRADE_CREATED");

    const found = await h.store.findActiveByIdForUser(t.id, h.owner);
    assert.notEqual(found, null);
    assert.equal(found!.id, t.id);
  } finally {
    await h.close();
  }
});

test("PG: ownership isolation + tombstone semantics (never a physical DELETE)", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const t = await h.store.createTrade(newTrade(h.owner), { ...newEvent("TRADE_CREATED", 0), tradeId: "0" });
    assert.equal(await h.store.findActiveByIdForUser(t.id, h.other), null, "foreign user sees null");

    const tomb = await h.store.tombstone(t.id, h.owner, newEvent("TOMBSTONE_SET", 0));
    assert.notEqual(tomb, null);
    assert.notEqual(tomb!.deletedAt, null);
    assert.equal(tomb!.version, 1);
    assert.equal(await h.store.findActiveByIdForUser(t.id, h.owner), null, "tombstoned trade is not active");
    // second tombstone → null (already tombstoned)
    assert.equal(await h.store.tombstone(t.id, h.owner, newEvent("TOMBSTONE_SET", 1)), null);

    const row = await h.pool.query("SELECT deleted_at IS NOT NULL AS d, version FROM trades WHERE id = $1", [t.id]);
    assert.equal(row.rows[0].d, true, "row still physically present (ADR-002 tombstone law)");
    assert.equal(Number(row.rows[0].version), 1, "int8 version arrives as string (S3) — compare numerically");
    const events = await h.pool.query("SELECT type FROM trade_events WHERE trade_id = $1 ORDER BY id", [t.id]);
    assert.equal(events.rows.length, 2, "projection + TOMBSTONE_SET events");
  } finally {
    await h.close();
  }
});

test("PG: version CAS — stale expectedVersion → TradeVersionConflictError, no event written", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const t = await h.store.createTrade(newTrade(h.owner), { ...newEvent("TRADE_CREATED", 0), tradeId: "0" });
    // first edit succeeds (version 0 → 1)
    const first = await h.store.editJournaling(t.id, h.owner, { notes: "v1" }, newEvent("JOURNALING_EDITED", 0));
    assert.notEqual(first, null);
    assert.equal(first!.version, 1);
    assert.equal(first!.notes, "v1");
    // stale CAS (version 0 against a trade now at 1) must conflict
    await assert.rejects(
      h.store.editJournaling(t.id, h.owner, { notes: "stale" }, newEvent("JOURNALING_EDITED", 0)),
      (e: unknown) => e instanceof TradeVersionConflictError,
    );
    const events = await h.pool.query("SELECT type FROM trade_events WHERE trade_id = $1 ORDER BY id", [t.id]);
    assert.equal(events.rows.length, 2, "conflicting edit appended NO event (tx rolled back)");
    assert.equal((await h.store.findActiveByIdForUser(t.id, h.owner))!.notes, "v1");
  } finally {
    await h.close();
  }
});

test("PG: journaling null-clear law — explicit null clears, absent keeps", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const t = await h.store.createTrade(newTrade(h.owner), { ...newEvent("TRADE_CREATED", 0), tradeId: "0" });
    const cleared = await h.store.editJournaling(t.id, h.owner, { strategy: null, emotion: null }, newEvent("JOURNALING_EDITED", 0));
    assert.notEqual(cleared, null);
    assert.equal(cleared!.strategy, null, "explicit null CLEARS strategy");
    assert.equal(cleared!.emotion, null);
    assert.equal(cleared!.notes, "pg probe", "absent patch key keeps the old value");
    const kept = await h.store.editJournaling(t.id, h.owner, { notes: "only notes" }, newEvent("JOURNALING_EDITED", 1));
    assert.equal(kept!.strategy, null, "still cleared");
    assert.equal(kept!.notes, "only notes");
  } finally {
    await h.close();
  }
});

test("PG: recordExit — allocation increments via trigger, version bumps, event appends", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const t = await h.store.createTrade(newTrade(h.owner), { ...newEvent("TRADE_CREATED", 0), tradeId: "0" });
    const exit = await h.store.recordExit(
      t.id, h.owner,
      { exitType: "partial", exitPrice: "2355.00000000", volume: "0.40000000", pnl: "160.00", exitedAt: "2026-09-10T12:00:00.000Z", notes: "half" },
      newEvent("EXIT_RECORDED", 0),
    );
    assert.equal(exit.exitType, "partial");
    assert.equal(exit.volume, "0.40000000");
    assert.equal(exit.pnl, "160.00");
    assert.equal(exit.deletedAt, null);

    const after = await h.store.findActiveByIdForUser(t.id, h.owner);
    assert.equal(after!.allocatedVolume, "0.40000000", "velora_apply_exit incremented allocation");
    assert.equal(after!.version, 1);

    const exits = await h.store.listActiveExitsForTrade(t.id, h.owner);
    assert.equal(exits.length, 1);
    assert.deepEqual(await h.store.listActiveExitsForTrade(t.id, h.other), [], "ownership-scoped exit listing");
    const byId = await h.store.findActiveExitByIdForUser(exit.id, h.owner);
    assert.notEqual(byId, null);
    assert.equal(await h.store.findActiveExitByIdForUser(exit.id, h.other), null);
  } finally {
    await h.close();
  }
});

test("PG: over-allocation → TradeOverAllocationError with FULL atomic rollback", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const t = await h.store.createTrade(newTrade(h.owner, { volume: "1.00000000" }), { ...newEvent("TRADE_CREATED", 0), tradeId: "0" });
    await h.store.recordExit(
      t.id, h.owner,
      { exitType: "partial", exitPrice: "2355.00000000", volume: "0.60000000", pnl: "160.00", exitedAt: "2026-09-10T12:00:00.000Z", notes: null },
      newEvent("EXIT_RECORDED", 0),
    );
    // 0.6 + 0.6 > 1.0 → trigger rejects; the whole tx must roll back
    await assert.rejects(
      h.store.recordExit(
        t.id, h.owner,
        { exitType: "manual", exitPrice: "2356.00000000", volume: "0.60000000", pnl: "20.00", exitedAt: "2026-09-10T13:00:00.000Z", notes: null },
        newEvent("EXIT_RECORDED", 1),
      ),
      (e: unknown) => e instanceof TradeOverAllocationError,
    );
    const after = await h.store.findActiveByIdForUser(t.id, h.owner);
    assert.equal(after!.allocatedVolume, "0.60000000", "allocation unchanged (rollback)");
    assert.equal(after!.version, 1, "version unchanged (rollback)");
    const exits = await h.store.listActiveExitsForTrade(t.id, h.owner);
    assert.equal(exits.length, 1, "no partial exit row survived (rollback)");
    const events = await h.pool.query("SELECT type FROM trade_events WHERE trade_id = $1 ORDER BY id", [t.id]);
    assert.equal(events.rows.length, 2, "no EXIT_RECORDED event for the rejected exit (rollback)");
  } finally {
    await h.close();
  }
});

test("PG: cancelExit — exit tombstone + allocation decrement + version bump, atomically", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const t = await h.store.createTrade(newTrade(h.owner), { ...newEvent("TRADE_CREATED", 0), tradeId: "0" });
    const exit = await h.store.recordExit(
      t.id, h.owner,
      { exitType: "partial", exitPrice: "2355.00000000", volume: "0.40000000", pnl: "160.00", exitedAt: "2026-09-10T12:00:00.000Z", notes: null },
      newEvent("EXIT_RECORDED", 0),
    );
    const cancelled = await h.store.cancelExit(exit.id, h.owner, newEvent("EXIT_CANCELLED", 1));
    assert.notEqual(cancelled, null);
    assert.notEqual(cancelled!.deletedAt, null, "exit tombstoned, never deleted");
    const after = await h.store.findActiveByIdForUser(t.id, h.owner);
    assert.equal(after!.allocatedVolume, "0.00000000", "allocation decremented");
    assert.equal(after!.version, 2);
    assert.equal(await h.store.findActiveExitByIdForUser(exit.id, h.owner), null);
    const physical = await h.pool.query("SELECT deleted_at IS NOT NULL AS d FROM trade_exits WHERE id = $1", [exit.id]);
    assert.equal(physical.rows[0].d, true, "exit row physically present (tombstone law)");
    // second cancel → null
    assert.equal(await h.store.cancelExit(exit.id, h.owner, newEvent("EXIT_CANCELLED", 2)), null);
  } finally {
    await h.close();
  }
});

test("PG: searchTrades — filters, journal q, sort whitelist, pagination total", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    // Fresh dedicated user: search totals must be immune to the trades that
    // earlier tests in this file created for the shared owner (run-series
    // lesson — never assert absolute totals on a user with prior state).
    const u = await h.pool.query(
      "INSERT INTO users (email, password_hash) VALUES ($1, 'x') " +
        "ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id",
      ["pgtrade-search@velora.test"],
    );
    const searcher = String(u.rows[0].id);
    const mk = async (symbol: string, strategy: string, notes: string, open: string): Promise<TradeRecord> => {
      const t = await h.store.createTrade(
        newTrade(searcher, { symbol, strategy, notes, openAtUtc: open }),
        { ...newEvent("TRADE_CREATED", 0), tradeId: "0" },
      );
      return t;
    };
    await mk("EURUSD", "breakout", "euro probe", "2026-09-01T08:00:00.000Z");
    await mk("GBPUSD", "reversal", "pound probe", "2026-09-02T08:00:00.000Z");
    await mk("EURJPY", "breakout", "carry probe", "2026-09-03T08:00:00.000Z");
    // foreign-user noise must never leak
    await h.store.createTrade(newTrade(h.other, { symbol: "EURUSD" }), { ...newEvent("TRADE_CREATED", 0), tradeId: "0" });

    const all = await h.store.searchTrades({ userId: searcher }, 1, 50);
    assert.equal(all.total, 3);

    const sym = await h.store.searchTrades({ userId: searcher, symbol: "eur" }, 1, 50); // contains, case-insensitive
    assert.equal(sym.total, 2);
    assert.deepEqual(sym.items.map((t) => t.symbol), ["EURJPY", "EURUSD"]); // default sort: open_time DESC

    const q = await h.store.searchTrades({ userId: searcher, q: "pound" }, 1, 50); // journal contains
    assert.equal(q.total, 1);
    assert.equal(q.items[0]!.symbol, "GBPUSD");

    const range = await h.store.searchTrades({ userId: searcher, from: "2026-09-02T00:00:00.000Z", to: "2026-09-10T23:59:59.000Z" }, 1, 50);
    assert.equal(range.total, 2, "from/to window on open/close instants");

    const byPnl = await h.store.searchTrades({ userId: searcher, sort: "profit_loss" }, 1, 50);
    assert.equal(byPnl.total, 3); // whitelist sort executes on the real planner

    const page = await h.store.searchTrades({ userId: searcher }, 2, 2);
    assert.equal(page.total, 3);
    assert.equal(page.items.length, 1, "pagination window (page 2 of size 2)");
    assert.equal(page.items[0]!.symbol, "EURUSD");
  } finally {
    await h.close();
  }
});

test("PG: CONCURRENT recordExit — row lock + CAS serialize: one winner, no over-allocation, no lost event", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const t = await h.store.createTrade(newTrade(h.owner, { volume: "1.00000000" }), { ...newEvent("TRADE_CREATED", 0), tradeId: "0" });
    // Two exits of 0.7 each (sum 1.4 > 1.0) with the SAME expectedVersion,
    // launched concurrently: exactly one may land; the other must be rejected
    // (version conflict or over-allocation — both correct) with zero partial state.
    const results = await Promise.allSettled([
      h.store.recordExit(
        t.id, h.owner,
        { exitType: "partial", exitPrice: "2355.00000000", volume: "0.70000000", pnl: "100.00", exitedAt: "2026-09-10T12:00:00.000Z", notes: null },
        newEvent("EXIT_RECORDED", 0),
      ),
      h.store.recordExit(
        t.id, h.owner,
        { exitType: "partial", exitPrice: "2356.00000000", volume: "0.70000000", pnl: "120.00", exitedAt: "2026-09-10T12:30:00.000Z", notes: null },
        newEvent("EXIT_RECORDED", 0),
      ),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(ok.length, 1, "exactly one concurrent exit lands");
    assert.equal(rejected.length, 1);
    const reason = rejected[0]!.reason as Error;
    assert.ok(
      reason instanceof TradeVersionConflictError || reason instanceof TradeOverAllocationError,
      `loser must be a domain conflict error, got: ${reason.constructor.name}: ${reason.message}`,
    );
    const after = await h.store.findActiveByIdForUser(t.id, h.owner);
    assert.equal(after!.allocatedVolume, "0.70000000");
    assert.equal(after!.version, 1);
    assert.equal((await h.store.listActiveExitsForTrade(t.id, h.owner)).length, 1);
    const events = await h.pool.query("SELECT type FROM trade_events WHERE trade_id = $1 ORDER BY id", [t.id]);
    assert.equal(events.rows.length, 2, "TRADE_CREATED + exactly one EXIT_RECORDED");
  } finally {
    await h.close();
  }
});

test("PG: CONCURRENT editJournaling — exactly one CAS winner", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const t = await h.store.createTrade(newTrade(h.owner), { ...newEvent("TRADE_CREATED", 0), tradeId: "0" });
    const results = await Promise.allSettled([
      h.store.editJournaling(t.id, h.owner, { notes: "winner-a" }, newEvent("JOURNALING_EDITED", 0)),
      h.store.editJournaling(t.id, h.owner, { notes: "winner-b" }, newEvent("JOURNALING_EDITED", 0)),
      h.store.editJournaling(t.id, h.owner, { notes: "winner-c" }, newEvent("JOURNALING_EDITED", 0)),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    assert.equal(ok.length, 1, "exactly one concurrent edit wins the CAS");
    for (const r of results.filter((r) => r.status === "rejected")) {
      assert.ok(r.reason instanceof TradeVersionConflictError);
    }
    const after = await h.store.findActiveByIdForUser(t.id, h.owner);
    assert.equal(after!.version, 1);
    const events = await h.pool.query("SELECT type FROM trade_events WHERE trade_id = $1 ORDER BY id", [t.id]);
    assert.equal(events.rows.length, 2, "one JOURNALING_EDITED event only");
  } finally {
    await h.close();
  }
});

test("PG: trade-store errors are domain errors, not driver leaks", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const t = await h.store.createTrade(newTrade(h.owner), { ...newEvent("TRADE_CREATED", 0), tradeId: "0" });
    // non-existent trade → TradeStoreError (service maps to 404), not raw pg
    await assert.rejects(
      h.store.recordExit("999999999", h.owner,
        { exitType: "manual", exitPrice: "1.00000000", volume: "0.10000000", pnl: "0.00", exitedAt: T0.toISOString(), notes: null },
        newEvent("EXIT_RECORDED", 0)),
      (e: unknown) => e instanceof TradeStoreError && !(e instanceof TradeOverAllocationError),
    );
    // foreign-owned trade id → same not-found shape (no disclosure)
    await assert.rejects(
      h.store.recordExit(t.id, h.other,
        { exitType: "manual", exitPrice: "1.00000000", volume: "0.10000000", pnl: "0.00", exitedAt: T0.toISOString(), notes: null },
        newEvent("EXIT_RECORDED", 0)),
      (e: unknown) => e instanceof TradeStoreError && !(e instanceof TradeOverAllocationError),
    );
  } finally {
    await h.close();
  }
});
