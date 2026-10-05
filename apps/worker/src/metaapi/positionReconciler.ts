// Position reconciliation — the MG-METAAPI-ASSEMBLY port of Legacy
// `MetaApiService::reconcileAccount` (api/src/Accounts/MetaApiService.php @
// edede31, source-read 2026-10-05, VERIFIED).
//
// FLOW (Legacy, verbatim):
//   1. pendingPositionIds(account) — only positions whose state is still
//      `received`; already-aggregated and terminal-skipped positions are never
//      re-assessed. A later fill for an aggregated/skipped position re-opens it
//      (importBatch upserts the state row back to `received`), exactly like a
//      new `received` fill row did in Legacy.
//   2. fillsForPosition(account, positionId) — ALL trade fills (in/out) of the
//      position from the DURABLE ledger, regardless of their own row state:
//      the fill ledger is evidence; the companion `sync_position_state` row is
//      the state machine (Legacy stored both on the fill row because it had no
//      separate place — Modern keeps the evidence append-only, ADR-002/B11).
//   3. assemblePositions(fills) — the pure domain port.
//   4. Trades emitted → INSERT keyed `pos-<positionId>` (idempotent on the
//      database UNIQUE), TRADE_IMPORTED event with a deterministic uid, then
//      mark the position aggregated with its trade id.
//   5. No trade emitted → terminal reasons (`close_before_open`,
//      `unknown_direction`) mark the position skipped durably; every other
//      reason is REPAIRABLE and leaves the position `received` so a later
//      webhook/sync fill can complete it. NOTHING IS EVER FABRICATED.
//
// CONVERGENCE (OD-M-PA-2, recommendation adopted 2026-10-05 pending owner
// ratification): `ON CONFLICT DO NOTHING` — a replayed batch converges instead
// of duplicating, and a re-opened position whose trade already exists simply
// re-aggregates. Repair of a wrong-but-committed trade is re-reconciliation
// from the immutable fill ledger (tombstone + re-import), never an UPDATE of
// history — consistent with ADR-002 and the append-only REVOKEs.
//
// SECURITY (D-2 Boundary-Scoped Option B): no credential, ciphertext, or key is
// ever read here; `user_credentials` stays fully revoked for the worker.
import type { PoolClient } from "pg";
import {
  assemblePositions,
  positionGroupKey,
  type AssemblyFill,
  type AssemblySkipReason,
} from "@velora/domain";
import type { SyncAccount } from "./syncRepository.js";

/** Legacy's terminal set — a later fill can never repair these. */
const TERMINAL_SKIP_REASONS: ReadonlySet<AssemblySkipReason> = new Set([
  "close_before_open",
  "unknown_direction",
] as const satisfies readonly AssemblySkipReason[]);

export interface ReconcileOutcome {
  readonly positionsAssembled: number;
  readonly positionsSkippedTerminal: number;
  readonly tradesImported: number;
  readonly tradesDuplicate: number;
}

/** pendingPositionIds — Legacy `MetaApiFillRepository::pendingPositionIds`.
 *
 * Legacy asked the FILL LEDGER: positions with at least one `received` trade
 * fill. Modern's fill rows are all `received` (append-only evidence), so the
 * answered question is the same one asked of the two tables that own it:
 * a position is pending iff its fills include a trade fill (in/out, valid
 * position id — Legacy `groupKey`'s pattern, same regex) AND its state row is
 * `received` or ABSENT. The absent case is load-bearing: positions ledgered
 * before 0029 (per-fill era) and any state row that ever goes missing are
 * picked up and assessed from the immutable ledger — the ledger, not the
 * state table, is the source of truth (Legacy: same, one table earlier).
 */
async function pendingPositionIds(
  client: PoolClient,
  accountId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ position_id: string }>(
    `SELECT DISTINCT f.position_id
       FROM sync_fills f
       LEFT JOIN sync_position_state s
              ON s.account_id = f.account_id AND s.position_id = f.position_id
      WHERE f.account_id = $1
        AND f.position_id IS NOT NULL
        AND f.position_id ~ '^[A-Za-z0-9._:-]{1,64}$'
        AND f.entry_type IN ('in','out')
        AND (s.position_id IS NULL OR s.state = 'received')
      ORDER BY f.position_id ASC`,
    [accountId],
  );
  return rows.map((r) => r.position_id);
}

/**
 * fillsForPosition — Legacy `MetaApiFillRepository::fillsForPosition`.
 *
 * Ordering is LOAD-BEARING (not cosmetic): `openDirection` and `firstString`
 * take the FIRST qualifying fill, so the row order decides direction/symbol on
 * ambiguous inputs. Legacy ordered by `occurred_at_utc ASC, id ASC` (MySQL:
 * NULLs first). The NULLS FIRST here reproduces that exactly.
 */
async function fillsForPosition(
  client: PoolClient,
  accountId: string,
  positionId: string,
): Promise<AssemblyFill[]> {
  const { rows } = await client.query<{
    external_deal_id: string;
    position_id: string | null;
    entry_type: "in" | "out" | null;
    direction: "buy" | "sell" | null;
    symbol: string | null;
    volume: string | null;
    price: string | null;
    profit: string | null;
    commission: string | null;
    swap: string | null;
    occurred_at_utc: Date | null;
    raw_time_text: string | null;
  }>(
    `SELECT external_deal_id, position_id, entry_type, direction, symbol,
            volume::text, price::text, profit::text, commission::text, swap::text,
            occurred_at_utc, raw_time_text
       FROM sync_fills
      WHERE account_id = $1 AND position_id = $2 AND entry_type IN ('in','out')
      ORDER BY occurred_at_utc ASC NULLS FIRST, id ASC`,
    [accountId, positionId],
  );
  return rows.map((r) => ({
    externalDealId: r.external_deal_id,
    positionId: r.position_id,
    entryType: r.entry_type,
    direction: r.direction,
    symbol: r.symbol,
    volume: r.volume,
    price: r.price,
    profit: r.profit,
    commission: r.commission,
    swap: r.swap,
    occurredAtUtc: r.occurred_at_utc === null ? null : r.occurred_at_utc.toISOString(),
    rawTimeText: r.raw_time_text,
  }));
}

/**
 * insertExternalTrade — Legacy `MetaApiService::insertExternalTrade`, mapped
 * onto the modern columns. One row per POSITION (external_deal_id =
 * `pos-<positionId>`), volume-weighted prices, Σ-IN volume, IN+OUT financial
 * sums, earliest-IN / latest-OUT boundaries.
 *
 * `occurred_at` (modern-only column) is the CLOSE instant: Legacy's analytics
 * bucket a trade by `DATE(close_time)` (MetricsService.php:77), and Modern's
 * daily recompute buckets by `occurred_at` — close keeps the attribution
 * identical. contract_size stays the schema default 1 (MG-OBS-5: Legacy's
 * assembler emits none; the legacy column default is 1.00000000).
 */
async function insertExternalTrade(
  client: PoolClient,
  account: SyncAccount,
  trade: ReturnType<typeof assemblePositions>["trades"][number],
  now: Date,
): Promise<{ tradeId: string | null }> {
  const rows = await client.query<{ id: string }>(
    `INSERT INTO trades
       (user_id, account_id, external_deal_id, symbol, direction, status,
        entry_price, exit_price, volume, contract_size, commission, swap, net_pnl,
        occurred_at, occurred_open_at_utc, occurred_close_at_utc,
        time_status, source_timezone, source_timezone_source, source_calendar,
        raw_open_text, raw_close_text, source)
     VALUES ($1,$2,$3,$4,$5,'CLOSED',$6,$7,$8,1,$9,$10,$11,$12,$13,$12,
             'resolved', NULL, 'metaapi_instant', 'gregorian', $14, $15, 'metaapi')
     ON CONFLICT (account_id, external_deal_id) DO NOTHING
     RETURNING id`,
    [
      account.userId, account.accountId, trade.positionKey,
      trade.symbol, trade.direction,
      trade.entryPrice, trade.exitPrice, trade.volume,
      trade.commission, trade.swap,
      // D-4: the PROVIDER's aggregate profit populates net_pnl. No local
      // computation participates in this value.
      trade.profitLoss,
      trade.closeInstantUtc, trade.openInstantUtc,
      trade.rawOpenText, trade.rawCloseText,
    ],
  );
  const tradeId = rows.rows[0]?.id ?? null;
  if (tradeId === null) {
    // The trade already exists (a replay, or a re-opened position whose trade
    // was imported before): converged, not duplicated. Legacy then located the
    // existing row the same way (findTradeIdByExternal).
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM trades WHERE account_id = $1 AND external_deal_id = $2 LIMIT 1`,
      [account.accountId, trade.positionKey],
    );
    return { tradeId: existing.rows[0]?.id ?? null };
  }
  // TRADE_IMPORTED event, actor `sync` (a server-side constant — never payload
  // derived). The uid is deterministic, so a replay collides on UNIQUE
  // (event_uid) and converges. Identifiers and provider facts only — no
  // token, no credential, no raw provider body.
  await client.query(
    `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload, at)
     VALUES ($1,$2,'TRADE_IMPORTED','sync',0,$3,$4)
     ON CONFLICT (event_uid) DO NOTHING`,
    [
      `metaapi:${account.accountId}:${trade.positionKey}`,
      tradeId,
      JSON.stringify({
        source: "metaapi",
        positionKey: trade.positionKey,
        symbol: trade.symbol,
        direction: trade.direction,
        netPnl: trade.profitLoss,
        volume: trade.volume,
        openInstantUtc: trade.openInstantUtc,
        closeInstantUtc: trade.closeInstantUtc,
      }),
      now.toISOString(),
    ],
  );
  return { tradeId };
}

/**
 * Reconcile an account's pending positions into closed-position trades.
 * Must be called INSIDE the same transaction as the batch import (Legacy ran
 * recordFill + reconcileAccount in one transaction; a failure rolls back the
 * cursor too, so a retry re-reads the same window).
 */
export async function reconcilePositions(
  client: PoolClient,
  account: SyncAccount,
  now: Date,
): Promise<ReconcileOutcome> {
  const pending = await pendingPositionIds(client, account.accountId);
  let positionsAssembled = 0;
  let positionsSkippedTerminal = 0;
  let tradesImported = 0;
  let tradesDuplicate = 0;

  for (const positionId of pending) {
    const key = positionGroupKey(positionId);
    if (key === null) {
      // The state row's CHECK makes this unreachable; fail loudly if not.
      throw new Error(`sync_position_state holds an invalid position id: ${JSON.stringify(positionId)}`);
    }
    const fills = await fillsForPosition(client, account.accountId, positionId);
    const result = assemblePositions(fills);

    if (result.trades.length > 0) {
      let tradeId: string | null = null;
      for (const trade of result.trades) {
        const inserted = await insertExternalTrade(client, account, trade, now);
        if (inserted.tradeId !== null) {
          tradeId = inserted.tradeId;
          tradesImported++;
        } else {
          tradesDuplicate++;
        }
      }
      if (tradeId === null) {
        // Every insert converged onto an existing trade but the row is gone
        // (tombstoned rows keep their id — SELECT above finds them). If the
        // trade truly cannot be located, do NOT claim aggregation.
        throw new Error(
          `assembled position ${key} produced no locatable trade row`,
        );
      }
      await client.query(
        `INSERT INTO sync_position_state (account_id, position_id, state, skip_reason, trade_id, assessed_at)
         VALUES ($1, $2, 'aggregated', NULL, $3, $4)
         ON CONFLICT (account_id, position_id) DO UPDATE
            SET state = 'aggregated', skip_reason = NULL, trade_id = $3,
                assessed_at = $4, updated_at = now()`,
        [account.accountId, positionId, tradeId, now.toISOString()],
      );
      positionsAssembled++;
    } else {
      const reason: AssemblySkipReason | "position_pending" =
        result.skipped[0]?.reason ?? "position_pending";
      if (reason !== "position_pending" && TERMINAL_SKIP_REASONS.has(reason)) {
        // Only mark terminal for data a future fill can never repair (Legacy:
        // bad chronology or an unusable direction). Everything else stays
        // `received` — the counterpart fill can arrive later.
        await client.query(
          `INSERT INTO sync_position_state (account_id, position_id, state, skip_reason, assessed_at)
           VALUES ($1, $2, 'skipped', $3, $4)
           ON CONFLICT (account_id, position_id) DO UPDATE
              SET state = 'skipped', skip_reason = $3, trade_id = NULL,
                  assessed_at = $4, updated_at = now()`,
          [account.accountId, positionId, reason, now.toISOString()],
        );
        positionsSkippedTerminal++;
      }
      // Repairable: no write. The position stays `received` and will be
      // re-assessed on the next batch that touches the account.
    }
  }

  return { positionsAssembled, positionsSkippedTerminal, tradesImported, tradesDuplicate };
}
