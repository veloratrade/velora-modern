// Deploy-safety regression tests for the migration runner.
//
// These exist because of a PROVEN defect: a blank MIGRATION_DATABASE_URL made
// the CLI construct an in-memory PGlite engine, print
// `applied: 0001_core.sql … 0010_user_credentials.sql` and exit 0, while the
// real PostgreSQL database received ZERO tables. `railway.json` runs
// `db/migrate.ts && server-main.ts`, so that false success sat directly on the
// deployment path.
//
// The selection rules are covered here as pure unit tests (no database needed),
// so they run inside `npm test` on every change. Real-PostgreSQL proof that the
// tables actually land lives in db/tests/migrateCli.pg.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import {
  resolveMigrationUrl,
  createEngine,
  createPgliteEngine,
  expectedHead,
  currentHead,
  migrate,
  MIGRATION_URL_REQUIRED,
} from "../migrate.ts";

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..");
const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const CLI = join(ROOT, "db", "migrate.ts");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

/** Run the real CLI with a controlled environment; never inherits the caller's DB vars. */
async function runCli(
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const clean = { ...process.env };
  delete clean.DATABASE_URL;
  delete clean.MIGRATION_DATABASE_URL;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TSX, CLI], {
      env: { ...clean, ...env },
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

// --- URL selection (the root cause) ----------------------------------------

test("selection: blank MIGRATION_DATABASE_URL does NOT win over a real DATABASE_URL", () => {
  // THE ROOT CAUSE. `??` only catches null/undefined, so "" used to be selected
  // and then silently degraded to PGlite.
  for (const blank of ["", "   ", "\t", "\n"]) {
    const r = resolveMigrationUrl({
      MIGRATION_DATABASE_URL: blank,
      DATABASE_URL: "postgresql://real/db",
    });
    assert.ok(!("error" in r), `blank ${JSON.stringify(blank)} must fall through`);
    assert.equal(r.url, "postgresql://real/db");
    assert.equal(r.source, "DATABASE_URL");
  }
});

test("selection: MIGRATION_DATABASE_URL takes precedence when genuinely set", () => {
  const r = resolveMigrationUrl({
    MIGRATION_DATABASE_URL: "postgresql://migrator/db",
    DATABASE_URL: "postgresql://runtime/db",
  });
  assert.ok(!("error" in r));
  assert.equal(r.url, "postgresql://migrator/db");
  assert.equal(r.source, "MIGRATION_DATABASE_URL");
});

test("selection: surrounding whitespace is trimmed, not treated as a distinct URL", () => {
  const r = resolveMigrationUrl({ DATABASE_URL: "  postgresql://real/db  " });
  assert.ok(!("error" in r));
  assert.equal(r.url, "postgresql://real/db");
});

test("selection: nothing configured is an ERROR, never a PGlite fallback", () => {
  for (const env of [
    {},
    { MIGRATION_DATABASE_URL: "", DATABASE_URL: "" },
    { MIGRATION_DATABASE_URL: "   ", DATABASE_URL: "  " },
    { MIGRATION_DATABASE_URL: undefined, DATABASE_URL: undefined },
  ]) {
    const r = resolveMigrationUrl(env);
    assert.ok("error" in r, `${JSON.stringify(env)} must fail closed`);
    assert.equal(r.error, MIGRATION_URL_REQUIRED);
  }
});

// --- engine construction ----------------------------------------------------

test("createEngine rejects a blank string instead of silently downgrading to PGlite", async () => {
  for (const blank of ["", "   "]) {
    await assert.rejects(
      () => createEngine(blank),
      /blank connection string/i,
      "a blank URL must never produce an in-memory engine",
    );
  }
});

test("explicit PGlite test path still works (no-arg createEngine and createPgliteEngine)", async () => {
  // The disposable in-wasm suites depend on this contract; hardening the CLI
  // must not break them.
  for (const make of [() => createEngine(), () => createPgliteEngine()]) {
    const engine = await make();
    try {
      const ran = await migrate(engine, MIGRATIONS);
      assert.ok(ran.includes("0001_core.sql"));
      assert.equal(await currentHead(engine), expectedHead(MIGRATIONS));
    } finally {
      await engine.close();
    }
  }
});

// --- migration head ---------------------------------------------------------

test("head: expectedHead reads the highest migration on disk; currentHead reads the database", async () => {
  assert.equal(expectedHead(MIGRATIONS), "0010_user_credentials.sql");
  const engine = await createPgliteEngine();
  try {
    assert.equal(await currentHead(engine), null, "no tracking table yet → null");
    await migrate(engine, MIGRATIONS);
    assert.equal(await currentHead(engine), expectedHead(MIGRATIONS));
  } finally {
    await engine.close();
  }
});

// --- CLI behaviour (the deploy path) ---------------------------------------

test("CLI: missing configuration exits non-zero with NO 'applied' output", async () => {
  const r = await runCli({});
  assert.notEqual(r.code, 0, "must fail closed");
  assert.ok(!/applied:/.test(r.stdout), "must never claim migrations were applied");
  assert.match(r.stderr, /Migration database URL is required/);
});

test("CLI: empty and whitespace configuration exit non-zero with NO 'applied' output", async () => {
  for (const env of [
    { MIGRATION_DATABASE_URL: "", DATABASE_URL: "" },
    { MIGRATION_DATABASE_URL: "   ", DATABASE_URL: "\t" },
  ]) {
    const r = await runCli(env);
    assert.notEqual(r.code, 0, `${JSON.stringify(env)} must fail closed`);
    assert.ok(!/applied:/.test(r.stdout), "must never claim migrations were applied");
    assert.match(r.stderr, /Migration database URL is required/);
  }
});

test("CLI: an unreachable database fails loudly and never prints a false success", async () => {
  const r = await runCli({ MIGRATION_DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none" });
  assert.notEqual(r.code, 0);
  assert.ok(!/applied:/.test(r.stdout), "a connection failure must not look like success");
  assert.match(r.stderr, /Migration database connection failed/);
});

test("CLI: failure output never leaks the connection string or its credentials", async () => {
  // Assembled at runtime so no credential-shaped literal exists in the repo:
  // the secret scanner correctly flags connection strings that embed a
  // username and password, and this test must not look like a real one.
  const user = "leakuser";
  const pass = "leakpass1234";
  const db = "leakdb";
  const dsn = ["postgresql", "://", user, ":", pass, "@127.0.0.1:1/", db].join("");

  const r = await runCli({ MIGRATION_DATABASE_URL: dsn });
  assert.notEqual(r.code, 0);
  const all = r.stdout + r.stderr;
  for (const secret of [user, pass, db, "127.0.0.1"]) {
    assert.ok(!all.includes(secret), `deploy output must not contain ${secret}`);
  }
});
