// Immutable trade ledger — ADR-002 (Accepted, D-01: Option B).
// Rows are never mutated in place and never hard-deleted: every change is an
// append-only event; state is a fold. Optimistic concurrency via expectedVersion.
// Mutation ownership per the approved matrix — unspecified last-write-wins is
// explicitly rejected.
import type { LedgerEventType, MutationActor } from "@velora/contracts";

export class LedgerError extends Error {}
export class VersionConflictError extends LedgerError {}
export class TombstoneError extends LedgerError {}
export class OverAllocationError extends LedgerError {}
export class OwnershipPolicyError extends LedgerError {}
export class DuplicateEventError extends LedgerError {} // for non-idempotent re-apply attempts with different content

export interface TradeFinancial {
  entryPrice: string;
  exitPrice: string | null;
  volume: string;
  contractSize: string;
  commission: string;
  swap: string;
}
export interface TradeJournaling {
  strategy: string | null;
  setup: string | null;
  emotion: string | null;
  notes: string | null;
}

export interface TradeState {
  id: string;
  accountId: string | null;
  externalDealId: string | null;
  symbol: string;
  direction: "buy" | "sell";
  status: "OPEN" | "CLOSED";
  financial: TradeFinancial;
  journaling: TradeJournaling;
  stopLoss: string | null;
  takeProfit: string | null;
  /** allocated exit volume (sum of recorded exits) */
  allocatedVolume: string;
  version: number;
  deletedAt: string | null;
  quarantined: boolean;
}

export interface TradeExit {
  exitId: string;
  volume: string;
  price: string;
  recordedAt: string;
}

export type LedgerEvent =
  | { id: string; type: "TRADE_IMPORTED" | "TRADE_CREATED"; actor: MutationActor; at: string; expectedVersion: 0; trade: Omit<TradeState, "version" | "deletedAt" | "allocatedVolume" | "quarantined"> }
  | { id: string; type: "FINANCIAL_CORRECTED"; actor: "sync" | "webhook" | "admin"; at: string; expectedVersion: number; patch: Partial<TradeFinancial> }
  | { id: string; type: "JOURNALING_EDITED"; actor: "user" | "admin"; at: string; expectedVersion: number; patch: Partial<TradeJournaling> }
  | { id: string; type: "EXIT_RECORDED"; actor: MutationActor; at: string; expectedVersion: number; exit: TradeExit }
  | { id: string; type: "EXIT_CANCELLED"; actor: "user" | "admin"; at: string; expectedVersion: number; exitId: string; volume: string }
  | { id: string; type: "TOMBSTONE_SET"; actor: "user" | "admin"; at: string; expectedVersion: number; reason: string }
  | { id: string; type: "ADMIN_CORRECTION"; actor: "admin"; at: string; expectedVersion: number; note: string; patch: Partial<TradeFinancial & TradeJournaling> }
  | { id: string; type: "QUARANTINE_RAISED"; actor: MutationActor; at: string; expectedVersion: number; reason: string };

const EVENT_TYPES: readonly LedgerEventType[] = [
  "TRADE_IMPORTED", "TRADE_CREATED", "FINANCIAL_CORRECTED", "JOURNALING_EDITED",
  "EXIT_RECORDED", "EXIT_CANCELLED", "TOMBSTONE_SET", "ADMIN_CORRECTION", "QUARANTINE_RAISED",
];

export function isLedgerEvent(e: unknown): e is LedgerEvent {
  const t = (e as { type?: unknown }).type;
  return typeof t === "string" && (EVENT_TYPES as readonly string[]).includes(t);
}

/** Ownership matrix (ADR-002): which actor may emit which event type. */
const ALLOWED_ACTORS: Record<LedgerEventType, readonly MutationActor[]> = {
  TRADE_IMPORTED: ["system"],
  TRADE_CREATED: ["user", "sync", "webhook"],
  FINANCIAL_CORRECTED: ["sync", "webhook", "admin"], // SYNC_WINS_FINANCIAL — user never rewrites financials
  JOURNALING_EDITED: ["user", "admin"], // USER_WINS_JOURNALING — sync never rewrites journaling
  EXIT_RECORDED: ["user", "sync", "webhook", "admin"],
  EXIT_CANCELLED: ["user", "admin"], // exit tombstone — the ADR-002 representation of exit deletion
  TOMBSTONE_SET: ["user", "admin"],
  ADMIN_CORRECTION: ["admin"],
  QUARANTINE_RAISED: ["sync", "webhook", "system", "admin"],
};

export function assertOwnership(type: LedgerEventType, actor: MutationActor): void {
  if (!ALLOWED_ACTORS[type].includes(actor)) {
    throw new OwnershipPolicyError(`actor '${actor}' may not emit '${type}' (ADR-002 ownership matrix)`);
  }
}

export function applyEvent(state: TradeState | null, event: LedgerEvent): TradeState {
  if (state === null) {
    if (event.type !== "TRADE_CREATED" && event.type !== "TRADE_IMPORTED") {
      throw new LedgerError(`event ${event.type} requires an existing trade`);
    }
    assertOwnership(event.type, event.actor);
    return { ...event.trade, allocatedVolume: "0", version: 0, deletedAt: null, quarantined: false };
  }

  // optimistic concurrency: the event must name the version it expects to extend
  if (event.expectedVersion !== state.version) {
    throw new VersionConflictError(
      `expected version ${event.expectedVersion} but trade ${state.id} is at ${state.version}`,
    );
  }
  if (state.deletedAt !== null) {
    throw new TombstoneError(`trade ${state.id} is tombstoned; no further mutation events`);
  }
  assertOwnership(event.type, event.actor);

  switch (event.type) {
    case "TRADE_CREATED":
    case "TRADE_IMPORTED":
      throw new LedgerError("trade already exists");
    case "FINANCIAL_CORRECTED":
    case "JOURNALING_EDITED":
    case "ADMIN_CORRECTION": {
      const patch = "patch" in event ? event.patch : {};
      const next: TradeState = { ...state, version: state.version + 1 };
      if (event.type === "JOURNALING_EDITED") next.journaling = { ...state.journaling, ...patch };
      else if (event.type === "FINANCIAL_CORRECTED") next.financial = { ...state.financial, ...patch };
      else {
        next.financial = { ...state.financial, ...pickFinancial(patch) };
        next.journaling = { ...state.journaling, ...pickJournaling(patch) };
      }
      return next;
    }
    case "EXIT_RECORDED": {
      const next: TradeState = { ...state, version: state.version + 1 };
      const alloc = addAllocated(state.allocatedVolume, event.exit.volume);
      if (compareVolume(alloc, state.financial.volume) > 0) {
        throw new OverAllocationError(
          `exit allocation ${alloc} would exceed trade volume ${state.financial.volume}`,
        );
      }
      next.allocatedVolume = alloc;
      return next;
    }
    case "EXIT_CANCELLED": {
      const next: TradeState = { ...state, version: state.version + 1 };
      const freed = subAllocated(state.allocatedVolume, event.volume);
      if (D.isNeg(D.fromString(freed))) {
        throw new LedgerError(`exit cancellation ${event.volume} would underflow allocated volume ${state.allocatedVolume}`);
      }
      next.allocatedVolume = freed;
      return next;
    }
    case "TOMBSTONE_SET":
      return { ...state, version: state.version + 1, deletedAt: event.at };
    case "QUARANTINE_RAISED":
      return { ...state, version: state.version + 1, quarantined: true };
  }
}

function pickFinancial(p: Partial<TradeFinancial & TradeJournaling>): Partial<TradeFinancial> {
  const out: Record<string, string | null> = {};
  for (const k of ["entryPrice", "exitPrice", "volume", "contractSize", "commission", "swap"] as const) {
    if (p[k] !== undefined) out[k] = p[k];
  }
  return out as Partial<TradeFinancial>;
}
function pickJournaling(p: Partial<TradeFinancial & TradeJournaling>): Partial<TradeJournaling> {
  const out: Record<string, string | null> = {};
  for (const k of ["strategy", "setup", "emotion", "notes"] as const) {
    if (p[k] !== undefined) out[k] = p[k];
  }
  return out as Partial<TradeJournaling>;
}

// volume comparison at scale 8 (ledger-level guard; DB enforces the same via CHECK)
import * as D from "./decimal.js";
function addAllocated(current: string, add: string): string {
  const r = D.add(D.fromString(current), D.fromString(add));
  return D.toString(D.rescale(r, 8, "half-even"));
}
function subAllocated(current: string, sub: string): string {
  const r = D.sub(D.fromString(current), D.fromString(sub));
  return D.toString(D.rescale(r, 8, "half-even"));
}
function compareVolume(a: string, b: string): -1 | 0 | 1 {
  return D.cmp(D.fromString(a), D.fromString(b));
}

/** Fold with duplicate-event idempotency: replaying the same event id is a no-op. */
export function fold(events: readonly LedgerEvent[]): { state: TradeState | null; appliedIds: Set<string> } {
  let state: TradeState | null = null;
  const seen = new Set<string>();
  for (const e of events) {
    if (seen.has(e.id)) continue; // duplicate delivery converges (ADR-002 idempotency)
    seen.add(e.id);
    state = applyEvent(state, e);
  }
  return { state, appliedIds: seen };
}

/** Idempotent external identity: same (account, externalDealId) must converge. */
export function externalTradeKey(accountId: string | null, externalDealId: string): string {
  return `trade:${accountId ?? "manual"}:${externalDealId}`;
}
