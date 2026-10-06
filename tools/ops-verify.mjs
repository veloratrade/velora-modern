#!/usr/bin/env node
// ops-verify — MG-OPS-TOOLING (AC-36) modern replacement for the legacy
// velora-mgmt read-only probe capability (ops inspect/verify templates).
//
// READ-ONLY by construction: every statement lives in
// ops/verify/verifyEnvironment.ts and is SELECT / catalog metadata only.
// No HTTP surface, no token gate needed (unlike legacy), no FTP mechanism,
// no DSN in output, no row payloads — counts and catalog rows only.
//
// Modes:
//   DATABASE_URL set  → verify that live target (pg driver, must be migrated)
//   absent            → disposable in-memory PGlite (dev evidence only);
//                       migrations are applied first so the report reflects
//                       a fully-migrated instance
//
// Usage: npx tsx tools/ops-verify.mjs [--json] [--check]   (npm run ops:verify)
//   --json   machine-readable report        --check  exit 1 on drift
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "db", "migrations");

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const checkMode = args.includes("--check");

function migrationFileNames() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function maskDsn(raw) {
  return raw.replace(/:\/\/([^:]+):[^@]*@/, "://$1:***@");
}

async function main() {
  const { runEnvironmentVerification } = await import(
    pathToFileURL(join(ROOT, "ops", "verify", "verifyEnvironment.ts")).href
  );
  const dsn = process.env["DATABASE_URL"];
  let mode;
  let database;
  let result;
  if (dsn) {
    // Live mode — the pool connects to an ALREADY-MIGRATED target; missing
    // migrations are drift, exactly what --check is for.
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: dsn, max: 1, ssl: dsn.includes("localhost") ? undefined : { rejectUnauthorized: false } });
    try {
      mode = "pg";
      database = maskDsn(dsn);
      result = await runEnvironmentVerification(async (sql, params = []) => {
        const res = await pool.query(sql, params);
        return res.rows;
      }, migrationFileNames());
    } finally {
      await pool.end();
    }
  } else {
    // Dev-evidence mode: disposable PGlite, migrated first.
    const { createEngine, migrate } = await import(pathToFileURL(join(ROOT, "db", "migrate.ts")).href);
    const engine = await createEngine();
    try {
      await migrate(engine, MIGRATIONS_DIR);
      mode = "pglite";
      database = "disposable-in-memory (dev evidence only)";
      result = await runEnvironmentVerification(async (sql, params = []) => {
        return (await engine.query(sql, params)).rows;
      }, migrationFileNames());
    } finally {
      await engine.close();
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify({ mode, database, ...result }, null, 2));
    return result.drift && checkMode ? 1 : 0;
  }

  console.log(`VELORA environment verification (${mode})`);
  console.log(`  database : ${database}`);
  console.log(`  server   : ${result.identity.version}`);
  console.log(`  user     : ${result.identity.dbUser}`);
  console.log("");
  console.log("Migrations:");
  if (result.unmigrated.length === 0 && result.phantomLedgerEntries.length === 0) {
    console.log("  ✓ every migration file is applied");
    console.log("  ✓ no phantom ledger entries");
  } else {
    if (result.unmigrated.length > 0)
      console.log(`  ✗ UNMIGRATED: ${result.unmigrated.join(", ")}`);
    if (result.phantomLedgerEntries.length > 0)
      console.log(`  ✗ PHANTOM LEDGER: ${result.phantomLedgerEntries.join(", ")}`);
  }
  console.log("");
  console.log("Tables (live row counts):");
  for (const [table, n] of Object.entries(result.tableCounts)) {
    console.log(`${String(n).padStart(9)}  ${table}`);
  }
  console.log("");
  console.log("Privileges of this connection user (report-only):");
  for (const g of result.privileges) console.log(`  ${g.table}: ${g.privs}`);
  console.log("");
  console.log("FK integrity:");
  if (result.fkOrphans.length === 0) console.log("  ✓ no orphaned child rows");
  else
    for (const o of result.fkOrphans)
      console.log(`  ✗ ${o.constraint}: ${o.orphaned} orphaned rows in ${o.child} → ${o.parent}`);
  console.log("");
  console.log(`VERDICT: ${result.drift ? "DRIFT" : "CLEAN"}`);
  return result.drift && checkMode ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  // Driver-level errors are logged as CODE ONLY — message bodies of e.g.
  // ECONNREFUSED can embed host/port details we do not want in CI logs.
  console.error(
    JSON.stringify({ level: "error", event: "ops-verify.failed", code: String(err.code ?? "UNKNOWN") }),
  );
  process.exitCode = 2;
}
