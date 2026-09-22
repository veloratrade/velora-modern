// Copy-signal DISPATCH handler — `copy.signal-dispatch`.
//
// ============================================================
// ONE JOB = ONE SIGNAL, FANNED OUT TO ITS ACTIVE FOLLOWERS
// ============================================================
// The job payload carries a signal id and nothing else. Everything else — the
// leader, the audience, the volume, the price — is read from the database at
// execution time, so a replayed payload cannot replay a stale audience, and a
// follower who revoked between enqueue and execution is simply not in the set.
//
// ============================================================
// ERROR HANDLING — WHERE THE DECISION BELONGS
// ============================================================
// TRANSPORT failures do NOT throw. A non-ok transport result is recorded on the
// signal (`last_error_code`, attempt counter, moved lease) and the job returns
// normally: the retry of a signal is driven by the signal's own durable state
// and the tick that reads it, not by the queue's attempt policy. Throwing would
// make two independent retry mechanisms race over one row.
//
// DATABASE failures DO throw, because then the handler cannot record anything
// at all: the runner's failure path is the only remaining signal that something
// is wrong, and the queue's own retry/DLQ policy (ADR-007) applies.
//
// ============================================================
// WHAT "DELIVERED" MEANS HERE
// ============================================================
// The handler marks a signal `acked` only when EVERY active follower's dispatch
// returned ok. If some followers succeed and others fail, the signal is retried
// with the same per-(signal, follower) idempotency keys, so the followers that
// already succeeded converge instead of duplicating — that is what the key is
// for. There is no partial-ack state in 0020 and none is invented; the signal's
// terminal state is therefore the AND of its followers.
import type { QueuedJob } from "../queue/QueuePort.js";
import { MAX_ATTEMPTS, retryDelaySeconds, type SignalQueue } from "./signalQueue.js";
import type { CopyTransport } from "./transports.js";

export const COPY_SIGNAL_JOB_CLASS = "copy.signal-dispatch";

export interface CopyDispatchDeps {
  readonly queue: SignalQueue;
  readonly transport: CopyTransport;
  readonly log: (event: Record<string, unknown>) => void;
  /** Lease held while dispatching (seconds). Must exceed worst-case runtime. */
  readonly leaseSeconds?: number;
}

export interface CopyDispatchOutcome {
  readonly status: "skipped" | "expired" | "acked" | "retry" | "failed";
  readonly delivered: number;
  readonly failed: number;
}

function signalIdOf(job: QueuedJob): string {
  const raw = (job.descriptor.payload as Record<string, unknown> | undefined)?.["signalId"];
  return typeof raw === "string" ? raw : "";
}

/** One per (signal, follower) pair, stable across retries. */
export function copyIdempotencyKey(signalId: string, followerAccountId: string): string {
  return `copy-signal:${signalId}:${followerAccountId}`;
}

/**
 * Build the handler. Exported as a factory (not a bare function) so the
 * transport is injected and the battery can drive it with a stub that fails on
 * demand — no provider is ever contacted by a test.
 */
export function createCopyDispatchHandler(deps: CopyDispatchDeps) {
  const leaseSeconds = deps.leaseSeconds ?? 120;

  return async function handleCopySignal(job: QueuedJob): Promise<void> {
    const signalId = signalIdOf(job);
    if (signalId === "") throw new Error("copy.signal-dispatch: missing signalId");

    // CLAIM. Null means: another worker owns the lease, or the signal reached a
    // terminal state already. Both are normal, and both must be silent no-ops —
    // that is the idempotency property a duplicated job relies on.
    const signal = await deps.queue.claim(signalId, leaseSeconds);
    if (signal === null) {
      deps.log({ level: "info", event: "copy.dispatch_skipped", signalId, outcome: "skipped" });
      return;
    }

    const followers = await deps.queue.followersOf(signal.leaderAccountId);
    if (followers.length === 0) {
      // Terminal, and NOT acked: nobody received this signal, and saying
      // otherwise would inflate the replication record. `expired` is the
      // vocabulary's only non-error terminal state.
      await deps.queue.markExpired(signal.id, "NO_ACTIVE_FOLLOWER");
      deps.log({
        level: "info",
        event: "copy.dispatch_expired",
        signalId: signal.id,
        outcome: "expired",
        reason: "NO_ACTIVE_FOLLOWER",
      });
      return;
    }

    let delivered = 0;
    let failureCode: string | null = null;
    for (const follower of followers) {
      let result;
      try {
        result = await deps.transport.dispatch({
          signalId: signal.id,
          idempotencyKey: copyIdempotencyKey(signal.id, follower.followerAccountId),
          followerAccountId: follower.followerAccountId,
          followerUserId: follower.followerUserId,
          leaderAccountId: signal.leaderAccountId,
          symbol: signal.symbol,
          direction: signal.direction,
          volume: signal.volume,
          price: signal.price,
          occurredAt: signal.occurredAt,
        });
      } catch {
        // A transport that THROWS is a transport failure, not a crash of the
        // signal's state machine. The error text is never read or recorded: it
        // can embed the request (and therefore user data) — a fixed code is
        // stored instead.
        result = { ok: false as const, errorCode: "TRANSPORT_ERROR" };
      }
      if (result.ok) delivered += 1;
      else if (failureCode === null) failureCode = result.errorCode;
    }

    if (failureCode === null) {
      await deps.queue.markAcked(signal.id);
      deps.log({
        level: "info",
        event: "copy.dispatch_acked",
        signalId: signal.id,
        outcome: "acked",
        count: delivered,
      });
      return;
    }

    const failed = followers.length - delivered;
    // `signal.attempts` was incremented by THIS claim, so it is the true count
    // of dispatch attempts — the terminal decision reads it, not a local guess.
    const terminal = signal.attempts >= MAX_ATTEMPTS;
    const delay = retryDelaySeconds(signal.attempts);
    await deps.queue.markFailed(signal.id, failureCode, terminal, delay);
    deps.log({
      level: terminal ? "error" : "warn",
      event: terminal ? "copy.dispatch_failed" : "copy.dispatch_retry",
      signalId: signal.id,
      outcome: terminal ? "failed" : "retry",
      count: failed,
      code: failureCode,
    });
  };
}
