// Trades persistence-boundary integration tests — Phase C increment 3.
//
// EVIDENCE LABEL (test honesty rule): real application boundary (TradeService
// → TradeStore port) against a DISPOSABLE PGlite instance (PostgreSQL
// semantics in-wasm) with the real migrations 0001–0005 applied. This is
// PGlite evidence — NOT real PostgreSQL, NOT production. True multi-client
// transactional guarantees (row locks under concurrency) remain Phase D; the
// store uses engine.transaction for statement atomicity within the single
// PGlite session and re-checks version/ownership on every mutation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createEngine, migrate, type MigrationEngine } from "../migrate.ts";
import { TradeService, TradeError } from "../../apps/api/src/trades/tradeService.ts";
import { fold, type LedgerEvent } from "@velora/domain";
import type {
  TradeStore, TradeRecord, NewTrade, NewTradeExit, StoredTradeEvent, TradeSearchFilter,
} from "../../apps/api/src/trades/tradeStore.ts";
import {
  TradeVersionConflictError, TradeOverAllocationError, TradeStoreError,
} from "../../apps/api/src/trades/tradeStore.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

/* ---------------- PGlite TradeStore (test-local, PostgreSQL dialect) ---------------- */

interface TradeRow {
  id: string | bigint; user_id: string | bigint; account_id: string | bigint | null;
  symbol: string; direction: string; status: string;
  entry_price: string; exit_price: string | null; volume: string; contract_size: string;
  commission: string; swap: string; net_pnl: string | null; r_multiple: string | null;
  stop_loss: string | null; take_profit: string | null;
  strategy: string | null; emotion: string | null; notes: string | null;
  allocated_volume: string; version: string | bigint; deleted_at: Date | string | null;
  occurred_open_at_utc: Date | string; occurred_close_at_utc: Date | string;
  time_status: string; source_timezone: string | null; source_timezone_source: string;
  source_calendar: string; raw_open_text: string | null; raw_close_text: string | null;
  source: string; created_at: Date | string; updated_at: Date | string;
}
interface ExitRow {
  id: string | bigint; trade_id: string | bigint; exit_type: string;
  price: string; volume: string; pnl: string | null; notes: string | null;
  exited_at: Date | string; recorded_at: Date | string; deleted_at: Date | string | null;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function mapTrade(r: TradeRow): TradeRecord {
  return {
    id: String(r.id), userId: String(r.user_id), accountId: r.account_id === null ? null : String(r.account_id),
    symbol: r.symbol, direction: r.direction as TradeRecord["direction"], status: r.status as TradeRecord["status"],
    entryPrice: r.entry_price, exitPrice: r.exit_price, volume: r.volume, contractSize: r.contract_size,
    commission: r.commission, swap: r.swap, netPnl: r.net_pnl, rMultiple: r.r_multiple,
    stopLoss: r.stop_loss, takeProfit: r.take_profit,
    strategy: r.strategy, emotion: r.emotion, notes: r.notes,
    allocatedVolume: r.allocated_volume, version: Number(r.version), deletedAt: r.deleted_at === null ? null : iso(r.deleted_at),
    openAtUtc: iso(r.occurred_open_at_utc), closeAtUtc: iso(r.occurred_close_at_utc),
    timeStatus: r.time_status as TradeRecord["timeStatus"],
    sourceTimezone: r.source_timezone, sourceTimezoneSource: r.source_timezone_source,
    sourceCalendar: r.source_calendar, rawOpenText: r.raw_open_text, rawCloseText: r.raw_close_text,
    source: r.source as TradeRecord["source"], createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

class PgliteTradeStore implements TradeStore {
  constructor(private readonly engine: MigrationEngine) {
    if (engine.transaction === undefined) throw new Error("engine.transaction required (PGlite)");
  }

  private async tx<T>(fn: (q: MigrationEngine["query"]) => Promise<T>): Promise<T> {
    return this.engine.transaction!(async (tx) => fn(tx.query));
  }

  async createTrade(record: NewTrade, event: StoredTradeEvent): Promise<TradeRecord> {
    return this.tx(async (q) => {
      const t = (await q(
        `INSERT INTO trades (user_id, account_id, symbol, direction, status,
           entry_price, exit_price, volume, contract_size, commission, swap, net_pnl, r_multiple,
           stop_loss, take_profit, strategy, emotion, notes, occurred_at,
           occurred_open_at_utc, occurred_close_at_utc, time_status, source_timezone,
           source_timezone_source, source_calendar, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
         RETURNING *`,
        [record.userId, record.accountId, record.symbol, record.direction, record.status,
         record.entryPrice, record.exitPrice, record.volume, record.contractSize,
         record.commission, record.swap, record.netPnl, record.rMultiple,
         record.stopLoss, record.takeProfit, record.strategy, record.emotion, record.notes,
         record.openAtUtc, record.openAtUtc, record.closeAtUtc, record.timeStatus,
         record.sourceTimezone, record.sourceTimezoneSource, record.sourceCalendar, record.source],
      )).rows[0] as unknown as TradeRow;
      await q(
        `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [event.eventUid, t.id, event.type, event.actor, event.expectedVersion,
         JSON.stringify(event.payload), event.at],
      );
      return mapTrade(t);
    });
  }

  async findActiveByIdForUser(id: string, userId: string): Promise<TradeRecord | null> {
    const rows = (await this.engine.query(
      "SELECT * FROM trades WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL", [id, userId],
    )).rows as unknown as TradeRow[];
    return rows.length === 0 ? null : mapTrade(rows[0]!);
  }

  async searchTrades(filter: TradeSearchFilter, page: number, limit: number): Promise<{ items: TradeRecord[]; total: number }> {
    const where: string[] = ["user_id = $1", "deleted_at IS NULL"];
    const params: unknown[] = [filter.userId];
    if (filter.symbol !== undefined) {
      params.push(filter.symbol.toUpperCase().replace(/([%_\\])/g, "\\$1"));
      where.push(`UPPER(symbol) LIKE '%' || $${params.length} || '%' ESCAPE '\\'`);
    }
    if (filter.direction !== undefined) { params.push(filter.direction); where.push(`direction = $${params.length}`); }
    if (filter.from !== undefined) { params.push(filter.from); where.push(`occurred_open_at_utc >= $${params.length}`); }
    if (filter.to !== undefined) { params.push(filter.to); where.push(`occurred_close_at_utc <= $${params.length}`); }
    const whereSql = where.join(" AND ");
    const total = Number((await this.engine.query(
      `SELECT COUNT(*)::int AS n FROM trades WHERE ${whereSql}`, params,
    )).rows[0]!.n);
    const items = (await this.engine.query(
      `SELECT * FROM trades WHERE ${whereSql} ORDER BY occurred_open_at_utc DESC, id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params,
    )).rows as unknown as TradeRow[];
    return { items: items.map(mapTrade), total };
  }

  async listSymbols(userId: string): Promise<string[]> {
    return (await this.engine.query(
      "SELECT DISTINCT symbol FROM trades WHERE user_id = $1 AND deleted_at IS NULL ORDER BY symbol", [userId],
    )).rows.map((r) => String(r.symbol));
  }

  /** Load the mutable parent under lock; classify null vs version-conflict. */
  private async lockedParent(q: MigrationEngine["query"], id: string, userId: string, expectedVersion: number): Promise<TradeRow | null> {
    const rows = (await q(
      "SELECT * FROM trades WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE", [id, userId],
    )).rows as unknown as TradeRow[];
    if (rows.length === 0) return null;
    if (Number(rows[0]!.version) !== expectedVersion) {
      throw new TradeVersionConflictError(`expected version ${expectedVersion} but trade is at ${rows[0]!.version}`);
    }
    return rows[0]!;
  }

  async editJournaling(id: string, userId: string, patch: { strategy?: string | null; emotion?: string | null; notes?: string | null }, event: StoredTradeEvent): Promise<TradeRecord | null> {
    return this.tx(async (q) => {
      const parent = await this.lockedParent(q, id, userId, event.expectedVersion);
      if (parent === null) return null;
      const updated = (await q(
        `UPDATE trades SET strategy = $1, emotion = $2, notes = $3, version = version + 1, updated_at = $4
         WHERE id = $5 AND version = $6 RETURNING *`,
        [patch.strategy ?? parent.strategy, patch.emotion ?? parent.emotion, patch.notes ?? parent.notes,
         event.at, id, event.expectedVersion],
      )).rows[0] as unknown as TradeRow;
      await q(
        `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [event.eventUid, id, event.type, event.actor, event.expectedVersion, JSON.stringify(event.payload), event.at],
      );
      return mapTrade(updated);
    });
  }

  async tombstone(id: string, userId: string, event: StoredTradeEvent): Promise<TradeRecord | null> {
    return this.tx(async (q) => {
      const parent = await this.lockedParent(q, id, userId, event.expectedVersion);
      if (parent === null) return null;
      const updated = (await q(
        `UPDATE trades SET deleted_at = $1, version = version + 1, updated_at = $1
         WHERE id = $2 AND version = $3 RETURNING *`,
        [event.at, id, event.expectedVersion],
      )).rows[0] as unknown as TradeRow;
      await q(
        `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [event.eventUid, id, event.type, event.actor, event.expectedVersion, JSON.stringify(event.payload), event.at],
      );
      return mapTrade(updated);
    });
  }

  async recordExit(tradeId: string, userId: string, exit: NewTradeExit, event: StoredTradeEvent): Promise<{ id: string; tradeId: string; exitType: NewTradeExit["exitType"]; exitPrice: string; volume: string; pnl: string; exitedAt: string; notes: string | null; recordedAt: string; deletedAt: null }> {
    try {
      return await this.tx(async (q) => {
        const parent = await this.lockedParent(q, tradeId, userId, event.expectedVersion);
        if (parent === null) throw new TradeStoreError("trade not found");
        let inserted: ExitRow;
        try {
          inserted = (await q(
            `INSERT INTO trade_exits (trade_id, exit_type, volume, price, pnl, notes, exited_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [tradeId, exit.exitType, exit.volume, exit.exitPrice, exit.pnl, exit.notes, exit.exitedAt],
          )).rows[0] as unknown as ExitRow; // velora_apply_exit trigger enforces allocation
        } catch (err) {
          if (/over-allocation/i.test(String(err))) throw new TradeOverAllocationError("cumulative exit volume exceeds the trade volume");
          throw err;
        }
        await q("UPDATE trades SET version = version + 1, updated_at = $1 WHERE id = $2 AND version = $3",
          [event.at, tradeId, event.expectedVersion]);
        await q(
          `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload, at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [event.eventUid, tradeId, event.type, event.actor, event.expectedVersion, JSON.stringify(event.payload), event.at],
        );
        return {
          id: String(inserted.id), tradeId, exitType: inserted.exit_type as NewTradeExit["exitType"],
          exitPrice: inserted.price, volume: inserted.volume, pnl: inserted.pnl ?? exit.pnl,
          exitedAt: iso(inserted.exited_at), notes: inserted.notes,
          recordedAt: iso(inserted.recorded_at), deletedAt: null,
        };
      });
    } catch (err) {
      if (err instanceof TradeStoreError && /not found/.test(err.message)) {
        // not-found races surface as null-equivalent; the service already 404s
        throw err;
      }
      throw err;
    }
  }

  async listActiveExitsForTrade(tradeId: string, userId: string): Promise<Array<{ id: string; tradeId: string; exitType: NewTradeExit["exitType"]; exitPrice: string; volume: string; pnl: string; exitedAt: string; notes: string | null; recordedAt: string; deletedAt: null }>> {
    const parent = await this.findActiveByIdForUser(tradeId, userId);
    if (parent === null) return [];
    return (await this.engine.query(
      "SELECT * FROM trade_exits WHERE trade_id = $1 AND deleted_at IS NULL ORDER BY exited_at ASC, id ASC", [tradeId],
    )).rows.map((r) => {
      const e = r as unknown as ExitRow;
      return {
        id: String(e.id), tradeId, exitType: e.exit_type as NewTradeExit["exitType"],
        exitPrice: e.price, volume: e.volume, pnl: e.pnl ?? "0.00",
        exitedAt: iso(e.exited_at), notes: e.notes, recordedAt: iso(e.recorded_at), deletedAt: null,
      };
    });
  }

  async findActiveExitByIdForUser(exitId: string, userId: string): Promise<{ id: string; tradeId: string; exitType: NewTradeExit["exitType"]; exitPrice: string; volume: string; pnl: string; exitedAt: string; notes: string | null; recordedAt: string; deletedAt: null } | null> {
    const rows = (await this.engine.query(
      `SELECT e.* FROM trade_exits e JOIN trades t ON t.id = e.trade_id
       WHERE e.id = $1 AND t.user_id = $2 AND e.deleted_at IS NULL AND t.deleted_at IS NULL`,
      [exitId, userId],
    )).rows as unknown as ExitRow[];
    if (rows.length === 0) return null;
    const e = rows[0]!;
    return {
      id: String(e.id), tradeId: String(e.trade_id), exitType: e.exit_type as NewTradeExit["exitType"],
      exitPrice: e.price, volume: e.volume, pnl: e.pnl ?? "0.00",
      exitedAt: iso(e.exited_at), notes: e.notes, recordedAt: iso(e.recorded_at), deletedAt: null,
    };
  }

  async cancelExit(exitId: string, userId: string, event: StoredTradeEvent): Promise<{ id: string; tradeId: string; exitType: NewTradeExit["exitType"]; exitPrice: string; volume: string; pnl: string; exitedAt: string; notes: string | null; recordedAt: string; deletedAt: string } | null> {
    return this.tx(async (q) => {
      const rows = (await q(
        `SELECT e.* FROM trade_exits e JOIN trades t ON t.id = e.trade_id
         WHERE e.id = $1 AND t.user_id = $2 AND e.deleted_at IS NULL AND t.deleted_at IS NULL FOR UPDATE OF e, t`,
        [exitId, userId],
      )).rows as unknown as ExitRow[];
      if (rows.length === 0) return null;
      const e = rows[0]!;
      const parent = await this.lockedParent(q, String(e.trade_id), userId, event.expectedVersion);
      if (parent === null) return null;
      await q("UPDATE trade_exits SET deleted_at = $1 WHERE id = $2", [event.at, exitId]);
      await q("UPDATE trades SET allocated_volume = allocated_volume - $1, version = version + 1, updated_at = $2 WHERE id = $3 AND version = $4",
        [e.volume, event.at, e.trade_id, event.expectedVersion]);
      await q(
        `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [event.eventUid, e.trade_id, event.type, event.actor, event.expectedVersion, JSON.stringify(event.payload), event.at],
      );
      return {
        id: String(e.id), tradeId: String(e.trade_id), exitType: e.exit_type as NewTradeExit["exitType"],
        exitPrice: e.price, volume: e.volume, pnl: e.pnl ?? "0.00",
        exitedAt: iso(e.exited_at), notes: e.notes, recordedAt: iso(e.recorded_at), deletedAt: event.at,
      };
    });
  }

  /** Test introspection: raw event log for the replay property. */
  async rawEvents(tradeId: string): Promise<Array<{ type: string; actor: string; expected_version: number; payload: unknown }>> {
    return (await this.engine.query(
      "SELECT type, actor, expected_version, payload FROM trade_events WHERE trade_id = $1 ORDER BY id", [tradeId],
    )).rows as Array<{ type: string; actor: string; expected_version: number; payload: unknown }>;
  }
}

/* ---------------- harness ---------------- */

const OWNER = "1";
const OTHER = "2";

async function freshHarness(): Promise<{
  engine: MigrationEngine; store: PgliteTradeStore; svc: TradeService; close: () => Promise<void>;
}> {
  const engine = await createEngine();
  const ran = await migrate(engine, MIGRATIONS);
  assert.ok(ran.includes("0005_trades_api_contract.sql"));
  await engine.query("INSERT INTO users (email, password_hash) VALUES ($1,$2), ($3,$4)",
    ["owner@velora.example", "x", "other@velora.example", "y"]);
  const store = new PgliteTradeStore(engine);
  let uid = 0;
  const svc = new TradeService({
    store,
    getUserTimezone: async (userId) => (userId === OWNER ? "Asia/Tehran" : "UTC"),
    verifyAccountOwnership: async () => false,
    now: () => new Date("2026-09-12T12:00:00.000Z"),
    newEventUid: () => `evt-${++uid}`,
  });
  return { engine, store, svc, close: () => engine.close() };
}

const VECTOR_A = {
  symbol: "EURUSD", direction: "buy", entryPrice: "1.1000", exitPrice: "1.1050",
  volume: "1.0", contractSize: "100000", commission: "5.00", swap: "1.50", stopLoss: "1.0970",
  openTime: "2026-09-10 10:00:00", closeTime: "2026-09-10 12:00:00",
  strategyTag: "Breakout", emotionalScore: 4, notes: "Clean H1 breakout trade",
};

/* ---------------- tests ---------------- */

test("PGlite: migration 0005 schema contract (columns, CHECKs, EXIT_CANCELLED widening)", async () => {
  const h = await freshHarness();
  try {
    const cols = (await h.engine.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'trades' AND column_name IN
       ('occurred_open_at_utc','occurred_close_at_utc','time_status','source_timezone',
        'source_timezone_source','source_calendar','raw_open_text','raw_close_text','source')`,
    )).rows.map((r) => String(r.column_name));
    assert.equal(cols.length, 9); // every ADD COLUMN landed (no silent no-op)
    const ts = (await h.engine.query(
      "SELECT data_type FROM information_schema.columns WHERE table_name='trades' AND column_name='occurred_open_at_utc'",
    )).rows[0]!;
    assert.equal(ts.data_type, "timestamp with time zone"); // ADR-004

    // event vocabulary widened, still closed (FK requires a real parent trade)
    const tradeId = String((await h.engine.query(
      `INSERT INTO trades (user_id, symbol, direction, entry_price, volume, occurred_at)
       VALUES (1, 'EURUSD', 'buy', '1.10000000', '1.00000000', now()) RETURNING id`,
    )).rows[0]!.id);
    await h.engine.query(
      `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload)
       VALUES ('uid-1', $1, 'EXIT_CANCELLED', 'user', 0, '{}')`, [tradeId],
    );
    await assert.rejects(
      h.engine.query(
        `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload)
         VALUES ('uid-2', $1, 'BOGUS_EVENT', 'user', 0, '{}')`, [tradeId],
      ),
      /check constraint/i,
    );

    const exitCols = (await h.engine.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='trade_exits'
       AND column_name IN ('exit_type','pnl','notes','exited_at','deleted_at')`,
    )).rows.map((r) => String(r.column_name));
    assert.equal(exitCols.length, 5);
    await assert.rejects(
      h.engine.query("INSERT INTO trade_exits (trade_id, exit_type, volume, price) VALUES ($1, 'limit', '0.1', '1.0')", [tradeId]),
      /check constraint/i,
    );
    await assert.rejects(
      h.engine.query("INSERT INTO trades (user_id, symbol, direction, entry_price, volume, occurred_at, source) VALUES (1,'X','buy',1,1,now(),'telepathy')"),
      /check constraint/i,
    );
  } finally {
    await h.close();
  }
});

test("PGlite: full ownership-scoped ledger lifecycle through the service", async () => {
  const h = await freshHarness();
  try {
    const t = (await h.svc.createTrade(OWNER, VECTOR_A)) as Record<string, unknown>;
    const id = t.id as string;
    assert.equal(t.profitLoss, "493.5");
    assert.equal(t.openTime, "2026-09-10T06:30:00.000Z"); // Asia/Tehran +03:30 (ADR-004)
    assert.equal(t.timeStatus, "resolved");

    // read + search
    assert.equal(((await h.svc.getTrade(id, OWNER)) as Record<string, unknown>).id, id);
    const search = (await h.svc.searchTrades(OWNER, { symbol: "eur" })) as { items: unknown[]; pagination: Record<string, number> };
    assert.equal(search.items.length, 1);
    assert.equal(search.pagination.total, 1);

    // journaling correction (event + version)
    const edited = (await h.svc.updateTrade(id, OWNER, { notes: "reviewed" })) as Record<string, unknown>;
    assert.equal(edited.version, 1);
    assert.equal(edited.profitLoss, "493.5");

    // optimistic concurrency is enforced by the store CAS
    await assert.rejects(h.svc.updateTrade(id, OWNER, { notes: "stale", version: 0 }), (e: unknown) => e instanceof TradeError && e.status === 409);

    // exits: allocation via trigger, cumulative cap, cancellation
    const e1 = (await h.svc.createExit(id, OWNER, { exitType: "tp", exitPrice: "1.1030", volume: "0.5", exitedAt: "2026-09-10 11:00:00" })) as { id: string };
    await assert.rejects(
      h.svc.createExit(id, OWNER, { exitType: "tp", exitPrice: "1.1040", volume: "0.6", exitedAt: "2026-09-10 11:30:00" }),
      (e: unknown) => e instanceof TradeError && e.status === 422,
    );
    const exits = (await h.svc.listExits(id, OWNER)) as { items: Array<Record<string, unknown>> };
    assert.equal(exits.items.length, 1);
    assert.equal(exits.items[0]!.pnl, "146.75"); // 150.00 gross − 2.50 commission − 0.75 swap (proportional, ×0.5)
    await h.svc.deleteExit(e1.id, OWNER);
    const reRecord = (await h.svc.createExit(id, OWNER, { exitType: "manual", exitPrice: "1.1050", volume: "0.6", exitedAt: "2026-09-10 11:45:00" })) as Record<string, unknown>;
    assert.equal(typeof reRecord.id, "string");

    // tombstone
    assert.deepEqual(await h.svc.deleteTrade(id, OWNER), { deleted: true });
    await assert.rejects(h.svc.getTrade(id, OWNER), (e: unknown) => e instanceof TradeError && e.status === 404);
    const after = (await h.svc.searchTrades(OWNER, {})) as { items: unknown[] };
    assert.equal(after.items.length, 0);

    // cross-user non-disclosure at the store level
    const other = (await h.svc.createTrade(OTHER, VECTOR_A)) as Record<string, unknown>;
    assert.equal(await h.store.findActiveByIdForUser(other.id as string, OWNER), null);
    assert.equal(await h.store.findActiveExitByIdForUser("1", OWNER), null);
  } finally {
    await h.close();
  }
});

test("PGlite: ADR-002 property — trades projection == fold(event replay)", async () => {
  const h = await freshHarness();
  try {
    const t = (await h.svc.createTrade(OWNER, VECTOR_A)) as Record<string, unknown>;
    const id = t.id as string;
    await h.svc.updateTrade(id, OWNER, { notes: "replay me", strategyTag: "Pullback" });
    await h.svc.createExit(id, OWNER, { exitType: "tp", exitPrice: "1.1030", volume: "0.25", exitedAt: "2026-09-10 11:00:00" });
    const e = (await h.svc.createExit(id, OWNER, { exitType: "manual", exitPrice: "1.1040", volume: "0.25", exitedAt: "2026-09-10 11:30:00" })) as { id: string };
    await h.svc.deleteExit(e.id, OWNER);
    await h.svc.deleteTrade(id, OWNER); // full life: create → edit → exit → cancel → tombstone

    const projection = await h.engine.query("SELECT * FROM trades WHERE id = $1", [id]);
    const row = projection.rows[0] as Record<string, unknown>;

    const events = await h.store.rawEvents(id);
    assert.equal(events.length, 6); // TRADE_CREATED, JOURNALING_EDITED, EXIT_RECORDED ×2, EXIT_CANCELLED, TOMBSTONE_SET
    assert.deepEqual(events.map((e) => e.type), ["TRADE_CREATED", "JOURNALING_EDITED", "EXIT_RECORDED", "EXIT_RECORDED", "EXIT_CANCELLED", "TOMBSTONE_SET"]);
    const replayed = events.map((ev, i) => {
      const payload = ev.payload as { event: LedgerEvent };
      const e2 = { ...payload.event, id: `replay-${i}` };
      if (e2.type === "TRADE_CREATED") e2.trade = { ...e2.trade, id }; // substitute the real id
      return e2 as LedgerEvent;
    });
    const { state } = fold(replayed);
    assert.ok(state);
    // financial + journaling + version + allocation + tombstone all derive from the log
    assert.equal(state!.financial.entryPrice, String(row.entry_price));
    assert.equal(state!.financial.netPnl ?? state!.financial.commission, String(row.commission));
    assert.equal(state!.journaling.notes, row.notes);
    assert.equal(state!.journaling.strategy, row.strategy);
    assert.equal(state!.version, Number(row.version));
    assert.equal(state!.allocatedVolume, String(row.allocated_volume));
    assert.ok(state!.deletedAt !== null && row.deleted_at !== null);
  } finally {
    await h.close();
  }
});

test("PGlite: DB-level allocation guard fires through the store (trigger)", async () => {
  const h = await freshHarness();
  try {
    const t = (await h.svc.createTrade(OWNER, { ...VECTOR_A, commission: "0", swap: "0", stopLoss: undefined })) as Record<string, unknown>;
    const id = t.id as string;
    const current = await h.store.findActiveByIdForUser(id, OWNER);
    await assert.rejects(
      h.store.recordExit(id, OWNER,
        { exitType: "manual", exitPrice: "1.2000", volume: "1.00000001", pnl: "0.00", exitedAt: "2026-09-10T07:00:00.000Z", notes: null },
        { eventUid: "evt-overflow", tradeId: id, type: "EXIT_RECORDED", actor: "user", expectedVersion: current!.version, payload: {}, at: "2026-09-12T12:00:00.000Z" }),
      (err: unknown) => {
        assert.ok(err instanceof TradeOverAllocationError || /over-allocation/i.test(String(err)), String(err));
        return true;
      },
    );
    // nothing was written: version unchanged, no event row
    const after = await h.store.findActiveByIdForUser(id, OWNER);
    assert.equal(after!.version, current!.version);
    assert.equal((await h.store.rawEvents(id)).length, 1); // only TRADE_CREATED
  } finally {
    await h.close();
  }
});
