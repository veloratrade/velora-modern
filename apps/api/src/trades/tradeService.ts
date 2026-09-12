// TradeService — Phase C increment 3. The trading-record capability on the
// ADR-002 ledger: every mutation goes through the domain fold (applyEvent)
// before the store appends it, so version CAS, tombstone, ownership-matrix and
// allocation invariants hold on every adapter. Financial authority = the Local
// PnL engine (ADR-001, 'half-even' for new computations). Manual times are
// interpreted in the USER's profile timezone (ADR-004 D-11 — intentional
// divergence from Remote's server-local parse and PHP's account-TZ policy).
import { randomUUID } from "node:crypto";
import { computePnl, applyEvent, VersionConflictError, TombstoneError, OverAllocationError, type LedgerEvent, type TradeState } from "@velora/domain";
import * as D from "@velora/domain";
import {
  type TradeStore, type TradeRecord, type NewTrade, type NewTradeExit, type TradeExitType, type StoredTradeEvent, type TradeSearchFilter,
  TradeVersionConflictError, TradeOverAllocationError, TradeStoreError,
} from "./tradeStore.js";

export class TradeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "TradeError";
  }
}

const SYMBOL_RE = /^[A-Z0-9#][A-Z0-9._:/#+-]{0,31}$/;
const ACCOUNT_ID_RE = /^[1-9]\d*$/;
const EXIT_TYPES: readonly TradeExitType[] = ["tp", "sl", "manual", "partial"];
/** 'YYYY-MM-DD[ T]HH:mm[:ss]' with optional explicit offset/Z; naive = user-local (ADR-004). */
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})([T ])(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/;

export interface TradeServiceDeps {
  readonly store: TradeStore;
  /** User profile timezone (0002 users.timezone, default 'UTC'). */
  readonly getUserTimezone: (userId: string) => Promise<string>;
  /** Account ownership check (accounts capability port). */
  readonly verifyAccountOwnership: (accountId: string, userId: string) => Promise<boolean>;
  readonly now?: () => Date;
  readonly newEventUid?: () => string;
}

export interface TradeSearchQuery {
  symbol?: string | undefined;
  direction?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  /** Remote-verified dead param: accepted, never applied. */
  q?: string | undefined;
  /** Remote-verified dead param: accepted, never applied. */
  order?: string | undefined;
  page?: string | undefined;
  limit?: string | undefined;
}

function invalid(field: string, messageKey: string, params?: Record<string, string | number>, message = "Invalid value."): never {
  throw new TradeError(400, "VALIDATION_FAILED", message, { field, messageKey, ...(params ?? {}) });
}

/** Remote trimZeros serialization (verified): '1.10000000'→'1.1', '0.00'→'0'. */
export function trimZeros(val: string): string {
  if (!val.includes(".")) return val;
  const trimmed = val.replace(/\.?0+$/, "");
  return trimmed === "" ? "0" : trimmed;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset (minutes) of `timeZone` at instant `at` — Intl-derived, no deps. */
function tzOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

interface InterpretedTime {
  readonly instant: Date;
  readonly iso: string;
  readonly offsetMinutes: number | null; // null when the input carried an explicit offset
}

/** Naive wall time → UTC instant in `timeZone` (two-pass, DST-safe). */
function interpretDatetime(input: string, timeZone: string, field: string): InterpretedTime {
  const m = DATETIME_RE.exec(input.trim());
  if (m === null) invalid(field, "errors.validation.datetime", undefined, "Invalid date and time.");
  const [, y, mo, d, , h, mi, s, zone] = m!;
  const yN = Number(y), moN = Number(mo), dN = Number(d), hN = Number(h), miN = Number(mi), sN = s === undefined ? 0 : Number(s);
  if (moN < 1 || moN > 12 || dN < 1 || dN > 31 || hN > 23 || miN > 59 || sN > 59) {
    invalid(field, "errors.validation.datetime", undefined, "Invalid date and time.");
  }
  const wall = new Date(Date.UTC(yN, moN - 1, dN, hN, miN, sN));
  if (
    wall.getUTCFullYear() !== yN || wall.getUTCMonth() !== moN - 1 || wall.getUTCDate() !== dN
  ) {
    invalid(field, "errors.validation.datetime", undefined, "Invalid date and time."); // e.g. Feb 30
  }
  if (zone !== undefined && zone !== "") {
    // explicit offset — authoritative evidence, no reinterpretation
    const withZone = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s === undefined ? "00" : s}${zone === "Z" ? "Z" : zone}`);
    if (Number.isNaN(withZone.getTime())) invalid(field, "errors.validation.datetime", undefined, "Invalid date and time.");
    return { instant: withZone, iso: withZone.toISOString(), offsetMinutes: null };
  }
  const guessMs = wall.getTime();
  let offset = tzOffsetMinutes(timeZone, new Date(guessMs));
  let utc = guessMs - offset * 60_000;
  const second = tzOffsetMinutes(timeZone, new Date(utc)); // DST boundary correction
  if (second !== offset) {
    offset = second;
    utc = guessMs - offset * 60_000;
  }
  const instant = new Date(utc);
  return { instant, iso: instant.toISOString(), offsetMinutes: offset };
}

function offsetString(minutes: number): string {
  if (minutes === 0) return "Z";
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** Decimal validation — Remote validateDecimal semantics at the Local ADR-001 scale. */
function validateDecimal(val: unknown, field: string, maxInt: number, maxFrac: number): string {
  if (typeof val !== "string" && typeof val !== "number") {
    invalid(field, "errors.validation.numeric", undefined, "Invalid numeric amount.");
  }
  const str = String(val).trim();
  if (!new RegExp(`^-?\\d{1,${maxInt}}(?:\\.\\d{1,${maxFrac}})?$`).test(str)) {
    invalid(field, "errors.validation.decimal", { maxIntegerDigits: maxInt, maxFractionDigits: maxFrac }, "Invalid numeric amount.");
  }
  return str;
}

function scale8(val: string): string {
  return D.toString(D.rescale(D.fromString(val), 8, "half-even"));
}
function scale2(val: string): string {
  return D.toString(D.rescale(D.fromString(val), 2, "half-even"));
}

function validateOptionalText(val: unknown, field: string, maxLength: number): string | null {
  if (val === undefined || val === null || val === "") return null;
  if (typeof val !== "string" || val.length > maxLength) {
    invalid(field, "errors.validation.maxLength", { max: maxLength }, "Invalid text value.");
  }
  return val;
}

function validateEmotionalScore(val: unknown): string | null {
  if (val === undefined || val === null || val === "") return null;
  const n = typeof val === "number" ? val : typeof val === "string" && val.trim() !== "" ? Number(val) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    invalid("emotionalScore", "errors.validation.range", { min: 1, max: 5 }, "Emotional score is out of range.");
  }
  return String(n);
}

function notFoundTrade(): never {
  throw new TradeError(404, "NOT_FOUND", "Trade not found.");
}
function notFoundExit(): never {
  throw new TradeError(404, "NOT_FOUND", "Trade exit not found.");
}

/** TradeRecord → domain TradeState (the fold input for every mutation). */
function stateOf(r: TradeRecord): TradeState {
  return {
    id: r.id,
    accountId: r.accountId,
    externalDealId: null,
    symbol: r.symbol,
    direction: r.direction,
    status: r.status,
    financial: {
      entryPrice: r.entryPrice, exitPrice: r.exitPrice, volume: r.volume,
      contractSize: r.contractSize, commission: r.commission, swap: r.swap,
    },
    journaling: { strategy: r.strategy, setup: null, emotion: r.emotion, notes: r.notes },
    stopLoss: r.stopLoss,
    takeProfit: r.takeProfit,
    allocatedVolume: r.allocatedVolume,
    version: r.version,
    deletedAt: r.deletedAt,
    quarantined: false,
  };
}

export class TradeService {
  private readonly now: () => Date;
  private readonly newEventUid: () => string;

  constructor(private readonly deps: TradeServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newEventUid = deps.newEventUid ?? (() => randomUUID());
  }

  /**
   * The stored payload embeds the domain LedgerEvent (foldable replay,
   * ADR-002 testing requirement) plus interpretation metadata.
   */
  private storedEvent(tradeId: string, ledgerEvent: LedgerEvent, meta: Record<string, unknown>, at: Date): StoredTradeEvent {
    return {
      eventUid: this.newEventUid(),
      tradeId,
      type: ledgerEvent.type,
      actor: ledgerEvent.actor,
      expectedVersion: ledgerEvent.expectedVersion,
      payload: { event: ledgerEvent, ...meta },
      at: at.toISOString(),
    };
  }

  /** Map domain/store concurrency failures to HTTP semantics. */
  private rethrowLedger(err: unknown): never {
    if (err instanceof TradeError) throw err;
    if (err instanceof VersionConflictError || err instanceof TradeVersionConflictError) {
      throw new TradeError(409, "CONFLICT", "Version conflict.");
    }
    if (err instanceof TombstoneError) notFoundTrade(); // tombstoned ≡ missing (non-disclosure)
    if (err instanceof OverAllocationError || err instanceof TradeOverAllocationError) {
      throw new TradeError(422, "VALIDATION_FAILED", "Cumulative exit volume exceeds the trade volume.", { volume: "EXIT_VOLUME_EXCEEDED" });
    }
    if (err instanceof TradeStoreError) notFoundTrade();
    throw err;
  }

  async createTrade(userId: string, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbolRaw = raw.symbol;
    const symbol = typeof symbolRaw === "string" ? symbolRaw.trim().toUpperCase() : "";
    if (symbol === "") invalid("symbol", "errors.validation.required", undefined, "Symbol is required.");
    if (!SYMBOL_RE.test(symbol)) invalid("symbol", "errors.validation.format", undefined, "Invalid symbol.");

    const direction = typeof raw.direction === "string" ? raw.direction : "";
    if (direction !== "buy" && direction !== "sell") {
      invalid("direction", "errors.validation.choice", undefined, "Invalid trade direction.");
    }

    let accountId: string | null = null;
    if (raw.accountId !== undefined && raw.accountId !== null && raw.accountId !== "") {
      const accStr = String(raw.accountId);
      if (!ACCOUNT_ID_RE.test(accStr)) invalid("accountId", "errors.validation.format", undefined, "Invalid broker account.");
      const owned = await this.deps.verifyAccountOwnership(accStr, userId);
      if (!owned) invalid("accountId", "errors.trades.accountNotOwned", undefined, "Broker account ownership check failed.");
      accountId = accStr;
    }

    // ADR-001 scale matrix: prices/volume/contract at 8; commission/swap at 2
    // (stricter than the lineages' (10,8) — documented difference).
    const entryPrice = validateDecimal(raw.entryPrice, "entryPrice", 10, 8);
    const exitPrice = validateDecimal(raw.exitPrice, "exitPrice", 10, 8);
    const volume = validateDecimal(raw.volume, "volume", 10, 8);
    const commission = validateDecimal(raw.commission ?? "0", "commission", 10, 2);
    const swap = validateDecimal(raw.swap ?? "0", "swap", 10, 2);
    const contractSize = validateDecimal(raw.contractSize ?? "1", "contractSize", 10, 8);
    const stopLoss = raw.stopLoss !== undefined && raw.stopLoss !== null && raw.stopLoss !== ""
      ? validateDecimal(raw.stopLoss, "stopLoss", 10, 8) : null;
    const takeProfit = raw.takeProfit !== undefined && raw.takeProfit !== null && raw.takeProfit !== ""
      ? validateDecimal(raw.takeProfit, "takeProfit", 10, 8) : null;

    if (D.cmp(D.fromString(entryPrice), D.fromString("0")) <= 0 || D.cmp(D.fromString(exitPrice), D.fromString("0")) <= 0) {
      invalid("entryPrice", "errors.validation.positive", undefined, "Trade prices must be positive.");
    }
    if (D.cmp(D.fromString(volume), D.fromString("0")) <= 0) invalid("volume", "errors.validation.positive", undefined, "Volume must be positive.");
    if (D.cmp(D.fromString(contractSize), D.fromString("0")) <= 0) invalid("contractSize", "errors.validation.positive", undefined, "Contract size must be positive.");
    if (stopLoss !== null && D.cmp(D.fromString(stopLoss), D.fromString("0")) <= 0) invalid("stopLoss", "errors.validation.positive", undefined, "Stop loss must be positive.");
    if (takeProfit !== null && D.cmp(D.fromString(takeProfit), D.fromString("0")) <= 0) invalid("takeProfit", "errors.validation.positive", undefined, "Take profit must be positive.");

    const timezone = await this.resolveTimezone(userId);
    if (typeof raw.openTime !== "string") invalid("openTime", "errors.validation.datetime", undefined, "Invalid date and time.");
    if (typeof raw.closeTime !== "string") invalid("closeTime", "errors.validation.datetime", undefined, "Invalid date and time.");
    const open = interpretDatetime(raw.openTime, timezone.effective, "openTime");
    const close = interpretDatetime(raw.closeTime, timezone.effective, "closeTime");
    if (close.instant.getTime() < open.instant.getTime()) {
      invalid("closeTime", "errors.validation.datetime", undefined, "Close time must not precede open time.");
    }

    const strategyTag = validateOptionalText(raw.strategyTag, "strategyTag", 64);
    const notes = validateOptionalText(raw.notes, "notes", 5000);
    const emotionalScore = validateEmotionalScore(raw.emotionalScore);

    const pnl = computePnl({
      direction, entryPrice: scale8(entryPrice), exitPrice: scale8(exitPrice),
      volume: scale8(volume), contractSize: scale8(contractSize),
      commission: scale2(commission), swap: scale2(swap),
      stopLoss: stopLoss === null ? null : scale8(stopLoss),
    }, "half-even");

    const now = this.now();
    const record: NewTrade = {
      userId, accountId,
      symbol, direction, status: "CLOSED",
      entryPrice: scale8(entryPrice), exitPrice: scale8(exitPrice),
      volume: scale8(volume), contractSize: scale8(contractSize),
      commission: scale2(commission), swap: scale2(swap),
      netPnl: pnl.kind === "ok" ? pnl.netPnl : pnl.netPnl,
      rMultiple: pnl.kind === "ok" ? pnl.rMultiple : null,
      stopLoss: stopLoss === null ? null : scale8(stopLoss),
      takeProfit: takeProfit === null ? null : scale8(takeProfit),
      strategy: strategyTag, emotion: emotionalScore, notes,
      openAtUtc: open.iso, closeAtUtc: close.iso,
      timeStatus: timezone.resolved ? "resolved" : "unresolved",
      sourceTimezone: timezone.resolved ? timezone.effective : null,
      sourceTimezoneSource: timezone.resolved ? "user_profile" : "unknown",
      sourceCalendar: "unknown",
      rawOpenText: null, rawCloseText: null,
      source: "manual",
    };

    // Domain fold gate: TRADE_CREATED from state null (ownership matrix: user may create).
    const ledgerEvent: LedgerEvent = {
      id: "pending", type: "TRADE_CREATED", actor: "user", at: now.toISOString(), expectedVersion: 0,
      trade: {
        id: "pending", accountId, externalDealId: null, symbol, direction, status: "CLOSED",
        financial: {
          entryPrice: record.entryPrice, exitPrice: record.exitPrice, volume: record.volume,
          contractSize: record.contractSize, commission: record.commission, swap: record.swap,
        },
        journaling: { strategy: strategyTag, setup: null, emotion: emotionalScore, notes },
        stopLoss: record.stopLoss, takeProfit: record.takeProfit,
      },
    };
    applyEvent(null, ledgerEvent);

    const stored = this.storedEvent("", ledgerEvent, {
      openTimeUtc: open.iso, closeTimeUtc: close.iso,
      sourceTzOffset: open.offsetMinutes === null ? null : offsetString(open.offsetMinutes),
      sourceTimeNaive: raw.openTime, pnl,
    }, now);
    try {
      const created = await this.deps.store.createTrade(record, stored);
      return this.serialize(created);
    } catch (err) {
      this.rethrowLedger(err);
    }
  }

  private async resolveTimezone(userId: string): Promise<{ effective: string; resolved: boolean }> {
    let tz = "UTC";
    try {
      tz = await this.deps.getUserTimezone(userId);
    } catch {
      tz = "UTC";
    }
    if (typeof tz !== "string" || tz.trim() === "" || !isValidTimeZone(tz)) {
      return { effective: "UTC", resolved: false }; // defensive: profile TZ invalid → UTC + unresolved
    }
    return { effective: tz, resolved: true };
  }

  async getTrade(id: string, userId: string): Promise<Record<string, unknown>> {
    const trade = await this.deps.store.findActiveByIdForUser(id, userId);
    if (trade === null) notFoundTrade();
    return this.serialize(trade!);
  }

  async searchTrades(userId: string, query: TradeSearchQuery): Promise<Record<string, unknown>> {
    const page = Math.max(1, Math.floor(Number(query.page ?? "1")) || 1);
    const rawLimit = Math.floor(Number(query.limit ?? "20")) || 20;
    const limit = Math.max(1, Math.min(200, rawLimit)); // PHP clamp (documented divergence from Remote)

    // PHP controller evidence: query params are trimmed; empty-after-trim = no filter.
    const trimmed = (v: string | undefined): string | undefined => {
      const t = v?.trim();
      return t === "" || t === undefined ? undefined : t;
    };
    const from = typeof query.from === "string" && query.from.trim() !== ""
      ? interpretDatetime(query.from, "UTC", "from").iso // bound must be an instant; naive → UTC
      : undefined;
    const to = typeof query.to === "string" && query.to.trim() !== ""
      ? interpretDatetime(query.to, "UTC", "to").iso
      : undefined;
    // PHP-evidenced order whitelist (open_time|profit_loss|close_time);
    // absent/unknown → open_time (Remote-lineage default; PHP defaults to
    // close_time — documented difference).
    const order = trimmed(query.order);
    const filter: TradeSearchFilter = {
      userId,
      symbol: trimmed(query.symbol),
      direction: trimmed(query.direction),
      q: trimmed(query.q), // journal search (PHP): symbol | strategy | notes
      from,
      to,
      sort: order === "close_time" || order === "profit_loss" || order === "open_time" ? order : "open_time",
    };

    const { items, total } = await this.deps.store.searchTrades(filter, page, limit);
    return {
      items: items.map((t) => this.serialize(t)),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  async listSymbols(userId: string): Promise<Record<string, unknown>> {
    return { symbols: await this.deps.store.listSymbols(userId) };
  }

  /** PUT — ADR-002: journaling-only for users; financial fields → 403 (documented divergence from Remote/PHP). */
  async updateTrade(id: string, userId: string, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const record = await this.deps.store.findActiveByIdForUser(id, userId);
    if (record === null) notFoundTrade();

    const financialFields = [
      "symbol", "direction", "entryPrice", "exitPrice", "volume", "contractSize",
      "commission", "swap", "stopLoss", "takeProfit", "accountId", "openTime", "closeTime",
    ].filter((f) => raw[f] !== undefined);
    if (financialFields.length > 0) {
      throw new TradeError(
        403, "FORBIDDEN",
        "Financial fields are immutable for users (ADR-002); tombstone the trade and re-create it.",
        { messageKey: "errors.trades.financialImmutable", fields: financialFields.join(",") },
      );
    }

    let expectedVersion = record!.version;
    if (raw.version !== undefined) {
      if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 0) {
        invalid("version", "errors.validation.numeric", undefined, "Invalid version.");
      }
      expectedVersion = raw.version;
    }

    const patch: { strategy?: string | null; emotion?: string | null; notes?: string | null } = {};
    if (raw.strategyTag !== undefined) patch.strategy = validateOptionalText(raw.strategyTag, "strategyTag", 64);
    if (raw.emotionalScore !== undefined) patch.emotion = validateEmotionalScore(raw.emotionalScore);
    if (raw.notes !== undefined) patch.notes = validateOptionalText(raw.notes, "notes", 5000);

    if (Object.keys(patch).length === 0) {
      return this.serialize(record!); // Remote-evidenced no-op PUT: 200, nothing changed, no event
    }

    const now = this.now();
    const ledgerEvent: LedgerEvent = {
      id: "pending", type: "JOURNALING_EDITED", actor: "user", at: now.toISOString(),
      expectedVersion, patch,
    };
    try {
      applyEvent(stateOf(record!), ledgerEvent); // version/tombstone/ownership gate
      const stored = await this.deps.store.editJournaling(id, userId, patch, this.storedEvent(id, ledgerEvent, {}, now));
      if (stored === null) notFoundTrade();
      return this.serialize(stored!);
    } catch (err) {
      this.rethrowLedger(err);
    }
  }

  /** DELETE — ADR-002 tombstone (never a physical delete). */
  async deleteTrade(id: string, userId: string): Promise<{ deleted: boolean }> {
    const record = await this.deps.store.findActiveByIdForUser(id, userId);
    if (record === null) notFoundTrade();
    const now = this.now();
    const ledgerEvent: LedgerEvent = {
      id: "pending", type: "TOMBSTONE_SET", actor: "user", at: now.toISOString(),
      expectedVersion: record!.version, reason: "user-requested deletion",
    };
    try {
      applyEvent(stateOf(record!), ledgerEvent);
      const stored = await this.deps.store.tombstone(id, userId, this.storedEvent(id, ledgerEvent, {}, now));
      if (stored === null) notFoundTrade();
      return { deleted: true };
    } catch (err) {
      this.rethrowLedger(err);
    }
  }

  async listExits(tradeId: string, userId: string): Promise<Record<string, unknown>> {
    const trade = await this.deps.store.findActiveByIdForUser(tradeId, userId);
    if (trade === null) notFoundTrade();
    const exits = await this.deps.store.listActiveExitsForTrade(tradeId, userId);
    return { items: exits.map((e) => this.serializeExit(e)) };
  }

  async createExit(tradeId: string, userId: string, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const trade = await this.deps.store.findActiveByIdForUser(tradeId, userId);
    if (trade === null) notFoundTrade();

    // PHP-hardened input validation (the fuller lineage evidence):
    const exitType = typeof raw.exitType === "string" ? raw.exitType : "";
    if (!(EXIT_TYPES as readonly string[]).includes(exitType)) {
      invalid("exitType", "errors.validation.choice", undefined, "Invalid exit type.");
    }
    const exitPrice = validateDecimal(raw.exitPrice, "exitPrice", 10, 8);
    const volume = validateDecimal(raw.volume, "volume", 10, 8);
    if (D.cmp(D.fromString(exitPrice), D.fromString("0")) <= 0 || D.cmp(D.fromString(volume), D.fromString("0")) <= 0) {
      invalid("volume", "errors.validation.positive", undefined, "Exit price and volume must be positive.");
    }
    if (typeof raw.exitedAt !== "string") invalid("exitedAt", "errors.validation.datetime", undefined, "Invalid exit time.");
    const notes = validateOptionalText(raw.notes, "notes", 255);

    const timezone = await this.resolveTimezone(userId);
    const exited = interpretDatetime(raw.exitedAt as string, timezone.effective, "exitedAt");
    if (exited.instant.getTime() < Date.parse(trade!.openAtUtc) || exited.instant.getTime() > Date.parse(trade!.closeAtUtc)) {
      throw new TradeError(422, "VALIDATION_FAILED", "Exit timestamp must be within trade open and close times.", { field: "exitedAt", messageKey: "errors.validation.datetime" });
    }

    // Proportional cost allocation (both lineages) at ADR-001 scales:
    // ratio scale 8; commission/swap allocations are currency amounts → scale 2.
    const ratio = D.div(D.fromString(scale8(volume)), D.fromString(trade!.volume), 8, "half-even");
    const commissionAlloc = D.toString(D.rescale(D.mul(D.fromString(trade!.commission), ratio), 2, "half-even"));
    const swapAlloc = D.toString(D.rescale(D.mul(D.fromString(trade!.swap), ratio), 2, "half-even"));
    const pnl = computePnl({
      direction: trade!.direction, entryPrice: trade!.entryPrice, exitPrice: scale8(exitPrice),
      volume: scale8(volume), contractSize: trade!.contractSize,
      commission: commissionAlloc, swap: swapAlloc, stopLoss: null,
    }, "half-even");
    const exit: NewTradeExit = {
      exitType: exitType as TradeExitType, exitPrice: scale8(exitPrice), volume: scale8(volume),
      pnl: pnl.netPnl, exitedAt: exited.iso, notes,
    };

    const now = this.now();
    const ledgerEvent: LedgerEvent = {
      id: "pending", type: "EXIT_RECORDED", actor: "user", at: now.toISOString(),
      expectedVersion: trade!.version,
      exit: { exitId: "assigned-by-store", volume: exit.volume, price: exit.exitPrice, recordedAt: now.toISOString() },
    };
    try {
      applyEvent(stateOf(trade!), ledgerEvent); // allocation + version + tombstone gate
      const created = await this.deps.store.recordExit(
        tradeId, userId, exit,
        this.storedEvent(tradeId, ledgerEvent, { exitDetails: exit }, now),
      );
      return { id: created.id, messageKey: "trades.exitCreated", params: {} };
    } catch (err) {
      this.rethrowLedger(err);
    }
  }

  /** DELETE exit — ADR-002: tombstone + EXIT_CANCELLED event (not a physical delete). */
  async deleteExit(exitId: string, userId: string): Promise<{ deleted: boolean }> {
    const exit = await this.deps.store.findActiveExitByIdForUser(exitId, userId);
    if (exit === null) notFoundExit();
    const trade = await this.deps.store.findActiveByIdForUser(exit!.tradeId, userId);
    if (trade === null) notFoundExit();
    const now = this.now();
    const ledgerEvent: LedgerEvent = {
      id: "pending", type: "EXIT_CANCELLED", actor: "user", at: now.toISOString(),
      expectedVersion: trade!.version, exitId: exit!.id, volume: exit!.volume,
    };
    try {
      applyEvent(stateOf(trade!), ledgerEvent); // underflow + version + tombstone gate
      const stored = await this.deps.store.cancelExit(
        exitId, userId,
        this.storedEvent(trade!.id, ledgerEvent, {}, now),
      );
      if (stored === null) notFoundExit();
      return { deleted: true };
    } catch (err) {
      this.rethrowLedger(err);
    }
  }

  private serializeExit(e: { id: string; tradeId: string; exitType: string; exitPrice: string; volume: string; pnl: string; exitedAt: string; notes: string | null }): Record<string, unknown> {
    return {
      id: e.id, tradeId: e.tradeId, exitType: e.exitType,
      exitPrice: trimZeros(e.exitPrice), volume: trimZeros(e.volume), pnl: trimZeros(e.pnl),
      exitedAt: e.exitedAt, notes: e.notes,
    };
  }

  serialize(t: TradeRecord): Record<string, unknown> {
    return {
      id: t.id,
      symbol: t.symbol,
      direction: t.direction,
      entryPrice: trimZeros(t.entryPrice),
      exitPrice: trimZeros(t.exitPrice ?? "0"),
      volume: trimZeros(t.volume),
      contractSize: trimZeros(t.contractSize),
      commission: trimZeros(t.commission),
      swap: trimZeros(t.swap),
      profitLoss: trimZeros(t.netPnl ?? "0.00"),
      rMultiple: t.rMultiple === null ? null : trimZeros(t.rMultiple),
      stopLoss: t.stopLoss === null ? null : trimZeros(t.stopLoss),
      takeProfit: t.takeProfit === null ? null : trimZeros(t.takeProfit),
      accountId: t.accountId,
      openTime: t.openAtUtc,
      closeTime: t.closeAtUtc,
      occurredOpenAtUtc: t.openAtUtc, // manual trades: primary ≡ canonical (ADR-004)
      occurredCloseAtUtc: t.closeAtUtc,
      timeStatus: t.timeStatus,
      sourceTimezone: t.sourceTimezone,
      sourceTimezoneSource: t.sourceTimezoneSource,
      sourceCalendar: t.sourceCalendar,
      rawOpenText: t.rawOpenText,
      rawCloseText: t.rawCloseText,
      session: "unconfigured", // Remote placeholder; session engine = Phase H+
      strategyTag: t.strategy,
      emotionalScore: t.emotion === null ? null : Number(t.emotion),
      notes: t.notes,
      source: t.source,
      version: t.version, // ADR-002 optimistic-concurrency token (Local addition)
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }
}
