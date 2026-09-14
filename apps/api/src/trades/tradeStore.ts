// TradeStore — the trades persistence port (Phase C increment 3).
// ADR-002 ledger semantics: the trades row is a projection; every mutation is
// an append-only trade_events row applied through the domain fold. This port is
// the smallest justified surface for the capability — real PostgreSQL adapters
// are Phase D; the PGlite store (db/tests) is in-wasm evidence only.
import type { LedgerEventType, MutationActor } from "@velora/contracts";

export type TradeDirection = "buy" | "sell";
export type TradeExitType = "tp" | "sl" | "manual" | "partial";
export type TradeTimeStatus = "resolved" | "unresolved";

/** Read-model projection of the ledger (0001 `trades` row + 0005 API columns). */
export interface TradeRecord {
  readonly id: string;
  readonly userId: string;
  readonly accountId: string | null;
  readonly symbol: string;
  readonly direction: TradeDirection;
  readonly status: "OPEN" | "CLOSED";
  readonly entryPrice: string; // scale 8
  readonly exitPrice: string | null; // scale 8
  readonly volume: string; // scale 8
  readonly contractSize: string; // scale 8
  readonly commission: string; // scale 2 (ADR-001 currency matrix)
  readonly swap: string; // scale 2
  readonly netPnl: string | null; // scale 2
  readonly rMultiple: string | null; // scale 8 (null = undefined risk)
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
  /** API `strategyTag` (Remote/PHP contract) maps to the 0001 journaling column. */
  readonly strategy: string | null;
  /** API `emotionalScore` (int 1–5) maps to the 0001 journaling column, as text. */
  readonly emotion: string | null;
  readonly notes: string | null;
  readonly allocatedVolume: string; // scale 8
  readonly version: number; // optimistic concurrency (ADR-002)
  readonly deletedAt: string | null; // tombstone
  readonly openAtUtc: string; // occurred_open_at_utc (ISO, ADR-004)
  readonly closeAtUtc: string; // occurred_close_at_utc (ISO)
  readonly timeStatus: TradeTimeStatus;
  readonly sourceTimezone: string | null;
  readonly sourceTimezoneSource: string;
  readonly sourceCalendar: string;
  readonly rawOpenText: string | null;
  readonly rawCloseText: string | null;
  readonly source: "manual"; // sync/import sources are Phase H
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Write model for a new manual trade (service-validated). */
export type NewTrade = Omit<
  TradeRecord,
  "id" | "allocatedVolume" | "version" | "deletedAt" | "createdAt" | "updatedAt"
>;

export interface TradeExitRecord {
  readonly id: string;
  readonly tradeId: string;
  readonly exitType: TradeExitType;
  readonly exitPrice: string; // scale 8
  readonly volume: string; // scale 8
  readonly pnl: string; // scale 2 (server-computed; client PnL ignored)
  readonly exitedAt: string; // ISO
  readonly notes: string | null;
  readonly recordedAt: string; // ISO
  readonly deletedAt: string | null; // exit tombstone
}

export type NewTradeExit = Omit<TradeExitRecord, "id" | "tradeId" | "recordedAt" | "deletedAt">;

/** Persisted audit event accompanying every store mutation (ADR-002). */
export interface StoredTradeEvent {
  readonly eventUid: string;
  readonly tradeId: string;
  readonly type: LedgerEventType;
  readonly actor: MutationActor;
  readonly expectedVersion: number;
  readonly payload: Record<string, unknown>;
  readonly at: string;
}

/** Sort keys whitelisted from PHP evidence (open_time|profit_loss|close_time). */
export type TradeSortKey = "open_time" | "close_time" | "profit_loss";

export interface TradeSearchFilter {
  readonly userId: string;
  readonly symbol?: string | undefined; // contains, case-insensitive (Remote evidence)
  readonly direction?: string | undefined; // exact; non buy/sell simply matches nothing
  readonly from?: string | undefined; // ISO instant — openAtUtc >=
  readonly to?: string | undefined; // ISO instant — closeAtUtc <=
  /** Journal search (PHP evidence): case-insensitive contains across symbol | strategy | notes. */
  readonly q?: string | undefined;
  /** Sort key (service-whitelisted); default open_time (Remote lineage). */
  readonly sort?: TradeSortKey | undefined;
}

/**
 * Canonical financial values recomputed from the realized exit ledger
 * (Phase 3B-2). `rMultiple` is null whenever risk is undefined (no SL, zero
 * SL, wrong-side SL) — never a fabricated fallback.
 */
export interface TradeFinancialRecompute {
  readonly netPnl: string; // scale 2
  readonly rMultiple: string | null; // scale 8
}

/** Store-level failure modes mapped by the service to HTTP semantics. */
export class TradeStoreError extends Error {}
/** CAS miss on trades.version (another mutation landed first). */
export class TradeVersionConflictError extends TradeStoreError {}
/** DB-level allocation guard rejection (0001 trigger). */
export class TradeOverAllocationError extends TradeStoreError {}

export interface TradeStore {
  /** Insert projection + TRADE_CREATED event atomically. */
  createTrade(record: NewTrade, event: StoredTradeEvent): Promise<TradeRecord>;
  /** Active (non-tombstoned) trade for its owner; null when missing/foreign/tombstoned. */
  findActiveByIdForUser(id: string, userId: string): Promise<TradeRecord | null>;
  /** Active trades, newest open first (Remote: orderBy openTime desc); paginated. */
  searchTrades(
    filter: TradeSearchFilter,
    page: number,
    limit: number,
  ): Promise<{ items: TradeRecord[]; total: number }>;
  /** DISTINCT symbols for the user, alphabetical (PHP evidence). */
  listSymbols(userId: string): Promise<string[]>;
  /**
   * Apply journaling patch + JOURNALING_EDITED event atomically (version CAS).
   * Null when the trade is missing/foreign/tombstoned.
   */
  editJournaling(
    id: string,
    userId: string,
    patch: { strategy?: string | null; emotion?: string | null; notes?: string | null },
    event: StoredTradeEvent,
  ): Promise<TradeRecord | null>;
  /** Set deleted_at + TOMBSTONE_SET event. Null when missing/foreign/already tombstoned. */
  tombstone(id: string, userId: string, event: StoredTradeEvent): Promise<TradeRecord | null>;
  /**
   * Insert exit + EXIT_RECORDED event + allocation + version bump, atomically.
   *
   * `recomputed` (Phase 3B-2, owner decision): the parent trade's canonical
   * `net_pnl`/`r_multiple` recomputed from the realized exit ledger. Applied in
   * the SAME transaction as the insert, so financial state and history can
   * never diverge. OD-6 is preserved — this rewrites the single canonical
   * field; no parallel financial column is introduced.
   */
  recordExit(
    tradeId: string,
    userId: string,
    exit: NewTradeExit,
    event: StoredTradeEvent,
    recomputed?: TradeFinancialRecompute,
  ): Promise<TradeExitRecord>;
  /** Active exits of an owned trade, exitedAt ascending (lineages agree). */
  listActiveExitsForTrade(tradeId: string, userId: string): Promise<TradeExitRecord[]>;
  /** Active exit by id, owner-scoped through its parent trade; null when missing/foreign/cancelled. */
  findActiveExitByIdForUser(exitId: string, userId: string): Promise<TradeExitRecord | null>;
  /**
   * Exit tombstone + EXIT_CANCELLED event + allocation decrement + version bump.
   * `recomputed` re-derives the parent's canonical net_pnl from the exits that
   * REMAIN after the cancellation, in the same transaction.
   */
  cancelExit(
    exitId: string,
    userId: string,
    event: StoredTradeEvent,
    recomputed?: TradeFinancialRecompute,
  ): Promise<TradeExitRecord | null>;
}
