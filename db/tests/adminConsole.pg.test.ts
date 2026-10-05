// Real-PostgreSQL battery for Phase 6 — the admin console's persistence rules.
//
// WHAT ONLY A REAL ENGINE CAN PROVE HERE. Every console read is an aggregate or
// a join, and the console's whole value is that its numbers MATCH the domain's
// own rules. Three classes of defect are invisible to a double and are the reason
// this file exists:
//
//   1. TOMBSTONES AND WINDOWS. A `deleted_at IS NOT NULL` trade must be excluded
//      from every count and every sum, and `occurred_at` windows are HALF-OPEN
//      [from, to) so consecutive windows partition the data without double
//      counting the boundary row. A console that disagrees with the user's own
//      dashboard about "how many trades" is worse than no console.
//   2. MONEY IS NUMERIC. `net_pnl`/`equity`/`volume` are summed in SQL and must
//      come back as exact strings (ADR-001). The battery asserts the exact value,
//      including the cents a float would drop.
//   3. THE WRITES ARE CONDITIONAL. `revokeUserSession` must not touch a session
//      belonging to another user or an already-revoked one; `verifyEmailOnce` must
//      change a row exactly once, even under a race, and the audit row must be in
//      the SAME transaction as the mutation (0027's vocabulary is what makes that
//      record possible at all).
//
// EVIDENCE LABEL (Phase D policy): executes ONLY against a REAL, disposable
// PostgreSQL (DATABASE_URL). Without it every test is SKIPPED, never silently
// passed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareDatabase } from "./support/pgTestDb.ts";
import { PgAdminConsoleStore } from "../../apps/api/src/admin/adminConsoleStore.ts";
import { PgUserStore } from "../../apps/api/src/auth/pgUserStore.ts";
import { PgAuditStore } from "../../apps/api/src/auth/pgAuditStore.ts";
import type { QueryFn } from "../../apps/api/src/persistence/pg.ts";

const PG_URL = process.env.DATABASE_URL;
const SKIP =
  PG_URL === undefined ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)" : false;

const q = (pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }): QueryFn =>
  (async (sql: string, params?: unknown[]) => (await pool.query(sql, params as unknown[] | undefined)).rows) as unknown as QueryFn;

interface Seeded {
  readonly userA: string;
  readonly userB: string;
  readonly admin: string;
  readonly accountA: string;
  readonly accountB: string;
}

/** Two ordinary users with one account each, plus an administrator. */
async function seed(
  pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
): Promise<Seeded> {
  const tag = `${process.pid}-${process.hrtime.bigint()}`;
  const mk = async (email: string, role = "user"): Promise<string> => {
    const r = await pool.query(
      "INSERT INTO users (email, password_hash, role) VALUES ($1,'hash',$2) RETURNING id",
      [email, role],
    );
    return String(r.rows[0]!.id);
  };
  const userA = await mk(`console-a-${tag}@velora.test`);
  const userB = await mk(`console-b-${tag}@velora.test`);
  const admin = await mk(`console-admin-${tag}@velora.test`, "admin");
  const mkAccount = async (userId: string, label: string, balance: string, equity: string): Promise<string> => {
    const r = await pool.query(
      `INSERT INTO trading_accounts (user_id, label, provider, platform, currency, sync_status, status, balance, equity)
       VALUES ($1,$2,'MT5','MT5','USD','CONNECTED','connected',$3,$4) RETURNING id`,
      [userId, label, balance, equity],
    );
    return String(r.rows[0]!.id);
  };
  const accountA = await mkAccount(userA, "A-1", "1000.50", "1010.25");
  const accountB = await mkAccount(userB, "B-1", "500.00", "490.00");
  return { userA, userB, admin, accountA, accountB };
}

interface TradeInput {
  readonly userId: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly direction: string;
  readonly status: string;
  readonly volume: string;
  readonly pnl: string | null;
  readonly occurredAt: string;
  readonly deleted?: boolean;
}

async function seedTrade(
  pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  t: TradeInput,
): Promise<string> {
  // A CLOSED row must carry the COMPLETE financial record (0025's
  // trades_closed_has_financials): exit price, realized PnL and the close
  // instant. The battery therefore seeds real closed rows, not shortcuts — a
  // fixture that only satisfies the console would prove the console against a
  // database the rest of the system would reject.
  const closeAt = new Date(new Date(t.occurredAt).getTime() + 3_600_000).toISOString();
  const r = await pool.query(
    `INSERT INTO trades (user_id, account_id, symbol, direction, status, entry_price, exit_price, volume,
                         contract_size, commission, swap, net_pnl, occurred_at, occurred_close_at_utc, deleted_at)
     VALUES ($1,$2,$3,$4,$5,'1.10000000',$6,$7,'1.00000000','0.00','0.00',$8,$9,$10,$11)
     RETURNING id`,
    [
      t.userId,
      t.accountId,
      t.symbol,
      t.direction,
      t.status,
      t.status === "CLOSED" ? "1.20000000" : null,
      t.volume,
      t.pnl,
      t.occurredAt,
      t.status === "CLOSED" ? closeAt : null,
      t.deleted === true ? new Date().toISOString() : null,
    ],
  );
  return String(r.rows[0]!.id);
}

const WINDOW_FROM = new Date("2026-09-01T00:00:00.000Z");
const WINDOW_TO = new Date("2026-10-01T00:00:00.000Z");

// ── The migration ───────────────────────────────────────────────────────────

test("0027 — the audit vocabulary admits the two Phase 6 actions and still admits every earlier one", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const def = await db.pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'audit_log_action_check'`,
    );
    const text = String(def.rows[0]!.def);
    for (const action of [
      // The two this migration adds.
      "USER_SESSIONS_REVOKED",
      "USER_EMAIL_VERIFIED",
      // Every earlier action must still be present: widening a CHECK must never
      // drop a value an existing writer depends on (a mistake here would surface
      // as a 23514 on a TELEGRAM_* write, long after this migration ran).
      "OWNERSHIP_CLAIMED",
      "USER_ROLE_CHANGED",
      "USER_STATUS_CHANGED",
      "CREDENTIAL_CREATED",
      "CREDENTIAL_DELETED",
      "CREDENTIAL_USED",
      "ACCOUNT_BINDING_CHANGED",
      "TELEGRAM_LINK_STARTED",
      "TELEGRAM_LINK_COMPLETED",
      "TELEGRAM_LINK_FAILED",
      "TELEGRAM_UNLINKED",
      "TELEGRAM_CHANNEL_BOUND",
      "TELEGRAM_CHANNEL_UNBOUND",
    ]) {
      assert.match(text, new RegExp(action), `${action} must remain admissible`);
    }

    // An action OUTSIDE the vocabulary is still refused — the constraint is
    // closed, not merely extended.
    let refused = false;
    try {
      await db.pool.query(
        "INSERT INTO audit_log (action, actor_user_id, target_user_id, before_state, after_state) VALUES ('MADE_UP_ACTION', 1, NULL, NULL, NULL)",
      );
    } catch (err) {
      refused = (err as { code?: string }).code === "23514";
    }
    assert.ok(refused, "an unknown action must still be refused by the CHECK");

    for (const index of ["audit_log_occurred_idx", "audit_log_target_idx", "audit_log_actor_idx", "auth_events_type_occurred_idx"]) {
      const idx = await db.pool.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [index]);
      assert.equal(idx.rows.length, 1, `${index} must exist (the console reads by filter)`);
    }
  } finally {
    await db.close();
  }
});

test("0027 — the migration is idempotent: a re-run keeps the vocabulary and the rows", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userA, admin } = await seed(db.pool);
    await db.pool.query(
      `INSERT INTO audit_log (action, actor_user_id, target_user_id, before_state, after_state)
       VALUES ('USER_SESSIONS_REVOKED', $1, $2, 'live:1', 'live:0')`,
      [admin, userA],
    );
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sql = readFileSync(join(import.meta.dirname, "..", "migrations", "0027_admin_console.sql"), "utf8");
    await db.pool.query(sql);
    const n = await db.pool.query("SELECT count(*)::int AS n FROM audit_log");
    assert.equal(n.rows[0]!.n, 1, "the re-run must not drop audit evidence");
  } finally {
    await db.close();
  }
});

// ── Overview: the counts must agree with the domain ─────────────────────────

test("OVERVIEW — counts exclude tombstoned trades and every group is consistent", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userA, userB, admin, accountA, accountB } = await seed(db.pool);
    await db.pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [userB]);
    await db.pool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [userA]);
    await db.pool.query("UPDATE users SET plan = 'pro' WHERE id = $1", [userA]);

    await seedTrade(db.pool, { userId: userA, accountId: accountA, symbol: "EURUSD", direction: "buy", status: "CLOSED", volume: "1.00000000", pnl: "120.55", occurredAt: "2026-09-05T10:00:00.000Z" });
    await seedTrade(db.pool, { userId: userA, accountId: accountA, symbol: "XAUUSD", direction: "sell", status: "OPEN", volume: "0.50000000", pnl: null, occurredAt: "2026-09-06T10:00:00.000Z" });
    await seedTrade(db.pool, { userId: userB, accountId: accountB, symbol: "EURUSD", direction: "buy", status: "CLOSED", volume: "2.00000000", pnl: "-40.10", occurredAt: "2026-09-07T10:00:00.000Z" });
    await seedTrade(db.pool, { userId: userB, accountId: accountB, symbol: "EURUSD", direction: "buy", status: "CLOSED", volume: "9.00000000", pnl: "9999.99", occurredAt: "2026-09-08T10:00:00.000Z", deleted: true });
    // Outside the window entirely — must not appear in a windowed aggregate.
    await seedTrade(db.pool, { userId: userA, accountId: accountA, symbol: "GBPUSD", direction: "sell", status: "CLOSED", volume: "1.00000000", pnl: "77.00", occurredAt: "2026-06-01T10:00:00.000Z" });

    const store = new PgAdminConsoleStore(q(db.pool), 27);
    const overview = await store.overview();

    assert.equal(overview.users.total, 3);
    assert.equal(overview.users.active, 2);
    assert.equal(overview.users.suspended, 1);
    assert.equal(overview.users.verified, 1);
    assert.equal(overview.users.admins, 1);
    assert.equal(overview.users.superAdmins, 0);
    const planTotal = overview.users.byPlan.reduce((sum, row) => sum + row.count, 0);
    assert.equal(planTotal, overview.users.total, "the plan breakdown must add up to the total");
    assert.equal(
      overview.users.byLocale.reduce((sum, row) => sum + row.count, 0),
      overview.users.total,
      "the locale breakdown must add up to the total",
    );

    assert.equal(overview.trading.accounts, 2);
    assert.equal(overview.trading.connectedAccounts, 2);
    assert.equal(overview.trading.trades, 4, "the tombstoned trade is not a trade");
    assert.equal(overview.trading.openTrades, 1);
    assert.equal(overview.trading.closedTrades, 3);
    // 120.55 - 40.10 + 77.00 = 157.45, as an EXACT string.
    assert.equal(overview.trading.netPnl, "157.45");
    assert.equal(overview.trading.equity, "1500.25");
  } finally {
    await db.close();
  }
});

// ── Analytics: windows, money, trends ───────────────────────────────────────

test("TRADING ANALYTICS — half-open windows partition the data and money stays exact", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userA, userB, accountA, accountB } = await seed(db.pool);
    await seedTrade(db.pool, { userId: userA, accountId: accountA, symbol: "EURUSD", direction: "buy", status: "CLOSED", volume: "1.00000000", pnl: "10.10", occurredAt: "2026-09-01T00:00:00.000Z" });
    await seedTrade(db.pool, { userId: userA, accountId: accountA, symbol: "EURUSD", direction: "buy", status: "CLOSED", volume: "1.50000000", pnl: "-5.05", occurredAt: "2026-09-15T12:00:00.000Z" });
    await seedTrade(db.pool, { userId: userB, accountId: accountB, symbol: "XAUUSD", direction: "sell", status: "CLOSED", volume: "0.25000000", pnl: "0.00", occurredAt: "2026-09-30T23:59:59.000Z" });
    // The boundary row: exactly at `to`, so the [from,to) window must EXCLUDE it
    // and the NEXT window must include it. This is the assertion that catches an
    // off-by-one that double counts a trade in two reports.
    await seedTrade(db.pool, { userId: userB, accountId: accountB, symbol: "XAUUSD", direction: "sell", status: "CLOSED", volume: "1.00000000", pnl: "3.33", occurredAt: "2026-10-01T00:00:00.000Z" });
    // Deleted inside the window: excluded from every figure.
    await seedTrade(db.pool, { userId: userA, accountId: accountA, symbol: "BTCUSD", direction: "buy", status: "CLOSED", volume: "5.00000000", pnl: "1000.00", occurredAt: "2026-09-20T12:00:00.000Z", deleted: true });

    const store = new PgAdminConsoleStore(q(db.pool), 27);
    const first = await store.tradingAnalytics(WINDOW_FROM, WINDOW_TO);
    assert.equal(first.totals.trades, 3);
    assert.equal(first.totals.closedTrades, 3);
    assert.equal(first.totals.wins, 1);
    assert.equal(first.totals.losses, 1);
    assert.equal(first.totals.breakEven, 1);
    assert.equal(first.totals.netPnl, "5.05", "10.10 - 5.05 + 0.00, exactly");
    assert.equal(first.totals.volume, "2.75000000");
    assert.equal(first.totals.distinctTraders, 2);
    assert.deepEqual(
      first.byDirection.map((r) => r.key).sort(),
      ["buy", "sell"],
    );
    assert.equal(first.bySymbol[0]!.key, "EURUSD", "the largest group first");
    assert.equal(
      first.pnlTrend.find((p) => p.day === "2026-09-15")!.netPnl,
      "-5.05",
    );

    const second = await store.tradingAnalytics(WINDOW_TO, new Date("2026-11-01T00:00:00.000Z"));
    assert.equal(second.totals.trades, 1, "the boundary row belongs to the NEXT window");
    assert.equal(second.totals.netPnl, "3.33");

    const all = await store.tradingAnalytics(new Date("2020-01-01T00:00:00.000Z"), WINDOW_TO);
    assert.equal(all.totals.trades, 3);
    const partition = first.totals.trades + second.totals.trades;
    assert.equal(partition, 4, "the two windows together cover every live trade in the range");
  } finally {
    await db.close();
  }
});

test("USERS ANALYTICS — the registration trend counts only the window and reconciles with the total", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userA } = await seed(db.pool);
    await db.pool.query("UPDATE users SET created_at = '2026-09-10T08:00:00Z' WHERE id = $1", [userA]);
    const store = new PgAdminConsoleStore(q(db.pool), 27);
    const analytics = await store.usersAnalytics(WINDOW_FROM, WINDOW_TO);
    assert.equal(analytics.totals.total, 3);
    assert.equal(analytics.totals.newInRange, 1, "only the backdated account is in the window");
    assert.equal(analytics.registrationTrend.length, 1);
    assert.deepEqual(analytics.registrationTrend[0], { day: "2026-09-10", count: 1 });
    assert.equal(
      analytics.byStatus.reduce((sum, r) => sum + r.count, 0),
      analytics.totals.total,
    );
  } finally {
    await db.close();
  }
});

// ── Security feed and audit filters ─────────────────────────────────────────

test("SECURITY FEED — the newest first, filterable by result, and the total matches the filter", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userA } = await seed(db.pool);
    for (const [i, result] of ["success", "failure", "success"].entries()) {
      await db.pool.query(
        `INSERT INTO auth_events (occurred_at, user_id, event_type, result, reason, ip_address, user_agent)
         VALUES ($1,$2,'login',$3,$4,'203.0.113.5','probe/1')`,
        [
          new Date(Date.UTC(2026, 8, 10 + i, 10)).toISOString(),
          result === "failure" ? null : userA,
          result,
          result === "failure" ? "INVALID_CREDENTIALS" : null,
        ],
      );
    }
    await db.pool.query(
      `INSERT INTO auth_events (user_id, event_type, result) VALUES ($1,'signup','success')`,
      [userA],
    );

    const store = new PgAdminConsoleStore(q(db.pool), 27);
    const logins = await store.securityFeed("login", { limit: 10 });
    assert.equal(logins.total, 3);
    assert.equal(logins.items.length, 3);
    assert.equal(logins.items[0]!.result, "success", "newest first");
    assert.equal(logins.items[0]!.email, `console-a-${String((await db.pool.query("SELECT email FROM users WHERE id=$1", [userA])).rows[0]!.email).split("console-a-")[1]}`, "the join carries the e-mail");
    assert.equal(logins.items[1]!.reason, "INVALID_CREDENTIALS");
    assert.equal(logins.items[1]!.userId, null, "a failed login with no account has no user_id");

    const failures = await store.securityFeed("login", { limit: 10, result: "failure" });
    assert.equal(failures.total, 1, "the total must describe the FILTERED set, not the whole feed");
    assert.equal(failures.items.length, 1);

    const signups = await store.securityFeed("signup", { limit: 10 });
    assert.equal(signups.total, 1);
    assert.equal(signups.items[0]!.eventType, "signup");

    const windowed = await store.securityFeed("login", {
      limit: 10,
      since: new Date("2026-09-11T00:00:00.000Z"),
    });
    assert.equal(windowed.total, 2, "the window excludes the first row");
  } finally {
    await db.close();
  }
});

test("PLATFORM LISTS — user scoping, status filter and tombstone rule hold on both lists", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userA, userB, accountA, accountB } = await seed(db.pool);
    await db.pool.query("UPDATE trading_accounts SET sync_status = 'ERROR' WHERE id = $1", [accountB]);
    await seedTrade(db.pool, { userId: userA, accountId: accountA, symbol: "EURUSD", direction: "buy", status: "OPEN", volume: "1.00000000", pnl: null, occurredAt: "2026-09-05T10:00:00.000Z" });
    await seedTrade(db.pool, { userId: userB, accountId: accountB, symbol: "XAUUSD", direction: "sell", status: "CLOSED", volume: "1.00000000", pnl: "5.00", occurredAt: "2026-09-06T10:00:00.000Z" });
    await seedTrade(db.pool, { userId: userA, accountId: accountA, symbol: "XAUUSD", direction: "sell", status: "CLOSED", volume: "1.00000000", pnl: "9.00", occurredAt: "2026-09-07T10:00:00.000Z", deleted: true });

    const store = new PgAdminConsoleStore(q(db.pool), 27);
    const all = await store.platformTrades({}, 50, 0);
    assert.equal(all.total, 2, "the tombstoned trade is not listed");
    assert.equal(all.items[0]!.symbol, "XAUUSD");
    assert.equal(all.items[0]!.ownerEmail.includes("console-b-"), true, "the owner is named, not just the id");

    const mine = await store.platformTrades({ userId: userA }, 50, 0);
    assert.equal(mine.total, 1);
    assert.equal(mine.items[0]!.symbol, "EURUSD");

    const open = await store.platformTrades({ status: "OPEN" }, 50, 0);
    assert.equal(open.total, 1);

    const symbol = await store.platformTrades({ symbol: "XAUUSD" }, 50, 0);
    assert.equal(symbol.total, 1);

    const accounts = await store.platformAccounts({}, 50, 0);
    assert.equal(accounts.total, 2);
    assert.equal(accounts.items[0]!.balance, "500.00", "money is an exact string");
    const errored = await store.platformAccounts({ syncStatus: "ERROR" }, 50, 0);
    assert.equal(errored.total, 1);
    assert.equal(errored.items[0]!.label, "B-1");

    const perUser = await store.userAccounts(userA, 50, 0);
    assert.equal(perUser.total, 1);
    const userTrades = await store.userTrades(userA, 50, 0);
    assert.equal(userTrades.total, 1, "per-user reads honour the same tombstone rule");

    // Paging is a real OFFSET, and the total describes the whole set.
    const firstPage = await store.platformTrades({}, 1, 0);
    const secondPage = await store.platformTrades({}, 1, 1);
    assert.equal(firstPage.total, 2);
    assert.equal(firstPage.items.length, 1);
    assert.notEqual(firstPage.items[0]!.id, secondPage.items[0]!.id);
  } finally {
    await db.close();
  }
});

test("AUDIT READ — the filters narrow, the total narrows with them, and the e-mails are joined", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userA, userB, admin } = await seed(db.pool);
    for (const [action, target] of [
      ["USER_ROLE_CHANGED", userA],
      ["USER_STATUS_CHANGED", userA],
      ["USER_SESSIONS_REVOKED", userB],
    ] as const) {
      await db.pool.query(
        `INSERT INTO audit_log (action, actor_user_id, target_user_id, before_state, after_state)
         VALUES ($1,$2,$3,'before','after')`,
        [action, admin, target],
      );
    }
    const { PgAdminStore } = await import("../../apps/api/src/admin/adminRoutes.ts");
    const store = new PgAdminStore(q(db.pool));
    const all = await store.auditLog({ limit: 50 });
    assert.equal(all.total, 3);
    assert.equal(all.items[0]!.action, "USER_SESSIONS_REVOKED");
    assert.ok(all.items[0]!.actorEmail?.includes("console-admin-"), "the actor is named");
    assert.ok(all.items[0]!.targetEmail?.includes("console-b-"), "the target is named");

    const byAction = await store.auditLog({ limit: 50, action: "USER_STATUS_CHANGED" });
    assert.equal(byAction.total, 1);
    assert.equal(byAction.items[0]!.beforeState, "before");

    const byTarget = await store.auditLog({ limit: 50, targetUserId: userA });
    assert.equal(byTarget.total, 2, "the per-user audit view is this same read, filtered");

    const byActor = await store.auditLog({ limit: 50, actorUserId: admin });
    assert.equal(byActor.total, 3);

    const newestFirst = await store.auditLog({ limit: 1 });
    assert.equal(newestFirst.items.length, 1);
    const older = await store.auditLog({ limit: 1, before: newestFirst.items[0]!.id });
    assert.equal(older.items[0]!.id, byAction.items[0]!.id, "keyset paging walks the trail without repeating a row");
  } finally {
    await db.close();
  }
});

// ── The mutations ───────────────────────────────────────────────────────────

test("REVOKE — the conditional writes refuse a foreign or already-revoked session and count what they changed", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userA, userB } = await seed(db.pool);
    const store = new PgUserStore(db.pool);

    const s1 = await store.createSession({ userId: userA, refreshTokenHash: "r1-" + Math.random(), accessTokenHash: "a1", ipAddress: "203.0.113.1", userAgent: "probe/1", expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date() });
    const s2 = await store.createSession({ userId: userA, refreshTokenHash: "r2-" + Math.random(), accessTokenHash: "a2", ipAddress: "203.0.113.2", userAgent: "probe/2", expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date() });

    // A session id that belongs to ANOTHER user must not be actionable through
    // this user's route — the user_id predicate is the whole protection.
    assert.equal(await store.revokeUserSession(userB, s1.id, new Date()), false);
    assert.equal(await store.revokeUserSession(userA, "999999999", new Date()), false);
    assert.equal(await store.revokeUserSession(userA, "not-a-number", new Date()), false, "an unparseable id is false, not a 500");

    assert.equal(await store.revokeUserSession(userA, s1.id, new Date()), true);
    assert.equal(await store.revokeUserSession(userA, s1.id, new Date()), false, "already revoked is not re-revoked (revoked_at must not move)");

    const listed = await store.listSessions(userA, 10, 0);
    assert.equal(listed.total, 2, "revoked sessions stay in the history");
    const revokedRow = listed.items.find((s) => s.id === s1.id)!;
    assert.notEqual(revokedRow.revokedAt, null);

    const n = await store.revokeAllUserSessions(userA, new Date());
    assert.equal(n, 1, "only the session that was still live is counted");
    assert.equal(await store.revokeAllUserSessions(userA, new Date()), 0);

    // And it stays BOUNDED: the total is the whole history, the page is the page.
    const paged = await store.listSessions(userA, 1, 0);
    assert.equal(paged.items.length, 1);
    assert.equal(paged.total, 2);
    void s2;
  } finally {
    await db.close();
  }
});

test("VERIFY — the conditional update changes the row ONCE, even under a race, and the audit is transactional", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userA, admin } = await seed(db.pool);
    const users = new PgUserStore(db.pool);
    const auditStore = new PgAuditStore(db.pool);

    // Two callers attempt the same grant concurrently. The UPDATE carries
    // `email_verified_at IS NULL`, so exactly ONE of them can win — and only the
    // winner's audit row exists, which is what makes the trail a record of grants
    // rather than of button presses.
    const attempt = async (): Promise<boolean> => {
      const updated = await users.verifyEmailOnce(userA, new Date(), (tx) =>
        auditStore.append(
          {
            action: "USER_EMAIL_VERIFIED",
            actorUserId: admin,
            targetUserId: userA,
            beforeState: "unverified",
            afterState: "verified",
            requestId: null,
            occurredAt: new Date(),
          },
          tx as unknown as QueryFn,
        ),
      );
      return updated !== null;
    };
    const results = await Promise.all([attempt(), attempt()]);
    assert.equal(results.filter(Boolean).length, 1, "exactly one caller may claim the grant");

    const rows = await db.pool.query("SELECT email_verified_at FROM users WHERE id = $1", [userA]);
    assert.notEqual(rows.rows[0]!.email_verified_at, null);
    const auditRows = await db.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'USER_EMAIL_VERIFIED'");
    assert.equal(auditRows.rows[0]!.n, 1);

    // A THIRD call changes nothing and writes nothing.
    assert.equal(await attempt(), false);
    const after = await db.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'USER_EMAIL_VERIFIED'");
    assert.equal(after.rows[0]!.n, 1);
  } finally {
    await db.close();
  }
});

test("VERIFY — a failed audit write rolls the grant back (the trail is part of the operation)", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userA, admin } = await seed(db.pool);
    const users = new PgUserStore(db.pool);
    const auditStore = new PgAuditStore(db.pool);

    await assert.rejects(
      () =>
        users.verifyEmailOnce(userA, new Date(), async () => {
          throw new Error("audit store unavailable");
        }),
      /audit store unavailable/,
    );

    const rows = await db.pool.query("SELECT email_verified_at FROM users WHERE id = $1", [userA]);
    assert.equal(
      rows.rows[0]!.email_verified_at,
      null,
      "if the grant cannot be recorded it must not happen — a silent unrecorded privilege change is the defect C-34 exists to prevent",
    );
    void auditStore;
    void admin;
  } finally {
    await db.close();
  }
});

test("REVOKE — a failed audit write rolls the revocation back too", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userA } = await seed(db.pool);
    const users = new PgUserStore(db.pool);
    const session = await users.createSession({
      userId: userA,
      refreshTokenHash: "rollback-" + Math.random(),
      accessTokenHash: "a",
      ipAddress: null,
      userAgent: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
    });
    await assert.rejects(
      () =>
        users.revokeAllUserSessions(userA, new Date(), async () => {
          throw new Error("audit store unavailable");
        }),
      /audit store unavailable/,
    );
    const listed = await users.listSessions(userA, 10, 0);
    assert.equal(listed.items.find((s) => s.id === session.id)!.revokedAt, null, "the session is still live");
  } finally {
    await db.close();
  }
});

test("HEALTH FACTS — the numbers come from the live catalogue, and the head is the newest migration", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const store = new PgAdminConsoleStore(q(db.pool), 27, () => 42);
    const facts = await store.health();
    assert.ok(facts.databaseLatencyMs >= 0, "a measured round trip, not a placeholder");
    assert.equal(facts.appliedMigrations, 27, "every migration is applied by the battery's own setup");
    assert.equal(facts.migrationHead, "0027_admin_console.sql");
    assert.equal(facts.expectedMigrations, 27);
    assert.ok(facts.tables > 30, "the catalogue is counted, not assumed");
    assert.equal(facts.processUptimeSeconds, 42, "uptime is injected so the report is deterministic");

    // The expectation is HELD BY THE CALLER, never read from the database: a
    // process compares the schema it was built for against the schema it found.
    const behind = new PgAdminConsoleStore(q(db.pool), 30, () => 1);
    assert.equal((await behind.health()).expectedMigrations, 30);
  } finally {
    await db.close();
  }
});

test("DEVICES — the table is readable and honestly empty: nothing in Modern writes to it yet", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userA } = await seed(db.pool);
    const users = new PgUserStore(db.pool);
    assert.deepEqual(await users.listDevices(userA), [], "an empty list, not a fabricated one");

    // The read DOES work when a row exists, so the console's empty state is a
    // statement about the data rather than about the query.
    await db.pool.query(
      "INSERT INTO user_devices (user_id, fingerprint, first_seen, last_seen) VALUES ($1,'fp-1','2026-09-01T00:00:00Z','2026-09-02T00:00:00Z')",
      [userA],
    );
    const devices = await users.listDevices(userA);
    assert.equal(devices.length, 1);
    assert.equal(devices[0]!.fingerprint, "fp-1");
    assert.equal(devices[0]!.firstSeen, "2026-09-01T00:00:00.000Z");
  } finally {
    await db.close();
  }
});
