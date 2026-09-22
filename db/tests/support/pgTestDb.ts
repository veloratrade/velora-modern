// Shared real-PostgreSQL test harness (directive t, pass 2).
//
// WHY THIS EXISTS. The `*.pg.test.ts` batteries are EVIDENCE appliances: they
// run against a real, disposable PostgreSQL and their assertions are exact
// (row counts, ordering, constraint outcomes). An evidence battery that only
// passes on a virgin database is not repeatable — re-running it locally, or
// running two batteries against the same cluster, produced false failures
// (observed in pass 1: `pgAccountStore` failed with `['Second', …]` after an
// earlier run had left rows behind).
//
// The reusable cause was that each battery assumed an empty cluster and owned no
// cleanup. This module fixes that at the source:
//
//   prepareDatabase()
//     1. applies the frozen migrations (idempotent),
//     2. TRUNCATEs every application table in the `public` schema except the
//        migration bookkeeping, RESTART IDENTITY CASCADE,
//     3. hands back a pooled handle.
//
// The truncate list is DISCOVERED from the catalogue rather than hard-coded, so
// a future migration cannot silently fall outside the reset.
//
// SCOPE: this is a TEST-ONLY helper. It must never be pointed at anything but a
// disposable database; the batteries are gated on DATABASE_URL precisely so that
// an unconfigured environment SKIPS instead of touching a real one.
import { join } from "node:path";
import type { Pool } from "pg";
import { createEngine, migrate } from "../../migrate.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "migrations");

/** Tables that must survive a reset: the migration ledger. */
const PRESERVED_TABLES: readonly string[] = ["schema_migrations"];

export interface TestDb {
  readonly pool: Pool;
  readonly close: () => Promise<void>;
}

/** Apply migrations, then reset every application table to empty. */
export async function prepareDatabase(connectionString: string): Promise<TestDb> {
  const engine = await createEngine(connectionString);
  await migrate(engine, MIGRATIONS);
  await engine.close();

  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  await resetSchema(pool);
  return { pool, close: () => pool.end() };
}

/**
 * Truncate every application table (discovered from the catalogue).
 *
 * `CASCADE` also clears rows in tables that are not named in the list but
 * reference one that is — that is intended: the goal is a database that has the
 * FOUNDATION SCHEMA and no data.
 */
export async function resetSchema(pool: Pool): Promise<void> {
  const rows = await pool.query(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> ALL($1::text[])
      ORDER BY tablename`,
    [PRESERVED_TABLES],
  );
  const tables = rows.rows.map((r: { tablename: string }) => `"${r.tablename}"`);
  if (tables.length === 0) return;
  await pool.query(`TRUNCATE TABLE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
}
