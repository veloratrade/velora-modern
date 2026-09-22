// Copy-signal QUEUE — the consumer half of the v2.5 dispatch pipeline (R-1).
//
// ============================================================
// WHAT THIS OWNS
// ============================================================
// `signal_queue` (0020) already fixes the shape of a durable work item: a
// status, an attempt counter, a lease expiry and a terminal acknowledgement.
// This module implements exactly that state machine against the frozen table —
// it does NOT add columns, and it does NOT reinterpret the vocabulary:
//
//   queued ──claim──▶ dispatched ──transport ok──▶ acked      (terminal)
//      ▲                  │
//      │                  ├── transport failed, attempts < MAX ─▶ dispatched
//      │                  │     (lease moved into the future = the backoff;
//      │                  │      the tick reclaims it when the lease expires,
//      │                  └      which is 0012's stale-recovery policy verbatim)
//      │
//      └── no active follower ─▶ expired  (terminal, nothing was delivered)
//                              └─ attempts = MAX ─▶ failed (terminal)
//
// `ACKED` IS THE ONLY STATE THAT MEANS "REPLICATED". A signal that reached the
// transport boundary and came back non-ok is NOT acknowledged; it is retried
// under a moved lease and, if it keeps failing, ends `failed` with a fixed
// error code. The `signal_queue_ack_coherent` CHECK (status='acked' ⇔
// acked_at IS NOT NULL) is what the database uses to enforce that claim.
//
// ============================================================
// WHY A LEASE IS THE RETRY TIMER
// ============================================================
// There is no `next_attempt_at` column, and inventing one is a migration this
// capability does not justify — the lease column already expresses "this row is
// mine until T". Reclaiming on `lease_expires_at < now()` is exactly the
// policy 0012 established for `sync_reservations`, so the two durable queues in
// this system behave the same way.
//
// ============================================================
// TENANT BOUNDARY
// ============================================================
// Followers are read from `copy_relationships` filtered by the signal's OWN
// `leader_account_id`, and only relationships in `active` state. Nothing in
// this module accepts a caller-supplied follower: the audience is derived from
// the leader's account row that the emitter already validated. Cross-user
// leakage is therefore not a policy this code remembers to apply — it is the
// only relationship the SQL can express.
/**
 * The narrow query port this module needs (mirrors `RateQuery` in the FX path).
 *
 * The worker does NOT import the API's persistence layer — the two are separate
 * TypeScript projects (TS6059/TS6307) and, more importantly, the worker's DB
 * authority is its own least-privilege role (ADR-010). A one-method port keeps
 * that boundary explicit instead of dragging `apps/api` types across it.
 */
export interface QueryFn {
  (sql: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}

/** Adapt a `pg` Pool to the port (the battery and the index use this). */
export function poolQueryFn(pool: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}): QueryFn {
  return async (sql, params) => {
    const result = await pool.query(sql, params === undefined ? undefined : [...params]);
    return result.rows as readonly Record<string, unknown>[];
  };
}

/** A signal that is due to be dispatched. */
export interface DispatchableSignal {
  readonly id: string;
  readonly leaderAccountId: string;
  readonly leaderUserId: string;
  readonly symbol: string;
  readonly direction: "buy" | "sell";
  readonly volume: string;
  readonly price: string;
  readonly occurredAt: string;
  readonly attempts: number;
}

/** One follower the signal must reach. */
export interface FollowerTarget {
  readonly relationshipId: string;
  readonly followerAccountId: string;
  readonly followerUserId: string;
}

export interface SignalQueue {
  /** Queued or lease-expired signals that still have attempts left. */
  listDispatchable(limit: number): Promise<DispatchableSignal[]>;
  /**
   * Atomically take ownership of one signal. Returns null when another worker
   * holds the lease, or the signal already reached a terminal state — the
   * caller then does nothing, which is what makes a duplicated job harmless.
   */
  claim(id: string, leaseSeconds: number): Promise<DispatchableSignal | null>;
  /** Active followers of a leader account, in a stable order. */
  followersOf(leaderAccountId: string): Promise<FollowerTarget[]>;
  markAcked(id: string): Promise<void>;
  /** Terminal: no active follower (nothing was delivered — never "acked"). */
  markExpired(id: string, errorCode: string): Promise<void>;
  /** Failed attempt: move the lease out (retry) or go terminal (attempts >= max). */
  markFailed(id: string, errorCode: string, terminal: boolean, retryAfterSeconds: number): Promise<void>;
  /** How many attempts this signal has already made (terminal decision input). */
  attemptsOf(id: string): Promise<number>;
}

type Row = Record<string, unknown>;

function s(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function mapSignal(row: Row): DispatchableSignal {
  const direction = s(row["direction"]);
  return {
    id: s(row["id"]),
    leaderAccountId: s(row["leader_account_id"]),
    leaderUserId: s(row["leader_user_id"]),
    symbol: s(row["symbol"]),
    // 0020 CHECK (direction IN ('buy','sell')) — the cast is a narrowing of a
    // value the database has already constrained, not a validation.
    direction: direction === "sell" ? "sell" : "buy",
    volume: s(row["volume"]),
    price: s(row["price"]),
    occurredAt: row["occurred_at"] instanceof Date ? (row["occurred_at"] as Date).toISOString() : s(row["occurred_at"]),
    attempts: Number(row["attempts"] ?? 0),
  };
}

const COLUMNS =
  "id::text AS id, leader_account_id::text AS leader_account_id, leader_user_id::text AS leader_user_id, " +
  "symbol, direction, volume::text AS volume, price::text AS price, occurred_at, attempts";

/** Due = never leased, or the lease has expired (0012 stale-recovery rule). */
const DUE = "(lease_expires_at IS NULL OR lease_expires_at < now())";

export class PgSignalQueue implements SignalQueue {
  constructor(private readonly q: QueryFn) {}

  async listDispatchable(limit: number): Promise<DispatchableSignal[]> {
    const rows = await this.q(
      `SELECT ${COLUMNS} FROM signal_queue
        WHERE status IN ('queued','dispatched')
          AND ${DUE}
          AND attempts < $2
        ORDER BY created_at ASC, id ASC
        LIMIT $1::int`,
      [limit, MAX_ATTEMPTS],
    );
    return rows.map(mapSignal);
  }

  async claim(id: string, leaseSeconds: number): Promise<DispatchableSignal | null> {
    // One statement: the WHERE clause is the concurrency control. Two workers
    // racing the same signal cannot both update it — the loser's predicate is
    // false by the time it runs (row lock + re-check), so exactly one wins and
    // the other receives no row.
    const rows = await this.q(
      `UPDATE signal_queue
          SET status = 'dispatched',
              attempts = attempts + 1,
              lease_expires_at = now() + make_interval(secs => $2::int)
        WHERE id = $1::bigint
          AND status IN ('queued','dispatched')
          AND ${DUE}
        RETURNING ${COLUMNS}`,
      [id, leaseSeconds],
    );
    const row = rows[0];
    return row === undefined ? null : mapSignal(row);
  }

  async followersOf(leaderAccountId: string): Promise<FollowerTarget[]> {
    const rows = await this.q(
      `SELECT id::text AS id,
              follower_account_id::text AS follower_account_id,
              follower_user_id::text AS follower_user_id
         FROM copy_relationships
        WHERE leader_account_id = $1::bigint
          AND status = 'active'
        ORDER BY id ASC`,
      [leaderAccountId],
    );
    return rows.map((row: Row) => ({
      relationshipId: s(row["id"]),
      followerAccountId: s(row["follower_account_id"]),
      followerUserId: s(row["follower_user_id"]),
    }));
  }

  async markAcked(id: string): Promise<void> {
    // acked_at is set in the SAME statement as the status, so the
    // signal_queue_ack_coherent CHECK can never see a half-applied ack.
    await this.q(
      "UPDATE signal_queue SET status = 'acked', acked_at = now(), lease_expires_at = NULL WHERE id = $1::bigint",
      [id],
    );
  }

  async markExpired(id: string, errorCode: string): Promise<void> {
    // `status IN ('queued','dispatched')` is deliberate: a terminal state is
    // terminal. A late or duplicated call must not turn an `acked` (delivered)
    // signal into `expired`, nor overwrite a recorded failure.
    await this.q(
      `UPDATE signal_queue SET status = 'expired', last_error_code = $2, lease_expires_at = NULL
        WHERE id = $1::bigint AND status IN ('queued','dispatched')`,
      [id, errorCode],
    );
  }

  async markFailed(id: string, errorCode: string, terminal: boolean, retryAfterSeconds: number): Promise<void> {
    if (terminal) {
      await this.q(
        `UPDATE signal_queue SET status = 'failed', last_error_code = $2, lease_expires_at = NULL
          WHERE id = $1::bigint AND status IN ('queued','dispatched')`,
        [id, errorCode],
      );
      return;
    }
    // Retry: stay in 'dispatched' (a claim is still outstanding) and push the
    // lease out by the backoff interval. The row becomes reclaimable the moment
    // that lease expires — no separate scheduler state, no sleeping worker.
    await this.q(
      `UPDATE signal_queue
          SET last_error_code = $2,
              lease_expires_at = now() + make_interval(secs => $3::int)
        WHERE id = $1::bigint AND status = 'dispatched'`,
      [id, errorCode, retryAfterSeconds],
    );
  }

  async attemptsOf(id: string): Promise<number> {
    const rows = await this.q("SELECT attempts FROM signal_queue WHERE id = $1::bigint", [id]);
    const row = rows[0];
    return row === undefined ? 0 : Number(row["attempts"] ?? 0);
  }
}

/**
 * Attempt ceiling for the queue's own state machine.
 *
 * Deliberately independent of pg-boss's per-job `maxAttempts` (ADR-007 job
 * policy): the job may be retried by the queue, but the SIGNAL must reach a
 * terminal state that a human can act on, and that decision belongs to the
 * signal's own counter — the durable one. Five attempts with the backoff below
 * spans roughly half an hour before a signal is declared failed.
 */
export const MAX_ATTEMPTS = 5;

/** Deterministic backoff (seconds): 30, 60, 120, 240 … capped at 15 minutes. */
export function retryDelaySeconds(attempts: number): number {
  const base = 30;
  const exponential = base * 2 ** Math.max(0, attempts - 1);
  return Math.min(exponential, 900);
}
