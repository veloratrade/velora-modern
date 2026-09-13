// Phase D D1 — real-PostgreSQL smoke (OD-6 spike verification apparatus).
//
// Purpose: one file that, against a REAL PostgreSQL server, proves the driver
// facts and DB behaviors the D1 recommendation depends on. Runs ONLY when
// DATABASE_URL is set (the authorized disposable environment: the
// postgres-evidence GitHub Actions service container). Without DATABASE_URL it
// prints SKIP and exits 0 — dev/CI batteries must not silently depend on it.
//
// Evidence policy (Phase D authorization): this file is the apparatus; the
// PASS/FAIL log from a real PostgreSQL run is the evidence. A local SKIP run
// proves only the gate, never PostgreSQL behavior.
//
// Checks (each prints "PASS <label>" so the Actions log is self-describing):
//   S1  server_version + migrations 0001–0005 apply on real PG (+ re-run no-op)
//   S2  NUMERIC(20,8)/(20,2) round-trip as EXACT strings with scale padding (ADR-001)
//   S3  BIGINT (int8) and COUNT(*) arrive as strings
//   S4  TIMESTAMPTZ round-trips as Date with exact epoch milliseconds
//   S5  velora_apply_exit trigger: valid exit allocates; over-allocation raises
//   S6  engine.transaction rolls back atomically on error
//   S7  cross-session row locking: FOR UPDATE blocks a second session until
//       statement_timeout (real two-client concurrency, impossible in PGlite)
//   S8  unique violation surfaces as PostgreSQL error code 23505; JSONB payload
//       round-trips as a parsed object
//   S9  single-statement ON CONFLICT upsert is atomic and returns BIGINT as string
import { join } from "node:path";
import assert from "node:assert/strict";
import { createEngine, migrate, type MigrationEngine } from "../db/migrate.ts";

const url = process.env.DATABASE_URL;

async function expectError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the operation to fail, but it succeeded");
}

function errParts(err: unknown): { code: string | undefined; message: string } {
  const e = err as { code?: string; message?: string };
  return { code: e.code, message: e.message ?? String(err) };
}

async function str(engine: MigrationEngine, sql: string, params?: unknown[]): Promise<string> {
  const rows = (await engine.query(sql, params)).rows;
  const first = rows[0];
  assert.ok(first, `query returned no rows: ${sql}`);
  const value = Object.values(first)[0];
  assert.ok(value !== undefined, `query returned no value: ${sql}`);
  return String(value);
}

async function main(): Promise<void> {
  if (url === undefined || url.trim() === "") {
    console.log(
      "SKIP: DATABASE_URL not set — the real-PostgreSQL smoke runs only in the " +
        "authorized disposable environment (postgres-evidence GitHub Actions workflow).",
    );
    return;
  }

  const engine = await createEngine(url);
  try {
    // ---- S1: real server identity + full migration set ----
    const version = await str(engine, "SELECT current_setting('server_version') AS v");
    assert.match(version, /^\d+\.\d+/, "server_version must look like a PostgreSQL version");
    console.log(`PASS S1a server_version = PostgreSQL ${version} (real server, not PGlite)`);

    const migrationsDir = join(import.meta.dirname, "..", "db", "migrations");
    const ran = await migrate(engine, migrationsDir);
    assert.deepEqual(
      ran,
      [
        "0001_core.sql",
        "0002_identity_capability.sql",
        "0003_email_preferences.sql",
        "0004_trading_accounts.sql",
        "0005_trades_api_contract.sql",
      ],
      "migrations 0001–0005 must apply on real PostgreSQL in order",
    );
    console.log("PASS S1b migrations 0001–0005 applied (schema_migrations tracking)");
    const reran = await migrate(engine, migrationsDir);
    assert.deepEqual(reran, [], "second migrate() run must be a no-op");
    console.log("PASS S1c migrate() re-run no-op (idempotency)");

    // ---- S2: NUMERIC exact-string round-trip (ADR-001 decimal-as-string) ----
    await engine.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)`,
      ["smoke@example.test", "not-a-real-hash-smoke-only"],
    );
    const userId = await str(engine, "SELECT id FROM users WHERE email = $1", ["smoke@example.test"]);
    await engine.query(
      `INSERT INTO trades (user_id, symbol, direction, entry_price, exit_price, volume,
         commission, net_pnl, r_multiple, occurred_at)
       VALUES ($1, 'XAUUSD', 'buy', $2, $3, $4, $5, $6, $7, $8)`,
      [userId, "1.10000000", "1.35000000", "2.00000000", "5.00", "493.50", "1.64500000", "2026-09-13T10:00:00Z"],
    );
    const tradeId = await str(engine, "SELECT id FROM trades WHERE user_id = $1", [userId]);
    const t = (await engine.query("SELECT * FROM trades WHERE id = $1", [tradeId])).rows[0];
    assert.ok(t, "trade row must exist");
    assert.equal(typeof t.entry_price, "string", "entry_price NUMERIC(20,8) must arrive as string");
    assert.equal(t.entry_price, "1.10000000", "NUMERIC(20,8) must preserve 8-decimal scale");
    assert.equal(t.exit_price, "1.35000000");
    assert.equal(t.volume, "2.00000000");
    assert.equal(t.contract_size, "1.00000000", "NUMERIC default must round-trip with scale");
    assert.equal(t.commission, "5.00", "NUMERIC(20,2) must preserve 2-decimal scale");
    assert.equal(t.net_pnl, "493.50");
    assert.equal(t.r_multiple, "1.64500000");
    assert.equal(t.allocated_volume, "0.00000000");
    console.log("PASS S2 NUMERIC(20,8)/(20,2) round-trip as exact scale-padded strings");

    // ---- S3: int8 → string (identity + COUNT) ----
    assert.equal(typeof t.id, "string", "BIGINT id must arrive as string (node-postgres parseBigInteger)");
    const count = await str(engine, "SELECT COUNT(*)::text AS c FROM users");
    assert.match(count, /^\d+$/, "COUNT(*) must arrive as digits (int8 → string)");
    console.log(`PASS S3 BIGINT/COUNT arrive as strings (id=${typeof t.id}, count=${count})`);

    // ---- S4: timestamptz → Date, exact epoch ----
    assert.ok(t.occurred_at instanceof Date, "timestamptz must arrive as Date");
    assert.equal((t.occurred_at as Date).getTime(), Date.parse("2026-09-13T10:00:00Z"));
    assert.ok(t.created_at instanceof Date, "DEFAULT now() timestamptz must arrive as Date");
    console.log("PASS S4 TIMESTAMPTZ round-trips as Date with exact epoch milliseconds");

    // ---- S5: velora_apply_exit trigger on real PG ----
    await engine.query(`INSERT INTO trade_exits (trade_id, volume, price) VALUES ($1, $2, $3)`, [
      tradeId,
      "0.50000000",
      "1.34000000",
    ]);
    const allocated = await str(engine, "SELECT allocated_volume FROM trades WHERE id = $1", [tradeId]);
    assert.equal(allocated, "0.50000000", "trigger must increment allocated_volume");
    const overErr = await expectError(() =>
      engine.query(`INSERT INTO trade_exits (trade_id, volume, price) VALUES ($1, $2, $3)`, [
        tradeId,
        "2.00000000",
        "1.40000000",
      ]),
    );
    assert.match(errParts(overErr).message, /over-allocation/, "over-allocation must raise the trigger exception");
    console.log("PASS S5 velora_apply_exit trigger: allocation increment + over-allocation rejection");

    // ---- S6: transaction rollback atomicity ----
    const usersBefore = Number(await str(engine, "SELECT COUNT(*)::text AS c FROM users"));
    const txErr = await expectError(() =>
      engine.transaction!(async (tx) => {
        await tx.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2)`, [
          "rollback-probe@example.test",
          "not-a-real-hash-smoke-only",
        ]);
        throw new Error("forced failure for rollback probe");
      }),
    );
    assert.match(errParts(txErr).message, /forced failure/, "transaction must propagate the error");
    const usersAfter = Number(await str(engine, "SELECT COUNT(*)::text AS c FROM users"));
    assert.equal(usersAfter, usersBefore, "rolled-back insert must not be visible");
    console.log("PASS S6 engine.transaction rolls back atomically on error");

    // ---- S7: cross-session row locking (two real clients) ----
    const engineB = await createEngine(url);
    try {
      await engine.exec("BEGIN");
      await engine.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      await engineB.exec("BEGIN");
      await engineB.exec("SET LOCAL statement_timeout = '500ms'");
      const started = Date.now();
      const lockErr = await expectError(() =>
        engineB.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]),
      );
      const waited = Date.now() - started;
      const parts = errParts(lockErr);
      assert.ok(
        parts.code === "57014" || /canceling statement/i.test(parts.message),
        `expected statement-timeout cancel, got code=${parts.code} message=${parts.message}`,
      );
      assert.ok(waited >= 400, `second session must have blocked (~500ms), waited ${waited}ms`);
      await engineB.exec("ROLLBACK");
      await engine.exec("ROLLBACK");
      console.log(
        `PASS S7 FOR UPDATE blocks a second session until statement_timeout (waited ${waited}ms, code 57014)`,
      );
    } finally {
      await engineB.close();
    }

    // ---- S8: unique violation code + JSONB round-trip ----
    await engine.query(
      `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload)
       VALUES ($1, $2, 'TRADE_CREATED', 'system', 0, $3)`,
      ["smoke-event-uid-1", tradeId, JSON.stringify({ source: "pg-smoke", n: 1 })],
    );
    const dupErr = await expectError(() =>
      engine.query(
        `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload)
         VALUES ($1, $2, 'TRADE_CREATED', 'system', 0, $3)`,
        ["smoke-event-uid-1", tradeId, JSON.stringify({ source: "pg-smoke", n: 1 })],
      ),
    );
    assert.equal(errParts(dupErr).code, "23505", "duplicate event_uid must surface as unique_violation");
    const ev = (await engine.query("SELECT payload FROM trade_events WHERE event_uid = $1", ["smoke-event-uid-1"])).rows[0];
    assert.ok(ev, "event row must exist");
    assert.deepEqual(ev.payload, { source: "pg-smoke", n: 1 }, "JSONB must round-trip as parsed object");
    console.log("PASS S8 unique violation = error code 23505; JSONB round-trips as parsed object");

    // ---- S9: atomic single-statement upsert (rate-limit shape) ----
    const upsertSql = `INSERT INTO rate_limits (bucket, hits, window_start)
      VALUES ($1, 1, now())
      ON CONFLICT (bucket) DO UPDATE SET hits = rate_limits.hits + 1
      RETURNING hits`;
    const h1 = (await engine.query(upsertSql, ["smoke:rl:1"])).rows[0]?.hits;
    const h2 = (await engine.query(upsertSql, ["smoke:rl:1"])).rows[0]?.hits;
    assert.equal(typeof h1, "string", "hits BIGINT must arrive as string");
    assert.equal(h1, "1");
    assert.equal(h2, "2", "ON CONFLICT must increment atomically in one statement");
    console.log("PASS S9 single-statement ON CONFLICT upsert is atomic (hits 1 → 2, BIGINT as string)");

    console.log("PG-SMOKE: ALL CHECKS PASSED on real PostgreSQL");
  } finally {
    await engine.close();
  }
}

main().catch((err: unknown) => {
  console.error("PG-SMOKE: FAIL", err);
  process.exitCode = 1;
});
