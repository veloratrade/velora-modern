// COPY-TRADING pipeline battery — real PostgreSQL (v2.5, R-1).
//
// EVIDENCE LABEL (Phase D policy): executes ONLY against a REAL, disposable
// PostgreSQL (DATABASE_URL — postgres-evidence workflow). Without it, every test
// is SKIPPED.
//
// WHAT THIS PROVES, and why it is the honest ceiling for this capability:
//
//   * the PRODUCER writes exactly one signal per leader event, only when an
//     ACTIVE relationship makes that leader a source, inside the trade's own
//     transaction (rollback leaves neither row);
//   * the QUEUE's state machine (0018's `signal_queue`) behaves as specified on
//     real SQL: a claim is exclusive, the lease is the retry timer, the attempt
//     counter drives the terminal decision, and the ack-coherence CHECK holds;
//   * the FOLLOWER MAPPING reads only ACTIVE relationships of the signal's own
//     leader account — the tenant boundary is the WHERE clause, not a check the
//     application remembers to perform;
//   * the DISPATCH HANDLER, driven through the real queue with a stub transport,
//     delivers one idempotency key per (signal, follower), acks only when every
//     follower accepted, and retries → fails terminally when it does not.
//
// WHAT THIS DOES NOT PROVE (reported as NOT_PROVEN, never as "copy trading
// works"): that a real broker or EA accepted and executed a replicated signal.
// The transport registry is empty by design; a deployment configures one, and
// that integration is the external boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareDatabase } from "./support/pgTestDb.ts";
import { PgTradeStore } from "../../apps/api/src/trades/pgTradeStore.ts";
import type { NewTrade, StoredTradeEvent } from "../../apps/api/src/trades/tradeStore.ts";
import { emitCopySignal, tradeOpenedSignal, tradeExitSignal } from "../../apps/api/src/tenancy/copySignalEmitter.ts";
import { PgSignalQueue, MAX_ATTEMPTS } from "../../apps/worker/src/copytrading/signalQueue.ts";
import { createCopyDispatchHandler } from "../../apps/worker/src/copytrading/copyDispatchHandler.ts";
import type { CopyDispatchRequest, CopyTransport } from "../../apps/worker/src/copytrading/transports.ts";
import type { QueuedJob } from "../../apps/worker/src/queue/QueuePort.ts";
import type { Pool, PoolClient } from "pg";

const PG_URL = process.env.DATABASE_URL;
const SKIP = PG_URL === undefined
  ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)"
  : false;

interface Fixture {
  pool: Pool;
  owner: string;
  follower: string;
  leaderAccount: string;
  followerAccount: string;
  close: () => Promise<void>;
}

/** Two users, two accounts, and a helper to open/close relationships. */
async function harness(): Promise<Fixture> {
  const { Pool } = await import("pg");
  await (await prepareDatabase(PG_URL as string)).close();
  const pool = new Pool({ connectionString: PG_URL });
  const users = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1,$2), ($3,$4) RETURNING id::text AS id, email`,
    ["copy-leader@velora.test", "x", "copy-follower@velora.test", "y"],
  );
  const idOf = (email: string): string =>
    String((users.rows as { id: string; email: string }[]).find((r) => r.email === email)?.id);
  const owner = idOf("copy-leader@velora.test");
  const follower = idOf("copy-follower@velora.test");

  const accounts = await pool.query(
    `INSERT INTO trading_accounts
       (user_id, provider, platform, label, account_number_masked, currency, leverage,
        timezone, timezone_source, status, balance, equity, starting_balance, account_type)
     VALUES ($1,'MANUAL','manual','leader','****1111','USD','100','UTC','user_config','connected','10000.00','10000.00','10000.00','live'),
            ($2,'MANUAL','manual','follower','****2222','USD','100','UTC','user_config','connected','5000.00','5000.00','5000.00','live')
     RETURNING id::text AS id, user_id::text AS user_id`,
    [owner, follower],
  );
  const acct = (userId: string): string =>
    String((accounts.rows as { id: string; user_id: string }[]).find((r) => r.user_id === userId)?.id);

  return {
    pool,
    owner,
    follower,
    leaderAccount: acct(owner),
    followerAccount: acct(follower),
    close: () => pool.end(),
  };
}

let uidCounter = 0;
const newEvent = (type: StoredTradeEvent["type"], expectedVersion: number): StoredTradeEvent => ({
  eventUid: `copy-pg-${Date.now()}-${++uidCounter}`,
  tradeId: "",
  type,
  actor: "user",
  expectedVersion,
  payload: { probe: "copy-pg" },
  at: "2026-09-20T09:00:00.000Z",
});

function newTrade(userId: string, accountId: string, over: Partial<NewTrade> = {}): NewTrade {
  return {
    userId,
    accountId,
    symbol: "EURUSD",
    direction: "buy",
    status: "OPEN",
    entryPrice: "1.10000000",
    exitPrice: null,
    volume: "0.50000000",
    contractSize: "100000.00000000",
    commission: "5.00",
    swap: "0.00",
    netPnl: null,
    rMultiple: null,
    stopLoss: "1.09700000",
    takeProfit: null,
    strategy: null,
    emotion: null,
    notes: null,
    openAtUtc: "2026-09-20T09:00:00.000Z",
    closeAtUtc: "2026-09-20T09:00:00.000Z",
    timeStatus: "resolved",
    sourceTimezone: "UTC",
    sourceTimezoneSource: "user_config",
    sourceCalendar: "proleptic-gregorian",
    rawOpenText: null,
    rawCloseText: null,
    source: "manual",
    externalDealId: null,
    ...over,
  };
}

async function relate(
  pool: Pool,
  f: { owner: string; follower: string; leaderAccount: string; followerAccount: string },
  status: string,
): Promise<string> {
  const res = await pool.query(
    `INSERT INTO copy_relationships
       (leader_user_id, follower_user_id, leader_account_id, follower_account_id,
        allocation_mode, allocation_value, status)
     VALUES ($1,$2,$3,$4,'proportional','1.00000000',$5)
     RETURNING id::text AS id`,
    [f.owner, f.follower, f.leaderAccount, f.followerAccount, status],
  );
  return String((res.rows[0] as { id: string }).id);
}

const signalRows = async (pool: Pool, leaderAccountId: string) =>
  (await pool.query(
    `SELECT id::text AS id, direction, volume::text AS volume, price::text AS price,
            occurred_at, status, attempts, lease_expires_at, last_error_code, acked_at
       FROM signal_queue WHERE leader_account_id = $1::bigint ORDER BY id`,
    [leaderAccountId],
  )).rows as Record<string, unknown>[];

// ---------------------------------------------------------------------------
// PRODUCER — the outbox half
// ---------------------------------------------------------------------------

test("PG: an event on a leader with NO active relationship writes nothing", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const emitted = await emitCopySignal(
      async (sql, params) => (await h.pool.query(sql, params as unknown[])).rows,
      {
        leaderAccountId: h.leaderAccount,
        leaderUserId: h.owner,
        symbol: "EURUSD",
        direction: "buy",
        volume: "0.50000000",
        price: "1.10000000",
        occurredAt: "2026-09-20T09:00:00.000Z",
      },
    );
    assert.equal(emitted, null, "no audience ⇒ no signal row (the common case, not an error)");
    assert.equal((await signalRows(h.pool, h.leaderAccount)).length, 0);
  } finally {
    await h.close();
  }
});

test("PG: only an ACTIVE relationship makes an account a copy source", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const rel = await relate(h.pool, h, "pending");
    const q = async (sql: string, params?: readonly unknown[]) => (await h.pool.query(sql, params as unknown[])).rows;
    const input = {
      leaderAccountId: h.leaderAccount,
      leaderUserId: h.owner,
      symbol: "EURUSD",
      direction: "buy" as const,
      volume: "0.50000000",
      price: "1.10000000",
      occurredAt: "2026-09-20T09:00:00.000Z",
    };
    assert.equal(await emitCopySignal(q, input), null, "pending is not consent to copy");

    await h.pool.query("UPDATE copy_relationships SET status = 'active' WHERE id = $1::bigint", [rel]);
    const emitted = await emitCopySignal(q, input);
    assert.notEqual(emitted, null);
    assert.match(String(emitted), /^\d+$/);

    // A second relationship for a DIFFERENT leader account must not widen the
    // audience: the EXISTS is anchored on the signal's own account.
    const otherAccount = await h.pool.query(
      `INSERT INTO trading_accounts
         (user_id, provider, platform, label, account_number_masked, currency, leverage,
          timezone_source, status, balance, equity, starting_balance, account_type)
       VALUES ($1,'MANUAL','manual','other','****3333','USD','100','unknown','connected','1.00','1.00','1.00','live')
       RETURNING id::text AS id`,
      [h.owner],
    );
    await h.pool.query(
      `INSERT INTO copy_relationships
         (leader_user_id, follower_user_id, leader_account_id, follower_account_id, allocation_mode, allocation_value, status)
       VALUES ($1,$2,$3,$4,'proportional','1.00000000','active')`,
      [h.owner, h.follower, String((otherAccount.rows[0] as { id: string }).id), h.followerAccount],
    );
    assert.equal(await emitCopySignal(q, { ...input, leaderAccountId: String((otherAccount.rows[0] as { id: string }).id) }) !== null, true);

    const rows = await signalRows(h.pool, h.leaderAccount);
    assert.equal(rows.length, 1, "one signal for one event on one leader account");
    const row = rows[0] as Record<string, unknown>;
    assert.equal(row["direction"], "buy");
    assert.equal(row["volume"], "0.50000000", "NUMERIC(20,8) round-trips exactly (ADR-001)");
    assert.equal(row["price"], "1.10000000");
    assert.equal(row["status"], "queued");
    assert.equal(row["attempts"], 0);
    assert.equal(row["lease_expires_at"], null);
    assert.equal(row["acked_at"], null, "a queued signal is never acked");
  } finally {
    await h.close();
  }
});

test("PG: the signal is written INSIDE the trade's transaction — rollback leaves neither row", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await relate(h.pool, h, "active");
    const store = new PgTradeStore(h.pool, {
      onTradeCreated: async (q, trade) => {
        const input = tradeOpenedSignal(trade);
        assert.ok(input !== null);
        await emitCopySignal(q, input);
      },
    });

    // (a) committed: trade + signal, one transaction.
    const trade = await store.createTrade(newTrade(h.owner, h.leaderAccount), { ...newEvent("TRADE_CREATED", 0), tradeId: "0" });
    assert.equal((await signalRows(h.pool, h.leaderAccount)).length, 1);

    // (b) a hook that fails must roll the TRADE back with it: a committed trade
    // whose signal silently vanished is the failure mode this design rules out.
    const failing = new PgTradeStore(h.pool, {
      onTradeCreated: async () => {
        throw new Error("producer is down");
      },
    });
    await assert.rejects(() =>
      failing.createTrade(newTrade(h.owner, h.leaderAccount, { symbol: "GBPUSD" }), { ...newEvent("TRADE_CREATED", 0), tradeId: "0" }),
    );
    const trades = await h.pool.query("SELECT symbol FROM trades WHERE user_id = $1::bigint ORDER BY symbol", [h.owner]);
    assert.deepEqual(
      (trades.rows as { symbol: string }[]).map((r) => r.symbol),
      [trade.symbol],
      "the failed hook left no trade behind — atomicity, not best effort",
    );
    assert.equal((await signalRows(h.pool, h.leaderAccount)).length, 1, "and no half-written signal either");
  } finally {
    await h.close();
  }
});

test("PG: an exit is mirrored as the OPPOSITE side at the exit's own volume and price", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await relate(h.pool, h, "active");
    const store = new PgTradeStore(h.pool, {
      onTradeCreated: async (q, trade) => {
        await emitCopySignal(q, tradeOpenedSignal(trade) as never);
      },
      onExitRecorded: async (q, trade, exit) => {
        await emitCopySignal(q, tradeExitSignal(trade, exit) as never);
      },
    });
    const trade = await store.createTrade(newTrade(h.owner, h.leaderAccount), { ...newEvent("TRADE_CREATED", 0), tradeId: "0" });
    const exit = await store.recordExit(
      trade.id,
      h.owner,
      {
        exitType: "manual",
        exitPrice: "1.10500000",
        volume: "0.50000000",
        pnl: "25.00",
        exitedAt: "2026-09-20T14:00:00.000Z",
        notes: null,
      },
      { ...newEvent("EXIT_RECORDED", 0), tradeId: trade.id },
    );
    assert.equal(exit.tradeId, trade.id);

    const rows = await signalRows(h.pool, h.leaderAccount);
    assert.equal(rows.length, 2, "open + exit both produce a signal");
    assert.equal(rows[0]?.["direction"], "buy");
    assert.equal(rows[1]?.["direction"], "sell", "a long is closed by selling — the schema's only encoding");
    assert.equal(rows[1]?.["volume"], "0.50000000");
    assert.equal(rows[1]?.["price"], "1.10500000");
  } finally {
    await h.close();
  }
});

test("PG: a trade with no account cannot be a copy source (no signal, no error)", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await relate(h.pool, h, "active");
    const store = new PgTradeStore(h.pool, {
      onTradeCreated: async (q, trade) => {
        const input = tradeOpenedSignal(trade);
        if (input !== null) await emitCopySignal(q, input);
      },
    });
    const trade = await store.createTrade(newTrade(h.owner, h.leaderAccount, { accountId: null }), {
      ...newEvent("TRADE_CREATED", 0),
      tradeId: "0",
    });
    assert.equal((await signalRows(h.pool, h.leaderAccount)).length, 0);
    assert.equal((await h.pool.query("SELECT COUNT(*)::int AS n FROM trades WHERE id = $1::bigint", [trade.id])).rows[0].n, 1);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// CONSUMER — the durable state machine
// ---------------------------------------------------------------------------

/** Emit one signal through the real emitter and return its id. */
async function seedSignal(h: Fixture): Promise<string> {
  const q = async (sql: string, params?: readonly unknown[]) => (await h.pool.query(sql, params as unknown[])).rows;
  const id = await emitCopySignal(q, {
    leaderAccountId: h.leaderAccount,
    leaderUserId: h.owner,
    symbol: "EURUSD",
    direction: "buy",
    volume: "0.50000000",
    price: "1.10000000",
    occurredAt: "2026-09-20T09:00:00.000Z",
  });
  return String(id);
}

const queueOf = (pool: Pool) => new PgSignalQueue(async (sql, params) => (await pool.query(sql, params as unknown[])).rows);

test("PG: a claim is exclusive, increments attempts and takes the lease", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await relate(h.pool, h, "active");
    const id = await seedSignal(h);
    const q = queueOf(h.pool);

    // Two workers race the same signal: exactly one may claim it.
    const [a, b] = await Promise.all([q.claim(id, 120), q.claim(id, 120)]);
    const winners = [a, b].filter((x) => x !== null);
    assert.equal(winners.length, 1, "the lease is the mutual exclusion");
    const claimed = winners[0] as NonNullable<typeof a>;
    assert.equal(claimed.id, id);
    assert.equal(claimed.attempts, 1, "the attempt counter is incremented BY the claim");
    assert.equal(claimed.symbol, "EURUSD");
    assert.equal(claimed.volume, "0.50000000");
    assert.equal(claimed.direction, "buy");

    const [row] = await signalRows(h.pool, h.leaderAccount);
    assert.equal(row?.["status"], "dispatched");
    assert.ok(row?.["lease_expires_at"] instanceof Date, "the lease is set");
    assert.equal(await q.claim(id, 120), null, "a held lease cannot be re-claimed");
  } finally {
    await h.close();
  }
});

test("PG: due-set semantics — lease, terminal states and the attempt ceiling", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await relate(h.pool, h, "active");
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(await seedSignal(h));
    const q = queueOf(h.pool);

    // (1) a fresh signal is due; claim it and it leaves the due set.
    assert.equal((await q.listDispatchable(10)).length, 4);
    await q.claim(ids[0] as string, 120);
    assert.equal((await q.listDispatchable(10)).length, 3, "a held lease is not due");

    // (2) forcing the lease into the past makes it due again — the retry timer.
    await h.pool.query("UPDATE signal_queue SET lease_expires_at = now() - interval '1 second' WHERE id = $1::bigint", [ids[0]]);
    const due = await q.listDispatchable(10);
    assert.equal(due.length, 4);
    assert.equal(due[0]?.id, ids[0], "ordered by created_at, then id");

    // (3) terminal states are never due, whatever the lease says.
    await q.markAcked(ids[1] as string);
    await q.markExpired(ids[2] as string, "NO_ACTIVE_FOLLOWER");
    assert.deepEqual(
      (await q.listDispatchable(10)).map((s) => s.id).sort(),
      [ids[0], ids[3]].sort(),
    );

    // (4) the attempt ceiling removes a row from the due set without any state
    //     change: attempts = MAX is the "stop retrying and let the tick skip it".
    await h.pool.query("UPDATE signal_queue SET attempts = $2, lease_expires_at = now() - interval '1 second' WHERE id = $1::bigint", [
      ids[3],
      MAX_ATTEMPTS,
    ]);
    assert.deepEqual((await q.listDispatchable(10)).map((s) => s.id), [ids[0]]);

    // (5) the bound is a bound: LIMIT is honoured. Reset the ceiling the
    //     previous step applied so that more than one row is genuinely due.
    await h.pool.query(
      "UPDATE signal_queue SET lease_expires_at = NULL, attempts = 0 WHERE leader_account_id = $1::bigint",
      [h.leaderAccount],
    );
    assert.equal((await q.listDispatchable(2)).length, 2);
  } finally {
    await h.close();
  }
});

test("PG: the follower mapping is the tenant boundary (active, same leader, ordered)", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const active = await relate(h.pool, h, "active");
    // A SECOND follower account carries the suspended relationship: the pair
    // (leader, follower) is unique, so a second relationship on the same pair is
    // not a state the schema admits (0018 `copy_relationships_pair_unique`).
    const pausedAccount = await h.pool.query(
      `INSERT INTO trading_accounts
         (user_id, provider, platform, label, account_number_masked, currency, leverage,
          timezone_source, status, balance, equity, starting_balance, account_type)
       VALUES ($1,'MANUAL','manual','paused-account','****7777','USD','100','unknown','connected','1.00','1.00','1.00','live')
       RETURNING id::text AS id`,
      [h.follower],
    );
    const paused = await relate(h.pool, { ...h, followerAccount: String((pausedAccount.rows[0] as { id: string }).id) }, "paused");

    // A second leader account of the SAME owner with its own follower: its
    // relationships must not appear in this account's audience.
    const second = await h.pool.query(
      `INSERT INTO trading_accounts
         (user_id, provider, platform, label, account_number_masked, currency, leverage,
          timezone_source, status, balance, equity, starting_balance, account_type)
       VALUES ($1,'MANUAL','manual','second','****4444','USD','100','unknown','connected','1.00','1.00','1.00','live')
       RETURNING id::text AS id`,
      [h.owner],
    );
    const secondAccount = String((second.rows[0] as { id: string }).id);
    await relate(h.pool, { ...h, leaderAccount: secondAccount }, "active");

    const followers = await queueOf(h.pool).followersOf(h.leaderAccount);
    assert.deepEqual(followers.map((f) => f.relationshipId), [active], "only active relationships of THIS leader account");
    assert.equal(followers[0]?.followerAccountId, h.followerAccount);
    assert.equal(followers[0]?.followerUserId, h.follower);
    assert.ok(!followers.some((f) => f.relationshipId === paused));
    assert.equal(followers.length, 1);

    // Suspending the relationship empties the audience without touching the
    // signal: the decision is read at dispatch time, never cached in the row.
    await h.pool.query("UPDATE copy_relationships SET status = 'paused' WHERE id = $1::bigint", [active]);
    assert.equal((await queueOf(h.pool).followersOf(h.leaderAccount)).length, 0);
  } finally {
    await h.close();
  }
});

test("PG: ack / expired / failed transitions, and the DB keeps them honest", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await relate(h.pool, h, "active");
    const q = queueOf(h.pool);
    const acked = await seedSignal(h);
    const expired = await seedSignal(h);
    const retried = await seedSignal(h);
    const failed = await seedSignal(h);

    await q.claim(acked, 120);
    await q.markAcked(acked);
    const [ackedRow] = (await signalRows(h.pool, h.leaderAccount)).filter((r) => r["id"] === acked);
    assert.equal(ackedRow?.["status"], "acked");
    assert.ok(ackedRow?.["acked_at"] instanceof Date, "acked and acked_at are written together (CHECK)");
    assert.equal(ackedRow?.["lease_expires_at"], null, "an acked signal holds no lease");
    assert.equal(await q.claim(acked, 120), null, "acked is terminal");

    await q.claim(expired, 120);
    await q.markExpired(expired, "NO_ACTIVE_FOLLOWER");
    const [expiredRow] = (await signalRows(h.pool, h.leaderAccount)).filter((r) => r["id"] === expired);
    assert.equal(expiredRow?.["status"], "expired");
    assert.equal(expiredRow?.["acked_at"], null, "nothing was delivered, so nothing claims a delivery");
    assert.equal(expiredRow?.["last_error_code"], "NO_ACTIVE_FOLLOWER");
    assert.equal(await q.claim(expired, 120), null);

    // Retry: still `dispatched`, the lease carries the backoff.
    await q.claim(retried, 120);
    await q.markFailed(retried, "TRANSPORT_UNAVAILABLE", false, 300);
    const [retryRow] = (await signalRows(h.pool, h.leaderAccount)).filter((r) => r["id"] === retried);
    assert.equal(retryRow?.["status"], "dispatched");
    assert.equal(retryRow?.["last_error_code"], "TRANSPORT_UNAVAILABLE");
    const leaseMs = (retryRow?.["lease_expires_at"] as Date).getTime() - Date.now();
    assert.ok(leaseMs > 240_000 && leaseMs <= 300_000, `lease moved forward by the backoff (${Math.round(leaseMs / 1000)}s)`);
    assert.equal(await q.claim(retried, 120), null, "the backoff window is not re-claimable");

    // Terminal failure.
    await q.claim(failed, 120);
    await q.markFailed(failed, "TRANSPORT_REJECTED", true, 900);
    const [failedRow] = (await signalRows(h.pool, h.leaderAccount)).filter((r) => r["id"] === failed);
    assert.equal(failedRow?.["status"], "failed");
    assert.equal(failedRow?.["lease_expires_at"], null);
    assert.equal(failedRow?.["acked_at"], null);
    assert.equal(await q.claim(failed, 120), null);

    // An acked signal cannot be re-opened by a late failure — that would turn a
    // delivered signal into a failed one.
    await q.markFailed(acked, "TRANSPORT_REJECTED", true, 900);
    await q.markExpired(acked, "NO_ACTIVE_FOLLOWER");
    const [stillAcked] = (await signalRows(h.pool, h.leaderAccount)).filter((r) => r["id"] === acked);
    assert.equal(stillAcked?.["status"], "acked");

    // A late call cannot rewrite a terminal state: the UPDATE's predicate (not
    // an application-side `if`) is what protects it.
    await q.markFailed(failed, "TRANSPORT_REJECTED", false, 60);
    await q.markExpired(failed, "LATE_EXPIRY");
    const [stillFailed] = (await signalRows(h.pool, h.leaderAccount)).filter((r) => r["id"] === failed);
    assert.equal(stillFailed?.["status"], "failed");
    assert.equal(stillFailed?.["last_error_code"], "TRANSPORT_REJECTED", "the recorded failure stands");

    // The error-code vocabulary is enforced by the DATABASE, not by a regex the
    // application hopes it applied (0020: ^[A-Z0-9_]{1,48}$). A row must be
    // non-terminal for the UPDATE to reach the CHECK at all.
    await assert.rejects(
      () => q.markFailed(retried, "lowercase and spaces", false, 60),
      (err: unknown) => (err as { code?: string }).code === "23514",
      "a malformed error code is refused by the CHECK",
    );
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// DISPATCH — the handler, the real queue, a stub transport
// ---------------------------------------------------------------------------

class RecordingTransport implements CopyTransport {
  readonly name = "recording";
  readonly requests: CopyDispatchRequest[] = [];
  constructor(private readonly outcome: (request: CopyDispatchRequest, call: number) => { ok: true } | { ok: false; errorCode: string }) {}
  async dispatch(request: CopyDispatchRequest) {
    this.requests.push(request);
    return this.outcome(request, this.requests.length);
  }
}

const job = (signalId: string): QueuedJob => ({
  id: `job-${signalId}`,
  attempts: 0,
  descriptor: {
    jobClass: "copy.signal-dispatch",
    priorityClass: "sync",
    idempotencyKey: `copy:signal:${signalId}`,
    payload: { signalId },
  } as unknown as QueuedJob["descriptor"],
});

test("PG: dispatch reaches every active follower with a stable key, then acks", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await relate(h.pool, h, "active");
    // A second follower account (same follower user, different account) — the
    // audience is account-level, so both must receive the signal.
    const secondAccount = await h.pool.query(
      `INSERT INTO trading_accounts
         (user_id, provider, platform, label, account_number_masked, currency, leverage,
          timezone_source, status, balance, equity, starting_balance, account_type)
       VALUES ($1,'MANUAL','manual','follower-2','****5555','USD','100','unknown','connected','1.00','1.00','1.00','live')
       RETURNING id::text AS id`,
      [h.follower],
    );
    await relate(h.pool, { ...h, followerAccount: String((secondAccount.rows[0] as { id: string }).id) }, "active");

    const id = await seedSignal(h);
    const transport = new RecordingTransport(() => ({ ok: true }));
    const handler = createCopyDispatchHandler({ queue: queueOf(h.pool), transport, log: () => undefined });

    await handler(job(id));
    assert.equal(transport.requests.length, 2, "one dispatch per active follower account");
    assert.deepEqual(
      transport.requests.map((r) => r.idempotencyKey).sort(),
      [
        `copy-signal:${id}:${h.followerAccount}`,
        `copy-signal:${id}:${String((secondAccount.rows[0] as { id: string }).id)}`,
      ].sort(),
      "one key per (signal, follower) — stable across retries",
    );
    assert.ok(transport.requests.every((r) => r.volume === "0.50000000" && r.price === "1.10000000" && r.symbol === "EURUSD"));
    assert.ok(transport.requests.every((r) => r.leaderAccountId === h.leaderAccount));

    const [row] = await signalRows(h.pool, h.leaderAccount);
    assert.equal(row?.["status"], "acked");
    assert.equal(row?.["attempts"], 1);

    // Replaying the job changes nothing: the signal is terminal, the claim fails
    // and the handler returns without touching the transport again.
    await handler(job(id));
    assert.equal(transport.requests.length, 2, "a duplicated job cannot double-deliver");
  } finally {
    await h.close();
  }
});

test("PG: no active follower expires the signal — never an ack", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await relate(h.pool, h, "paused");
    // The emitter refuses to create a signal without an active relationship, so
    // this scenario is reached by the relationship being suspended AFTER the
    // signal was written — which is exactly when an ack would be a lie.
    await h.pool.query("UPDATE copy_relationships SET status = 'active' WHERE leader_account_id = $1::bigint", [h.leaderAccount]);
    const id = await seedSignal(h);
    await h.pool.query("UPDATE copy_relationships SET status = 'paused' WHERE leader_account_id = $1::bigint", [h.leaderAccount]);

    const transport = new RecordingTransport(() => ({ ok: true }));
    await createCopyDispatchHandler({ queue: queueOf(h.pool), transport, log: () => undefined })(job(id));

    assert.equal(transport.requests.length, 0, "a follower who revoked mid-flight is not written to");
    const [row] = await signalRows(h.pool, h.leaderAccount);
    assert.equal(row?.["status"], "expired");
    assert.equal(row?.["acked_at"], null);
  } finally {
    await h.close();
  }
});

test("PG: repeated transport failure retries under the lease, then fails terminally", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await relate(h.pool, h, "active");
    const id = await seedSignal(h);
    const transport = new RecordingTransport(() => ({ ok: false, errorCode: "TRANSPORT_REJECTED" }));
    const handler = createCopyDispatchHandler({ queue: queueOf(h.pool), transport, log: () => undefined });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      // Each attempt requires the lease to be due: for attempt 1 that is the
      // initial state, afterwards the backoff must have elapsed. Waiting for the
      // real backoff (30s+) is not a test — the battery moves the clock the way
      // the tick's "lease expired" predicate would.
      if (attempt > 1) {
        await h.pool.query(
          "UPDATE signal_queue SET lease_expires_at = now() - interval '1 second' WHERE id = $1::bigint AND status = 'dispatched'",
          [id],
        );
      }
      assert.equal((await queueOf(h.pool).listDispatchable(10)).length, 1, `attempt ${attempt} must be due`);
      await handler(job(id));
    }

    const [row] = await signalRows(h.pool, h.leaderAccount);
    assert.equal(row?.["status"], "failed", "the signal's own counter decides, not the queue's");
    assert.equal(row?.["attempts"], MAX_ATTEMPTS);
    assert.equal(row?.["last_error_code"], "TRANSPORT_REJECTED");
    assert.equal(row?.["acked_at"], null);
    assert.equal(transport.requests.length, MAX_ATTEMPTS, "one transport call per attempt — never a silent extra");
    assert.equal((await queueOf(h.pool).listDispatchable(10)).length, 0, "a failed signal is not work");
  } finally {
    await h.close();
  }
});

test("PG: a partial failure is a retry, and the successful follower keeps its key", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const first = await relate(h.pool, h, "active");
    const secondAccount = await h.pool.query(
      `INSERT INTO trading_accounts
         (user_id, provider, platform, label, account_number_masked, currency, leverage,
          timezone_source, status, balance, equity, starting_balance, account_type)
       VALUES ($1,'MANUAL','manual','follower-3','****6666','USD','100','unknown','connected','1.00','1.00','1.00','live')
       RETURNING id::text AS id`,
      [h.follower],
    );
    const secondFollower = String((secondAccount.rows[0] as { id: string }).id);
    await relate(h.pool, { ...h, followerAccount: secondFollower }, "active");

    // First call fails for the FIRST follower only; the second succeeds.
    const flaky = new RecordingTransport((request, call) =>
      call === 1 ? { ok: false, errorCode: "TRANSPORT_TIMEOUT" } : { ok: true },
    );
    const id = await seedSignal(h);
    await createCopyDispatchHandler({ queue: queueOf(h.pool), transport: flaky, log: () => undefined })(job(id));

    let [row] = await signalRows(h.pool, h.leaderAccount);
    assert.equal(row?.["status"], "dispatched", "one follower failed ⇒ the signal is not acked");
    assert.equal(row?.["last_error_code"], "TRANSPORT_TIMEOUT");
    assert.equal(row?.["attempts"], 1);
    const firstKeys = flaky.requests.map((r) => r.idempotencyKey);
    assert.equal(firstKeys.length, 2);
    assert.ok(firstKeys.includes(`copy-signal:${id}:${h.followerAccount}`));
    assert.ok(firstKeys.includes(`copy-signal:${id}:${secondFollower}`));

    // Retry after the backoff: BOTH followers are retried, and the follower that
    // already succeeded receives the SAME key, so a real transport converges
    // instead of executing twice.
    await h.pool.query("UPDATE signal_queue SET lease_expires_at = now() - interval '1 second' WHERE id = $1::bigint", [id]);
    const ok = new RecordingTransport(() => ({ ok: true }));
    await createCopyDispatchHandler({ queue: queueOf(h.pool), transport: ok, log: () => undefined })(job(id));
    [row] = await signalRows(h.pool, h.leaderAccount);
    assert.equal(row?.["status"], "acked");
    assert.equal(row?.["attempts"], 2);
    assert.deepEqual(ok.requests.map((r) => r.idempotencyKey).sort(), firstKeys.sort(), "identical keys on retry");

    // The relationship that was created first is the same one the mapping reads.
    assert.equal(
      (await queueOf(h.pool).followersOf(h.leaderAccount)).map((f) => f.relationshipId).sort().join(","),
      [first, (await h.pool.query("SELECT id::text AS id FROM copy_relationships WHERE follower_account_id = $1::bigint", [secondFollower])).rows[0].id].sort().join(","),
    );
  } finally {
    await h.close();
  }
});

test("PG: a missing signalId is a producer bug and fails the job", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const transport = new RecordingTransport(() => ({ ok: true }));
    const handler = createCopyDispatchHandler({ queue: queueOf(h.pool), transport, log: () => undefined });
    await assert.rejects(() => handler({ ...job("1"), descriptor: { ...job("1").descriptor, payload: {} } as never }));
    assert.equal(transport.requests.length, 0);
  } finally {
    await h.close();
  }
});

test("PG: the transactional emitter is safe to call from an explicit transaction", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await relate(h.pool, h, "active");
    const client: PoolClient = await h.pool.connect();
    try {
      await client.query("BEGIN");
      const q = async (sql: string, params?: readonly unknown[]) => (await client.query(sql, params as unknown[])).rows;
      const id = await emitCopySignal(q, {
        leaderAccountId: h.leaderAccount,
        leaderUserId: h.owner,
        symbol: "XAUUSD",
        direction: "sell",
        volume: "0.25000000",
        price: "2350.50000000",
        occurredAt: "2026-09-20T10:00:00.000Z",
      });
      assert.notEqual(id, null);
      // Visible inside the transaction, invisible outside it.
      const inside = await client.query("SELECT COUNT(*)::int AS n FROM signal_queue");
      assert.equal(inside.rows[0].n, 1);
      const outside = await h.pool.query("SELECT COUNT(*)::int AS n FROM signal_queue");
      assert.equal(outside.rows[0].n, 0, "the parallel connection cannot see uncommitted work");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    assert.equal((await signalRows(h.pool, h.leaderAccount)).length, 0, "rollback removed the signal with its trade");
  } finally {
    await h.close();
  }
});
