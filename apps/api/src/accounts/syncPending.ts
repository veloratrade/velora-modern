// The durable "work is outstanding" marker for an account — ONE implementation.
//
// It was written inline in the composition root for the webhook ingress. The
// user-triggered sync needs exactly the same statement, and two copies of a
// state transition are two chances to disagree about what it means, so it lives
// here and both callers take it from here.
//
// `sync_status` is constrained by migration 0004 to
// DISCONNECTED | CONNECTING | SYNCING | CONNECTED | ERROR. There is no
// "PENDING": the closest TRUE statement the vocabulary can make is CONNECTING
// ("not yet converged"). The durable record of the outstanding work is the
// queued job (and, for webhooks, the `webhook_events` row) — not this column.
// Writing an out-of-vocabulary value would be rejected by the engine (found by
// the real-PG battery).
//
// The UPDATE is deliberately conditional: an account that is already SYNCING or
// CONNECTED must not be dragged backwards to CONNECTING by a duplicate request,
// because the worker sets those states when it actually takes the work.
import type { QueryFn } from "../persistence/pg.js";

export function makeSyncPendingMarker(q: QueryFn): (accountId: string) => Promise<void> {
  return async (accountId: string): Promise<void> => {
    await q(
      "UPDATE trading_accounts SET sync_status = 'CONNECTING', updated_at = now() WHERE id = $1 AND sync_status NOT IN ('SYNCING', 'CONNECTED')",
      [accountId],
    );
  };
}
