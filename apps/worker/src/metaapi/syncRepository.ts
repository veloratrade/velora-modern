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
import type { NormalizedFill, SyncErrorCode } from "@velora/contracts";

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
}

/**
 * Persist one provider batch and fold it into the ledger — ALL IN ONE
 * TRANSACTION, so fills, trades, events and the cursor can never diverge.
 *
 * IDEMPOTENCY is delegated to the database at three levels, each proven by the
 * constraint rather than by a pre-read:
 *   1. `sync_fills` ON CONFLICT (account_id, external_deal_id) DO NOTHING
 *   2. `trades`     ON CONFLICT (account_id, external_deal_id) DO NOTHING
 *   3. `trade_events` UNIQUE (event_uid), with a DETERMINISTIC uid derived
 *      from the account + provider deal id, so a replay produces the SAME uid
 *      and converges instead of appending a duplicate event.
 *
 * CURSOR SAFETY: the cursor is advanced INSIDE this transaction. If anything
 * throws, the whole transaction rolls back and the cursor does not move, so a
 * retry re-reads the same window. The cursor therefore can never run ahead of
 * committed work.
 */
export async function importBatch(
  pool: Pool,
  account: SyncAccount,
  fills: readonly NormalizedFill[],
  nextCursor: string,
  now: Date,
): Promise<ImportOutcome> {
  const client: PoolClient = await pool.connect();
  let fillsInserted = 0, fillsDuplicate = 0, tradesImported = 0, tradesDuplicate = 0, quarantined = 0;
  try {
    await client.query("BEGIN");

    for (const fill of fills) {
      // --- 1. Decide the fill's FINAL state before writing anything --------
      // `sync_fills` is APPEND-ONLY: velora_worker holds INSERT/SELECT and is
      // explicitly REVOKEd UPDATE/DELETE (db/roles.sql §4, B11/D-6). That is a
      // deliberate integrity control — provider evidence must never be
      // rewritten — so the row is written exactly ONCE, already carrying its
      // terminal state. (An earlier draft inserted then UPDATEd and was
      // refused by the grant at runtime with 42501.)
      const importable =
        fill.timeStatus === "resolved_utc" && fill.entryType === "out"
        && fill.direction !== null && fill.symbol !== null
        && fill.price !== null && fill.volume !== null;

      // A fill we cannot place on the timeline is `skipped` with a fixed
      // reason, NOT silently promoted to normal analytics data (J).
      const skipReason = fill.timeStatus === "unresolved" ? "UNRESOLVED_TIME" : null;
      const state = skipReason !== null ? "skipped" : importable ? "aggregated" : "received";

      // The trade is created FIRST when importable, so its id can be stored on
      // the fill row in the same single insert.
      let tradeId: string | null = null;
      if (importable) {
        const tradeRows = await client.query<{ id: string }>(
          `INSERT INTO trades
             (user_id, account_id, external_deal_id, symbol, direction, status,
              entry_price, exit_price, volume, contract_size, commission, swap,
              net_pnl, occurred_at, occurred_open_at_utc, occurred_close_at_utc,
              time_status, source_timezone, source_timezone_source, source_calendar,
              raw_open_text, raw_close_text, source)
           VALUES ($1,$2,$3,$4,$5,'CLOSED',$6,$6,$7,1,$8,$9,$10,$11,$11,$11,
                   'resolved', NULL, 'metaapi_instant', 'gregorian', $12, $12, 'metaapi')
           ON CONFLICT (account_id, external_deal_id) DO NOTHING
           RETURNING id`,
          [
            account.userId, account.accountId, fill.externalDealId, fill.symbol, fill.direction,
            fill.price, fill.volume, fill.commission ?? "0", fill.swap ?? "0",
            // D-4: the PROVIDER's profit populates the canonical net_pnl.
            // No local PnL computation participates in this value.
            fill.profit, fill.occurredAtUtc, fill.rawTimeText,
          ],
        );
        tradeId = tradeRows.rows[0]?.id ?? null;
        if (tradeId === null) {
          // The trade already exists: a replay. Converged, not duplicated.
          tradesDuplicate++;
        } else {
          tradesImported++;
          // --- TRADE_IMPORTED event, actor `sync` ---------------------------
          // The actor is a SERVER-SIDE CONSTANT: never read from the job
          // payload, the provider response, or any request, so it cannot be
          // selected by a client (ADR-002 A-1 / D-3). The uid is deterministic,
          // so a replay collides on UNIQUE(event_uid) and converges.
          await client.query(
            `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload, at)
             VALUES ($1,$2,'TRADE_IMPORTED','sync',0,$3,$4)
             ON CONFLICT (event_uid) DO NOTHING`,
            [
              `metaapi:${account.accountId}:${fill.externalDealId}`,
              tradeId,
              // Identifiers and provider-reported facts only — no token, no
              // credential, no raw provider body.
              JSON.stringify({
                source: "metaapi",
                externalDealId: fill.externalDealId,
                positionId: fill.positionId,
                netPnl: fill.profit,
                occurredAtUtc: fill.occurredAtUtc,
                rawTimeText: fill.rawTimeText,
                brokerTimeText: fill.brokerTimeText,
              }),
              now.toISOString(),
            ],
          );
        }
      }

      // --- 2. Write the fill ONCE, already in its terminal state -----------
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
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'historical',$17,$18,$19)
         ON CONFLICT (account_id, external_deal_id) DO NOTHING
         RETURNING id`,
        [
          account.accountId, account.userId, fill.externalDealId, fill.positionId,
          fill.entryType, fill.direction, fill.symbol, fill.volume, fill.price,
          fill.profit, fill.commission, fill.swap,
          fill.occurredAtUtc, fill.rawTimeText, fill.brokerTimeText, fill.timeStatus,
          state, skipReason, tradeId,
        ],
      );
      if (inserted.rowCount === 0) fillsDuplicate++;
      else {
        fillsInserted++;
        if (skipReason !== null) quarantined++;
      }
    }

    // --- 4. Cursor advance, in the SAME transaction -------------------------
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
  return { fillsInserted, fillsDuplicate, tradesImported, tradesDuplicate, quarantined };
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
