// AccountSyncStatusService — the v0.2 "Connection Status Monitor" surface.
//
// CAPABILITY (Legacy `AccountController::syncStatus`, roadmap v0.2 "Connection
// Status Monitor"): a user can see whether their connection is healthy, when it
// last synced, whether work is outstanding, and — when it failed — the failure
// code rather than a provider stack trace.
//
// WHAT IS DELIBERATELY NOT CARRIED OVER FROM LEGACY:
//   - Legacy exposed raw provider/sync bookkeeping (`sync_jobs` counters) and,
//     on some paths, the last provider error text. The Modern surface reports a
//     bounded vocabulary plus the stored error CODE, and never returns provider
//     payloads, credentials or account identifiers belonging to the provider
//     beyond the non-secret `metaapi_account_id` the user already owns.
//   - Ownership is enforced by the (accountId, userId) key: a foreign or
//     missing account is ONE non-disclosing 404, exactly as every other
//     ownership-scoped resource in this codebase.
//
// PERSISTENCE: `trading_accounts` already carries the state this needs
// (sync_status, last_synced_at, sync_cursor, last_sync_error_code,
// consecutive_errors, last_error, connection_checked_at, connected_at). No
// migration is required and none is proposed.
import type { QueryFn } from "../persistence/pg.js";

/**
 * The vocabulary is the 0004 CHECK constraint on `trading_accounts.sync_status`,
 * VERBATIM: DISCONNECTED | CONNECTING | SYNCING | CONNECTED | ERROR.
 *
 * There is no "PENDING" value in storage, so a status must never try to write
 * one (the engine rejects it — proven by the real-PG battery). "Work is
 * outstanding" is expressed by CONNECTING, and the durable record of that work
 * is the `webhook_events` row plus the queued sync job.
 */
export type SyncState = "DISCONNECTED" | "CONNECTING" | "SYNCING" | "CONNECTED" | "ERROR";

export interface SyncStatusView {
  readonly accountId: string;
  readonly provider: string;
  readonly platform: string;
  readonly state: SyncState;
  readonly lastSyncedAt: string | null;
  readonly lastErrorCode: string | null;
  readonly consecutiveErrors: number;
  readonly connectedAt: string | null;
  /** True when the account is a MetaAPI-connected account (has a provider id). */
  readonly metaapiConnected: boolean;
}

export interface SyncStatusStore {
  /** Ownership-scoped read: (accountId, userId) — a miss is indistinguishable. */
  findForUser(accountId: string, userId: string): Promise<SyncStatusView | null>;
}

type Row = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}

function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : str(v);
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const STATES: readonly string[] = ["DISCONNECTED", "CONNECTING", "SYNCING", "CONNECTED", "ERROR"];

export function toSyncState(raw: unknown): SyncState {
  const value = typeof raw === "string" ? raw.toUpperCase() : "";
  return (STATES.includes(value) ? value : "DISCONNECTED") as SyncState;
}

export function mapSyncStatusRow(row: Row): SyncStatusView {
  return {
    accountId: str(row["id"]),
    provider: str(row["provider"]),
    platform: str(row["platform"]),
    state: toSyncState(row["sync_status"]),
    lastSyncedAt: isoOrNull(row["last_synced_at"]),
    lastErrorCode: row["last_sync_error_code"] === null ? null : str(row["last_sync_error_code"]),
    consecutiveErrors: num(row["consecutive_errors"]),
    connectedAt: isoOrNull(row["connected_at"]),
    metaapiConnected: row["metaapi_account_id"] !== null && row["metaapi_account_id"] !== undefined,
  };
}

export class PgSyncStatusStore implements SyncStatusStore {
  constructor(private readonly q: QueryFn) {}

  async findForUser(accountId: string, userId: string): Promise<SyncStatusView | null> {
    const rows = await this.q(
      `SELECT id, provider, platform, sync_status, last_synced_at, last_sync_error_code,
              consecutive_errors, connected_at, metaapi_account_id
         FROM trading_accounts
        WHERE id = $1 AND user_id = $2`,
      [accountId, userId],
    );
    const row = rows[0];
    return row === undefined ? null : mapSyncStatusRow(row);
  }
}

/** In-memory double for route/service tests (same contract, not DB evidence). */
export class MemorySyncStatusStore implements SyncStatusStore {
  readonly #rows = new Map<string, SyncStatusView>();

  set(userId: string, view: SyncStatusView): void {
    this.#rows.set(`${userId}\u0000${view.accountId}`, view);
  }

  async findForUser(accountId: string, userId: string): Promise<SyncStatusView | null> {
    return this.#rows.get(`${userId}\u0000${accountId}`) ?? null;
  }
}
