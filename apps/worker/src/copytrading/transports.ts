// Copy-transport BOUNDARY — the last internal step before an external system.
//
// ============================================================
// WHY THIS IS A PORT AND NOT AN INTEGRATION
// ============================================================
// Replicating a signal onto a follower's account ends in a broker-facing action:
// either the MetaAPI copy endpoint (which needs the installation's platform
// token and a live provisioned follower account) or an EA command channel.
// Neither exists in this environment, and neither may be faked — a "transport"
// that reported success without delivering would make the queue's `acked` state
// a lie, and `acked` is the only state this system presents as replication.
//
// So the boundary is implemented and its absence is EXPLICIT:
//
//   * `CopyTransport`         — what a real transport must satisfy;
//   * `resolveCopyTransport`  — the registry, currently EMPTY, which therefore
//                               returns "no transport" rather than a stub;
//   * the worker registers its dispatch handler ONLY when a transport exists
//                               (apps/worker/src/index.ts), so a deployment
//                               without one never claims signals it cannot
//                               deliver — the same fail-closed discipline the
//                               MetaAPI handler uses for a missing token.
//
// WHAT IS PROVEN WITHOUT ONE: the producer, the durable queue, the lease, the
// attempt/backoff state machine, the follower mapping, the idempotency key and
// the terminal transitions — all against real PostgreSQL (db/tests/
// copyDispatch.pg.test.ts). WHAT IS NOT PROVEN: that a real broker/EA accepted
// and executed a replicated signal. That is reported as NOT_PROVEN, not as
// copied-under-a-millisecond.
//
// ============================================================
// IDEMPOTENCY KEY
// ============================================================
// `copy-signal:{signalId}:{followerAccountId}` — one key per (signal, follower)
// pair, stable across retries, and containing no user data beyond identifiers
// the transport already needs. A transport that receives the same key twice must
// converge on one execution; that requirement is the port's contract, and it is
// the reason the retry path above it is safe to be at-least-once.
export interface CopyDispatchRequest {
  readonly signalId: string;
  readonly idempotencyKey: string;
  readonly followerAccountId: string;
  readonly followerUserId: string;
  readonly leaderAccountId: string;
  readonly symbol: string;
  readonly direction: "buy" | "sell";
  /** Exact decimal string (never a JS number). */
  readonly volume: string;
  readonly price: string;
  /** UTC instant of the leader's event (ISO-8601). */
  readonly occurredAt: string;
}

export type CopyDispatchResult =
  | { readonly ok: true }
  /** `errorCode` must satisfy ^[A-Z0-9_]{1,48}$ — it is written to the queue. */
  | { readonly ok: false; readonly errorCode: string };

export interface CopyTransport {
  /** Non-secret name, for the log line (never a credential). */
  readonly name: string;
  dispatch(request: CopyDispatchRequest): Promise<CopyDispatchResult>;
}

export interface CopyTransportResolution {
  readonly transport: CopyTransport | null;
  /** The value that was requested but is not available, if any (for logging). */
  readonly requested: string | null;
}

/**
 * The transport registry.
 *
 * EMPTY BY DESIGN — see the header. There is deliberately no "loopback" or
 * "noop" entry: a transport that always returns `ok` would let the pipeline
 * report `acked` for a signal no follower ever received, which is precisely the
 * fake-completeness conversion this pass forbids.
 *
 * A deployment that sets `COPY_TRANSPORT` to a name this build does not
 * implement gets a warning and NO transport (fail closed) rather than a
 * silently idle pipeline.
 */
export function resolveCopyTransport(env: NodeJS.ProcessEnv = process.env): CopyTransportResolution {
  const requested = env["COPY_TRANSPORT"]?.trim() ?? "";
  if (requested === "") return { transport: null, requested: null };
  return { transport: null, requested };
}
