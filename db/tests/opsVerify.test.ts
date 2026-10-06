// AC-36 battery — ops-verify environment verification core (MG-OPS-TOOLING).
//
// EVIDENCE LABEL (test honesty rule): runs the REAL verification core
// (ops/verify/verifyEnvironment.ts — the same code tools/ops-verify.mjs
// drives) against a DISPOSABLE PGlite instance with the real migrations
// applied. PGlite evidence — NOT real-PostgreSQL evidence, NOT production
// evidence. The live-PG path is exercised wherever `npm run ops:verify` runs
// with DATABASE_URL set (deployment verification); that boundary is not
// claimed here.
//
// WHAT IS PINNED:
//   1. CLEAN verdict on a fully migrated instance (ledger ↔ files in sync,
//      zero FK orphans, inventory populated, privilege report present).
//   2. DRIFT when a ledger entry is missing (unmigrated-file detection).
//   3. DRIFT when a child row references a missing parent (orphan detection,
//      with constraint/child/parent attribution and count).
//   4. READ-ONLY by construction, pinned TWO ways: a runtime spy asserting
//      every executed statement begins with SELECT, and a static scan of the
//      core's source (comments stripped) for write/DDL keywords.
//   5. LEAST-PRIVILEGE resilience: a 42501 (permission denied) on individual
//      tables is RECORDED ("nopriv" / unverifiable FK) — the probe reports the
//      privilege boundary instead of crashing or fabricating a finding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine, migrate } from "../migrate.ts";
import { runEnvironmentVerification } from "../../ops/verify/verifyEnvironment.ts";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const MIGRATIONS = join(ROOT, "db", "migrations");

function migrationFileNames(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function queryVia(engine: { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }) {
  return async (sql: string, params: readonly unknown[] = []) =>
    (await engine.query(sql, [...params])).rows;
}

async function withMigratedInstance(
  fn: (q: ReturnType<typeof queryVia>, engine: Awaited<ReturnType<typeof createEngine>>) => Promise<void>,
): Promise<void> {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    await fn(queryVia(engine), engine);
  } finally {
    await engine.close();
  }
}

test("AC36-01 clean verdict on fully migrated instance", async () => {
  await withMigratedInstance(async (q) => {
    const result = await runEnvironmentVerification(q, migrationFileNames());

    assert.equal(result.drift, false, "fully migrated instance must verify CLEAN");
    assert.deepEqual(result.unmigrated, []);
    assert.deepEqual(result.phantomLedgerEntries, []);
    assert.deepEqual(result.fkOrphans, []);
    assert.ok(
      result.fkConstraintsChecked >= 50,
      `the FK scan must actually evaluate constraints (checked ${result.fkConstraintsChecked}) — a hollow scan must never report "no orphans"`,
    );
    assert.equal(result.tableCounts["users"], 0, "users table must be inventoried");
    assert.equal(result.tableCounts["trades"], 0, "trades table must be inventoried");
    assert.ok(
      result.privileges.some((g) => g.table === "users"),
      "privilege report must cover the users table",
    );
    assert.ok(result.identity.database.length > 0 && result.identity.dbUser.length > 0);
  });
});

test("AC36-02 missing ledger entry is reported as drift", async () => {
  await withMigratedInstance(async (q, engine) => {
    // Ledger rows store the file name WITH the .sql suffix (db/migrate.ts).
    await engine.query("DELETE FROM schema_migrations WHERE name = '0001_core.sql'");
    const result = await runEnvironmentVerification(q, migrationFileNames());

    assert.equal(result.drift, true);
    assert.deepEqual(result.unmigrated, ["0001_core"]);
    assert.deepEqual(result.phantomLedgerEntries, []);
  });
});

test("AC36-03 phantom ledger entry is reported as drift", async () => {
  await withMigratedInstance(async (q, engine) => {
    await engine.query("INSERT INTO schema_migrations(name) VALUES ('9999_never_existed.sql')");
    const result = await runEnvironmentVerification(q, migrationFileNames());

    assert.equal(result.drift, true);
    assert.deepEqual(result.unmigrated, []);
    assert.deepEqual(result.phantomLedgerEntries, ["9999_never_existed"]);
  });
});

test("AC36-04 orphaned child row is reported as drift with attribution", async () => {
  await withMigratedInstance(async (q, engine) => {
    // sessions reference users; a session row pointing at a user that does
    // not exist is exactly the corruption class the probe must surface —
    // the classic outcome of a legacy bulk import (FKs not enforced during
    // load, or added after the fact). PostgreSQL blocks the INSERT while
    // the FK trigger is active, so the TEST simulates the corruption the
    // way bulk loaders actually produce it: trigger disabled for the load,
    // then re-enabled (the verification CORE stays read-only; only this
    // setup writes).
    await engine.query("ALTER TABLE user_sessions DISABLE TRIGGER ALL");
    await engine.query(
      `INSERT INTO user_sessions (user_id, refresh_token_hash, expires_at)
       VALUES (999999, 'ops-verify-orphan-probe', now() + interval '1 hour')`,
    );
    await engine.query("ALTER TABLE user_sessions ENABLE TRIGGER ALL");
    const result = await runEnvironmentVerification(q, migrationFileNames());

    assert.equal(result.drift, true);
    const hit = result.fkOrphans.find((o) => o.child.includes("user_sessions"));
    assert.ok(hit, "orphan must be attributed to user_sessions");
    assert.equal(hit.orphaned, 1);
    assert.ok(hit.parent.includes("users"));
    assert.ok(hit.constraint.length > 0);
  });
});

test("AC36-05 verification core executes SELECT-only statements (runtime spy)", async () => {
  await withMigratedInstance(async (_q, engine) => {
    const executed: string[] = [];
    const spy = async (sql: string, params: readonly unknown[] = []) => {
      executed.push(sql);
      return (await engine.query(sql, [...params])).rows;
    };
    await runEnvironmentVerification(spy, migrationFileNames());

    assert.ok(executed.length >= 10, "expected a real statement set to inspect");
    for (const sql of executed) {
      assert.match(
        sql.trimStart(),
        /^SELECT\b/i,
        `verification must be SELECT-only, got: ${sql.trimStart().slice(0, 80)}`,
      );
    }
  });
});

test("AC36-06b least-privilege role: 42501 is recorded, never a crash", async () => {
  // A role without SELECT on some tables (e.g. velora_worker vs audit_log)
  // must still get a full report: denied counts surface as "nopriv", denied
  // FK constraints surface as unverifiable — neither is drift, neither stops
  // the run. The denial is privilege evidence, not a failure.
  await withMigratedInstance(async (_q, engine) => {
    const denied = new Set(["users", "user_sessions"]);
    const partial = async (sql, params = []) => {
      const fromMatch = /\bFROM\s+"?([a-z_]+)"?/i.exec(sql) ?? [];
      const table = fromMatch[1];
      if (table && denied.has(table)) {
        const err = new Error("permission denied for table " + table) as NodeJS.ErrnoException;
        err.code = "42501";
        throw err;
      }
      return (await engine.query(sql, [...params])).rows;
    };
    const result = await runEnvironmentVerification(partial, migrationFileNames());

    assert.equal(result.tableCounts["users"], "nopriv");
    assert.equal(result.tableCounts["trades"], 0, "non-denied tables still counted");
    assert.equal(result.drift, false, "a privilege boundary is not drift");
    assert.ok(
      result.fkUnverifiable.some((u) => u.reason === "nopriv"),
      "denied FK constraints must be recorded as unverifiable",
    );
    assert.deepEqual(result.fkOrphans, [], "no fabricated orphan findings");
  });
});

test("AC36-06 verification core source contains no write/DDL keywords (static pin)", () => {
  // Static complement of AC36-05: scan the core's own source, comments
  // stripped, so prose cannot mask a finding and a comment cannot fake one.
  const source = readFileSync(join(ROOT, "ops", "verify", "verifyEnvironment.ts"), "utf8");
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const forbidden = /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE)\b/;
  const match = noComments.match(forbidden);
  assert.equal(match, null, `write/DDL keyword found in verification core: ${match?.[0]}`);
});
