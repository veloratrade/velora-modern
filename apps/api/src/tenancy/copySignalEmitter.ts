// Copy-signal EMITTER — the producer half of the v2.5 copy-trading dispatch
// pipeline (R-1).
//
// ============================================================
// WHERE THE SIGNAL COMES FROM
// ============================================================
// Roadmap v2.5 names `signal_queue` and accepts "Copy trading signal replicates
// from master to follower EA". The queue row is therefore written at the moment
// the LEADER's own ledger changes — trade opened, trade exited — not by a
// scanner that would have to invent a watermark column (`signal_queue` has none,
// so a scanner could never be idempotent).
//
// ============================================================
// WHY THIS RUNS INSIDE THE TRADE'S TRANSACTION
// ============================================================
// `emitCopySignal` takes the transaction's `QueryFn`, not the pool: the caller
// (PgTradeStore) invokes it inside the same BEGIN…COMMIT as the trade insert.
// That is the transactional-outbox property ADR-007 calls out as the reason
// PostgreSQL queues beat Redis here, and it is what makes "the leader traded"
// and "the followers' signal exists" a single atomic fact. A committed trade
// with a silently missing signal is not a state this design can reach, and a
// rolled-back emit cannot leave a signal for a trade that does not exist.
//
// ============================================================
// MAPPING — LEADER ACTION → SIGNAL (no invented vocabulary)
// ============================================================
// 0020's `signal_queue(leader_account_id, leader_user_id, symbol, direction,
// volume, price, occurred_at)` has no "action" column, and `direction` is
// constrained to (buy, sell). The mapping therefore uses the only encoding the
// frozen schema admits:
//
//   leader opens a buy            → signal direction 'buy'  (open the same side)
//   leader exits part of the buy  → signal direction 'sell' (close that much)
//
// i.e. an exit is emitted as the OPPOSITE side at the exit's volume and price —
// which is precisely what a follower must do to mirror it. Nothing is inferred
// beyond that: no stop-loss, no take-profit, no leverage is copied, because the
// contract carries none of those fields.
//
// ============================================================
// WHO RECEIVES IT
// ============================================================
// The INSERT … SELECT … WHERE EXISTS makes the audience check part of the write:
// a signal is created ONLY for an account that currently has at least one
// `active` copy relationship as the LEADER. A trade on a leader with no active
// follower writes nothing (the common case: most accounts are not leaders), so
// the queue is not filled with rows nobody will ever consume. `pending` and
// `paused` relationships deliberately do NOT qualify — the follower has not been
// activated (or has been suspended) and delivering to them would execute trades
// on an account whose owner did not currently consent to copying.
//
// A trade with no `account_id` cannot be a copy source at all:
// `signal_queue.leader_account_id` is NOT NULL, and a relationship is defined on
// an account, never on "the user".
import type { QueryFn } from "../persistence/pg.js";
import type { TradeRecord, TradeExitRecord } from "../trades/tradeStore.js";

/**
 * One leader-side event to be replicated.
 *
 * `volume`/`price` are exact decimal STRINGS (ADR-001: money never travels as a
 * JS number) and are cast to NUMERIC by the statement.
 */
export interface CopySignalInput {
  readonly leaderAccountId: string;
  readonly leaderUserId: string;
  readonly symbol: string;
  readonly direction: "buy" | "sell";
  readonly volume: string;
  readonly price: string;
  /** UTC instant of the leader event (ISO-8601). */
  readonly occurredAt: string;
}

export interface CopySignalStore {
  /** Insert one signal when (and only when) an active copy relationship exists. */
  emit(input: CopySignalInput): Promise<string | null>;
}

/**
 * The emit statement.
 *
 * A single statement, so it is atomic even outside an explicit transaction, and
 * it is safe to call twice for the same event: `EXISTS` and the insert are
 * evaluated together under one snapshot, so two concurrent emits can only both
 * insert if a relationship was in fact active for both — which is the correct
 * outcome (the follower is expected to receive the signal).
 */
const EMIT = `
  INSERT INTO signal_queue
    (leader_account_id, leader_user_id, symbol, direction, volume, price, occurred_at)
  SELECT $1::bigint, $2::bigint, $3, $4, $5::numeric, $6::numeric, $7::timestamptz
   WHERE EXISTS (
     SELECT 1 FROM copy_relationships r
      WHERE r.leader_account_id = $1::bigint
        AND r.status = 'active'
   )
  RETURNING id::text AS id`;

/**
 * Emit through an EXPLICIT executor.
 *
 * This is the form the ledger hooks use: the hook is handed the transaction's
 * own `QueryFn`, so the signal is written on the same connection, inside the
 * same BEGIN…COMMIT, as the trade it describes.
 */
export async function emitCopySignal(q: QueryFn, input: CopySignalInput): Promise<string | null> {
  const rows = await q(EMIT, [
    input.leaderAccountId,
    input.leaderUserId,
    input.symbol,
    input.direction,
    input.volume,
    input.price,
    input.occurredAt,
  ]);
  const row = rows[0];
  return row === undefined ? null : String(row["id"]);
}

/** Executor-bound view of the same statement (non-transactional callers). */
export function createCopySignalStore(q: QueryFn): CopySignalStore {
  return {
    emit: (input: CopySignalInput) => emitCopySignal(q, input),
  };
}

/** The inverse of a trade direction — how an exit is mirrored. */
export function oppositeDirection(direction: "buy" | "sell"): "buy" | "sell" {
  return direction === "buy" ? "sell" : "buy";
}

/**
 * The signal a newly opened trade implies, or null when there is none.
 *
 * `accountId === null` returns null: copy relationships are anchored on an
 * ACCOUNT (`copy_relationships.leader_account_id`), so a journal-only trade with
 * no broker account cannot be a copy source — and `signal_queue`'s NOT NULL
 * column would refuse it anyway.
 */
export function tradeOpenedSignal(trade: TradeRecord): CopySignalInput | null {
  if (trade.accountId === null) return null;
  return {
    leaderAccountId: trade.accountId,
    leaderUserId: trade.userId,
    symbol: trade.symbol,
    direction: trade.direction,
    volume: trade.volume,
    price: trade.entryPrice,
    occurredAt: trade.openAtUtc,
  };
}

/**
 * The signal a recorded exit implies: the OPPOSITE side at the exit's own volume
 * and price, so a follower closes the same amount at the same level the leader
 * did (the schema has no `action` column — see the header).
 */
export function tradeExitSignal(trade: TradeRecord, exit: TradeExitRecord): CopySignalInput | null {
  if (trade.accountId === null) return null;
  return {
    leaderAccountId: trade.accountId,
    leaderUserId: trade.userId,
    symbol: trade.symbol,
    direction: oppositeDirection(trade.direction),
    volume: exit.volume,
    price: exit.exitPrice,
    occurredAt: exit.exitedAt,
  };
}
