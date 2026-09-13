// PgAccountStore real-PostgreSQL battery — Phase D D2.
//
// EVIDENCE LABEL (Phase D policy): executes ONLY against a REAL, disposable
// PostgreSQL (DATABASE_URL — postgres-evidence workflow). Without it, every
// test is SKIPPED. Proves: SQL-level ownership isolation, newest-first
// listing, quota count from the real table, CHECK-constraint surfacing
// (23514), and the rowCount-based delete boolean (pg-specific).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createEngine, migrate } from "../migrate.ts";
import { PgAccountStore } from "../../apps/api/src/accounts/pgAccountStore.ts";
import { isCheckViolation } from "../../apps/api/src/persistence/pg.ts";
import type { Pool } from "pg";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const PG_URL = process.env.DATABASE_URL;
const SKIP = PG_URL === undefined
  ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)"
  : false;

const T0 = new Date("2026-09-13T09:00:00.000Z");
const T1 = new Date("2026-09-13T09:05:00.000Z");

async function harness(): Promise<{
  pool: Pool;
  store: PgAccountStore;
  owner: string;
  other: string;
  close: () => Promise<void>;
}> {
  const { Pool } = await import("pg");
  const engine = await createEngine(PG_URL);
  await migrate(engine, MIGRATIONS);
  await engine.close();
  const pool = new Pool({ connectionString: PG_URL });
  await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1,$2), ($3,$4) ON CONFLICT (email) DO NOTHING",
    ["pgacct-owner@velora.test", "x", "pgacct-other@velora.test", "y"],
  );
  const ids = await pool.query(
    "SELECT id, email FROM users WHERE email IN ($1, $2)",
    ["pgacct-owner@velora.test", "pgacct-other@velora.test"],
  );
  const byEmail = new Map<string, string>(ids.rows.map((r: { id: string; email: string }) => [r.email, String(r.id)]));
  const owner = byEmail.get("pgacct-owner@velora.test")!;
  const other = byEmail.get("pgacct-other@velora.test")!;
  return { pool, store: new PgAccountStore(pool), owner, other, close: () => pool.end() };
}

test("PG: account lifecycle — create, newest-first list, ownership-scoped read/update/delete", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const a = await h.store.create(h.owner, {
      provider: "MT5", platform: "MT5", label: "First", accountNumber: "10001",
      currency: "USD", leverage: "100", timezone: "Asia/Tehran",
      timezoneSource: "user_config", status: "connected",
    }, T0);
    const b = await h.store.create(h.owner, {
      provider: "MANUAL", platform: "MANUAL", label: "Second", accountNumber: "",
      currency: "USD", leverage: "100", timezone: null,
      timezoneSource: "unknown", status: "disconnected",
    }, T1);
    assert.match(a.id, /^\d+$/);
    assert.equal(a.balance, "0.00"); // NUMERIC(20,2) default via toFixed normalization
    assert.equal(a.syncStatus, "DISCONNECTED"); // 0004 default

    const list = await h.store.listByUser(h.owner);
    assert.deepEqual(list.map((x) => x.label), ["Second", "First"]); // newest first
    assert.equal(list.length, 2);

    // ownership isolation at SQL level: wrong user → null (non-disclosing)
    assert.equal(await h.store.findByIdForUser(a.id, h.other), null);
    assert.notEqual(await h.store.findByIdForUser(a.id, h.owner), null);
    assert.equal(await h.store.countByUser(h.owner), 2);
    assert.equal(await h.store.countByUser(h.other), 0);

    const patched = await h.store.updateTimezone(a.id, h.owner, null, "unknown", T1);
    assert.notEqual(patched, null);
    assert.equal(patched!.timezone, null);
    assert.equal(await h.store.updateTimezone(a.id, h.other, "UTC", "user_config", T1), null);

    // rowCount-based boolean delete (pg-specific): true once, false after
    assert.equal(await h.store.deleteForUser(a.id, h.owner), true);
    assert.equal(await h.store.deleteForUser(a.id, h.owner), false);
    assert.equal(await h.store.deleteForUser(b.id, h.other), false); // ownership-scoped
    assert.equal(await h.store.countByUser(h.owner), 1);
  } finally {
    await h.close();
  }
});

test("PG: 0004 CHECK constraints surface through the adapter (SQLSTATE 23514)", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    for (const [col, val] of [["provider", "MT6"], ["currency", "usd"], ["leverage", "0"]] as const) {
      await assert.rejects(
        h.pool.query(
          `INSERT INTO trading_accounts (user_id, ${col}) VALUES ($1, $2)`,
          [h.owner, val],
        ),
        (e: unknown) => isCheckViolation(e),
        `${col} = ${val} must violate its CHECK with SQLSTATE 23514`,
      );
    }
  } finally {
    await h.close();
  }
});

test("PG: quota count under concurrent creation is exact (count-then-create races still bounded by the real table)", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    // 8 concurrent creates for one user; the count queries race but every
    // row lands — proving countByUser reads the real table under concurrency.
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        h.store.create(h.owner, {
          provider: "MT4", platform: "MT4", label: `Concurrent ${i}`, accountNumber: String(20000 + i),
          currency: "USD", leverage: "100", timezone: null,
          timezoneSource: "unknown", status: "disconnected",
        }, T0),
      ),
    );
    assert.equal(created.length, 8);
    assert.equal(await h.store.countByUser(h.owner), 8);
    // NOTE (D3 boundary): deterministic quota ENFORCEMENT under concurrency
    // (user-row FOR UPDATE) is Phase D3 scope — this test proves only exact
    // counting, not quota serialization.
  } finally {
    await h.close();
  }
});
