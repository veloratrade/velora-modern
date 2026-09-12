// MemoryTradeStore — dev/test adapter for the trades port (Phase C inc 3).
// In-process only; no durability claims. Mutations are serialized through a
// promise chain (the same pattern the Remote repository uses for its in-memory
// path) and re-verify the ledger invariants (version CAS, tombstone,
// allocation) under the lock — process-local convenience, NOT a database
// guarantee (real-PostgreSQL transactions = Phase D).
import {
  type TradeStore, type TradeRecord, type NewTrade, type TradeExitRecord, type NewTradeExit,
  type StoredTradeEvent, type TradeSearchFilter,
  TradeStoreError, TradeVersionConflictError, TradeOverAllocationError,
} from "./tradeStore.js";
import * as D from "@velora/domain";

export class TradeNotFoundError extends TradeStoreError {}

/** Internal mutable copies (the port exposes readonly records). */
type MutableTrade = { -readonly [K in keyof TradeRecord]: TradeRecord[K] } & { userId: string };
type MutableExit = { -readonly [K in keyof TradeExitRecord]: TradeExitRecord[K] } & { userId: string };

export class MemoryTradeStore implements TradeStore {
  private readonly trades = new Map<string, MutableTrade>();
  private readonly exits = new Map<string, MutableExit>();
  private readonly events: StoredTradeEvent[] = [];
  private idCounter = 0;
  private exitIdCounter = 0;
  private chain: Promise<void> = Promise.resolve();

  /** All stored events, in append order (test/audit introspection only). */
  readonly eventLog = (): readonly StoredTradeEvent[] => this.events;

  private withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private activeOwned(id: string, userId: string): MutableTrade | null {
    const t = this.trades.get(id);
    return t !== undefined && t.userId === userId && t.deletedAt === null ? t : null;
  }

  private static versionCheck(trade: { version: number }, expected: number): void {
    if (trade.version !== expected) {
      throw new TradeVersionConflictError(`expected version ${expected} but trade is at ${trade.version}`);
    }
  }

  async createTrade(record: NewTrade, event: StoredTradeEvent): Promise<TradeRecord> {
    return this.withLock(() => {
      const id = String(++this.idCounter);
      const now = event.at;
      const full: MutableTrade = {
        ...record, id, userId: record.userId,
        allocatedVolume: "0.00000000", version: 0, deletedAt: null,
        createdAt: now, updatedAt: now,
      };
      this.trades.set(id, full);
      this.events.push({ ...event, tradeId: id });
      return full;
    });
  }

  async findActiveByIdForUser(id: string, userId: string): Promise<TradeRecord | null> {
    const t = this.activeOwned(id, userId);
    return t === null ? null : { ...t };
  }

  async searchTrades(
    filter: TradeSearchFilter,
    page: number,
    limit: number,
  ): Promise<{ items: TradeRecord[]; total: number }> {
    let list = [...this.trades.values()].filter(
      (t) => t.userId === filter.userId && t.deletedAt === null,
    );
    if (filter.symbol !== undefined && filter.symbol !== "") {
      const needle = filter.symbol.toUpperCase();
      list = list.filter((t) => t.symbol.includes(needle));
    }
    if (filter.direction !== undefined && filter.direction !== "") {
      list = list.filter((t) => t.direction === filter.direction);
    }
    if (filter.from !== undefined) {
      const from = Date.parse(filter.from);
      list = list.filter((t) => Date.parse(t.openAtUtc) >= from);
    }
    if (filter.to !== undefined) {
      const to = Date.parse(filter.to);
      list = list.filter((t) => Date.parse(t.closeAtUtc) <= to);
    }
    if (filter.q !== undefined) {
      // Journal search (PHP evidence): symbol | strategy | notes, contains.
      const needle = filter.q.toUpperCase();
      list = list.filter(
        (t) =>
          t.symbol.toUpperCase().includes(needle) ||
          (t.strategy ?? "").toUpperCase().includes(needle) ||
          (t.notes ?? "").toUpperCase().includes(needle),
      );
    }
    const byOpen = (t: { openAtUtc: string }): number => Date.parse(t.openAtUtc);
    const byClose = (t: { closeAtUtc: string }): number => Date.parse(t.closeAtUtc);
    const byPnl = (t: { netPnl: string | null }): number => Number(t.netPnl ?? "0");
    const key = filter.sort ?? "open_time";
    const cmpFn = key === "close_time" ? byClose : key === "profit_loss" ? byPnl : byOpen;
    list.sort((a, b) => cmpFn(b) - cmpFn(a) || Number(a.id) - Number(b.id)); // deterministic id tiebreak
    const total = list.length;
    const items = list.slice((page - 1) * limit, (page - 1) * limit + limit).map((t) => ({ ...t }));
    return { items, total };
  }

  async listSymbols(userId: string): Promise<string[]> {
    const symbols = new Set<string>();
    for (const t of this.trades.values()) {
      if (t.userId === userId && t.deletedAt === null) symbols.add(t.symbol);
    }
    return [...symbols].sort();
  }

  async editJournaling(
    id: string,
    userId: string,
    patch: { strategy?: string | null; emotion?: string | null; notes?: string | null },
    event: StoredTradeEvent,
  ): Promise<TradeRecord | null> {
    return this.withLock(() => {
      const t = this.activeOwned(id, userId);
      if (t === null) return null;
      MemoryTradeStore.versionCheck(t, event.expectedVersion);
      if (patch.strategy !== undefined) t.strategy = patch.strategy;
      if (patch.emotion !== undefined) t.emotion = patch.emotion;
      if (patch.notes !== undefined) t.notes = patch.notes;
      t.version += 1;
      t.updatedAt = event.at;
      this.events.push(event);
      return { ...t };
    });
  }

  async tombstone(id: string, userId: string, event: StoredTradeEvent): Promise<TradeRecord | null> {
    return this.withLock(() => {
      const t = this.activeOwned(id, userId);
      if (t === null) return null;
      MemoryTradeStore.versionCheck(t, event.expectedVersion);
      t.deletedAt = event.at;
      t.version += 1;
      t.updatedAt = event.at;
      this.events.push(event);
      return { ...t };
    });
  }

  async recordExit(tradeId: string, userId: string, exit: NewTradeExit, event: StoredTradeEvent): Promise<TradeExitRecord> {
    return this.withLock(() => {
      const t = this.activeOwned(tradeId, userId);
      if (t === null) throw new TradeNotFoundError("trade not found");
      MemoryTradeStore.versionCheck(t, event.expectedVersion);
      const alloc = D.rescale(D.add(D.fromString(t.allocatedVolume), D.fromString(exit.volume)), 8, "half-even");
      if (D.cmp(alloc, D.fromString(t.volume)) > 0) {
        throw new TradeOverAllocationError("cumulative exit volume exceeds the trade volume");
      }
      const exitId = String(++this.exitIdCounter);
      const record: MutableExit = {
        ...exit, id: exitId, tradeId, userId,
        recordedAt: event.at, deletedAt: null,
      };
      this.exits.set(exitId, record);
      t.allocatedVolume = D.toString(alloc);
      t.version += 1;
      t.updatedAt = event.at;
      this.events.push(event);
      const { userId: _u, ...publicRecord } = record;
      return publicRecord;
    });
  }

  async listActiveExitsForTrade(tradeId: string, userId: string): Promise<TradeExitRecord[]> {
    if (this.activeOwned(tradeId, userId) === null) return [];
    return [...this.exits.values()]
      .filter((e) => e.tradeId === tradeId && e.userId === userId && e.deletedAt === null)
      .sort((a, b) => Date.parse(a.exitedAt) - Date.parse(b.exitedAt) || Number(a.id) - Number(b.id))
      .map(({ userId: _u, ...e }) => e);
  }

  async findActiveExitByIdForUser(exitId: string, userId: string): Promise<TradeExitRecord | null> {
    const e = this.exits.get(exitId);
    if (e === undefined || e.userId !== userId || e.deletedAt !== null) return null;
    if (this.activeOwned(e.tradeId, userId) === null) return null; // tombstoned parent ≡ missing
    const { userId: _u, ...publicRecord } = e;
    return publicRecord;
  }

  async cancelExit(exitId: string, userId: string, event: StoredTradeEvent): Promise<TradeExitRecord | null> {
    return this.withLock(() => {
      const e = this.exits.get(exitId);
      if (e === undefined || e.userId !== userId || e.deletedAt !== null) return null;
      const t = this.activeOwned(e.tradeId, userId);
      if (t === null) return null;
      MemoryTradeStore.versionCheck(t, event.expectedVersion);
      const freed = D.rescale(D.sub(D.fromString(t.allocatedVolume), D.fromString(e.volume)), 8, "half-even");
      if (D.isNeg(freed)) throw new TradeStoreError("exit cancellation would underflow allocated volume");
      e.deletedAt = event.at;
      t.allocatedVolume = D.toString(freed);
      t.version += 1;
      t.updatedAt = event.at;
      this.events.push(event);
      const { userId: _u, ...publicRecord } = e;
      return publicRecord;
    });
  }
}
