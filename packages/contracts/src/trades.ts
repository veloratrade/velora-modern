// Trade & ledger contract — ADR-002 (Accepted, D-01: Option B) + ADR-001 scales.
import { z } from "zod";
import { isDecimalString } from "./money.js";

const dec = (places: number) =>
  z.string().refine((v) => isDecimalString(v), "must be a decimal string");

export const directionSchema = z.enum(["buy", "sell"]);
export const tradeStatusSchema = z.enum(["OPEN", "CLOSED"]);

export const financialFields = z.object({
  entryPrice: dec(8),
  exitPrice: dec(8).nullable(),
  volume: dec(8),
  contractSize: dec(8),
  commission: dec(2),
  swap: dec(2),
});

export const journalingFields = z.object({
  strategy: z.string().max(100).nullable(),
  setup: z.string().max(100).nullable(),
  emotion: z.string().max(50).nullable(),
  notes: z.string().max(5000).nullable(),
});

export const tradeSchema = financialFields.merge(journalingFields).extend({
  id: z.string(),
  accountId: z.string().nullable(),
  externalDealId: z.string().max(64).nullable(),
  symbol: z.string().max(32),
  direction: directionSchema,
  status: tradeStatusSchema,
  stopLoss: dec(8).nullable(),
  takeProfit: dec(8).nullable(),
  /** Optimistic concurrency version (ADR-002 §Decision). */
  version: z.number().int().nonnegative(),
  deletedAt: z.string().nullable(), // tombstone — row is never hard-deleted
});

export type Trade = z.infer<typeof tradeSchema>;

// Mutation ownership — ADR-002 ownership matrix (never last-write-wins).
export type MutationActor = "user" | "sync" | "webhook" | "admin" | "system";

/** Explicit conflict policy per field group (ADR-002; final mapping owner-approved Phase 2). */
export const FIELD_GROUP_POLICY = {
  financial: "SYNC_WINS_FINANCIAL",
  journaling: "USER_WINS_JOURNALING",
  unknown: "QUARANTINE_FOR_REVIEW",
} as const;

export const LEDGER_EVENTS = [
  "TRADE_IMPORTED", // migration origin event
  "TRADE_CREATED",
  "FINANCIAL_CORRECTED", // by sync/webhook (SYNC_WINS_FINANCIAL)
  "JOURNALING_EDITED", // by user (USER_WINS_JOURNALING)
  "EXIT_RECORDED",
  "EXIT_CANCELLED", // exit tombstone (ADR-002: exit deletion is a mutation event)
  "TOMBSTONE_SET", // soft delete (immutable history preserved)
  "ADMIN_CORRECTION",
  "QUARANTINE_RAISED",
] as const;
export type LedgerEventType = (typeof LEDGER_EVENTS)[number];
