// Real-PostgreSQL proof for the deploy-safety fix. Excluded from `npm test` by
// the *.pg.test.ts convention; run explicitly with DATABASE_URL set.
//
// The unit suite proves the SELECTION rules. This proves the thing that
// actually failed in production terms: that a successful CLI run leaves real
// tables in a real database, and that the historical false-success invocation
// now genuinely migrates.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { Client } from "pg";
import { expectedHead } from "../migrate.ts";

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..");
const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const CLI = join(ROOT, "db", "migrate.ts");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const ADMIN_URL = process.env.DATABASE_URL;

async function runCli(env: Record<string, string>) {
  const clean = { ...process.env };
  delete clean.DATABASE_URL;
  delete clean.MIGRATION_DATABASE_URL;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TSX, CLI], {
      env: { ...clean, ...env },
      timeout: 120_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Create a throwaway database and return its URL. */
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

async function inspect(url: string) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const tables = await c.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'",
    );
    // A fresh database has no tracking table at all, so ask before selecting.
    const exists = await c.query(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
    );
    let head: string | null = null;
    if (exists.rows[0].present === true) {
      const h = await c.query("SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1");
      head = (h.rows[0]?.name as string | undefined) ?? null;
    }
    return { tables: tables.rows[0].n as number, head };
  } finally {
    await c.end();
  }
}

test("deploy safety on real PostgreSQL", { skip: ADMIN_URL === undefined }, async (t) => {
  await t.test("the historical false-success invocation now really migrates", async () => {
    // EXACTLY the reproduction from the baseline audit: blank
    // MIGRATION_DATABASE_URL + a valid DATABASE_URL. This previously printed
    // `applied: 0001…0010`, exited 0, and left the database with ZERO tables.
    const url = await freshDb("ds_hist");
    const before = await inspect(url);
    assert.equal(before.tables, 0, "precondition: the database starts empty");

    const r = await runCli({ MIGRATION_DATABASE_URL: "", DATABASE_URL: url });
    assert.equal(r.code, 0, "a valid DATABASE_URL must succeed");
    assert.match(r.stdout, /applied:/);

    const after = await inspect(url);
    assert.ok(after.tables >= 16, `tables must really exist, got ${after.tables}`);
    assert.equal(after.head, expectedHead(MIGRATIONS), "database head must match disk");
  });

  await t.test("reported head matches the database and all migrations through 0010 applied", async () => {
    const url = await freshDb("ds_head");
    const r = await runCli({ MIGRATION_DATABASE_URL: url });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /migration head: 0010_user_credentials\.sql/);

    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      const rows = await c.query("SELECT name FROM schema_migrations ORDER BY name");
      const names = rows.rows.map((x) => String(x.name));
      assert.equal(names.length, 10, "all ten migrations must be recorded");
      assert.equal(names[0], "0001_core.sql");
      assert.equal(names[9], "0010_user_credentials.sql");
      // The tracking table must agree with what the CLI printed.
      assert.ok(r.stdout.includes(names[9]));
    } finally {
      await c.end();
    }
  });

  await t.test("MIGRATION_DATABASE_URL wins deterministically over DATABASE_URL", async () => {
    // Two DIFFERENT real databases: only the migrator target may be written.
    const target = await freshDb("ds_target");
    const other = await freshDb("ds_other");
    const r = await runCli({ MIGRATION_DATABASE_URL: target, DATABASE_URL: other });
    assert.equal(r.code, 0);

    const t1 = await inspect(target);
    const t2 = await inspect(other);
    assert.ok(t1.tables >= 16, "the MIGRATION_DATABASE_URL database must be migrated");
    assert.equal(t2.tables, 0, "the DATABASE_URL database must be untouched");
  });

  await t.test("re-running is idempotent and still reports the head", async () => {
    const url = await freshDb("ds_idem");
    const first = await runCli({ MIGRATION_DATABASE_URL: url });
    assert.equal(first.code, 0);
    const second = await runCli({ MIGRATION_DATABASE_URL: url });
    assert.equal(second.code, 0);
    assert.match(second.stdout, /up to date/);
    assert.ok(!/applied:/.test(second.stdout), "nothing may be reapplied");
    assert.match(second.stdout, /migration head: 0010_user_credentials\.sql/);
  });

  await t.test("an unreachable database leaves no false success and no partial schema", async () => {
    const r = await runCli({ MIGRATION_DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none" });
    assert.notEqual(r.code, 0);
    assert.ok(!/applied:/.test(r.stdout));
    assert.match(r.stderr, /Migration database connection failed/);
  });
});
