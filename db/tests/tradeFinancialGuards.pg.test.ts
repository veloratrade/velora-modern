// Real-PostgreSQL battery for 0025_trade_financial_guards — the DB-level form of
// Legacy `v0.3_trade_financial_consistency.sql` (Legacy lineage, see the migration
// header). Two things must be true, and only a real engine can prove either:
//
//   1. the guards REFUSE the financially-unresolved states Legacy refused
//      (zero/negative price, non-positive contract size, close before open,
//      CLOSED with no exit/PnL) — and accept the one state Modern adds (OPEN);
//   2. the migration FAILS LOUDLY when applied to a database that already holds
//      such a row, instead of repairing or ignoring it. That is the same
//      fail-closed choice Legacy made, and it is the property a load rehearsal
//      depends on: a dirty import must stop the migration, not pass through it.
//
// EVIDENCE LABEL (Phase D policy): executes ONLY against a REAL, disposable
// PostgreSQL (DATABASE_URL). Without it every test is SKIPPED, never silently
// passed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEngine, migrate } from "../migrate.ts";
import { prepareDatabase } from "./support/pgTestDb.ts";

const PG_URL = process.env.DATABASE_URL;
const SKIP =
  PG_URL === undefined ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)" : false;

const GUARDED_MIGRATION = "0025_trade_financial_guards.sql";

async function seedTrade(
  pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  values: Record<string, unknown> = {},
): Promise<void> {
  const user = await pool.query("INSERT INTO users (email, password_hash) VALUES ($1,'x') ON CONFLICT (email) DO NOTHING RETURNING id", [
    `guards-${process.pid}-${process.hrtime.bigint()}@velora.test`,
  ]);
  let userId: string;
  if (user.rows.length > 0) {
    userId = String(user.rows[0].id);
  } else {
    const again = await pool.query("SELECT id FROM users ORDER BY id LIMIT 1");
    userId = String(again.rows[0].id);
  }
  await pool.query(
    `INSERT INTO trades (user_id, symbol, direction, status, entry_price, exit_price, volume,
                         contract_size, commission, swap, net_pnl, occurred_at, occurred_close_at_utc,
                         stop_loss, take_profit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      userId,
      (values.symbol as string) ?? "EURUSD",
      (values.direction as string) ?? "buy",
      (values.status as string) ?? "CLOSED",
      values.entry_price ?? "1.10000",
      values.exit_price === undefined ? "1.10500" : values.exit_price,
      values.volume ?? "1.00000000",
      values.contract_size ?? "1.00000000",
      values.commission ?? "0.00",
      values.swap ?? "0.00",
      values.net_pnl === undefined ? "493.50" : values.net_pnl,
      values.occurred_at ?? "2026-09-01T10:00:00Z",
      values.close === undefined ? "2026-09-01T11:00:00Z" : values.close,
      values.stop_loss ?? null,
      values.take_profit ?? null,
    ],
  );
}

/** Run a statement that must be REFUSED, and report why the database said no. */
async function rejected(
  pool: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  fn: () => Promise<unknown>,
  constraintName: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const code = (err as { code?: string }).code;
    assert.equal(code, "23514", `expected a CHECK violation, got ${code}: ${String(err)}`);
    assert.match(String(err), new RegExp(constraintName), `expected constraint ${constraintName} to be the reason`);
    return;
  }
  assert.fail(`the database ACCEPTED a row that must be refused by ${constraintName}`);
}

test("0025 — a complete CLOSED trade is accepted (the guards do not reject valid history)", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    await seedTrade(db.pool as never);
    const n = await db.pool.query("SELECT count(*)::int AS n FROM trades");
    assert.equal(n.rows[0].n, 1);
  } finally {
    await db.close();
  }
});

test("0025 — an OPEN trade with no exit, no PnL and no close instant is accepted (the state Modern adds over Legacy)", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    await seedTrade(db.pool as never, { status: "OPEN", exit_price: null, net_pnl: null, close: null });
    const row = await db.pool.query("SELECT status, exit_price, net_pnl FROM trades");
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].net_pnl, null);
  } finally {
    await db.close();
  }
});

test("0025 — entry price, exit price, contract size, stop loss and take profit must be positive", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    // Each case would be a silently-wrong PnL: Legacy's own guard listed exactly
    // these magnitudes and refused to deploy while any row violated them.
    await rejected(db.pool as never, () => seedTrade(db.pool as never, { entry_price: "0" }), "trades_entry_price_positive");
    await rejected(db.pool as never, () => seedTrade(db.pool as never, { exit_price: "0" }), "trades_exit_price_positive");
    await rejected(db.pool as never, () => seedTrade(db.pool as never, { contract_size: "0" }), "trades_contract_size_positive");
    const c = await db.pool.query("SELECT count(*)::int AS n FROM trades");
    assert.equal(c.rows[0].n, 0, "no rejected row may have been written");
  } finally {
    await db.close();
  }
});

test("0025 — a stop loss / take profit is either absent or positive, never zero", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    // OPEN on purpose: a CLOSED trade without an exit would trip the
    // completeness guard first and hide the magnitude guard under test.
    await seedTrade(db.pool as never, { status: "OPEN", exit_price: null, net_pnl: null, close: null });
    await rejected(db.pool as never, () => seedTrade(db.pool as never, { status: "OPEN", exit_price: null, net_pnl: null, close: null, stop_loss: "0" }), "trades_stop_loss_positive");
    await rejected(db.pool as never, () => seedTrade(db.pool as never, { status: "OPEN", exit_price: null, net_pnl: null, close: null, take_profit: "0" }), "trades_take_profit_positive");
    // A stop loss on the correct side of the entry is the ordinary case.
    await seedTrade(db.pool as never, { status: "OPEN", exit_price: null, net_pnl: null, close: null, stop_loss: "1.09700", take_profit: "1.11000" });
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM trades")).rows[0].n, 2);
  } finally {
    await db.close();
  }
});

test("0025 — a close instant before the open instant is refused; equal instants are allowed", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    await rejected(
      db.pool as never,
      () => seedTrade(db.pool as never, { occurred_at: "2026-09-01T11:00:00Z", close: "2026-09-01T10:00:00Z" }),
      "trades_close_after_open",
    );
    // Zero-duration fills are real (MetaAPI deal snapshots) and must remain legal.
    await seedTrade(db.pool as never, { occurred_at: "2026-09-01T10:00:00Z", close: "2026-09-01T10:00:00Z" });
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM trades")).rows[0].n, 1);
  } finally {
    await db.close();
  }
});

test("0025 — a CLOSED trade must carry exit price, realized PnL and a close instant together", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    await rejected(db.pool as never, () => seedTrade(db.pool as never, { exit_price: null }), "trades_closed_has_financials");
    await rejected(db.pool as never, () => seedTrade(db.pool as never, { net_pnl: null }), "trades_closed_has_financials");
    await rejected(db.pool as never, () => seedTrade(db.pool as never, { close: null }), "trades_closed_has_financials");
  } finally {
    await db.close();
  }
});

test("0025 — a partial exit must have a positive price and volume (Legacy's trade_exits guard, migrated)", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    await seedTrade(db.pool as never);
    const tradeId = String((await db.pool.query("SELECT id FROM trades LIMIT 1")).rows[0].id);
    await rejected(
      db.pool as never,
      () => db.pool.query("INSERT INTO trade_exits (trade_id, volume, price) VALUES ($1,'0.5','0')", [tradeId]),
      "trade_exits_price_positive",
    );
    await rejected(
      db.pool as never,
      () => db.pool.query("INSERT INTO trade_exits (trade_id, volume, price) VALUES ($1,'0','1.1')", [tradeId]),
      "trade_exits_volume_check",
    );
    await db.pool.query("INSERT INTO trade_exits (trade_id, volume, price) VALUES ($1,'0.5','1.105')", [tradeId]);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM trade_exits")).rows[0].n, 1);
  } finally {
    await db.close();
  }
});

test("0025 — the migration is idempotent: re-applying its statements over existing data is a no-op", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    await seedTrade(db.pool as never);
    const sql = readFileSync(join(import.meta.dirname, "..", "migrations", GUARDED_MIGRATION), "utf8");
    // Same idiom the runner uses: the file's own DROP … IF EXISTS + ADD lines.
    await db.pool.query(sql);
    await db.pool.query(sql);
    const cons = await db.pool.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'trades'::regclass AND contype = 'c' ORDER BY conname`,
    );
    const names = cons.rows.map((r: { conname: string }) => r.conname);
    assert.equal(names.filter((n: string) => n === "trades_closed_has_financials").length, 1, "exactly one guard, not duplicates");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM trades")).rows[0].n, 1, "existing valid row survives");
  } finally {
    await db.close();
  }
});

test("0025 — applied to a database holding a stale unresolved row the migration FAILS LOUDLY (never repairs, never ignores)", { skip: SKIP }, async () => {
  // The rehearsal property: a dirty load must stop the migration. Built on a
  // scratch DATABASE so the shared test database keeps its schema.
  const admin = new URL(PG_URL as string);
  const scratchName = "velora_guard_scratch";
  const scratchUrl = new URL(admin.toString());
  scratchUrl.pathname = `/${scratchName}`;

  const adminEngine = await createEngine(PG_URL as string);
  await adminEngine.exec(`DROP DATABASE IF EXISTS ${scratchName}`);
  await adminEngine.exec(`CREATE DATABASE ${scratchName}`);
  await adminEngine.close();

  // 1. every migration BEFORE the guards (a faithful "pre-0025" database).
  const dir = mkdtempSync(join(tmpdir(), "velora-guards-"));
  const source = join(import.meta.dirname, "..", "migrations");
  const files = readdirSync(source).filter((f) => f.endsWith(".sql")).sort();
  const before = files.filter((f) => f < GUARDED_MIGRATION);
  assert.ok(before.length > 0, "the guard migration must not be the first one");
  for (const f of before) writeFileSync(join(dir, f), readFileSync(join(source, f)));

  const scratch = await createEngine(scratchUrl.toString());
  await migrate(scratch, dir);
  // …holding exactly the sort of row Legacy's guard refused to deploy with.
  await scratch.query("INSERT INTO users (email, password_hash) VALUES ($1,'x')", ["stale@velora.test"]);
  await scratch.query(
    `INSERT INTO trades (user_id, symbol, direction, status, entry_price, exit_price, volume, occurred_at)
     VALUES ((SELECT id FROM users LIMIT 1), 'EURUSD', 'buy', 'CLOSED', '1.10000', '0', '1', now())`,
  );
  await scratch.close();

  // 2. now the real chain, which includes 0025.
  const withGuards = await createEngine(scratchUrl.toString());
  let failed = false;
  let message = "";
  try {
    await migrate(withGuards, source);
  } catch (err) {
    failed = true;
    message = String(err);
  }
  if (!failed) {
    // …and, if it did NOT fail, say exactly which guard was missing.
    const check = await withGuards.query(
      "SELECT count(*)::int AS n FROM trades WHERE status = 'CLOSED' AND (exit_price IS NULL OR exit_price <= 0)",
    );
    const n = (check.rows[0] as { n: number }).n;
    await withGuards.close();
    await cleanupScratch(PG_URL as string, scratchName);
    assert.fail(`the guard migration accepted a stale unresolved row (unresolved CLOSED rows present: ${n})`);
  }
  assert.match(message, /trades_closed_has_financials|trades_exit_price_positive|check constraint/i);
  // The failed migration must not have left the schema half-guarded.
  const cons = await withGuards.query(
    "SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'trades'::regclass AND conname = 'trades_closed_has_financials'",
  );
  const applied = await withGuards.query("SELECT count(*)::int AS n FROM schema_migrations WHERE name = $1", [GUARDED_MIGRATION]);
  await withGuards.close();
  await cleanupScratch(PG_URL as string, scratchName);
  assert.equal((cons.rows[0] as { n: number }).n, 0, "a failed migration must not be partially recorded as applied");
  assert.equal((applied.rows[0] as { n: number }).n, 0);
});

async function cleanupScratch(url: string, name: string): Promise<void> {
  const engine = await createEngine(url);
  await engine.exec(`DROP DATABASE IF EXISTS ${name}`);
  await engine.close();
}
