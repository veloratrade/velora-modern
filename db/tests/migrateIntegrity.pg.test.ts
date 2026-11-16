// Real-PostgreSQL evidence battery — migration-runner serialization (D1).
//
// The local battery (migrateIntegrity.test.ts) proves checksums, tamper
// detection, backfill and lock hygiene on the disposable PGlite engine, which
// has ONE session and therefore cannot falsify cross-connection behavior. This
// battery runs against a REAL server (postgres-evidence workflow) and proves:
//   1. checksums are recorded on real PostgreSQL;
//   2. a second migrator genuinely WAITS on the advisory lock while another
//      session holds it, and proceeds the moment it is released — the lost-
//      update race two concurrent deploy instances used to hit is closed.
//
// Runs on a disposable scratch database created and dropped by the battery, so
// the shared evidence database's migration head is untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { MIGRATION_LOCK_KEY, createEngine, migrate } from "../migrate.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const BASE_URL = process.env.DATABASE_URL;
const BATTERY_DB = "velora_migrate_battery";

function urlFor(db: string): string {
  const u = new URL(BASE_URL!);
  u.pathname = `/${db}`;
  return u.toString();
}

/** Drop + create the scratch database (no transaction; DROP/CREATE are their own statements). */
async function recreateBattery(): Promise<void> {
  const admin = new Client({ connectionString: urlFor("postgres") });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${BATTERY_DB}`);
    await admin.query(`CREATE DATABASE ${BATTERY_DB}`);
  } finally {
    await admin.end();
  }
}

async function dropBattery(): Promise<void> {
  const admin = new Client({ connectionString: urlFor("postgres") });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${BATTERY_DB}`);
  } finally {
    await admin.end();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("checksums are recorded on real PostgreSQL and a re-run is a no-op", async () => {
  await recreateBattery();
  const engine = await createEngine(urlFor(BATTERY_DB));
  try {
    const ran = await migrate(engine, MIGRATIONS);
    assert.ok(ran.length >= 42, "the full migration set applied");
    const { rows } = await engine.query("SELECT count(*) AS n FROM schema_migrations WHERE checksum IS NULL");
    assert.equal(Number(rows[0]!["n"]), 0);
    const reran = await migrate(engine, MIGRATIONS);
    assert.deepEqual(reran, []);
  } finally {
    await engine.close();
    await dropBattery();
  }
});

test("a second migrator waits for the advisory lock and proceeds on release", async () => {
  await recreateBattery();
  const engineA = await createEngine(urlFor(BATTERY_DB));
  const engineB = await createEngine(urlFor(BATTERY_DB));
  const holder = new Client({ connectionString: urlFor(BATTERY_DB) });
  const scratch = mkdtempSync(join(tmpdir(), "velora-migrate-serial-"));
  try {
    await migrate(engineA, MIGRATIONS); // baseline schema, session A
    // A THIRD session (not engine A or B) holds the lock, simulating another
    // deploy instance mid-run. engine B must wait, never proceed.
    await holder.connect();
    await holder.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    cpSync(MIGRATIONS, scratch, { recursive: true });
    const pendingFile = "9000_battery_serialization.sql";
    writeFileSync(join(scratch, pendingFile), "CREATE TABLE battery_serialization (id int);\n");

    let migrationError: Error | null = null;
    const pending = migrate(engineB, scratch).catch((err: Error) => {
      migrationError = err;
      return [] as string[];
    });

    await sleep(500); // B cannot proceed while the lock is held — the row must be absent
    const held = await holder.query(
      "SELECT count(*) AS n FROM schema_migrations WHERE name = $1",
      [pendingFile],
    );
    assert.equal(Number(held.rows[0]!["n"]), 0, "the waiting migrator applied nothing while the lock was held");

    await holder.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    const ran = await pending;
    assert.equal(migrationError, null, "the waiting migrator succeeds once the lock is released");
    assert.ok(ran.includes(pendingFile), "the pending migration applied after release");
    const recorded = await engineA.query("SELECT checksum FROM schema_migrations WHERE name = $1", [pendingFile]);
    assert.ok(String(recorded.rows[0]!["checksum"]).length > 0);
  } finally {
    await holder.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    await holder.end();
    await engineA.close();
    await engineB.close();
    rmSync(scratch, { recursive: true, force: true });
    await dropBattery();
  }
});
