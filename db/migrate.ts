// Migration runner — forward-only (ADR-010). Records applied migrations in
// schema_migrations. Engine: PGlite (disposable, dev/test — the default here)
// or a real PostgreSQL via DATABASE_URL (staging/production, provisioned later).
// The runner never interprets legacy data: the MySQL→PG transform is a separate,
// evidence-gated pipeline (ADR-004 legacy-TZ blocker; db/MIGRATION_MAP.md).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface MigrationEngine {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  /**
   * Serialized, rollback-on-error multi-statement unit. PGlite: native
   * single-session transaction (in-wasm — still NOT real-PostgreSQL
   * concurrency evidence). pg Client: BEGIN/COMMIT on the shared client.
   * Optional so existing engines/mocks keep compiling.
   */
  transaction?<T>(fn: (tx: { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }) => Promise<T>): Promise<T>;
}

/** Fixed, secret-free CLI messages. Never interpolate a connection string. */
export const MIGRATION_URL_REQUIRED =
  "Migration database URL is required. Set MIGRATION_DATABASE_URL or DATABASE_URL " +
  "to a non-empty PostgreSQL connection string.";
export const MIGRATION_CONNECTION_FAILED = "Migration database connection failed.";
const BLANK_ENGINE_URL =
  "createEngine received a blank connection string. Pass a real PostgreSQL URL, " +
  "or call createPgliteEngine() explicitly for disposable test engines.";

/**
 * Resolve the migration connection string from the environment, FAIL-CLOSED.
 *
 * Deliberately NOT nullish-coalescing: `??` only catches null/undefined, so an
 * empty or whitespace-only MIGRATION_DATABASE_URL used to win the selection and
 * then silently degrade to an in-memory engine. Blank is treated as ABSENT at
 * every step, and "nothing configured" is an ERROR rather than a fallback.
 */
export function resolveMigrationUrl(env: {
  MIGRATION_DATABASE_URL?: string | undefined;
  DATABASE_URL?: string | undefined;
}): { url: string; source: "MIGRATION_DATABASE_URL" | "DATABASE_URL" } | { error: string } {
  const migration = env.MIGRATION_DATABASE_URL?.trim();
  if (migration !== undefined && migration !== "") {
    return { url: migration, source: "MIGRATION_DATABASE_URL" };
  }
  const database = env.DATABASE_URL?.trim();
  if (database !== undefined && database !== "") {
    return { url: database, source: "DATABASE_URL" };
  }
  return { error: MIGRATION_URL_REQUIRED };
}

/**
 * Disposable in-memory PGlite engine — EXPLICIT test/dev use only.
 *
 * This is the only way to obtain PGlite. It is never selected by environment
 * configuration, so no deployment path can reach it by accident.
 */
export async function createPgliteEngine(): Promise<MigrationEngine> {
  {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    return {
      query: async (sql, params) => {
        const res = await db.query(sql, params as never[]);
        return { rows: res.rows as Record<string, unknown>[] };
      },
      exec: async (sql) => { await db.exec(sql); },
      close: async () => { await db.close(); },
      transaction: async (fn) =>
        db.transaction(async (tx) =>
          fn({
            query: async (sql, params) => {
              const res = await tx.query(sql, params as never[]);
              return { rows: res.rows as Record<string, unknown>[] };
            },
          }),
        ),
    };
  }
}

/**
 * Create a migration engine.
 *
 * No argument → the explicit PGlite test engine (the long-standing contract
 * used by the disposable in-wasm suites).
 * A string    → a REAL PostgreSQL connection. A blank string is rejected
 *               rather than silently downgraded to PGlite: that downgrade was
 *               the root cause of a migration reporting success while writing
 *               to no database at all.
 */
export async function createEngine(connectionString?: string): Promise<MigrationEngine> {
  if (connectionString === undefined) {
    return createPgliteEngine();
  }
  if (connectionString.trim() === "") {
    throw new Error(BLANK_ENGINE_URL);
  }
  const { Client } = await import("pg");
  const client = new Client({ connectionString });
  await client.connect();
  return {
    query: async (sql, params = []) => {
      const res = await client.query(sql, params as never[]);
      return { rows: res.rows as Record<string, unknown>[] };
    },
    exec: async (sql) => { await client.query(sql); },
    close: async () => { await client.end(); },
    transaction: async (fn) => {
      await client.query("BEGIN");
      try {
        const result = await fn({
          query: async (sql, params = []) => {
            const res = await client.query(sql, params as never[]);
            return { rows: res.rows as Record<string, unknown>[] };
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    },
  };
}

/**
 * The migration head recorded in the DATABASE (highest applied name), or null
 * when the tracking table is absent/empty. Single source of truth for "what
 * schema is actually live" — callers must not re-derive it.
 */
export async function currentHead(engine: MigrationEngine): Promise<string | null> {
  try {
    const rows = (
      await engine.query("SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1")
    ).rows;
    const row = rows[0];
    return row === undefined ? null : String(row.name);
  } catch {
    return null; // tracking table does not exist yet
  }
}

/** The migration head on DISK (highest .sql filename) — what SHOULD be applied. */
export function expectedHead(migrationsDir: string): string | null {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.length === 0 ? null : (files[files.length - 1] as string);
}

export async function migrate(engine: MigrationEngine, migrationsDir: string): Promise<string[]> {
  await engine.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = new Set((await engine.query("SELECT name FROM schema_migrations")).rows.map((r) => String(r.name)));
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    await engine.exec("BEGIN");
    try {
      await engine.exec(sql);
      await engine.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
      await engine.exec("COMMIT");
      ran.push(file);
    } catch (err) {
      await engine.exec("ROLLBACK");
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }
  return ran;
}

// CLI entry: npm run migrate:dev [-- --url postgres://...]
//
// Connection precedence (Railway staging preparation):
//   MIGRATION_DATABASE_URL — the migrator identity (velora_migrator). Preferred
//     when present so the schema is evolved by a role that holds NO runtime DML.
//   DATABASE_URL           — fallback; the dev/CI path and the historical
//     behaviour, unchanged when MIGRATION_DATABASE_URL is absent.
//
// The migrator must OWN nothing itself: objects are owned by `velora_owner`,
// which the migrator assumes for DDL. That is requested per-connection with
// `?options=-c role=velora_owner` inside MIGRATION_DATABASE_URL rather than a
// service-wide PGOPTIONS, so the API/worker runtime can never inherit it.
// (VERIFIED: a service-wide PGOPTIONS is rejected for app_readwrite —
// "permission denied to set role" — i.e. it fails closed, but scoping it to the
// migration connection removes the footgun entirely.)
// FAIL-CLOSED (deploy safety). The CLI runs as the first half of the deployment
// start command, so a "success" it prints is taken as proof the schema is live.
// It therefore REQUIRES a real PostgreSQL URL and never falls back to PGlite:
// previously a blank MIGRATION_DATABASE_URL produced `applied: 0001…0010` and
// exit 0 while the real database received zero tables.
if (process.argv[1] && process.argv[1].endsWith("migrate.ts")) {
  const resolved = resolveMigrationUrl(process.env);
  if ("error" in resolved) {
    console.error(resolved.error);
    process.exit(1);
  }
  let engine: MigrationEngine;
  try {
    engine = await createEngine(resolved.url);
  } catch {
    // Driver errors can embed the connection string — never surface them.
    console.error(MIGRATION_CONNECTION_FAILED);
    process.exit(1);
  }
  try {
    const ran = await migrate(engine, join(import.meta.dirname, "migrations"));
    console.log(ran.length ? `applied: ${ran.join(", ")}` : "up to date");
    console.log(`migration head: ${await currentHead(engine)}`);
  } finally {
    await engine.close();
  }
}
