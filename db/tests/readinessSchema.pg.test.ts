// Schema-aware readiness — real-PostgreSQL evidence.
//
// `/health` is liveness-only and is what the platform healthcheck hits, so a
// reachable-but-UNMIGRATED database used to pass every automated check while
// every capability would fail. Readiness must therefore distinguish:
//   reachable + migrated   → ready
//   reachable + no schema  → NOT ready
//   unreachable            → NOT ready
//
// This suite drives the REAL probe (apps/api/src/kernel/dbProbe.ts) against a
// real PostgreSQL server, so it verifies shipped behaviour rather than a
// re-implementation. The /ready -> 503 wiring is covered separately by
// apps/api/src/kernel/server.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Client } from "pg";
import { createEngine, migrate } from "../migrate.ts";
import { makeDbProbe } from "../../apps/api/src/kernel/dbProbe.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const ADMIN_URL = process.env.DATABASE_URL;

/** Drive the REAL production probe against a real database. */
async function probe(connectionString: string): Promise<"ok" | "fail"> {
  const p = makeDbProbe(connectionString, { warn: () => {} });
  try {
    return await p();
  } finally {
    await p.close(); // release the self-healing connection
  }
}

async function freshDb(name: string): Promise<string> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  // Terminate lingering backends first: a probe/CLI connection from an
  // earlier subtest otherwise makes DROP DATABASE fail with 55006.
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [name],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return String(ADMIN_URL).replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
}

test("schema-aware readiness on real PostgreSQL", { skip: ADMIN_URL === undefined }, async (t) => {
  await t.test("reachable but UNMIGRATED → not ready (the deploy-safety case)", async () => {
    const url = await freshDb("rdy_empty");
    // Connectivity alone would pass: prove the database really is reachable.
    const c = new Client({ connectionString: url });
    await c.connect();
    const alive = await c.query("SELECT 1 AS ok");
    await c.end();
    assert.equal(alive.rows[0].ok, 1, "precondition: database is reachable");

    assert.equal(await probe(url), "fail", "an unmigrated database must NOT be ready");
  });

  await t.test("reachable and migrated → ready", async () => {
    const url = await freshDb("rdy_full");
    const engine = await createEngine(url);
    try {
      await migrate(engine, MIGRATIONS);
    } finally {
      await engine.close();
    }
    assert.equal(await probe(url), "ok");
  });

  await t.test("tracking table present but EMPTY → not ready", async () => {
    // The partial state a half-finished or manually-reset migration leaves.
    const url = await freshDb("rdy_partial");
    const c = new Client({ connectionString: url });
    await c.connect();
    await c.query(
      "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    await c.end();
    assert.equal(await probe(url), "fail", "an empty tracking table is not a migrated schema");
  });

  await t.test("unreachable database → not ready", async () => {
    assert.equal(await probe("postgresql://nobody@127.0.0.1:1/none"), "fail");
  });
});
