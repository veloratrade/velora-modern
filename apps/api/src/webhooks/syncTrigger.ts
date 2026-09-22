// SyncTrigger — how an ingested webhook asks for the trades it implies.
//
// WHY A PORT AND NOT A DIRECT pg-boss CALL. The API and the worker are separate
// processes with separate dependency sets, and the queue is an integration
// boundary (ADR-007). Making the ingress depend on a specific queue
// implementation in its core logic would make the v0.2 ingress untestable
// without a live queue, and would spread pg-boss knowledge across two apps.
// The port keeps the boundary explicit and the ingress deterministic in tests.
//
// DEGRADATION IS DELIBERATE AND DOCUMENTED. `requestSync` returning false means
// "no immediate dispatch happened". It is NOT a failure: the webhook event is
// already recorded durably and the account is marked PENDING, so the worker's
// scheduled tick still performs the sync. A lost queue can therefore delay
// convergence; it can never lose it. This is the reason the ingress records
// first and dispatches second (never the other way round).
import { DEFAULT_JOB_POLICIES, METAAPI_SYNC_JOB_CLASS } from "@velora/contracts";
import type { MetaApiSyncPayload } from "@velora/contracts";

export interface SyncRequest {
  readonly accountId: string;
  readonly metaapiAccountId: string;
  /** Inclusive ISO-8601 window start (the account's durable cursor). */
  readonly from: string;
  /** Exclusive ISO-8601 window end (request time). */
  readonly to: string;
}

export interface SyncTrigger {
  /** Human-readable implementation name (logged at boot; never a secret). */
  readonly name: string;
  /** True when a job was actually handed to the queue. */
  requestSync(request: SyncRequest): Promise<boolean>;
  /** Release any resources. Safe to call when nothing was started. */
  close(): Promise<void>;
}

/**
 * The durable-only trigger.
 *
 * Used when no queue is configured (development, tests) and as the fallback
 * when the queue cannot be started. The ingress still records the event and
 * still marks the account pending, so the scheduled tick remains the safety net.
 */
export class DurableOnlySyncTrigger implements SyncTrigger {
  readonly name = "durable-only";
  async requestSync(): Promise<boolean> {
    return false;
  }
  async close(): Promise<void> {
    // no resources held
  }
}

/**
 * pg-boss trigger — the production path.
 *
 * Constructed lazily and once: pg-boss v10 needs the queues to exist before it
 * can accept a send, which is asynchronous work that must not happen inside a
 * request. The factory therefore runs at boot; a failure to start is reported
 * and degrades to `DurableOnlySyncTrigger` rather than crashing the API (the
 * async-analytics and authentication surfaces must not be taken down by an
 * optional integration).
 *
 * The descriptor is built with the SAME job class, idempotency key shape
 * (`sync:{accountId}:{from}`) and policy the worker's scheduler uses, so a
 * webhook-triggered sync and a tick-triggered sync for the same window are the
 * same job — under the `stately` policy the second one is debounced by pg-boss
 * itself.
 */
export class PgBossSyncTrigger implements SyncTrigger {
  readonly name = "pg-boss";

  private constructor(
    private readonly boss: { send: (name: string, data: unknown, options: Record<string, unknown>) => Promise<string | null> },
    private readonly stop: () => Promise<void>,
  ) {}

  static async create(connectionString: string): Promise<PgBossSyncTrigger> {
    const { default: PgBoss } = await import("pg-boss");
    const boss = new PgBoss({ connectionString, max: 3 });
    await boss.start();
    // Idempotent: creating an existing queue is a no-op in v10.
    await boss.createQueue(METAAPI_SYNC_JOB_CLASS, { name: METAAPI_SYNC_JOB_CLASS, policy: "stately" });
    return new PgBossSyncTrigger(
      boss as unknown as {
        send: (name: string, data: unknown, options: Record<string, unknown>) => Promise<string | null>;
      },
      async () => {
        await boss.stop({ graceful: true });
      },
    );
  }

  async requestSync(request: SyncRequest): Promise<boolean> {
    const policy = DEFAULT_JOB_POLICIES.sync;
    // The descriptor carries IDENTIFIERS and window bounds only: pg-boss
    // persists the payload across retries and into the DLQ, so a credential must
    // never enter it (ADR-007 §Security).
    const payload: MetaApiSyncPayload = {
      accountId: request.accountId,
      metaapiAccountId: request.metaapiAccountId,
      from: request.from,
      to: request.to,
    };
    const id = await this.boss.send(
      METAAPI_SYNC_JOB_CLASS,
      {
        jobClass: METAAPI_SYNC_JOB_CLASS,
        idempotencyKey: `sync:${request.accountId}:${request.from}`,
        payload,
        ...policy,
      },
      {
        singletonKey: `sync:${request.accountId}:${request.from}`,
        priority: 1,
        retryLimit: Math.max(0, policy.maxAttempts - 1),
        retryDelay: Math.ceil(policy.backoffBaseMs / 1000),
        retryBackoff: true,
        expireInSeconds: Math.ceil(policy.leaseMs / 1000),
      },
    );
    // null = duplicate singletonKey under the stately policy: already queued.
    return id !== null ? true : false;
  }

  async close(): Promise<void> {
    await this.stop();
  }
}
