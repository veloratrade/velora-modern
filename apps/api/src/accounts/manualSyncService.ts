// Manual sync request — TRD-06 (Legacy `AccountController::sync`).
//
// CAPABILITY. Until now a user could only WAIT for the hourly tick or hope a
// MetaAPI webhook arrived: `GET /accounts/{id}/sync-status` reported state and
// POST /accounts/{id}/sync did not exist in Modern at all, so "sync this
// account now" — a button in Legacy's accounts page — had no equivalent.
//
// ORDER OF OPERATIONS IS THE DESIGN, and it is the same order the webhook
// ingress uses: mark the account as awaiting sync FIRST (durable, survives a
// lost queue and a restart), dispatch SECOND (best effort). A queue outage can
// therefore delay convergence; it cannot lose the request, because the state
// marker plus the scheduled tick are the safety net.
//
// WHAT IS DELIBERATELY NOT CARRIED OVER FROM LEGACY:
//   - Legacy returned the `sync_jobs` row id and a `deduplicated` flag derived
//     from a 60-second cooldown plus a UNIQUE dedupe key. Modern's queue is an
//     integration boundary (ADR-007) whose id is not a domain identifier, and
//     its dedupe is the business key `sync:{accountId}:{from}` (pg-boss
//     `stately`). The response therefore reports what actually happened
//     (`dispatched` / `deduplicated`) instead of a database row id the client
//     could never use — the client follows `sync-status`, exactly as it does
//     after a webhook-triggered sync.
//   - Legacy always queued, even when there was nothing to ask for. Modern
//     answers `up-to-date` instead of manufacturing a job with an empty window.
//   - Legacy's 422 `VALIDATION_ERROR` for a non-MetaAPI account becomes the
//     Modern envelope's canonical validation shape (400 `VALIDATION_FAILED`)
//     with the SAME machine-readable detail (`account: METAAPI_REQUIRED`).
import { syncWindow, type SyncWindow } from "@velora/contracts";
import type { QueryFn } from "../persistence/pg.js";

/** The three fields the decision needs — nothing else is read. */
export interface SyncableAccount {
  readonly accountId: string;
  /** NON-SECRET provider identifier (D-2). `null` ⇒ nothing to synchronize. */
  readonly metaapiAccountId: string | null;
  readonly syncCursor: string | null;
}

export interface ManualSyncStore {
  /** Ownership-scoped read: (accountId, userId) — a miss is indistinguishable. */
  findForUser(accountId: string, userId: string): Promise<SyncableAccount | null>;
}

/** The queue port, structurally identical to `SyncTrigger` (ADR-007). */
export interface ManualSyncTrigger {
  requestSync(request: {
    readonly accountId: string;
    readonly metaapiAccountId: string;
    readonly from: string;
    readonly to: string;
  }): Promise<boolean>;
}

export type ManualSyncResult =
  | { readonly kind: "not-found" }
  | { readonly kind: "not-metaapi" }
  | { readonly kind: "up-to-date" }
  | {
      readonly kind: "queued";
      /** True when a job was actually handed to the queue. */
      readonly dispatched: boolean;
      readonly window: SyncWindow;
    };

export interface ManualSyncDeps {
  readonly store: ManualSyncStore;
  /** Durable "work is outstanding" marker (same SQL the ingress uses). */
  readonly markSyncPending: (accountId: string) => Promise<void>;
  readonly trigger: ManualSyncTrigger;
  readonly now?: () => Date;
  /** Structured, code-only logging — never an account id, never an error text. */
  readonly log?: (event: Record<string, unknown>) => void;
}

export class ManualSyncService {
  constructor(private readonly deps: ManualSyncDeps) {}

  async request(accountId: string, userId: string): Promise<ManualSyncResult> {
    const account = await this.deps.store.findForUser(accountId, userId);
    if (account === null) return { kind: "not-found" };
    if (account.metaapiAccountId === null) return { kind: "not-metaapi" };

    const window = syncWindow(account.syncCursor, (this.deps.now ?? (() => new Date()))());
    if (window === null) return { kind: "up-to-date" };

    // Record first: the account is now known to be non-converged even if the
    // process dies before the queue is touched.
    await this.deps.markSyncPending(account.accountId);

    let dispatched = false;
    try {
      dispatched = await this.deps.trigger.requestSync({
        accountId: account.accountId,
        metaapiAccountId: account.metaapiAccountId,
        from: window.from,
        to: window.to,
      });
    } catch {
      // Degradation, not failure (same rationale as the ingress): the durable
      // marker is written and the hourly tick will converge the window. Only a
      // code is logged — a queue error can carry a connection string.
      this.deps.log?.({ level: "warn", event: "accounts.manual_sync.dispatch_failed" });
    }

    return { kind: "queued", dispatched, window };
  }
}

type Row = Record<string, unknown>;

export class PgManualSyncStore implements ManualSyncStore {
  constructor(private readonly q: QueryFn) {}

  async findForUser(accountId: string, userId: string): Promise<SyncableAccount | null> {
    const rows = await this.q(
      `SELECT id::text AS id, metaapi_account_id, sync_cursor
         FROM trading_accounts
        WHERE id = $1 AND user_id = $2`,
      [accountId, userId],
    );
    const row: Row | undefined = rows[0];
    if (row === undefined) return null;
    return {
      accountId: String(row["id"]),
      metaapiAccountId: row["metaapi_account_id"] === null || row["metaapi_account_id"] === undefined
        ? null
        : String(row["metaapi_account_id"]),
      syncCursor: row["sync_cursor"] === null || row["sync_cursor"] === undefined
        ? null
        : (row["sync_cursor"] as Date | string) instanceof Date
          ? (row["sync_cursor"] as Date).toISOString()
          : String(row["sync_cursor"]),
    };
  }
}

/** In-memory double for route/service tests (same contract, not DB evidence). */
export class MemoryManualSyncStore implements ManualSyncStore {
  readonly #rows = new Map<string, SyncableAccount>();

  set(userId: string, account: SyncableAccount): void {
    this.#rows.set(`${userId}\u0000${account.accountId}`, account);
  }

  async findForUser(accountId: string, userId: string): Promise<SyncableAccount | null> {
    return this.#rows.get(`${userId}\u0000${accountId}`) ?? null;
  }
}
