// The MetaAPI historical-sync handler — the first real job class.
//
// FLOW (each step is governance-anchored, none invented):
//   1. read the non-secret account identity from the job payload
//   2. acquire the account's sync lease            (0012 partial unique index)
//   3. call the documented history-deals endpoint  (D-7)
//   4. normalize each deal                         (D-5 timestamps, D-4 PnL)
//   5. persist fills + trades + events + cursor in ONE transaction
//   6. release the lease — always, including on failure
//
// CREDENTIAL BOUNDARY (D-2, Boundary-Scoped Option B): this handler consumes
// exactly two secrets-adjacent inputs — DATABASE_URL (its own least-privilege
// role) and METAAPI_PLATFORM_TOKEN (an installation-level platform secret).
// It does NOT import the credential store, does NOT read `user_credentials`,
// and never sees a broker login, an investor password, credential ciphertext,
// or CREDENTIAL_MASTER_KEY.
import type { Pool } from "pg";
import type { MetaApiDeal, MetaApiSyncPayload, NormalizedFill } from "@velora/contracts";
import type { QueuedJob } from "../queue/QueuePort.js";
import { ClassifiedError, classifyError, type WorkerErrorCode } from "../observability/safeError.js";
import { fetchHistoryDeals } from "./../metaapi/historyDealsClient.js";
import { normalizeDeal } from "./../metaapi/normalizeDeal.js";
import {
  acquireReservation, releaseReservation, importBatch, recordSyncError,
} from "./../metaapi/syncRepository.js";

export interface MetaApiSyncDeps {
  readonly pool: Pool;
  /** Supplied by the composition root from METAAPI_PLATFORM_TOKEN. */
  readonly platformToken: string;
  readonly baseUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  /** Worker instance identity recorded on the reservation. Never a credential. */
  readonly holder: string;
  readonly leaseMs?: number;
  readonly now?: () => Date;
}

/** Codes that map cleanly onto the non-secret `last_sync_error_code` vocabulary. */
const PERSISTABLE: ReadonlySet<WorkerErrorCode> = new Set([
  "PROVIDER_REJECTED", "PROVIDER_UNAVAILABLE", "PROVIDER_MALFORMED", "NOT_CONFIGURED",
]);

export function createMetaApiSyncHandler(deps: MetaApiSyncDeps) {
  const leaseMs = deps.leaseMs ?? 300_000; // ADR-007 `sync` class lease
  const nowFn = deps.now ?? (() => new Date());

  return async function handleMetaApiSync(job: QueuedJob<MetaApiSyncPayload>): Promise<void> {
    const { accountId, metaapiAccountId, from, to } = job.descriptor.payload;

    // The producer only enqueues accounts that HAVE an identifier, but the
    // handler re-checks rather than trusting the payload: a job row can
    // outlive the state that created it.
    if (!metaapiAccountId) {
      await recordSyncError(deps.pool, accountId, "NO_METAAPI_ACCOUNT_ID");
      throw new ClassifiedError("PROVIDER_REJECTED", "account has no MetaAPI identifier");
    }
    if (deps.platformToken.trim() === "") {
      await recordSyncError(deps.pool, accountId, "NOT_CONFIGURED");
      throw new ClassifiedError("NOT_CONFIGURED", "platform token absent");
    }

    // Ownership is re-derived from the ACCOUNT ROW, never from the payload.
    const { rows } = await deps.pool.query<{ user_id: string; metaapi_account_id: string | null }>(
      "SELECT user_id, metaapi_account_id FROM trading_accounts WHERE id = $1",
      [accountId],
    );
    const row = rows[0];
    if (row === undefined || row.metaapi_account_id === null) {
      await recordSyncError(deps.pool, accountId, "NO_METAAPI_ACCOUNT_ID");
      throw new ClassifiedError("PROVIDER_REJECTED", "account not syncable");
    }

    const reservationId = await acquireReservation(
      deps.pool, accountId, row.user_id, deps.holder, leaseMs,
    );
    if (reservationId === null) {
      // Not an error condition worth retrying aggressively: another attempt
      // owns the account. The job fails with a classified code and pg-boss
      // applies the normal bounded-retry policy.
      throw new ClassifiedError("RESERVATION_HELD", "account already being synced");
    }

    try {
      const deals = await fetchHistoryDeals(
        deps.platformToken,
        { metaapiAccountId: row.metaapi_account_id, from, to },
        { baseUrl: deps.baseUrl, fetchImpl: deps.fetchImpl },
      );

      const normalized: NormalizedFill[] = [];
      for (const raw of deals) {
        if (typeof raw !== "object" || raw === null) continue;
        const fill = normalizeDeal(raw as MetaApiDeal);
        if (fill !== null) normalized.push(fill);
      }

      // The window end becomes the new cursor ONLY on success, and it is
      // written inside importBatch's transaction alongside the rows.
      await importBatch(deps.pool, {
        accountId, userId: row.user_id, metaapiAccountId: row.metaapi_account_id,
        syncCursor: from, lastSyncedAt: null,
      }, normalized, to, nowFn());
    } catch (err) {
      const code = classifyError(err);
      if (PERSISTABLE.has(code)) {
        await recordSyncError(deps.pool, accountId, code as never);
      }
      throw err; // the runner logs a CODE only; the raw error is never logged
    } finally {
      // Always released, so a failure cannot leave a permanent lock. Even if
      // this were missed, the lease expiry makes the row reclaimable.
      await releaseReservation(deps.pool, reservationId);
    }
  };
}
