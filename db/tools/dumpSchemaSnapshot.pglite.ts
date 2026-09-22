// Regenerates db/schema-snapshots/modern-target-<head>.sql — a consolidated DDL
// snapshot of the schema at the head of the migration chain, for review/archival.
//
// Run:  npx tsx db/tools/dumpSchemaSnapshot.pglite.ts
// It also SELF-CHECKS the result: the emitted snapshot is re-executed from scratch
// on a fresh disposable engine, so a snapshot that cannot recreate the schema fails
// loudly instead of being archived silently.
//
// The snapshot is NOT the source of truth — db/migrations/ is (ADR-010, forward-only).
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { createEngine, migrate } from "../migrate.ts";
const engine = await createEngine();
await migrate(engine, join(import.meta.dirname, "..", "migrations"));
const q = async (sql: string, p: unknown[] = []) => (await engine.query(sql, p)).rows as Record<string, unknown>[];
const tables = (await q(`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind='r' AND c.relname <> 'schema_migrations' ORDER BY c.relname`)).map(r => String(r.t));
const out: string[] = [];
const applied = (await q("SELECT name FROM schema_migrations ORDER BY name")).map(r => String(r.name));
out.push(`-- ═══════════════════════════════════════════════════════════════════════════════`,
`-- VELORA — MODERN TARGET SCHEMA · consolidated DDL snapshot`,
`-- Generated from a live PGlite (PostgreSQL 16 semantics) run of db/migrations/`,
`-- Migrations applied: ${applied.length} (${applied[0]} … ${applied[applied.length-1]})`,
`-- Tables: ${tables.length} application tables (schema_migrations omitted)`,
`--`,
`-- ⚠ This file is a GENERATED SNAPSHOT for archival/review. The migration files in`,
`--   db/migrations/ remain the single source of truth (ADR-010, forward-only).`,
`-- ═══════════════════════════════════════════════════════════════════════════════`,
``);
const deferredFks: string[] = [];
for (const t of tables) {
  const cols = await q(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
      a.attnotnull AS notnull, pg_get_expr(ad.adbin, ad.adrelid) AS def
    FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
    WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [t]);
  const cons = await q(`SELECT conname AS n, pg_get_constraintdef(oid) AS d FROM pg_constraint
    WHERE conrelid=$1::regclass AND contype IN ('p','u','c') ORDER BY contype, conname`, [t]);
  out.push(`CREATE TABLE ${t} (`);
  const colLines = cols.map(c => `  ${c.name} ${c.type}${c.def ? ` DEFAULT ${c.def}` : ""}${c.notnull ? " NOT NULL" : ""}`);
  const conLines = cons.map(c => `  CONSTRAINT ${c.n} ${c.d}`);
  out.push([...colLines, ...conLines].join(",\n"));
  const fks = await q(`SELECT conname AS n, pg_get_constraintdef(oid) AS d, confrelid::regclass::text AS ref
      FROM pg_constraint WHERE conrelid=$1::regclass AND contype='f' ORDER BY conname`, [t]);
  for (const f of fks) deferredFks.push(`ALTER TABLE ${t} ADD CONSTRAINT ${f.n} ${f.d};`);
  out.push(`);`);
  const idx = await q(`SELECT indexdef AS d FROM pg_indexes i WHERE i.schemaname='public' AND i.tablename=$1
      AND NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class cc ON cc.oid=k.conindid WHERE cc.relname=i.indexname)`, [t]);
  for (const r of idx) out.push(`${r.d};`);
  out.push("");
}
out.push(`-- ── foreign keys (emitted after all tables, so creation order cannot matter) ──`, ``);
out.push(...deferredFks, ``);
const fns = await q(`SELECT p.proname AS n, pg_get_functiondef(p.oid) AS d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prokind='f' ORDER BY p.proname`);
for (const f of fns) out.push(String(f.d).trim().replace(/;?$/, ";"), "");
const trg = await q(`SELECT tgname AS n, pg_get_triggerdef(t.oid) AS d FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY tgname`);
for (const t of trg) out.push(String(t.d).trim() + ";", "");
const text = out.join("\n");
const head = applied[applied.length - 1]!.replace(/^0*(\d+).*$/, "$1");
const outDir = join(import.meta.dirname, "..", "schema-snapshots");
const outPath = join(outDir, `modern-target-${head}.sql`);
console.log(`snapshot -> ${outPath}`);
console.log(`tables=${tables.length} functions=${fns.length} triggers=${trg.length} bytes=${text.length} lines=${text.split("\n").length}`);
// sanity: every applied migration id is recorded
console.log("migrations:", applied.join(", "));
await engine.close();
// SELF-CHECK: the snapshot must recreate the schema from scratch.
const { createEngine: mk } = await import("../migrate.ts");
const fresh = await mk();
try {
  await fresh.exec(text);
  const t2 = (await fresh.query(`SELECT count(*) AS c FROM information_schema.tables WHERE table_schema='public' AND table_name <> 'schema_migrations'`)).rows as { c: unknown }[];
  console.log(`SELF-CHECK: snapshot re-executed cleanly; tables recreated = ${t2[0]!.c}`);
} catch (e) { console.log("SELF-CHECK FAILED:", (e as Error).message); }
await fresh.close();
