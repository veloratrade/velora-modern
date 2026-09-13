// D5 real-PostgreSQL battery — ROLES & PRIVILEGE ENFORCEMENT.
//
// EVIDENCE LABEL (Phase D policy): executes ONLY against a REAL, disposable
// PostgreSQL (DATABASE_URL — postgres-evidence workflow). Without it, every
// test is SKIPPED. A local SKIP is NOT D5 evidence.
//
// WHY THIS BATTERY EXISTS: `db/roles.sql` declares the least-privilege grid
// (ADR-010, D-15) but was applied by NOTHING before D5 — the append-only
// guarantee on the trade ledger (D1 risk R9) was an unexecuted SQL file.
//
// ── TESTING METHOD AND ITS LIMIT (read before trusting these results) ───────
// Privileges are exercised with `SET ROLE`, NOT with per-role logins.
//
//   Why: the connection role in CI is the container bootstrap SUPERUSER, and
//   it also OWNS every table (it runs the migrations). PostgreSQL exempts both
//   from privilege checks — "database superusers can access all objects
//   regardless of object privilege settings" and "there is no need to grant
//   privileges to the owner". A REVOKE test issued on that connection would
//   silently PASS the forbidden UPDATE and certify a false guarantee.
//   `SET ROLE` drops those exemptions: "when a superuser chooses to SET ROLE to
//   a non-superuser role, they lose their superuser privileges", and
//   "permissions checking is carried out as though the named role were the one
//   that had logged in originally".
//
//   THE LIMIT — stated plainly: this proves the PRIVILEGE AUTHORIZATION GRID.
//   It does NOT prove LOGIN/AUTHENTICATION. No test passwords are created
//   (owner instruction; AGENTS.md rule 1), so pg_hba/scram authentication for
//   these roles is NOT exercised and is NOT claimed. That is D5's documented
//   boundary, not an oversight.
//
// Structure: this battery owns its schema setup. It applies the migration
// chain, then db/roles-bootstrap.sql + db/roles.sql, then asserts the grid.
// Negative tests assert SQLSTATE 42501 (insufficient_privilege) — never
// message text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createEngine, migrate } from "../migrate.ts";
import type { Pool, PoolClient } from "pg";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const DB_DIR = join(import.meta.dirname, "..");
const PG_URL = process.env.DATABASE_URL;
const SKIP = PG_URL === undefined
  ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)"
  : false;

const ROLES = ["app_readwrite", "velora_worker", "velora_migrator", "velora_readonly"] as const;
const INSUFFICIENT_PRIVILEGE = "42501";

/** Applies migrations + the D5 privilege layer, then returns a pool. */
async function harness(): Promise<{ pool: Pool; close: () => Promise<void> }> {
  const { Pool } = await import("pg");
  const engine = await createEngine(PG_URL);
  await migrate(engine, MIGRATIONS);
  await engine.close();

  const pool = new Pool({ connectionString: PG_URL });
  pool.on("error", () => { /* idle-client socket errors must not crash the battery */ });

  // Bootstrap roles, then the post-migration privilege grid — the documented
  // execution order (db/roles-bootstrap.sql → migrate → db/roles.sql).
  await pool.query(readFileSync(join(DB_DIR, "roles-bootstrap.sql"), "utf8"));
  await pool.query(readFileSync(join(DB_DIR, "roles.sql"), "utf8"));

  return { pool, close: async () => { await pool.end(); } };
}

/**
 * Runs `fn` on a dedicated client under `SET LOCAL ROLE <role>` inside a
 * transaction that is ALWAYS rolled back. Rollback keeps the battery
 * side-effect-free and guarantees the role reverts even on failure.
 */
async function asRole<T>(pool: Pool, role: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    return await fn(client);
  } finally {
    try { await client.query("ROLLBACK"); } catch { /* connection already unusable */ }
    client.release();
  }
}

/**
 * Executes committed DDL AS velora_migrator on a dedicated client.
 *
 * Deliberately not `asRole`: that helper rolls back (so nothing would persist),
 * and its `SET LOCAL ROLE` reverts at COMMIT — a table created after committing
 * would be owned by the connection role instead of the migrator, which would
 * silently bypass the very default-privilege path under test.
 */
async function createAsMigrator(pool: Pool, ddl: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SET ROLE velora_migrator");
    await client.query(ddl);
  } finally {
    try { await client.query("RESET ROLE"); } catch { /* connection unusable */ }
    client.release();
  }
}

/** Asserts a statement is rejected with SQLSTATE 42501 (never message text). */
async function assertDenied(pool: Pool, role: string, sql: string, params: unknown[] = []): Promise<void> {
  await asRole(pool, role, async (c) => {
    await assert.rejects(
      () => c.query(sql, params as never[]),
      (err: unknown) => {
        const code = (err as { code?: string }).code;
        assert.equal(code, INSUFFICIENT_PRIVILEGE,
          `expected SQLSTATE ${INSUFFICIENT_PRIVILEGE} for [${role}] ${sql} — got ${String(code)}`);
        return true;
      },
      `${role} must NOT be permitted: ${sql}`,
    );
  });
}

/** Seeds one user + one trade as the owner; returns ids. Committed (not rolled back). */
async function seed(pool: Pool): Promise<{ userId: string; tradeId: string }> {
  const tag = `d5-${Date.now()}`;
  const u = await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id",
    [`${tag}@velora.test`],
  );
  const userId = String(u.rows[0].id);
  const t = await pool.query(
    `INSERT INTO trades (user_id, symbol, direction, entry_price, volume, occurred_at)
     VALUES ($1,'EURUSD','buy','1.10000000','1.00000000', now()) RETURNING id`,
    [userId],
  );
  return { userId, tradeId: String(t.rows[0].id) };
}

// ── P1/P2 — roles exist, and the layer is idempotent ────────────────────────

test("PG D5 P1: all four roles exist after applying the privilege layer", { skip: SKIP }, async () => {
  const { pool, close } = await harness();
  try {
    const res = await pool.query("SELECT rolname FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname", [ROLES]);
    assert.deepEqual(res.rows.map((r: { rolname: string }) => r.rolname), [...ROLES].sort());
  } finally { await close(); }
});

test("PG D5 P2: roles.sql is idempotent — re-applying twice is a clean no-op", { skip: SKIP }, async () => {
  const { pool, close } = await harness();
  try {
    const sql = readFileSync(join(DB_DIR, "roles.sql"), "utf8");
    await pool.query(sql);
    await pool.query(sql); // third application overall
    const res = await pool.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY($1)", [ROLES]);
    assert.equal(res.rows[0].n, 4);
    // The append-only guarantee must survive re-application.
    const priv = await pool.query(
      "SELECT has_table_privilege('app_readwrite','trade_events','UPDATE') AS u",
    );
    assert.equal(priv.rows[0].u, false);
  } finally { await close(); }
});

// ── P3–P8 — append-only ledger enforcement (the core D5 guarantee) ──────────

test("PG D5 P3: app_readwrite CAN INSERT into trade_events (append allowed)", { skip: SKIP }, async () => {
  const { pool, close } = await harness();
  try {
    const { tradeId } = await seed(pool);
    await asRole(pool, "app_readwrite", async (c) => {
      const res = await c.query(
        `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload)
         VALUES ($1,$2,'TRADE_CREATED','user',0,'{}'::jsonb) RETURNING id`,
        [`d5-append-${Date.now()}`, tradeId],
      );
      assert.ok(res.rows[0].id, "append must succeed");
    });
  } finally { await close(); }
});

test("PG D5 P4: app_readwrite CANNOT UPDATE trade_events → 42501", { skip: SKIP }, async () => {
  const { pool, close } = await harness();
  try { await assertDenied(pool, "app_readwrite", "UPDATE trade_events SET actor = 'admin'"); }
  finally { await close(); }
});

test("PG D5 P5: app_readwrite CANNOT DELETE trade_events → 42501", { skip: SKIP }, async () => {
  const { pool, close } = await harness();
  try { await assertDenied(pool, "app_readwrite", "DELETE FROM trade_events"); }
  finally { await close(); }
});

test("PG D5 P6: app_readwrite CANNOT UPDATE/DELETE webhook_events → 42501", { skip: SKIP }, async () => {
  const { pool, close } = await harness();
  try {
    await assertDenied(pool, "app_readwrite", "UPDATE webhook_events SET source = 'x'");
    await assertDenied(pool, "app_readwrite", "DELETE FROM webhook_events");
  } finally { await close(); }
});

test("PG D5 P7: velora_worker CAN INSERT into both ledger tables (append allowed)", { skip: SKIP }, async () => {
  const { pool, close } = await harness();
  try {
    const { tradeId } = await seed(pool);
    await asRole(pool, "velora_worker", async (c) => {
      await c.query(
        `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload)
         VALUES ($1,$2,'TRADE_IMPORTED','sync',0,'{}'::jsonb)`,
        [`d5-worker-${Date.now()}`, tradeId],
      );
      await c.query(
        "INSERT INTO webhook_events (source, event_id, payload) VALUES ('metaapi',$1,'{}'::jsonb)",
        [`d5-wh-${Date.now()}`],
      );
    });
  } finally { await close(); }
});

test("PG D5 P8: velora_worker CANNOT UPDATE/DELETE either ledger table → 42501", { skip: SKIP }, async () => {
  const { pool, close } = await harness();
  try {
    await assertDenied(pool, "velora_worker", "UPDATE trade_events SET actor = 'admin'");
    await assertDenied(pool, "velora_worker", "DELETE FROM trade_events");
    await assertDenied(pool, "velora_worker", "UPDATE webhook_events SET source = 'x'");
    await assertDenied(pool, "velora_worker", "DELETE FROM webhook_events");
  } finally { await close(); }
});

// ── P9 — least privilege must not break the application ────────────────────

test("PG D5 P9: app_readwrite retains full DML on ordinary application tables", { skip: SKIP }, async () => {
  const { pool, close } = await harness();
  try {
    const { userId } = await seed(pool);
    await asRole(pool, "app_readwrite", async (c) => {
      const t = await c.query(
        `INSERT INTO trades (user_id, symbol, direction, entry_price, volume, occurred_at)
         VALUES ($1,'GBPUSD','sell','1.25000000','2.00000000', now()) RETURNING id`,
        [userId],
      );
      const id = String(t.rows[0].id);
      await c.query("UPDATE trades SET notes = 'ok' WHERE id = $1", [id]);
      await c.query("SELECT * FROM trades WHERE id = $1", [id]);
      await c.query("DELETE FROM trades WHERE id = $1", [id]);
      await c.query("SELECT * FROM users WHERE id = $1", [userId]);
      await c.query("UPDATE users SET full_name = 'n' WHERE id = $1", [userId]);
    });
  } finally { await close(); }
});

// ── P10/P11 — readonly ──────────────────────────────────────────────────────

test("PG D5 P10: velora_readonly CAN SELECT", { skip: SKIP }, async () => {
  const { pool, close } = await harness();
  try {
    await seed(pool);
    await asRole(pool, "velora_readonly", async (c) => {
      await c.query("SELECT count(*) FROM trades");
      await c.query("SELECT count(*) FROM users");
      await c.query("SELECT count(*) FROM trade_events");
    });
  } finally { await close(); }
});

test("PG D5 P11: velora_readonly CANNOT INSERT/UPDATE/DELETE → 42501", { skip: SKIP }, async () => {
  const { pool, close } = await harness();
  try {
    const { userId } = await seed(pool);
    await assertDenied(pool, "velora_readonly",
      `INSERT INTO trades (user_id, symbol, direction, entry_price, volume, occurred_at)
       VALUES ($1,'EURUSD','buy','1.0','1.0', now())`, [userId]);
    await assertDenied(pool, "velora_readonly", "UPDATE trades SET notes = 'x'");
    await assertDenied(pool, "velora_readonly", "DELETE FROM trades");
    await assertDenied(pool, "velora_readonly", "INSERT INTO webhook_events (source,event_id,payload) VALUES ('s','e','{}'::jsonb)");
  } finally { await close(); }
});

// ── P12/P13 — migrator: owns the schema, but is not an app role ────────────

test("PG D5 P12: velora_migrator can perform schema DDL (CREATE/ALTER/DROP)", { skip: SKIP }, async () => {
  const { pool, close } = await harness();
  try {
    await asRole(pool, "velora_migrator", async (c) => {
      await c.query("CREATE TABLE d5_ddl_probe (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY)");
      await c.query("ALTER TABLE d5_ddl_probe ADD COLUMN note TEXT");
      await c.query("CREATE INDEX d5_ddl_probe_idx ON d5_ddl_probe(note)");
      await c.query("DROP TABLE d5_ddl_probe");
    });
  } finally { await close(); }
});

test("PG D5 P13: velora_migrator holds NO runtime DML on application tables → 42501", { skip: SKIP }, async () => {
  const { pool, close } = await harness();
  try {
    // Role separation: the schema owner is not an application data role.
    await assertDenied(pool, "velora_migrator", "SELECT * FROM users");
    await assertDenied(pool, "velora_migrator", "DELETE FROM trades");
  } finally { await close(); }
});

// ── P14 — the privilege-sensitive service path (owner-required) ─────────────

test("PG D5 P14: least privilege does not break the exit path — trigger UPDATEs trades as invoker", { skip: SKIP }, async () => {
  const { pool, close } = await harness();
  try {
    const { tradeId } = await seed(pool);
    // velora_apply_exit is NOT SECURITY DEFINER, so it executes with the
    // INVOKER's privileges: inserting an exit as app_readwrite forces a
    // trigger-driven UPDATE on `trades`. If least privilege were mis-scoped,
    // this is exactly where the application would break.
    await asRole(pool, "app_readwrite", async (c) => {
      await c.query(
        "INSERT INTO trade_exits (trade_id, volume, price) VALUES ($1,'0.40000000','1.20000000')",
        [tradeId],
      );
      const res = await c.query("SELECT allocated_volume FROM trades WHERE id = $1", [tradeId]);
      assert.equal(res.rows[0].allocated_volume, "0.40000000",
        "trigger must have incremented allocation under app_readwrite");
    });
  } finally { await close(); }
});

test("PG D5 P14b: over-allocation still rejected under app_readwrite (guard intact)", { skip: SKIP }, async () => {
  const { pool, close } = await harness();
  try {
    const { tradeId } = await seed(pool);
    await asRole(pool, "app_readwrite", async (c) => {
      await assert.rejects(
        () => c.query(
          "INSERT INTO trade_exits (trade_id, volume, price) VALUES ($1,'5.00000000','1.20000000')",
          [tradeId],
        ),
        (err: unknown) => {
          // Business guard (RAISE EXCEPTION / CHECK) — explicitly NOT 42501.
          assert.notEqual((err as { code?: string }).code, INSUFFICIENT_PRIVILEGE,
            "over-allocation must fail as a business guard, not a privilege error");
          return true;
        },
      );
    });
  } finally { await close(); }
});

// ── P15 — future-table behaviour (defect D-2), proven by execution ─────────

test("PG D5 P15: ALTER DEFAULT PRIVILEGES covers FUTURE migrator-created tables", { skip: SKIP }, async () => {
  const { pool, close } = await harness();
  try {
    // A table created later by the migrator must be immediately usable by the
    // runtime roles — otherwise every future migration silently breaks the app.
    //
    // NOTE (harness correctness): the table must be created by velora_migrator
    // AND persist, so `asRole` (which rolls back) cannot be used. `SET LOCAL
    // ROLE` also expires at COMMIT, so we use a plain `SET ROLE` on a dedicated
    // client and RESET afterwards — otherwise the creator would be the
    // connection's own role and the default-privilege path would not be tested.
    await pool.query("DROP TABLE IF EXISTS d5_future_probe");
    await createAsMigrator(pool,
      "CREATE TABLE d5_future_probe (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v TEXT)");
    const rw = await pool.query(
      `SELECT has_table_privilege('app_readwrite','d5_future_probe','SELECT') AS s,
              has_table_privilege('app_readwrite','d5_future_probe','INSERT') AS i,
              has_table_privilege('velora_readonly','d5_future_probe','SELECT') AS ro_s,
              has_table_privilege('velora_readonly','d5_future_probe','INSERT') AS ro_i`,
    );
    assert.equal(rw.rows[0].s, true, "future table must be SELECTable by app_readwrite");
    assert.equal(rw.rows[0].i, true, "future table must be INSERTable by app_readwrite");
    assert.equal(rw.rows[0].ro_s, true, "future table must be SELECTable by velora_readonly");
    assert.equal(rw.rows[0].ro_i, false, "velora_readonly must NOT gain INSERT on future tables");
    await pool.query("DROP TABLE IF EXISTS d5_future_probe");
  } finally { await close(); }
});

test("PG D5 P15b: DOCUMENTED RESIDUAL RISK — a future ledger table is NOT append-only automatically", { skip: SKIP }, async () => {
  const { pool, close } = await harness();
  try {
    await pool.query("DROP TABLE IF EXISTS d5_future_events");
    await createAsMigrator(pool,
      "CREATE TABLE d5_future_events (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY)");
    const res = await pool.query(
      "SELECT has_table_privilege('app_readwrite','d5_future_events','UPDATE') AS u",
    );
    // Asserting the TRUE state honestly: default privileges are type-wide, so a
    // NEW append-only table must get an explicit REVOKE in roles.sql. This test
    // exists so the limitation is executed evidence, not a footnote.
    assert.equal(res.rows[0].u, true,
      "documents that new ledger tables require an explicit REVOKE in roles.sql");
    await pool.query("DROP TABLE IF EXISTS d5_future_events");
  } finally { await close(); }
});

// ── P16 — no unnecessary privileges ────────────────────────────────────────

test("PG D5 P16: no unnecessary privileges — PUBLIC cannot CREATE in schema public", { skip: SKIP }, async () => {
  const { pool, close } = await harness();
  try {
    const res = await pool.query("SELECT has_schema_privilege('app_readwrite','public','CREATE') AS c");
    assert.equal(res.rows[0].c, false, "runtime roles must not be able to CREATE objects");
    const su = await pool.query(
      "SELECT bool_or(rolsuper) AS any_super FROM pg_roles WHERE rolname = ANY($1)", [ROLES],
    );
    assert.equal(su.rows[0].any_super, false, "no Velora role may be a superuser");
    const createdb = await pool.query(
      "SELECT bool_or(rolcreatedb OR rolcreaterole) AS any_admin FROM pg_roles WHERE rolname = ANY($1)", [ROLES],
    );
    assert.equal(createdb.rows[0].any_admin, false, "no Velora role may hold CREATEDB/CREATEROLE");
  } finally { await close(); }
});
