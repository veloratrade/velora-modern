// Real-PostgreSQL battery for Phase 9 analytics — overview / ai / operations / revenue.
//
// WHAT ONLY A REAL ENGINE CAN PROVE HERE. Analytics is an aggregation over
// multiple tables and time windows, and the value is that the numbers are
// EXACT, half-open, and authoritative. This battery proves:
//
//   1. TABLES EXIST WITH THE RIGHT CONTRACTS. `integration_health` is a closed
//      vocabulary (PK, CHECKs) and `system_logs`/`ai_coaching_logs` are counted
//      with the same half-open windows as the admin console's trading analytics.
//   2. MONEY AND TOKENS ARE EXACT. `cost_micro_usd` is summed as BIGINT micros
//      and `tokens_in+tokens_out` as ints — never floats.
//   3. WINDOWS PARTITION WITHOUT DOUBLE-COUNTING. A row exactly on `to` belongs
//      to the NEXT window, not the current one.
//   4. REVENUE IS NEVER FABRICATED. `revenueAnalytics` returns
//      available:false / NO_BILLING_SOURCE, not zeros.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareDatabase } from "./support/pgTestDb.ts";
import { PgAdminConsoleStore } from "../../apps/api/src/admin/adminConsoleStore.ts";
import type { QueryFn } from "../../apps/api/src/persistence/pg.ts";

const PG_URL = process.env.DATABASE_URL;
const SKIP = PG_URL === undefined ? "DATABASE_URL not set — real-PG battery" : false;

const q = (pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }): QueryFn =>
  (async (sql: string, params?: unknown[]) => (await pool.query(sql, params as unknown[] | undefined)).rows) as unknown as QueryFn;

async function seedUser(pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }): Promise<string> {
  const r = await pool.query("INSERT INTO users (email, password_hash, role) VALUES ($1,'hash','user') RETURNING id", [`analytics-${process.pid}-${process.hrtime.bigint()}@velora.test`]);
  return String(r.rows[0]!.id);
}

const WINDOW_FROM = new Date("2026-09-01T00:00:00.000Z");
const WINDOW_TO = new Date("2026-10-01T00:00:00.000Z");

test("0033 — integration_health table exists with closed vocabularies", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const t = await db.pool.query("SELECT to_regclass('public.integration_health') AS oid");
    assert.ok(t.rows[0]!.oid !== null, "integration_health must exist");
    const def = await db.pool.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'integration_health_integration_check'`);
    // May be named differently; check column check exists via information_schema
    const chk = await db.pool.query(`SELECT check_clause FROM information_schema.check_constraints WHERE constraint_name LIKE 'integration_health%'`);
    assert.ok(chk.rows.length > 0, "CHECK must exist on integration_health");
    // Valid row
    await db.pool.query(`INSERT INTO integration_health (integration, status, latency_ms, checked_at) VALUES ('metaapi','HEALTHY',12, now()) ON CONFLICT (integration) DO UPDATE SET status='HEALTHY'`);
    const n = await db.pool.query(`SELECT count(*)::int AS n FROM integration_health WHERE integration='metaapi'`);
    assert.equal(n.rows[0]!.n, 1);
    // Invalid vocab rejected
    let refused = false;
    try {
      await db.pool.query(`INSERT INTO integration_health (integration, status) VALUES ('unknown_integration','HEALTHY')`);
    } catch (e) {
      refused = (e as { code?: string }).code === "23514";
    }
    assert.ok(refused, "unknown integration must be rejected");
    let badStatus = false;
    try {
      await db.pool.query(`INSERT INTO integration_health (integration, status) VALUES ('email','BOGUS')`);
    } catch (e) {
      badStatus = (e as { code?: string }).code === "23514";
    }
    assert.ok(badStatus, "unknown status must be rejected");
  } finally {
    await db.close();
  }
});

test("ANALYTICS OVERVIEW — mixed-domain counts are consistent and windowed", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const user = await seedUser(db.pool);
    // Make user active and create a trading account
    await db.pool.query(`INSERT INTO trading_accounts (user_id, label, provider, platform, currency, sync_status, status, balance, equity) VALUES ($1,'OV-1','MT5','MT5','USD','CONNECTED','connected','1000','1000')`, [user]);
    // One trade inside window, one outside, one tombstoned
    await db.pool.query(
      `INSERT INTO trades (user_id, account_id, symbol, direction, status, entry_price, exit_price, volume, contract_size, commission, swap, net_pnl, occurred_at, occurred_close_at_utc, deleted_at)
       VALUES ($1, (SELECT id FROM trading_accounts WHERE user_id=$1 LIMIT 1), 'EURUSD','buy','CLOSED','1.1','1.2','1.0','1.0','0','0','10.00','2026-09-15T10:00:00Z','2026-09-15T11:00:00Z', NULL)`, [user]);
    await db.pool.query(
      `INSERT INTO trades (user_id, account_id, symbol, direction, status, entry_price, volume, contract_size, commission, swap, net_pnl, occurred_at, deleted_at)
       VALUES ($1, (SELECT id FROM trading_accounts WHERE user_id=$1 LIMIT 1), 'GBPUSD','sell','OPEN','1.1','1.0','1.0','0','0',NULL,'2026-08-01T10:00:00Z', NULL)`, [user]);
    await db.pool.query(
      `INSERT INTO trades (user_id, account_id, symbol, direction, status, entry_price, exit_price, volume, contract_size, commission, swap, net_pnl, occurred_at, occurred_close_at_utc, deleted_at)
       VALUES ($1, (SELECT id FROM trading_accounts WHERE user_id=$1 LIMIT 1), 'XAUUSD','buy','CLOSED','1.1','1.2','1.0','1.0','0','0','5.00','2026-09-20T10:00:00Z','2026-09-20T11:00:00Z', now())`, [user]);
    // AI ledger: one success inside window, one failed inside, one outside
    await db.pool.query(
      `INSERT INTO ai_coaching_logs (user_id, provider, model, prompt_version, insight, outcome, feature, tokens_in, tokens_out, cost_micro_usd, created_at)
       VALUES ($1,'gemini','gemini-1.5-flash','v1','{}','success','coach',100,50, 50000, '2026-09-10T10:00:00Z')`, [user]);
    await db.pool.query(
      `INSERT INTO ai_coaching_logs (user_id, provider, model, prompt_version, insight, outcome, feature, tokens_in, tokens_out, cost_micro_usd, created_at)
       VALUES ($1,'openai','gpt-4o','v1','{}','error','coach',10,5, 10000, '2026-09-12T10:00:00Z')`, [user]);
    await db.pool.query(
      `INSERT INTO ai_coaching_logs (user_id, provider, model, prompt_version, insight, outcome, feature, tokens_in, tokens_out, cost_micro_usd, created_at)
       VALUES ($1,'gemini','gemini-1.5-flash','v1','{}','success','coach', 20,10, 20000, '2026-08-15T10:00:00Z')`, [user]);
    // System logs: one error inside, one info inside, one outside
    await db.pool.query(`INSERT INTO system_logs (severity, source, message, created_at) VALUES ('ERROR','api','boom','2026-09-05T10:00:00Z')`);
    await db.pool.query(`INSERT INTO system_logs (severity, source, message, created_at) VALUES ('INFO','worker','ok','2026-09-06T10:00:00Z')`);
    await db.pool.query(`INSERT INTO system_logs (severity, source, message, created_at) VALUES ('ERROR','api','old','2026-08-05T10:00:00Z')`);
    await db.pool.query(`INSERT INTO integration_health (integration, status, checked_at) VALUES ('email','UNHEALTHY', now()) ON CONFLICT (integration) DO UPDATE SET status='UNHEALTHY'`);
    await db.pool.query(`INSERT INTO integration_health (integration, status, checked_at) VALUES ('metaapi','HEALTHY', now()) ON CONFLICT (integration) DO UPDATE SET status='HEALTHY'`);

    const store = new PgAdminConsoleStore(q(db.pool), 33);
    const overview = await store.analyticsOverview(WINDOW_FROM, WINDOW_TO);
    assert.ok(overview.users.total >= 1);
    assert.ok(overview.trading.totalTrades >= 1, "tombstoned excluded but not all");
    assert.equal(overview.trading.tradesInRange, 1, "only the 2026-09-15 CLOSED trade is in range and not deleted");
    assert.equal(overview.ai.totalRequests, 3);
    assert.equal(overview.ai.requestsInRange, 2);
    assert.equal(overview.ai.failedInRange, 1);
    assert.equal(overview.operations.systemErrors, 1);
    assert.equal(overview.operations.integrationFailures, 1, "email UNHEALTHY counts as failure");
    assert.equal(overview.revenue.available, false);
    assert.equal(overview.revenue.reason, "NO_BILLING_SOURCE");
  } finally {
    await db.close();
  }
});

test("AI ANALYTICS — group-by, tokens, cost, and half-open window", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const user = await seedUser(db.pool);
    await db.pool.query(
      `INSERT INTO ai_coaching_logs (user_id, provider, model, prompt_version, insight, outcome, feature, tokens_in, tokens_out, cost_micro_usd, created_at)
       VALUES ($1,'gemini','gemini-1.5-flash','v1','{}','success','coach', 100, 100, 100000, '2026-09-01T00:00:00Z')`, [user]);
    await db.pool.query(
      `INSERT INTO ai_coaching_logs (user_id, provider, model, prompt_version, insight, outcome, feature, tokens_in, tokens_out, cost_micro_usd, created_at)
       VALUES ($1,'openai','gpt-4o','v1','{}','error','journal_extract', 50, 0, 50000, '2026-09-30T23:59:59Z')`, [user]);
    // Exactly on TO -> next window
    await db.pool.query(
      `INSERT INTO ai_coaching_logs (user_id, provider, model, prompt_version, insight, outcome, feature, tokens_in, tokens_out, cost_micro_usd, created_at)
       VALUES ($1,'gemini','gemini-1.5-flash','v1','{}','success','coach', 10, 10, 10000, '2026-10-01T00:00:00Z')`, [user]);

    const store = new PgAdminConsoleStore(q(db.pool), 33);
    const ai = await store.aiAnalytics(WINDOW_FROM, WINDOW_TO);
    assert.equal(ai.total, 3);
    assert.equal(ai.inRange, 2, "half-open: 2026-10-01 excluded");
    assert.equal(ai.byProvider.find((r) => r.key === "gemini")!.count, 1, "only one gemini in range");
    assert.equal(ai.byFeature.find((r) => r.key === "coach")!.count, 1);
    assert.equal(ai.tokensUsed, 250, "100+100+50+0 = 250 in range");
    assert.equal(ai.cost, "0.1500", "100000+50000 micros = 0.15");
    assert.equal(ai.trend.length, 2);
    const next = await store.aiAnalytics(WINDOW_TO, new Date("2026-11-01T00:00:00Z"));
    assert.equal(next.inRange, 1, "boundary row belongs to next window");
  } finally {
    await db.close();
  }
});

test("OPERATIONS ANALYTICS — system logs breakdown and admin audit count", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const user = await seedUser(db.pool);
    await db.pool.query(`INSERT INTO system_logs (severity, source, message, created_at) VALUES ('ERROR','api','e1','2026-09-10T10:00:00Z')`);
    await db.pool.query(`INSERT INTO system_logs (severity, source, message, created_at) VALUES ('WARN','worker','w1','2026-09-11T10:00:00Z')`);
    await db.pool.query(`INSERT INTO system_logs (severity, source, message, created_at) VALUES ('ERROR','worker','e2','2026-09-12T10:00:00Z')`);
    await db.pool.query(`INSERT INTO audit_log (action, actor_user_id, target_user_id, before_state, after_state, created_at) VALUES ('USER_STATUS_CHANGED', $1, $1, 'a','b','2026-09-11T10:00:00Z')`, [user]);
    await db.pool.query(`INSERT INTO integration_health (integration, status, checked_at) VALUES ('ai','DEGRADED', now()) ON CONFLICT (integration) DO UPDATE SET status='DEGRADED'`);

    const store = new PgAdminConsoleStore(q(db.pool), 33);
    const ops = await store.operationsAnalytics(WINDOW_FROM, WINDOW_TO);
    assert.equal(ops.systemLogs.total, 3);
    assert.equal(ops.systemLogs.errors, 2);
    assert.equal(ops.systemLogs.bySeverity.find((r) => r.key === "ERROR")!.count, 2);
    assert.ok(ops.systemLogs.bySource.find((r) => r.key === "api")!.count >= 1);
    assert.ok(ops.integrations.find((r) => r.integration === "ai")!.status === "DEGRADED");
    assert.ok(ops.integrationFailures >= 1);
    assert.equal(ops.adminAudit.eventsInRange, 1);
  } finally {
    await db.close();
  }
});

test("REVENUE — always unavailable, never zeroed", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const store = new PgAdminConsoleStore(q(db.pool), 33);
    const rev = await store.revenueAnalytics();
    assert.equal(rev.available, false);
    assert.equal(rev.reason, "NO_BILLING_SOURCE");
    assert.match(rev.note, /unavailable, not zero/);
    for (const k of ["revenue", "mrr", "arr", "churn", "ltv", "paymentVolume", "refunds"]) {
      assert.equal((rev.metrics as Record<string, { available: false; reason: string }>)[k]!.available, false);
      assert.equal((rev.metrics as Record<string, { available: false; reason: string }>)[k]!.reason, "NO_BILLING_SOURCE");
    }
  } finally {
    await db.close();
  }
});
