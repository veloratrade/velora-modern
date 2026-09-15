// The scheduled producer — the FIRST legitimate job producer in this system.
//
// WHY THIS IS NOT AN INVENTED SCHEDULER
// =====================================
// ADR-007 (D-13) adopted pg-boss, and pg-boss 10.4.2 ships a NATIVE cron
// scheduler: `boss.schedule(queue, cron, data)` persists a row in
// `pgboss.schedule`, and the timekeeper fires it through the internal
// `__pgboss__send-it` queue. No second application, no second service, no host
// cron, and no new dependency is introduced — the mechanism already exists in
// the dependency the ADR selected. That is the smallest repository-authorized
// scheduling mechanism available, which is exactly what the owner asked for.
//
// WHY A FAN-OUT TICK RATHER THAN ONE CRON ROW PER ACCOUNT
// Accounts come and go at runtime, and pg-boss schedules are durable rows. One
// row per account would need lifecycle management (create/delete on every
// account change) and would silently rot when an account is deleted. Instead a
// single cron row fires a TICK, and the tick enqueues one sync job per
// currently-eligible account, read live from the database.
//
// NOTHING FABRICATED: the tick enqueues a job ONLY for an account that already
// carries a `metaapi_account_id`. With zero such accounts it enqueues zero
// jobs — the correct behaviour for an installation that has not connected any
// MetaAPI account, and the reason this producer cannot manufacture work.
import type { Pool } from "pg";
import { METAAPI_SYNC_JOB_CLASS, DEFAULT_JOB_POLICIES } from "@velora/contracts";
import type { MetaApiSyncPayload, SafeJobDescriptor } from "@velora/contracts";
import type { QueuePort } from "../queue/QueuePort.js";
import { listSyncableAccounts } from "../metaapi/syncRepository.js";

/** Queue that carries the scheduler tick itself. */
export const SYNC_TICK_JOB_CLASS = "metaapi.sync-tick";

/**
 * Default cadence: hourly, on the hour.
 *
 * Conservative by intent — historical sync is a catch-up mechanism, not a
 * realtime feed, and ADR-007 requires bounded load on the shared PostgreSQL.
 */
export const DEFAULT_SYNC_CRON = "0 * * * *";

/**
 * How far back a first-ever sync reaches.
 *
 * Mirrors the VERIFIED legacy bound (`months` clamped to 12, floor
 * `-12 months`) rather than inventing a retention policy.
 */
export const INITIAL_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Build the descriptor for one account's sync job.
 *
 * IDEMPOTENCY: `idempotencyKey` follows the ADR-007 business-key shape
 * `sync:{accountId}:{cursor}`. Queues are created with the pg-boss `stately`
 * policy, under which a repeated singletonKey returns null instead of
 * inserting a second row — so a tick that runs twice for the same account and
 * window enqueues ONE job, not two.
 *
 * PAYLOAD SAFETY: `SafeJobPayload` permits flat scalars only, and every field
 * here is an identifier or a window bound. No token, no credential, no
 * ciphertext ever enters a pg-boss payload (ADR-007 §Security, D-2 term 9).
 */
export function buildSyncDescriptor(
  accountId: string,
  metaapiAccountId: string,
  from: string,
  to: string,
): SafeJobDescriptor<MetaApiSyncPayload> {
  const policy = DEFAULT_JOB_POLICIES.sync;
  return {
    jobClass: METAAPI_SYNC_JOB_CLASS,
    priorityClass: "sync",
    idempotencyKey: `sync:${accountId}:${from}`,
    payload: { accountId, metaapiAccountId, from, to },
    ...policy,
  };
}

/**
 * One scheduler tick: enqueue a historical-sync job per eligible account.
 *
 * Returns the number of jobs enqueued (0 is a legitimate, common result).
 */
export async function runSyncTick(
  pool: Pool,
  queue: QueuePort,
  now: Date = new Date(),
): Promise<number> {
  const accounts = await listSyncableAccounts(pool);
  const to = now.toISOString();
  let enqueued = 0;

  for (const account of accounts) {
    // The window starts at the durable cursor. Only a first-ever sync falls
    // back to the lookback bound — the cursor is never guessed thereafter.
    const from = account.syncCursor ?? new Date(now.getTime() - INITIAL_LOOKBACK_MS).toISOString();
    if (from >= to) continue; // nothing to ask for; never emit an inverted window

    await queue.enqueue(
      buildSyncDescriptor(account.accountId, account.metaapiAccountId, from, to),
    );
    enqueued++;
  }
  return enqueued;
}
