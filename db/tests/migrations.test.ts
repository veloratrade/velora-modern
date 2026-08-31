// Migration execution test — runs the real migration files against a
// DISPOSABLE PGlite instance (real PostgreSQL semantics in-wasm).
// This is dev/test evidence ONLY — it is NOT production hosting evidence
// (Gate 3B stays BLOCKED 0/20; ADR-010; governance 2026-08-31).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createEngine, migrate } from "../migrate.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

test("migrations apply cleanly and are idempotent (forward-only)", async () => {
  const engine = await createEngine();
  try {
    const ran = await migrate(engine, MIGRATIONS);
    assert.ok(ran.includes("0001_core.sql"));
    const reran = await migrate(engine, MIGRATIONS);
    assert.deepEqual(reran, []); // nothing reapplied
  } finally { await engine.close(); }
});

test("canonical email: write-time canonicalization + plain UNIQUE (ADR-003/D-02)", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    await engine.query(
      "INSERT INTO users(email, password_hash) VALUES ($1,$2)", ["owner@velora.ir", "x"]);
    // exact duplicates are rejected by the DB constraint…
    await assert.rejects(
      engine.query("INSERT INTO users(email, password_hash) VALUES ($1,$2)", ["owner@velora.ir", "y"]),
      /duplicate key|unique/i,
    );
    // …mixed-case input converges to the canonical form BEFORE the write,
    // so it must also collide (application-layer canonicalization is the gate).
    const { canonicalEmail } = await import("@velora/contracts");
    const canonical = canonicalEmail("  Owner@Velora.IR ");
    assert.equal(canonical, "owner@velora.ir");
    await assert.rejects(
      engine.query("INSERT INTO users(email, password_hash) VALUES ($1,$2)", [canonical, "y"]),
      /duplicate key|unique/i,
    );
  } finally { await engine.close(); }
});

test("trades: timestamptz + ADR-001 scales + external-id idempotency (ADR-002)", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const { rows } = await engine.query(`SELECT
        data_type, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_name='trades' AND column_name='entry_price'`);
    assert.equal(rows[0]!.data_type, "numeric");
    assert.equal(String(rows[0]!.numeric_precision), "20");
    assert.equal(String(rows[0]!.numeric_scale), "8");
    const ts = (await engine.query(`SELECT data_type FROM information_schema.columns
      WHERE table_name='trades' AND column_name='occurred_at'`)).rows[0]!;
    assert.equal(ts.data_type, "timestamp with time zone"); // ADR-004

    const u = (await engine.query("INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id", ["t@t.ir","x"])).rows[0]!;
    const a = (await engine.query(
      "INSERT INTO trading_accounts(user_id, external_account_id) VALUES($1,$2) RETURNING id",
      [u.id, "ACC-1"])).rows[0]!;
    await engine.query(`INSERT INTO trades(user_id, account_id, external_deal_id, symbol,
        direction, entry_price, volume, occurred_at)
      VALUES($1,$2,'D-1','XAUUSD','buy',$3,$4, now())`, [u.id, a.id, "2350.50000000", "1.00000000"]);
    // duplicate (account, external_deal_id) converges instead of double-counting
    await assert.rejects(
      engine.query(`INSERT INTO trades(user_id, account_id, external_deal_id, symbol,
          direction, entry_price, volume, occurred_at)
        VALUES($1,$2,'D-1','XAUUSD','buy',$3,$4, now())`, [u.id, a.id, "2350.00000000", "1.00000000"]),
      /duplicate key|unique/i,
    );
  } finally { await engine.close(); }
});

test("exit over-allocation is rejected at the DB level (ADR-002)", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const u = (await engine.query("INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id", ["a@a.ir","x"])).rows[0]!;
    const t = (await engine.query(`INSERT INTO trades(user_id, symbol, direction, entry_price,
        volume, occurred_at) VALUES($1,'EURUSD','buy',$2,$3, now()) RETURNING id`,
      [u.id, "1.08500000", "2.00000000"])).rows[0]!;
    await engine.query("INSERT INTO trade_exits(trade_id, volume, price) VALUES($1,$2,$3)",
      [t.id, "1.50000000", "1.08800000"]);
    await assert.rejects(
      engine.query("INSERT INTO trade_exits(trade_id, volume, price) VALUES($1,$2,$3)",
        [t.id, "0.50000001", "1.09000000"]),
      /over-allocation/i,
    );
  } finally { await engine.close(); }
});

test("webhook_events dedupe on (source, event_id) (ADR-008)", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    await engine.query("INSERT INTO webhook_events(source, event_id, payload) VALUES($1,$2,$3)",
      ["metaapi", "evt-1", JSON.stringify({ a: 1 })]);
    await assert.rejects(
      engine.query("INSERT INTO webhook_events(source, event_id, payload) VALUES($1,$2,$3)",
        ["metaapi", "evt-1", JSON.stringify({ a: 1 })]),
      /duplicate key|unique/i,
    );
  } finally { await engine.close(); }
});
