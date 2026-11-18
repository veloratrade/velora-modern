// Migration-runner integrity — advisory locking + applied-file checksums (D1).
//
// Two gaps this battery pins, both on the deployment path (`railway.json` runs
// db/migrate.ts as the first half of every deploy start):
//
//   1. NO MUTUAL EXCLUSION. Two deploy instances starting together each ran the
//      same unapplied migration inside its own transaction — a lost-update race
//      on schema_migrations and duplicate DDL. The runner must take a
//      session-scoped advisory lock for the whole run and release it in a
//      finally (verified here via pg_locks on the disposable PGlite engine;
//      true cross-connection serialization is real-PG evidence, see
//      migrateIntegrity.pg.test.ts).
//
//   2. NO TAMPER DETECTION. schema_migrations recorded only names: an edited
//      already-applied file (forward-only violation, ADR-010) was silently
//      skipped forever, so "migration head: 00XX" printed by the CLI was a
//      claim about a file that no longer matches the live schema. Every applied
//      file's sha256 must be recorded, verified on every run, and a mismatch
//      must fail the run loudly; rows applied before the column existed are
//      backfilled, never re-run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIGRATION_LOCK_KEY,
  createPgliteEngine,
  expectedHead,
  migrate,
  migrationChecksum,
} from "../migrate.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

test("every applied migration records its sha256 checksum", async () => {
  const engine = await createPgliteEngine();
  try {
    const ran = await migrate(engine, MIGRATIONS);
    assert.ok(ran.includes("0001_core.sql"));
    const { rows } = await engine.query(
      "SELECT name, checksum FROM schema_migrations WHERE name IN ('0001_core.sql', '0042_telegram_post_preferences.sql')",
    );
    assert.equal(rows.length, 2);
    for (const row of rows) {
      const file = readFileSync(join(MIGRATIONS, String(row.name)), "utf8");
      assert.equal(row.checksum, migrationChecksum(file), `${row.name} checksum matches the file on disk`);
    }
  } finally {
    await engine.close();
  }
});

test("a re-run against an unchanged directory is still a no-op (checksums verified, nothing reapplied)", async () => {
  const engine = await createPgliteEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const reran = await migrate(engine, MIGRATIONS);
    assert.deepEqual(reran, []);
  } finally {
    await engine.close();
  }
});

test("an edited already-applied migration FAILS the run instead of being silently skipped", async () => {
  const scratch = join(tmpdir(), `velora-migrate-tamper-${Date.now()}`);
  mkdirSync(scratch, { recursive: true });
  try {
    cpSync(MIGRATIONS, scratch, { recursive: true });
    const engine = await createPgliteEngine();
    try {
      await migrate(engine, MIGRATIONS); // apply the real files first
      // Tamper with an applied file in a second directory serving the same database.
      writeFileSync(join(scratch, "0001_core.sql"), readFileSync(join(scratch, "0001_core.sql"), "utf8") + "\n-- tampered after apply\n");
      await assert.rejects(
        migrate(engine, scratch),
        /migration 0001_core\.sql checksum mismatch/,
        "forward-only violation must be loud",
      );
      // And the database refuses to advance past the tampered file.
      const head = await engine.query("SELECT max(name) AS head FROM schema_migrations");
      assert.equal(String((head.rows[0] as Record<string, unknown>).head), expectedHead(MIGRATIONS));
    } finally {
      await engine.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("rows applied before the checksum column existed are backfilled, never re-run", async () => {
  const engine = await createPgliteEngine();
  try {
    await migrate(engine, MIGRATIONS);
    // Simulate a database migrated by the pre-checksum runner.
    await engine.exec("UPDATE schema_migrations SET checksum = NULL");
    const reran = await migrate(engine, MIGRATIONS);
    assert.deepEqual(reran, [], "backfill must not re-apply anything");
    const { rows } = await engine.query(
      "SELECT count(*) AS n FROM schema_migrations WHERE checksum IS NULL",
    );
    assert.equal(Number((rows[0] as Record<string, unknown>).n), 0, "every row carries its checksum again");
  } finally {
    await engine.close();
  }
});

test("the advisory lock is released after the run (no leak) and the key stays acquirable", async () => {
  const engine = await createPgliteEngine();
  try {
    await migrate(engine, MIGRATIONS);
    // Leak probe without pg_locks (PGlite binds objid as oid, out of range for
    // a bigint key): re-unlocking returns TRUE only if migrate() left the lock
    // held. A released lock answers FALSE.
    const { rows } = await engine.query("SELECT pg_advisory_unlock($1) AS released", [MIGRATION_LOCK_KEY]);
    assert.equal(rows[0]!["released"], false, "migrate() released the advisory lock in finally");
    // The same key is still acquirable: the run did not leave it held.
    await engine.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await engine.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
  } finally {
    await engine.close();
  }
});
