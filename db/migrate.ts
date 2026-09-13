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

export async function createEngine(connectionString?: string): Promise<MigrationEngine> {
  if (!connectionString) {
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
if (process.argv[1] && process.argv[1].endsWith("migrate.ts")) {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  const engine = await createEngine(url);
  try {
    const ran = await migrate(engine, join(import.meta.dirname, "migrations"));
    console.log(ran.length ? `applied: ${ran.join(", ")}` : "up to date");
  } finally {
    await engine.close();
  }
}
