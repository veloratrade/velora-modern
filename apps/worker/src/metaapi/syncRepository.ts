// Durable state for MetaAPI historical sync: reservation, cursor, fills, and
// the trade/event import. Direct `pg` (OD-6: no ORM).
//
// EVERY guarantee in this file is a DATABASE guarantee, deliberately:
//   - one active reservation per account  → partial unique index (0012)
//   - one fill per provider deal          → UNIQUE (account_id, external_deal_id)
//   - one trade per provider position     → UNIQUE (account_id, external_deal_id) on trades
//   - one event per logical mutation      → UNIQUE (event_uid)
// Application-level "check then write" cannot provide any of these across
// concurrent processes, so none of them is implemented that way here.
//
// SECURITY (D-2 Boundary-Scoped Option B): this module touches
// `trading_accounts`, `sync_reservations`, `sync_fills`, `trades` and
// `trade_events`. It NEVER reads `user_credentials` (the worker holds
// REVOKE ALL on it) and never handles a credential, ciphertext, or key.
import type { Pool, PoolClient } from "pg";
import { positionGroupKey } from "@velora/domain";
import type { NormalizedFill, SyncErrorCode } from "@velora/contracts";
import { reconcilePositions } from "./positionReconciler.js";

export interface SyncAccount {
  readonly accountId: string;
  readonly userId: string;
  readonly metaapiAccountId: string;
  readonly syncCursor: string | null;
  readonly lastSyncedAt: string | null;
}

/**
 * Accounts eligible for scheduled sync.
 *
 * ELIGIBILITY IS EXPLICIT: only accounts that actually carry a MetaAPI
 * identifier. An account without one is not "synced with a guessed id" — it is
 * simply not eligible, which is the owner's instruction (fail/skip explicitly
 * rather than guess). `user_id` comes from the account row, so ownership is
 * server-derived and never supplied by a payload.
 */
export async function listSyncableAccounts(pool: Pool, limit = 100): Promise<SyncAccount[]> {
  const { rows } = await pool.query<{
    id: string; user_id: string; metaapi_account_id: string;
    sync_cursor: string | null; last_synced_at: Date | null;
  }>(
    `SELECT id, user_id, metaapi_account_id, sync_cursor, last_synced_at
       FROM trading_accounts
      WHERE metaapi_account_id IS NOT NULL
      ORDER BY last_synced_at ASC NULLS FIRST, id ASC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    accountId: r.id,
    userId: r.user_id,
    metaapiAccountId: r.metaapi_account_id,
    syncCursor: r.sync_cursor,
    lastSyncedAt: r.last_synced_at === null ? null : r.last_synced_at.toISOString(),
  }));
}

/**
 * Acquire the account's sync lease.
 *
 * Returns the reservation id, or null when another attempt already holds it.
 *
 * CONCURRENCY: the partial unique index
 * `sync_reservations_one_active_per_account (account_id) WHERE released_at IS
 * NULL` makes a second concurrent INSERT fail with SQLSTATE 23505 — across
 * processes, not merely within one. That 23505 is translated to `null` (a
 * normal "someone else has it" outcome), never to a crash.
 *
 * STALE RECLAIM is a separate, explicit UPDATE that marks the expired row
 * released and `stale_reclaimed = true`. The row is never deleted, so an
 * abandoned operation remains visible as evidence (0012 policy).
 */
export async function acquireReservation(
  pool: Pool,
  accountId: string,
  userId: string,
  holder: string,
  leaseMs: number,
): Promise<string | null> {
  // Reclaim first: an expired lease must not block a new attempt forever.
  await pool.query(
    `UPDATE sync_reservations
        SET released_at = now(), stale_reclaimed = true
      WHERE account_id = $1 AND released_at IS NULL AND lease_expires_at < now()`,
    [accountId],
  );
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO sync_reservations
         (account_id, user_id, operation, holder, lease_expires_at)
       VALUES ($1, $2, 'HISTORICAL', $3, now() + make_interval(secs => $4))
       RETURNING id`,
      [accountId, userId, holder, leaseMs / 1000],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    // 23505 = the partial unique index fired: another attempt owns the lease.
    if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505") {
      return null;
    }
    throw err;
  }
}

/** Release a held lease. Idempotent: releasing twice is a no-op, never an error. */
export async function releaseReservation(pool: Pool, reservationId: string): Promise<void> {
  await pool.query(
    `UPDATE sync_reservations SET released_at = now()
      WHERE id = $1 AND released_at IS NULL`,
    [reservationId],
  );
}

export interface ImportOutcome {
  readonly fillsInserted: number;
  readonly fillsDuplicate: number;
  readonly tradesImported: number;
  readonly tradesDuplicate: number;
  readonly quarantined: number;
  /** Positions assembled into trades by the in-transaction reconciliation. */
  readonly positionsAssembled: number;
  /** Positions terminally skipped (close_before_open / unknown_direction). */
  readonly positionsSkippedTerminal: number;
}

/**
 * Persist one provider batch and reconcile positions — ALL IN ONE
 * TRANSACTION, so fills, state, trades, events and the cursor can never
 * diverge. This is Legacy `MetaApiService::runNextSyncJob` verbatim: record
 * every fill into the durable ledger, then `reconcileAccount` in the same
 * transaction (MG-METAAPI-ASSEMBLY; the per-OUT-fill trade creation that
 * audit §9.2 ruled the largest behavioural divergence is gone).
 *
 * IDEMPOTENCY is delegated to the database at three levels, each proven by the
 * constraint rather than by a pre-read:
 *   1. `sync_fills`     ON CONFLICT (account_id, external_deal_id) DO NOTHING
 *   2. `trades`         ON CONFLICT (account_id, external_deal_id) DO NOTHING
 *      (external_deal_id is `pos-<positionId>` — one trade per POSITION)
 *   3. `trade_events`   UNIQUE (event_uid) with a DETERMINISTIC uid derived
 *      from the account + position key, so a replay produces the SAME uid and
 *      converges instead of appending a duplicate event.
 *
 * CURSOR SAFETY: the cursor is advanced INSIDE this transaction. If anything
 * throws — including inside the reconciliation — the whole transaction rolls
 * back and the cursor does not move, so a retry re-reads the same window. The
 * cursor therefore can never run ahead of committed work.
 */
export async function importBatch(
  pool: Pool,
  account: SyncAccount,
  fills: readonly NormalizedFill[],
  nextCursor: string,
  now: Date,
): Promise<ImportOutcome> {
  const client: PoolClient = await pool.connect();
  let fillsInserted = 0, fillsDuplicate = 0, quarantined = 0;
  let tradesImported = 0, tradesDuplicate = 0;
  let positionsAssembled = 0, positionsSkippedTerminal = 0;
  try {
    await client.query("BEGIN");

    for (const fill of fills) {
      // --- 1. The fill's own INGESTION state, decided before writing -------
      // `sync_fills` is APPEND-ONLY: velora_worker holds INSERT/SELECT and is
      // explicitly REVOKEd UPDATE/DELETE (db/roles.sql §4, B11/D-6). Provider
      // evidence must never be rewritten, so the row is written exactly ONCE.
      //
      // The fill row records only what the INGEST knows at arrival time: an
      // unresolvable time is quarantined here (modern hardening, 0013); every
      // trade fill is `received`. Whether the fill's POSITION has been
      // aggregated is NOT a fill-row fact anymore — that state machine lives
      // in `sync_position_state` (0029), the companion Legacy kept on the
      // fill rows because it had no separate place.
      const skipReason = fill.timeStatus === "unresolved" ? "UNRESOLVED_TIME" : null;
      const state = skipReason !== null ? "skipped" : "received";

      // --- 2. Write the fill ONCE ------------------------------------------
      // Both timestamp columns are written independently: raw_time_text holds
      // the offset-explicit `time`, broker_time_text holds the naive
      // `brokerTime` (D-5). `occurred_at_utc` is null unless resolution
      // succeeded, and the DB CHECK enforces that pairing.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO sync_fills
           (account_id, user_id, external_deal_id, position_id, entry_type, direction,
            symbol, volume, price, profit, commission, swap,
            occurred_at_utc, raw_time_text, broker_time_text, time_status,
            ingestion_source, processing_state, skip_reason, processed_trade_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'historical',$17,$18,NULL)
         ON CONFLICT (account_id, external_deal_id) DO NOTHING
         RETURNING id`,
        [
          account.accountId, account.userId, fill.externalDealId, fill.positionId,
          fill.entryType, fill.direction, fill.symbol, fill.volume, fill.price,
          fill.profit, fill.commission, fill.swap,
          fill.occurredAtUtc, fill.rawTimeText, fill.brokerTimeText, fill.timeStatus,
          state, skipReason,
        ],
      );
      if (inserted.rowCount === 0) {
        // A replayed provider deal: converged, never double-counted. Legacy
        // INSERT IGNORE behaved the same — and, like Legacy, a duplicate does
        // NOT re-open the position (only a NEW fill does).
        fillsDuplicate++;
        continue;
      }
      fillsInserted++;
      if (skipReason !== null) quarantined++;

      // --- 3. A NEW trade fill (re)opens its position's assessment ---------
      // Legacy parity: recordFill inserted every deal `received`, so a new
      // fill for an already-aggregated/skipped position flipped it back to
      // pending. Only trade fills (in/out) with a VALID position id can ever
      // assemble, so only they get/open a state row; balance/credit deals and
      // keyless fills are ledgered as evidence and never assessed.
      if (fill.entryType === "in" || fill.entryType === "out") {
        if (positionGroupKey(fill.positionId) !== null) {
          await client.query(
            `INSERT INTO sync_position_state (account_id, position_id, state)
             VALUES ($1, $2, 'received')
             ON CONFLICT (account_id, position_id) DO UPDATE
                SET state = 'received', skip_reason = NULL, trade_id = NULL,
                    updated_at = now()`,
            [account.accountId, fill.positionId as string],
          );
        }
      }
    }

    // --- 4. Reconcile pending positions, in the SAME transaction -----------
    // Legacy ran reconcileAccount right after the fills, inside the same
    // transaction — a failure there must roll back the cursor too.
    const recon = await reconcilePositions(client, account, now);
    tradesImported = recon.tradesImported;
    tradesDuplicate = recon.tradesDuplicate;
    positionsAssembled = recon.positionsAssembled;
    positionsSkippedTerminal = recon.positionsSkippedTerminal;

    // --- 5. Cursor advance, in the SAME transaction -------------------------
    await client.query(
      `UPDATE trading_accounts
          SET sync_cursor = $1, last_synced_at = $2, last_sync_error_code = NULL,
              updated_at = now()
        WHERE id = $3`,
      [nextCursor, now.toISOString(), account.accountId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return {
    fillsInserted, fillsDuplicate, quarantined,
    tradesImported, tradesDuplicate, positionsAssembled, positionsSkippedTerminal,
  };
}

/**
 * Record a failure code against the account.
 *
 * Only a FIXED code from the closed vocabulary is written — never provider
 * text, never an exception message. The 0012 CHECK (`^[A-Z0-9_]{1,48}$`)
 * enforces that at the database level too. The cursor is deliberately NOT
 * touched, so a failed attempt cannot advance it.
 */
export async function recordSyncError(
  pool: Pool,
  accountId: string,
  code: SyncErrorCode,
): Promise<void> {
  await pool.query(
    `UPDATE trading_accounts SET last_sync_error_code = $1, updated_at = now() WHERE id = $2`,
    [code, accountId],
  );
}
