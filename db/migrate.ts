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
if (process.argv[1] && process.argv[1].endsWith("migrate.ts")) {
  const url = process.env.DATABASE_URL;
  const engine = await createEngine(url);
  try {
    const ran = await migrate(engine, join(import.meta.dirname, "migrations"));
    console.log(ran.length ? `applied: ${ran.join(", ")}` : "up to date");
  } finally {
    await engine.close();
  }
}
