// PgTradeStore — Phase D D2: the real-PostgreSQL TradeStore adapter (direct
// pg). SQL contract is the PGlite-evidenced implementation from
// db/tests/tradePersistence.test.ts (behavioral guidance per the D2 rule),
// preserving ADR-002 ledger semantics end to end:
//   - every mutation appends its trade_events row in the SAME transaction;
//   - mutations lock the parent projection with SELECT … FOR UPDATE and
//     classify CAS misses as TradeVersionConflictError;
//   - exit inserts run through the 0001 velora_apply_exit trigger; its
//     over-allocation exception maps to TradeOverAllocationError (message
//     match — the trigger raises a plain exception, no SQLSTATE to key on);
//   - deletes are tombstones (deleted_at), never physical DELETEs.
//
// PostgreSQL-specific divergences from the guidance adapter (documented, not
// blind translation):
//   - searchTrades parameterizes LIMIT/OFFSET ($n::int) instead of string
//     interpolation (same semantics, injection-proof by construction);
//   - multi-statement units run on one checked-out pool client via
//     withTransaction (BEGIN/COMMIT/ROLLBACK), the pg equivalent of the
//     engine.transaction guidance — VERIFIED on real PostgreSQL 16.15 (S6/S7).
//
// EVIDENCE: adapter battery = db/tests/pgTradeStore.pg.test.ts, executed only
// against a real disposable PostgreSQL (postgres-evidence workflow); the
// PGlite trade suite remains separate, in-wasm evidence.
import type { Pool } from "pg";
import { poolQuery, withTransaction, iso, isoOrNull, type QueryFn } from "../persistence/pg.js";
import type {
  TradeStore,
  TradeRecord,
  NewTrade,
  NewTradeExit,
  StoredTradeEvent,
  TradeSearchFilter,
  TradeExitRecord,
} from "./tradeStore.js";
import { TradeVersionConflictError, TradeOverAllocationError, TradeStoreError } from "./tradeStore.js";

interface TradeRow {
  id: string;
  user_id: string;
  account_id: string | null;
  symbol: string;
  direction: string;
  status: string;
  entry_price: string;
  exit_price: string | null;
  volume: string;
  contract_size: string;
  commission: string;
  swap: string;
  net_pnl: string | null;
  r_multiple: string | null;
  stop_loss: string | null;
  take_profit: string | null;
  strategy: string | null;
  emotion: string | null;
  notes: string | null;
  allocated_volume: string;
  version: string;
  deleted_at: Date | string | null;
  occurred_open_at_utc: Date | string | null;
  occurred_close_at_utc: Date | string | null;
  time_status: string;
  source_timezone: string | null;
  source_timezone_source: string;
  source_calendar: string;
  raw_open_text: string | null;
  raw_close_text: string | null;
  source: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ExitRow {
  id: string;
  trade_id: string;
  exit_type: string;
  price: string;
  volume: string;
  pnl: string | null;
  notes: string | null;
  exited_at: Date | string | null;
  recorded_at: Date | string;
  deleted_at: Date | string | null;
}

function mapTrade(r: TradeRow): TradeRecord {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    accountId: r.account_id === null ? null : String(r.account_id),
    symbol: r.symbol,
    direction: r.direction as TradeRecord["direction"],
    status: r.status as TradeRecord["status"],
    entryPrice: r.entry_price,
    exitPrice: r.exit_price,
    volume: r.volume,
    contractSize: r.contract_size,
    commission: r.commission,
    swap: r.swap,
    netPnl: r.net_pnl,
    rMultiple: r.r_multiple,
    stopLoss: r.stop_loss,
    takeProfit: r.take_profit,
    strategy: r.strategy,
    emotion: r.emotion,
    notes: r.notes,
    allocatedVolume: r.allocated_volume,
    version: Number(r.version),
    deletedAt: isoOrNull(r.deleted_at),
    openAtUtc: iso(r.occurred_open_at_utc as Date | string),
    closeAtUtc: iso(r.occurred_close_at_utc as Date | string),
    timeStatus: r.time_status as TradeRecord["timeStatus"],
    sourceTimezone: r.source_timezone,
    sourceTimezoneSource: r.source_timezone_source,
    sourceCalendar: r.source_calendar,
    rawOpenText: r.raw_open_text,
    rawCloseText: r.raw_close_text,
    source: r.source as TradeRecord["source"],
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function mapExit(r: ExitRow, fallbackPnl: string): TradeExitRecord {
  return {
    id: String(r.id),
    tradeId: String(r.trade_id),
    exitType: r.exit_type as TradeExitRecord["exitType"],
    exitPrice: r.price,
    volume: r.volume,
    pnl: r.pnl ?? fallbackPnl,
    exitedAt: iso(r.exited_at as Date | string),
    notes: r.notes,
    recordedAt: iso(r.recorded_at),
    deletedAt: isoOrNull(r.deleted_at),
  };
}

/** PHP-evidenced order whitelist -> SQL column (default open_time, Remote lineage). */
function sortColumn(sort: TradeSearchFilter["sort"]): string {
  if (sort === "close_time") return "occurred_close_at_utc";
  if (sort === "profit_loss") return "net_pnl";
  return "occurred_open_at_utc";
}

export class PgTradeStore implements TradeStore {
  private readonly q: QueryFn;

  constructor(private readonly pool: Pool) {
    this.q = poolQuery(pool);
  }

  async createTrade(record: NewTrade, event: StoredTradeEvent): Promise<TradeRecord> {
    return withTransaction(this.pool, async (q) => {
      const rows = await q(
        `INSERT INTO trades (user_id, account_id, symbol, direction, status,
           entry_price, exit_price, volume, contract_size, commission, swap, net_pnl, r_multiple,
           stop_loss, take_profit, strategy, emotion, notes, occurred_at,
           occurred_open_at_utc, occurred_close_at_utc, time_status, source_timezone,
           source_timezone_source, source_calendar, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
         RETURNING *`,
        [
          record.userId,
          record.accountId,
          record.symbol,
          record.direction,
          record.status,
          record.entryPrice,
          record.exitPrice,
          record.volume,
          record.contractSize,
          record.commission,
          record.swap,
          record.netPnl,
          record.rMultiple,
          record.stopLoss,
          record.takeProfit,
          record.strategy,
          record.emotion,
          record.notes,
          record.openAtUtc,
          record.openAtUtc,
          record.closeAtUtc,
          record.timeStatus,
          record.sourceTimezone,
          record.sourceTimezoneSource,
          record.sourceCalendar,
          record.source,
        ],
      );
      const t = rows[0];
      if (t === undefined) throw new TradeStoreError("createTrade: INSERT returned no row");
      await q(
        `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          event.eventUid,
          t.id,
          event.type,
          event.actor,
          event.expectedVersion,
          JSON.stringify(event.payload),
          event.at,
        ],
      );
      return mapTrade(t as unknown as TradeRow);
    });
  }

  async findActiveByIdForUser(id: string, userId: string): Promise<TradeRecord | null> {
    const rows = await this.q(
      "SELECT * FROM trades WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
      [id, userId],
    );
    return rows.length === 0 ? null : mapTrade(rows[0] as unknown as TradeRow);
  }

  async searchTrades(
    filter: TradeSearchFilter,
    page: number,
    limit: number,
  ): Promise<{ items: TradeRecord[]; total: number }> {
    const where: string[] = ["user_id = $1", "deleted_at IS NULL"];
    const params: unknown[] = [filter.userId];
    if (filter.symbol !== undefined) {
      params.push(filter.symbol.toUpperCase().replace(/([%_\\])/g, "\\$1"));
      where.push(`UPPER(symbol) LIKE '%' || $${params.length} || '%' ESCAPE '\\'`);
    }
    if (filter.direction !== undefined) {
      params.push(filter.direction);
      where.push(`direction = $${params.length}`);
    }
    if (filter.from !== undefined) {
      params.push(filter.from);
      where.push(`occurred_open_at_utc >= $${params.length}`);
    }
    if (filter.to !== undefined) {
      params.push(filter.to);
      where.push(`occurred_close_at_utc <= $${params.length}`);
    }
    if (filter.q !== undefined) {
      // Journal search (PHP evidence): symbol | strategy | notes, contains.
      params.push(filter.q.toUpperCase().replace(/([%_\\])/g, "\\$1"));
      where.push(
        `(UPPER(symbol) LIKE '%' || $${params.length} || '%' ESCAPE '\\' OR UPPER(strategy) LIKE '%' || $${params.length} || '%' ESCAPE '\\' OR UPPER(COALESCE(notes, '')) LIKE '%' || $${params.length} || '%' ESCAPE '\\')`,
      );
    }
    const whereSql = where.join(" AND ");
    const totalRows = await this.q(`SELECT COUNT(*)::int AS n FROM trades WHERE ${whereSql}`, params);
    const total = Number(totalRows[0]?.n ?? 0);
    // pg divergence: LIMIT/OFFSET parameterized (service-validated integers).
    params.push(limit, (page - 1) * limit);
    const items = await this.q(
      `SELECT * FROM trades WHERE ${whereSql} ORDER BY ${sortColumn(filter.sort)} DESC, id DESC
       LIMIT $${params.length - 1}::int OFFSET $${params.length}::int`,
      params,
    );
    return { items: items.map((r) => mapTrade(r as unknown as TradeRow)), total };
  }

  async listSymbols(userId: string): Promise<string[]> {
    const rows = await this.q(
      "SELECT DISTINCT symbol FROM trades WHERE user_id = $1 AND deleted_at IS NULL ORDER BY symbol",
      [userId],
    );
    return rows.map((r) => String(r.symbol));
  }

  /** Load the mutable parent under lock; classify null vs version-conflict. */
  private async lockedParent(
    q: QueryFn,
    id: string,
    userId: string,
    expectedVersion: number,
  ): Promise<TradeRow | null> {
    const rows = await q(
      "SELECT * FROM trades WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE",
      [id, userId],
    );
    if (rows.length === 0) return null;
    const row = rows[0] as unknown as TradeRow;
    if (Number(row.version) !== expectedVersion) {
      throw new TradeVersionConflictError(
        `expected version ${expectedVersion} but trade is at ${row.version}`,
      );
    }
    return row;
  }

  async editJournaling(
    id: string,
    userId: string,
    patch: { strategy?: string | null; emotion?: string | null; notes?: string | null },
    event: StoredTradeEvent,
  ): Promise<TradeRecord | null> {
    return withTransaction(this.pool, async (q) => {
      const parent = await this.lockedParent(q, id, userId, event.expectedVersion);
      if (parent === null) return null;
      // NOTE: explicit null in the patch CLEARS the column (?? would treat null
      // as absent and keep the old value — journal null-clear law).
      const rows = await q(
        `UPDATE trades SET strategy = $1, emotion = $2, notes = $3, version = version + 1, updated_at = $4
         WHERE id = $5 AND version = $6 RETURNING *`,
        [
          patch.strategy !== undefined ? patch.strategy : parent.strategy,
          patch.emotion !== undefined ? patch.emotion : parent.emotion,
          patch.notes !== undefined ? patch.notes : parent.notes,
          event.at,
          id,
          event.expectedVersion,
        ],
      );
      const updated = rows[0];
      if (updated === undefined) throw new TradeStoreError("editJournaling: UPDATE returned no row");
      await q(
        `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          event.eventUid,
          id,
          event.type,
          event.actor,
          event.expectedVersion,
          JSON.stringify(event.payload),
          event.at,
        ],
      );
      return mapTrade(updated as unknown as TradeRow);
    });
  }

  async tombstone(id: string, userId: string, event: StoredTradeEvent): Promise<TradeRecord | null> {
    return withTransaction(this.pool, async (q) => {
      const parent = await this.lockedParent(q, id, userId, event.expectedVersion);
      if (parent === null) return null;
      const rows = await q(
        `UPDATE trades SET deleted_at = $1, version = version + 1, updated_at = $1
         WHERE id = $2 AND version = $3 RETURNING *`,
        [event.at, id, event.expectedVersion],
      );
      const updated = rows[0];
      if (updated === undefined) throw new TradeStoreError("tombstone: UPDATE returned no row");
      await q(
        `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          event.eventUid,
          id,
          event.type,
          event.actor,
          event.expectedVersion,
          JSON.stringify(event.payload),
          event.at,
        ],
      );
      return mapTrade(updated as unknown as TradeRow);
    });
  }

  async recordExit(
    tradeId: string,
    userId: string,
    exit: NewTradeExit,
    event: StoredTradeEvent,
  ): Promise<TradeExitRecord> {
    return withTransaction(this.pool, async (q) => {
      const parent = await this.lockedParent(q, tradeId, userId, event.expectedVersion);
      if (parent === null) throw new TradeStoreError("trade not found");
      let inserted: Record<string, unknown> | undefined;
      try {
        const rows = await q(
          `INSERT INTO trade_exits (trade_id, exit_type, volume, price, pnl, notes, exited_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [tradeId, exit.exitType, exit.volume, exit.exitPrice, exit.pnl, exit.notes, exit.exitedAt],
        );
        inserted = rows[0]; // velora_apply_exit trigger enforces allocation
      } catch (err) {
        if (/over-allocation/i.test(String((err as Error).message))) {
          throw new TradeOverAllocationError("cumulative exit volume exceeds the trade volume");
        }
        throw err;
      }
      await q(
        "UPDATE trades SET version = version + 1, updated_at = $1 WHERE id = $2 AND version = $3",
        [event.at, tradeId, event.expectedVersion],
      );
      await q(
        `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          event.eventUid,
          tradeId,
          event.type,
          event.actor,
          event.expectedVersion,
          JSON.stringify(event.payload),
          event.at,
        ],
      );
      return mapExit(inserted as unknown as ExitRow, exit.pnl);
    });
  }

  async listActiveExitsForTrade(tradeId: string, userId: string): Promise<TradeExitRecord[]> {
    const parent = await this.findActiveByIdForUser(tradeId, userId);
    if (parent === null) return [];
    const rows = await this.q(
      "SELECT * FROM trade_exits WHERE trade_id = $1 AND deleted_at IS NULL ORDER BY exited_at ASC, id ASC",
      [tradeId],
    );
    return rows.map((r) => mapExit(r as unknown as ExitRow, "0.00"));
  }

  async findActiveExitByIdForUser(exitId: string, userId: string): Promise<TradeExitRecord | null> {
    const rows = await this.q(
      `SELECT e.* FROM trade_exits e JOIN trades t ON t.id = e.trade_id
       WHERE e.id = $1 AND t.user_id = $2 AND e.deleted_at IS NULL AND t.deleted_at IS NULL`,
      [exitId, userId],
    );
    if (rows.length === 0) return null;
    return mapExit(rows[0] as unknown as ExitRow, "0.00");
  }

  async cancelExit(
    exitId: string,
    userId: string,
    event: StoredTradeEvent,
  ): Promise<TradeExitRecord | null> {
    return withTransaction(this.pool, async (q) => {
      const rows = await q(
        `SELECT e.* FROM trade_exits e JOIN trades t ON t.id = e.trade_id
         WHERE e.id = $1 AND t.user_id = $2 AND e.deleted_at IS NULL AND t.deleted_at IS NULL FOR UPDATE OF e, t`,
        [exitId, userId],
      );
      if (rows.length === 0) return null;
      const e = rows[0] as unknown as ExitRow;
      const parent = await this.lockedParent(q, String(e.trade_id), userId, event.expectedVersion);
      if (parent === null) return null;
      await q("UPDATE trade_exits SET deleted_at = $1 WHERE id = $2", [event.at, exitId]);
      await q(
        "UPDATE trades SET allocated_volume = allocated_volume - $1, version = version + 1, updated_at = $2 WHERE id = $3 AND version = $4",
        [e.volume, event.at, e.trade_id, event.expectedVersion],
      );
      await q(
        `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          event.eventUid,
          e.trade_id,
          event.type,
          event.actor,
          event.expectedVersion,
          JSON.stringify(event.payload),
          event.at,
        ],
      );
      // Guidance semantics: the returned record carries the tombstone time
      // (event.at) — the row `e` was read BEFORE the UPDATE and would still
      // show deleted_at = null. Caught by the real-PG battery (run 34732875535).
      return { ...mapExit(e, "0.00"), deletedAt: event.at };
    });
  }
}
