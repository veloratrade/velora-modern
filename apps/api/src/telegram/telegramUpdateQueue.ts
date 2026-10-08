// Telegram update queue — the API-side producer for MG-TG-3.
//
// WHY THIS EXISTS AS A SEPARATE MODULE. The webhook ingress must answer
// Telegram quickly (200) while the media download + model call that follows
// does NOT fit in a request budget. The previous `acceptDeferred` claimed the
// update and then ran `setTimeout(() => processClaimed)` inside the API
// process — the work still occupied an API slot after the answer, and a slow
// voice note blocked that slot. Moving the same `TelegramUpdate` through the
// existing `pg-boss` boundary reuses the worker deployment that already exists
// (ADR-007/D-13) and frees the API process immediately.
//
// WHAT THIS MODULE OWNS
//   * THE JOB CLASS. `telegram.update` — the worker half consumes exactly this
//     name, created `stately` so a redelivered webhook enqueues ONE job, not
//     two (the `singletonKey` is the Telegram `update_id`).
//   * THE PAYLOAD SHAPE. `TelegramUpdatePayload` is a `SafeJobPayload` (flat
//     scalars only, never a secret). The full `TelegramUpdate` travels as a
//     JSON string (`updateJson`) because pg-boss persists payloads and the queue
//     must never receive a nested credential shape.
//   * THE PRODUCER CONTRACT. `TelegramUpdateQueue` is the only thing the API
//     needs to know about the queue — it enqueues one update and returns the
//     boss id (or a `dup:` marker when the `stately` dedupe converged).
//
// WHAT IT DOES NOT OWN. `claimUpdate` semantics — the API still claims the
// update BEFORE enqueueing so a retry of the same `update_id` is recognised
// as a duplicate at the HTTP layer (200 duplicate) rather than enqueued twice.
// The worker then re-parses the same JSON and calls `processClaimed` (the
// update is already claimed, so the worker does not claim again). If the
// enqueue fails the claim already exists and a retry will be answered as a
// duplicate — a narrow window (claim succeeded, enqueue did not) that is
// logged and surfaced as 503 so the caller (Telegram) will retry; the next
// retry will be a duplicate and will not be lost. In the steady state the
// queue IS the durability: a crash after enqueue loses nothing because the
// job row survives, and a duplicate webhook converges via the `stately`
// singletonKey.

import type { SafeJobDescriptor } from "@velora/contracts";
import {
  DEFAULT_JOB_POLICIES,
  TELEGRAM_UPDATE_JOB_CLASS,
  type TelegramUpdatePayload,
} from "@velora/contracts";
import type { TelegramUpdate } from "@velora/contracts";

/**
 * The minimal queue surface the API needs — one method, one job class.
 *
 * Implementations are `Memory` (tests) and `PgBoss` (production). The return
 * is the boss `id` for a fresh enqueue or `dup:<key>` when the `stately`
 * policy reported a duplicate (the contract converged, not an error).
 */
export interface TelegramUpdateQueue {
  enqueue(update: TelegramUpdate): Promise<string>;
  stop?(): Promise<void>;
}

/**
 * Build the descriptor for one Telegram update.
 *
 * `idempotencyKey` is the Telegram `update_id` — the same value the
 * `telegram_updates` claim uses, so the queue's `singletonKey` and the
 * table's primary key agree on what "same update" means.
 */
export function buildTelegramUpdateDescriptor(
  update: TelegramUpdate,
): SafeJobDescriptor<TelegramUpdatePayload> {
  const policy = DEFAULT_JOB_POLICIES.ai; // media + model fits the ai budget (60s/120s/3)
  const updateId = String(update.update_id);
  const kind =
    update.message !== undefined
      ? "message"
      : update.callback_query !== undefined
        ? "callback_query"
        : update.edited_message !== undefined
          ? "edited_message"
          : "other";
  return {
    jobClass: TELEGRAM_UPDATE_JOB_CLASS,
    priorityClass: "ai",
    idempotencyKey: `telegram.update:${updateId}`,
    payload: {
      updateId,
      updateJson: JSON.stringify(update),
      kind,
    },
    ...policy,
  };
}

// ── Memory double (tests + offline boots) ────────────────────────────────

export class MemoryTelegramUpdateQueue implements TelegramUpdateQueue {
  readonly enqueued: TelegramUpdate[] = [];
  readonly descriptors: SafeJobDescriptor<TelegramUpdatePayload>[] = [];

  async enqueue(update: TelegramUpdate): Promise<string> {
    const descriptor = buildTelegramUpdateDescriptor(update);
    // Dedupe like pg-boss `stately`: same update_id converges.
    if (this.enqueued.some((u) => String(u.update_id) === String(update.update_id))) {
      return `dup:telegram.update:${String(update.update_id)}`;
    }
    this.enqueued.push(update);
    this.descriptors.push(descriptor);
    return `mem:${String(update.update_id)}`;
  }
}

// ── pg-boss production producer ─────────────────────────────────────────

/**
 * Create a pg-boss-backed queue for `telegram.update`.
 *
 * The caller must provide the Postgres `connectionString` (the API's own
 * `DATABASE_URL` — the same database the worker's `pgBossAdapter` uses, so
 * the job row is visible to the worker). The queue is created `stately`
 * and the dead-letter queue is the same `velora.dlq` the worker creates —
 * whichever side starts first creates it, the other re-uses it, so boot
 * order does not matter.
 *
 * Lifecycle: call `stop()` on shutdown to release the boss's pool. The API
 * process does not poll this queue, it only enqueues; the worker polls.
 */
export async function createPgTelegramUpdateQueue(
  connectionString: string,
): Promise<TelegramUpdateQueue & { stop(): Promise<void> }> {
  const { default: PgBoss } = await import("pg-boss");
  const boss = new PgBoss({ connectionString, max: 2 });
  await boss.start();

  const dlqName = "velora.dlq";
  await boss.createQueue(dlqName, { name: dlqName, policy: "standard" });
  await boss.createQueue(TELEGRAM_UPDATE_JOB_CLASS, {
    name: TELEGRAM_UPDATE_JOB_CLASS,
    policy: "stately",
    deadLetter: dlqName,
  });

  return {
    async enqueue(update: TelegramUpdate): Promise<string> {
      const descriptor = buildTelegramUpdateDescriptor(update);
      const id = await boss.send(
        descriptor.jobClass,
        descriptor as unknown as Record<string, unknown>,
        {
          singletonKey: descriptor.idempotencyKey,
          priority: 1,
          retryLimit: Math.max(0, descriptor.maxAttempts - 1),
          retryDelay: Math.ceil(descriptor.backoffBaseMs / 1000),
          retryBackoff: true,
          expireInSeconds: Math.ceil(descriptor.leaseMs / 1000),
        },
      );
      if (id === null) return `dup:${descriptor.idempotencyKey}`;
      return id;
    },
    async stop(): Promise<void> {
      await boss.stop({ graceful: true });
    },
  };
}
