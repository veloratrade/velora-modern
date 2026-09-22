// ASYNC ANALYTICS pre-aggregation battery — real PostgreSQL (roadmap §3, R-10).
//
// EVIDENCE LABEL (Phase D policy): executes ONLY against a REAL, disposable
// PostgreSQL (DATABASE_URL — postgres-evidence workflow). Without it, every test
// is SKIPPED.
//
// The writer under test (`apps/worker/src/analytics/dailyRecompute.ts`) is the
// missing half of 0016: the tables `user_analytics_daily` and
// `account_performance_summary` existed since pass 1 and nothing ever wrote to
// them. This battery proves the properties the roadmap demands of that writer,
// on real SQL rather than on a scripted port:
//
//   DETERMINISTIC   two runs over the same ledger produce identical figures;
//   IDEMPOTENT      every write is an upsert on 0016's own primary key;
//   CONVERGENT      a day whose trades were deleted loses its derived row;
//   BOUNDED         a window beyond the cap fails instead of truncating;
//   CORRECT DATING  the day bucket follows the ACCOUNT's timezone (ADR-004) and
//                   records its basis honestly (`account` / `assumed_utc`);
//   EXACT MONEY     the stored NUMERICs satisfy 0016's signs and scales.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareDatabase } from "./support/pgTestDb.ts";
import {
  MAX_WINDOW_DAYS,
  RecomputeBoundError,
  recomputeUserAnalytics,
} from "../../apps/worker/src/analytics/dailyRecompute.ts";
import { listRecomputeUsers, recomputeWindow } from "../../apps/worker/src/scheduler/analyticsScheduler.ts";
import type { Pool } from "pg";

const PG_URL = process.env.DATABASE_URL;
const SKIP = PG_URL === undefined
  ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)"
  : false;

const FROM = "2026-09-01T00:00:00.000Z";
const TO = "2026-09-22T00:00:00.000Z";

interface Fixture {
  pool: Pool;
  /** user with two accounts: Berlin (declared) and UTC (unknown source). */
  user: string;
  berlinAccount: string;
  utcAccount: string;
  /** an unrelated user, to prove the tenant boundary of the writer. */
  other: string;
  close: () => Promise<void>;
}

async function harness(): Promise<Fixture> {
  const { Pool } = await import("pg");
  await (await prepareDatabase(PG_URL as string)).close();
  const pool = new Pool({ connectionString: PG_URL });

  const users = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1,$2), ($3,$4) RETURNING id::text AS id, email`,
    ["analytics-owner@velora.test", "x", "analytics-other@velora.test", "y"],
  );
  const idOf = (email: string): string =>
    String((users.rows as { id: string; email: string }[]).find((r) => r.email === email)?.id);
  const user = idOf("analytics-owner@velora.test");
  const other = idOf("analytics-other@velora.test");

  const accounts = await pool.query(
    `INSERT INTO trading_accounts
       (user_id, provider, platform, label, account_number_masked, currency, leverage,
        timezone, timezone_source, status, balance, equity, starting_balance, account_type)
     VALUES ($1,'MANUAL','manual','berlin','****1111','EUR','100','Europe/Berlin','user_config','connected','1000.00','1000.00','1000.00','live'),
            ($1,'MANUAL','manual','utc','****2222','USD','100',NULL,'unknown','connected','1000.00','1000.00','1000.00','live'),
            ($2,'MANUAL','manual','other','****3333','USD','100',NULL,'unknown','connected','1000.00','1000.00','1000.00','live')
     RETURNING id::text AS id, user_id::text AS user_id, label`,
    [user, other],
  );
  const byLabel = (label: string): string =>
    String((accounts.rows as { id: string; label: string }[]).find((r) => r.label === label)?.id);

  return {
    pool,
    user,
    berlinAccount: byLabel("berlin"),
    utcAccount: byLabel("utc"),
    other,
    close: () => pool.end(),
  };
}

/** One closed trade on the real ledger. */
async function addTrade(
  h: Fixture,
  input: { userId?: string; accountId: string | null; occurredAt: string; netPnl: string | null; rMultiple?: string | null; symbol?: string },
): Promise<string> {
  const res = await h.pool.query(
    `INSERT INTO trades
       (user_id, account_id, symbol, direction, status, entry_price, exit_price, volume, contract_size,
        commission, swap, net_pnl, r_multiple, allocated_volume, version, occurred_at, created_at, updated_at,
        occurred_open_at_utc, occurred_close_at_utc, time_status, source_timezone_source, source_calendar, source, quarantined)
     VALUES ($1, $2::bigint, $3, 'buy', 'CLOSED', '1.10000000', '1.10500000', '1.00000000', '100000.00000000',
             '1.00', '0.00', $4::numeric, $5::numeric, '0.00000000', 1, $6::timestamptz, $6::timestamptz, $6::timestamptz,
             $6::timestamptz, $6::timestamptz, 'resolved', 'user_config', 'proleptic-gregorian', 'manual', false)
     RETURNING id::text AS id`,
    [input.userId ?? h.user, input.accountId, input.symbol ?? "EURUSD", input.netPnl, input.rMultiple ?? null, input.occurredAt],
  );
  return String((res.rows[0] as { id: string }).id);
}

interface DailyRow extends Record<string, unknown> {
  day: string;
  tz_basis: string;
  tz_basis_source: string;
  trades_count: number;
  wins: number;
  losses: number;
  breakeven: number;
  gross_profit: string;
  gross_loss: string;
  net_pnl: string;
  win_rate: string;
  profit_factor: string | null;
  expectancy: string;
  max_drawdown: string;
}

const dailyRows = async (pool: Pool, userId: string): Promise<DailyRow[]> =>
  (await pool.query(
    `SELECT to_char(day,'YYYY-MM-DD') AS day, tz_basis, tz_basis_source, trades_count, wins, losses, breakeven,
            gross_profit::text AS gross_profit, gross_loss::text AS gross_loss, net_pnl::text AS net_pnl,
            win_rate::text AS win_rate, profit_factor::text AS profit_factor, expectancy::text AS expectancy,
            max_drawdown::text AS max_drawdown
       FROM user_analytics_daily WHERE user_id = $1::bigint ORDER BY day, tz_basis`,
    [userId],
  )).rows as DailyRow[];

/** The tick's own due-set query (this is what decides who gets a job). */
const due = async (h: Fixture, from = FROM, to = TO): Promise<string[]> =>
  listRecomputeUsers(
    async (sql, params) => (await h.pool.query(sql, params as unknown[])).rows,
    from,
    to,
    50,
  );

const run = (h: Fixture, from = FROM, to = TO) =>
  recomputeUserAnalytics(async (sql, params) => (await h.pool.query(sql, params as unknown[])).rows, {
    userId: h.user,
    from,
    to,
  });

test("PG: one day's figures are exact and satisfy 0016's scales and signs", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await addTrade(h, { accountId: h.utcAccount, occurredAt: "2026-09-20T09:00:00.000Z", netPnl: "120.00", rMultiple: "2.00000000" });
    await addTrade(h, { accountId: h.utcAccount, occurredAt: "2026-09-20T11:00:00.000Z", netPnl: "-45.00", rMultiple: "-1.00000000" });
    await addTrade(h, { accountId: h.utcAccount, occurredAt: "2026-09-20T13:00:00.000Z", netPnl: "0.00" });

    const result = await run(h);
    assert.equal(result.dailyRows, 1, "one day, one basis (the account has no declared timezone)");
    assert.equal(result.accountRows, 1);

    const [row] = (await dailyRows(h.pool, h.user)).filter((r) => r.tz_basis === "UTC");
    assert.ok(row);
    assert.equal(row.day, "2026-09-20");
    assert.equal(row.tz_basis_source, "assumed_utc", "no declared timezone ⇒ the basis says so");
    assert.equal(row.trades_count, 3, "wins + losses + breakeven (a realized result exists for all three)");
    assert.equal(row.wins, 1);
    assert.equal(row.losses, 1);
    assert.equal(row.breakeven, 1);
    assert.equal(row.gross_profit, "120.00", "NUMERIC(20,2), non-negative by CHECK");
    assert.equal(row.gross_loss, "-45.00", "NUMERIC(20,2), non-positive by CHECK");
    assert.equal(row.net_pnl, "75.00");
    assert.equal(row.win_rate, "0.50000000", "the column is NUMERIC(18,8): the contract's 4-dp ratio is padded by the column");
    assert.equal(row.profit_factor, "2.66670000", "the 4-dp value padded by the NUMERIC(18,8) column");
    assert.equal(row.expectancy, "25.00");
    assert.equal(row.max_drawdown, "45.00", "peak 120.00 → 75.00 → 75.00");
  } finally {
    await h.close();
  }
});

test("PG: the day bucket follows the ACCOUNT timezone, and the basis is recorded per row", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    // 23:30 UTC on the 20th is 01:30 on the 21st in Berlin.
    await addTrade(h, { accountId: h.berlinAccount, occurredAt: "2026-09-20T23:30:00.000Z", netPnl: "10.00" });
    // 09:00 UTC on the 20th is 11:00 in Berlin — the same Berlin day.
    await addTrade(h, { accountId: h.berlinAccount, occurredAt: "2026-09-20T09:00:00.000Z", netPnl: "-4.00" });

    await run(h);
    const rows = await dailyRows(h.pool, h.user);
    const berlin = rows.filter((r) => r.tz_basis === "Europe/Berlin");
    assert.deepEqual(berlin.map((r) => r.day), ["2026-09-20", "2026-09-21"], "two Berlin days, not one UTC day");
    assert.ok(berlin.every((r) => r.tz_basis_source === "account"));
    assert.equal(berlin[0]?.net_pnl, "-4.00");
    assert.equal(berlin[1]?.net_pnl, "10.00", "the 23:30 UTC trade belongs to the NEXT Berlin day");

    // The UTC basis row exists (it is added unconditionally) but contains none of
    // this account's trades: a trade belongs to exactly one basis.
    const utc = rows.filter((r) => r.tz_basis === "UTC");
    assert.equal(utc.length, 0, "no trade buckets in UTC for a Berlin account");
  } finally {
    await h.close();
  }
});

test("PG: two runs are byte-identical, and the upsert converges on one row per key", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await addTrade(h, { accountId: h.berlinAccount, occurredAt: "2026-09-20T09:00:00.000Z", netPnl: "100.00", rMultiple: "1.00000000" });
    await addTrade(h, { accountId: h.utcAccount, occurredAt: "2026-09-21T09:00:00.000Z", netPnl: "-30.00" });

    const first = await run(h);
    const snapshot = await dailyRows(h.pool, h.user);
    const second = await run(h);
    const again = await dailyRows(h.pool, h.user);

    assert.deepEqual(again, snapshot, "a re-run cannot shift a reported figure");
    assert.deepEqual(second, first);
    assert.equal(snapshot.length, 2, "one row per (user, day, basis) — never a second aggregate");
    const keys = await h.pool.query(
      "SELECT user_id::text AS u, day, tz_basis, COUNT(*)::int AS n FROM user_analytics_daily GROUP BY 1,2,3 HAVING COUNT(*) > 1",
    );
    assert.equal(keys.rows.length, 0, "the primary key is doing the work, not luck");
  } finally {
    await h.close();
  }
});

test("PG: an open trade has no attributable result and is excluded, while the partition stays exact", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await addTrade(h, { accountId: h.utcAccount, occurredAt: "2026-09-20T09:00:00.000Z", netPnl: "50.00" });
    await h.pool.query(
      `INSERT INTO trades
         (user_id, account_id, symbol, direction, status, entry_price, volume, contract_size, commission, swap,
          allocated_volume, version, occurred_at, created_at, updated_at, occurred_open_at_utc,
          time_status, source_timezone_source, source_calendar, source, quarantined)
       VALUES ($1, $2::bigint, 'EURUSD', 'buy', 'OPEN', '1.10000000', '1.00000000', '100000.00000000', '1.00', '0.00',
               '0.00000000', 1, '2026-09-20T10:00:00.000Z', now(), now(), '2026-09-20T10:00:00.000Z',
               'resolved', 'user_config', 'proleptic-gregorian', 'manual', false)`,
      [h.user, h.utcAccount],
    );
    await run(h);
    const [row] = await dailyRows(h.pool, h.user);
    assert.equal(row?.trades_count, 1, "the open trade contributes nothing yet");
    assert.equal(row?.net_pnl, "50.00");
  } finally {
    await h.close();
  }
});

test("PG: convergence — a deleted trade removes the derived row it justified", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const tradeId = await addTrade(h, { accountId: h.utcAccount, occurredAt: "2026-09-20T09:00:00.000Z", netPnl: "50.00" });
    await run(h);
    assert.equal((await dailyRows(h.pool, h.user)).length, 1);
    assert.equal((await h.pool.query("SELECT COUNT(*)::int AS n FROM account_performance_summary WHERE user_id = $1::bigint", [h.user])).rows[0].n, 1);

    // Soft delete (the ledger's tombstone) — the trade is no longer in any report.
    await h.pool.query("UPDATE trades SET deleted_at = now() WHERE id = $1::bigint", [tradeId]);
    const after = await run(h);
    assert.equal(after.dailyRows, 0);
    assert.equal(after.removedDailyRows, 1, "the stale derived row was pruned, not left behind");
    assert.equal((await dailyRows(h.pool, h.user)).length, 0);
    assert.equal(
      (await h.pool.query("SELECT COUNT(*)::int AS n FROM account_performance_summary WHERE user_id = $1::bigint", [h.user])).rows[0].n,
      0,
      "an account with nothing realized has no summary",
    );

    // A quarantined trade is equally excluded (0015 hygiene).
    const second = await addTrade(h, { accountId: h.utcAccount, occurredAt: "2026-09-21T09:00:00.000Z", netPnl: "7.00" });
    await h.pool.query("UPDATE trades SET quarantined = true WHERE id = $1::bigint", [second]);
    await run(h);
    assert.equal((await dailyRows(h.pool, h.user)).length, 0);
  } finally {
    await h.close();
  }
});

test("PG: an unusable stored timezone degrades one basis to UTC instead of failing the job", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const bad = await h.pool.query(
      `INSERT INTO trading_accounts
         (user_id, provider, platform, label, account_number_masked, currency, leverage,
          timezone, timezone_source, status, balance, equity, starting_balance, account_type)
       VALUES ($1,'MANUAL','manual','mars','****9999','USD','100','Mars/Olympus_Mons','user_config','connected','1.00','1.00','1.00','live')
       RETURNING id::text AS id`,
      [h.user],
    );
    const badAccount = String((bad.rows[0] as { id: string }).id);
    await addTrade(h, { accountId: badAccount, occurredAt: "2026-09-20T09:00:00.000Z", netPnl: "5.00" });

    const result = await run(h);
    assert.equal(result.dailyRows, 1, "the recompute still produced the user's analytics");
    const [row] = await dailyRows(h.pool, h.user);
    assert.equal(row?.tz_basis, "UTC");
    assert.equal(row?.tz_basis_source, "assumed_utc", "ADR-004 honesty: an unusable zone is recorded as assumed");
    assert.equal(row?.net_pnl, "5.00");
  } finally {
    await h.close();
  }
});

test("PG: a window beyond the cap fails loudly and writes NOTHING", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await addTrade(h, { accountId: h.utcAccount, occurredAt: "2026-09-20T09:00:00.000Z", netPnl: "10.00" });
    const tooWide = new Date(Date.parse(TO) - (MAX_WINDOW_DAYS + 10) * 86_400_000).toISOString();
    await assert.rejects(() => run(h, tooWide, TO), RecomputeBoundError);
    assert.equal((await dailyRows(h.pool, h.user)).length, 0, "a refused job leaves no partial aggregate");
    assert.equal((await h.pool.query("SELECT COUNT(*)::int AS n FROM account_performance_summary")).rows[0].n, 0);
  } finally {
    await h.close();
  }
});

test("PG: the writer is confined to the user it was asked about", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    // The other user's trade is inside the window and in the same UTC basis.
    const otherAccount = (await h.pool.query("SELECT id::text AS id FROM trading_accounts WHERE user_id = $1::bigint", [h.other]))
      .rows[0].id as string;
    await addTrade(h, { userId: h.other, accountId: otherAccount, occurredAt: "2026-09-20T09:00:00.000Z", netPnl: "999.00" });
    await addTrade(h, { accountId: h.utcAccount, occurredAt: "2026-09-20T09:00:00.000Z", netPnl: "10.00" });

    await run(h);
    assert.equal((await dailyRows(h.pool, h.user))[0]?.net_pnl, "10.00", "only the requested user's ledger");
    assert.equal((await dailyRows(h.pool, h.other)).length, 0, "another tenant's analytics are untouched");
    const summaries = await h.pool.query("SELECT user_id::text AS user_id FROM account_performance_summary");
    assert.deepEqual((summaries.rows as { user_id: string }[]).map((r) => r.user_id), [h.user]);

    // And it is repeatable for the other user without disturbing the first.
    const second = await recomputeUserAnalytics(async (sql, params) => (await h.pool.query(sql, params as unknown[])).rows, {
      userId: h.other,
      from: FROM,
      to: TO,
    });
    assert.equal(second.dailyRows, 1);
    assert.equal((await dailyRows(h.pool, h.user))[0]?.net_pnl, "10.00");
  } finally {
    await h.close();
  }
});

test("PG: the account summary aggregates the full history and carries peak/trough", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    // Two trades inside the window, one deliberately OUTSIDE it: the summary is
    // about the account, not about the window.
    await addTrade(h, { accountId: h.utcAccount, occurredAt: "2026-09-20T09:00:00.000Z", netPnl: "100.00" });
    await addTrade(h, { accountId: h.utcAccount, occurredAt: "2026-09-21T09:00:00.000Z", netPnl: "-40.00" });
    await addTrade(h, { accountId: h.utcAccount, occurredAt: "2026-01-15T09:00:00.000Z", netPnl: "10.00" });

    await run(h);
    const rows = await h.pool.query(
      `SELECT account_id::text AS account_id, user_id::text AS user_id, currency, trades_count, net_pnl::text AS net_pnl,
              max_drawdown::text AS max_drawdown, equity_peak::text AS equity_peak, equity_trough::text AS equity_trough
         FROM account_performance_summary WHERE account_id = $1::bigint`,
      [h.utcAccount],
    );
    const row = rows.rows[0] as Record<string, unknown>;
    assert.equal(row["user_id"], h.user);
    assert.equal(row["currency"], "USD");
    assert.equal(row["trades_count"], 3, "the January trade is part of the account's history");
    assert.equal(row["net_pnl"], "70.00");
    assert.equal(row["equity_peak"], "110.00", "the cumulative series peaks after the 100.00 trade");
    assert.equal(row["equity_trough"], "0.00", "the series starts at zero and never goes below it");
    assert.equal(row["max_drawdown"], "40.00");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// CONVERGENCE THROUGH THE TICK — the property the pass-2 due set could not reach
// ---------------------------------------------------------------------------

test("PG: a deleted trade brings its user BACK into the due set, and the run removes the stale row", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const tradeId = await addTrade(h, { accountId: h.utcAccount, occurredAt: "2026-09-20T09:00:00.000Z", netPnl: "50.00" });

    // A fresh ledger with no derived rows is due for reason (1): new work.
    assert.deepEqual(await due(h), [h.user]);
    await run(h);
    assert.equal((await dailyRows(h.pool, h.user)).length, 1);

    // Converged: the tick is now silent for this user (no needless hourly work).
    assert.deepEqual(await due(h), [], "a converged user is not re-enqueued forever");

    // The user deletes the trade. The tombstone bumps `updated_at`, which is the
    // ONLY evidence that the derived row is now wrong — and pass 2's due set
    // (activity only) could not see it: the trade is no longer a live row inside
    // the window. This is report item Q-4.
    await h.pool.query("UPDATE trades SET deleted_at = now(), updated_at = now() WHERE id = $1::bigint", [tradeId]);
    assert.deepEqual(await due(h), [h.user], "stale derived state is work, not history");

    // The recompute removes the row it can no longer justify…
    const second = await run(h);
    assert.equal(second.dailyRows, 0);
    assert.equal(second.removedDailyRows, 1);
    assert.equal((await dailyRows(h.pool, h.user)).length, 0);
    // …and the loop TERMINATES: nothing is left to fix, so nothing is re-queued.
    assert.deepEqual(await due(h), [], "the due set is self-terminating, not a permanent queue");
  } finally {
    await h.close();
  }
});

test("PG: an edited trade re-enters the due set, and a quarantined ledger is caught without a bump", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const tradeId = await addTrade(h, { accountId: h.utcAccount, occurredAt: "2026-09-20T09:00:00.000Z", netPnl: "50.00" });
    await run(h);
    assert.deepEqual(await due(h), []);

    // (a) An in-window edit: the ledger moved after the aggregate was computed.
    await h.pool.query("UPDATE trades SET net_pnl = 75.00, updated_at = now() WHERE id = $1::bigint", [tradeId]);
    assert.deepEqual(await due(h), [h.user]);
    await run(h);
    assert.equal((await dailyRows(h.pool, h.user))[0]?.net_pnl, "75.00", "the corrected figure reaches the aggregate");
    assert.deepEqual(await due(h), []);

    // (b) Quarantine does NOT bump `updated_at` — the derived row is nonetheless
    //     unjustified, which is why the due set has reason (3) as well.
    await h.pool.query("UPDATE trades SET quarantined = true WHERE id = $1::bigint", [tradeId]);
    assert.deepEqual(await due(h), [h.user], "reason (3): the ledger behind the row is gone");
    await run(h);
    assert.equal((await dailyRows(h.pool, h.user)).length, 0);
    assert.deepEqual(await due(h), []);
  } finally {
    await h.close();
  }
});

test("PG: an orphaned account summary is due; a merely stale one for an inactive account is not", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const tradeId = await addTrade(h, { accountId: h.utcAccount, occurredAt: "2026-09-20T09:00:00.000Z", netPnl: "50.00" });
    await run(h);
    assert.equal((await h.pool.query("SELECT COUNT(*)::int AS n FROM account_performance_summary")).rows[0].n, 1);
    assert.deepEqual(await due(h), []);

    // The account's ledger is emptied: the summary is now an orphan and the
    // recompute's account pass (which is NOT window-bounded) removes it.
    await h.pool.query("UPDATE trades SET deleted_at = now(), updated_at = now() WHERE id = $1::bigint", [tradeId]);
    assert.deepEqual(await due(h), [h.user]);
    await run(h);
    assert.equal((await h.pool.query("SELECT COUNT(*)::int AS n FROM account_performance_summary")).rows[0].n, 0);
    assert.deepEqual(await due(h), [], "converged: no work is manufactured that the run cannot finish");

    // A trade OUTSIDE the recompute window that changes later does NOT enter the
    // due set: the window-bounded run could not refresh it, so listing it would
    // queue the same user every hour forever.
    const old = await addTrade(h, { accountId: h.utcAccount, occurredAt: "2025-01-15T09:00:00.000Z", netPnl: "10.00" });
    await run(h, FROM, TO);
    await h.pool.query("UPDATE trades SET net_pnl = 11.00, updated_at = now() WHERE id = $1::bigint", [old]);
    assert.deepEqual(await due(h), [], "no unfixable work is queued");
  } finally {
    await h.close();
  }
});

test("PG: the tick's window is the documented default and the due set is bounded", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const now = new Date("2026-09-22T12:00:00.000Z");
    const { from, to } = recomputeWindow(now);
    assert.equal(to, now.toISOString());
    assert.equal(from, "2026-06-24T12:00:00.000Z", "90 days by default");

    // Inside the window ⇒ due. Outside ⇒ the recompute would ignore it, so it is
    // not work (it is still legitimate data, just not this pass's business).
    await addTrade(h, { accountId: h.utcAccount, occurredAt: "2026-09-20T09:00:00.000Z", netPnl: "5.00" });
    await addTrade(h, { accountId: h.utcAccount, occurredAt: "2026-01-01T09:00:00.000Z", netPnl: "5.00" });
    assert.deepEqual(await due(h, from, to), [h.user]);
    const bounded = await due(h, from, to);
    assert.equal(bounded.length, 1, "one entry per user, not per trade");

    // The batch bound is a bound: LIMIT is applied to the union.
    const short = await listRecomputeUsers(
      async (sql, params) => (await h.pool.query(sql, params as unknown[])).rows,
      from,
      to,
      0,
    );
    assert.deepEqual(short, [], "batch 0 is a legitimate (if useless) tick");
  } finally {
    await h.close();
  }
});
