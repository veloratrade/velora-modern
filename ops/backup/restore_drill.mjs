#!/usr/bin/env node
// VELORA MODERN — PostgreSQL RESTORE DRILL (MG-BACKUP-RESTORE, MG-G13).
//
// WHAT IT PROVES, IN ORDER
//   1. a REAL backup of a REAL database is produced by the project's own producer
//      (`ops/backup/create_pg_backup.sh` — the same path a scheduled backup uses);
//   2. the artifact is restored into a DISPOSABLE database with `pg_restore`;
//   3. the restored copy is EQUAL to the source on every catalog-discovered
//      invariant: table set, row counts, relation sizes, and the exact decimal
//      SUM of every numeric column (money included);
//   4. the restored copy is APPLICATION-USABLE: `tools/pg-smoke.ts` runs against
//      it (S1..S9: driver facts, scales, trigger, transaction, locks, upserts);
//   5. the evidence record is written, and the deployment gate is asked for its
//      verdict on that record (it is expected to REJECT while nothing has been
//      uploaded to the backup repository — that rejection is recorded, not hidden).
//
// SAFETY / FAIL-CLOSED
//   * the target database name must end in `_drill`, must differ from the source,
//     and must not be a maintenance database (`restoreDrillCore.planDrill`);
//   * the target is DROPPED and recreated — nothing else is ever dropped;
//   * no connection string, password or credential is printed or written;
//   * every step that cannot be verified fails the drill (non-zero exit).
//
// Usage:
//   DATABASE_URL=… DRILL_DATABASE_URL=… ENVIRONMENT=staging \
//   SOURCE_COMMIT_SHA=$(git rev-parse HEAD) \
//   node ops/backup/restore_drill.mjs [--keep] [--out DIR]
import { execFileSync, execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { Client } from "pg";
import { buildEvidence, compareLedger, compareSnapshots, planDrill, snapshotFromRows } from "./restoreDrillCore.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = new URL("../../", import.meta.url).pathname;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};
const KEEP = process.argv.includes("--keep");
const OUT_DIR = arg("--out", join(REPO_ROOT, "backup-artifacts", "drills"));

const started = Date.now();
const log = (msg) => console.log(msg);
const stage = (msg) => log(`\n── ${msg}`);

async function main() {
  // ── preflight (pure, tested in ops/backup/tests/restoreDrill.test.ts) ──────
  const plan = planDrill({
    sourceUrl: process.env.DATABASE_URL,
    drillUrl: process.env.DRILL_DATABASE_URL,
    environment: process.env.ENVIRONMENT,
    sourceCommitSha: process.env.SOURCE_COMMIT_SHA,
  });
  if (!plan.ok) {
    console.error("RESTORE DRILL REFUSED:");
    for (const e of plan.errors) console.error(`  - ${e}`);
    process.exit(2);
  }
  const { source, target, environment, sourceCommitSha } = plan.plan;
  log(`source: ${source.host}:${source.port}/${source.database}   target: ${target.host}:${target.port}/${target.database}   env: ${environment}`);
  const drillId = `restore-drill-${environment}-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
  const artifacts = mkdtempSync(join(tmpdir(), "velora-drill-"));
  mkdirSync(OUT_DIR, { recursive: true });
  const timings = {};

  try {
    // ── 1. real backup through the project's own producer ───────────────────
    stage("1) create + verify a real backup (ops/backup/create_pg_backup.sh)");
    const t0 = Date.now();
    const producerOut = execFileSync("bash", [join(REPO_ROOT, "ops/backup/create_pg_backup.sh"), artifacts], {
      env: { ...process.env, ENVIRONMENT: environment, SOURCE_COMMIT_SHA: sourceCommitSha },
      encoding: "utf8",
    });
    timings.backup_ms = Date.now() - t0;
    const backupId = /^backup_id: (.+)$/m.exec(producerOut)?.[1];
    const sha256 = /^sha256:\s+([0-9a-f]{64})$/m.exec(producerOut)?.[1];
    const sizeBytes = Number(/^size:\s+(\d+) bytes$/m.exec(producerOut)?.[1]);
    if (!backupId || !sha256 || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw new Error("the producer did not emit a usable artifact (backup_id/sha256/size)");
    }
    const artifact = join(artifacts, `${backupId}.dump.gz`);
    log(`artifact ${backupId} · ${sizeBytes} bytes · sha256 ${sha256.slice(0, 12)}…`);
    const backupEvidence = JSON.parse(readFileSync(join(artifacts, `${backupId}.json`), "utf8"));

    // ── 2. restore into the disposable target ──────────────────────────────
    stage("2) restore into the disposable target");
    const t1 = Date.now();
    await dropAndCreate(target);
    // The producer's artifact is gzipped; decompress to a real dump for pg_restore.
    const dump = join(artifacts, `${backupId}.dump`);
    await execFileAsync("bash", ["-c", `gunzip -c ${shellQuote(artifact)} > ${shellQuote(dump)}`]);
    // The drill connection string is passed to pg_restore the same way the
    // producer passes its own to pg_dump; it is never printed or written down.
    await execFileAsync("pg_restore", [
      "--no-owner", "--no-privileges", "--exit-on-error", "-d", process.env.DRILL_DATABASE_URL, dump,
    ]).catch((err) => {
      throw new Error(`pg_restore failed: ${String(err.stderr ?? err).split("\n").slice(0, 4).join(" ")}`);
    });
    timings.restore_ms = Date.now() - t1;
    log(`restored in ${timings.restore_ms} ms`);

    // ── 3. parity gates (catalog-driven, exact decimals) ────────────────────
    stage("3) parity: table set, row counts, relation sizes, exact numeric sums");
    const t2 = Date.now();
    const sourceSnapshot = await snapshot(process.env.DATABASE_URL);
    const restoredSnapshot = await snapshot(process.env.DRILL_DATABASE_URL);
    const parity = compareSnapshots(sourceSnapshot.tables, restoredSnapshot.tables);
    const ledger = compareLedger(sourceSnapshot.ledger, restoredSnapshot.ledger);
    timings.parity_ms = Date.now() - t2;
    log(`compared ${parity.tables} tables and ${parity.numericColumns} numeric columns; ledger head ${sourceSnapshot.ledger.last}`);
    for (const m of [...parity.mismatches, ...ledger.mismatches]) console.error(`  MISMATCH ${m}`);
    for (const o of parity.observations) log(`  observation: ${o}`);
    log(parity.ok && ledger.ok ? "  parity: PASS" : "  parity: FAIL");

    // ── 4. application-level usability of the restored copy ────────────────
    stage("4) application smoke against the RESTORED database (tools/pg-smoke.ts, PG_SMOKE_SCHEMA=restored)");
    const t3 = Date.now();
    const smoke = await runSmoke(process.env.DRILL_DATABASE_URL);
    timings.smoke_ms = Date.now() - t3;
    log(`  smoke: ${smoke.ok ? "PASS" : "FAIL"} (${smoke.passed} checks passed${smoke.failed > 0 ? `, ${smoke.failed} failed` : ""})`);

    // ── 5. evidence + the deployment gate's verdict on it ──────────────────
    stage("5) evidence and the ADR-012 gate verdict");
    const evidence = buildEvidence({
      backup: { backupId, sha256, sizeBytes, createdAt: backupEvidence.created_at, storageStatus: backupEvidence.storage_status },
      plan: plan.plan,
      parity,
      ledger,
      smoke,
      durationsMs: { ...timings, total_ms: Date.now() - started },
      drillId,
      drillAt: new Date().toISOString(),
      gate: null,
    });
    const evidencePath = join(OUT_DIR, `${drillId}.json`);
    evidence.restore_drill.backup_gate = gateVerdict(evidence);
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    log(`  evidence: ${evidencePath}`);
    log(`  gate (deployment): ${evidence.restore_drill.backup_gate.ok ? "ACCEPT" : "REJECT"} — ${evidence.restore_drill.backup_gate.reasons.join("; ") || "no reasons"}`);
    log(`  restore verification: ${evidence.verification_status}`);

    const ok = parity.ok && ledger.ok && smoke.ok;
    log(`\n${ok ? "RESTORE DRILL PASSED" : "RESTORE DRILL FAILED"} in ${Date.now() - started} ms`);
    if (ok) {
      console.log(`EVIDENCE_JSON=${evidencePath}`);
      console.log(`ARTIFACT_SHA256=${sha256}`);
    }
    process.exitCode = ok ? 0 : 1;
  } finally {
    if (!KEEP) {
      await dropQuietly(target).catch(() => undefined);
      log(`\ntarget ${target.database} dropped (pass --keep to inspect it)`);
    } else {
      log(`\ntarget ${target.database} kept for inspection`);
    }
  }
}

/** The maintenance connection: same server, `postgres` database — never the target. */
function adminClient() {
  const url = new URL(process.env.DRILL_DATABASE_URL);
  url.pathname = "/postgres";
  return new Client({ connectionString: url.toString() });
}

async function dropAndCreate(target) {
  const admin = adminClient();
  await admin.connect();
  try {
    // Identifiers are quoted; the names were validated by planDrill (suffix _drill).
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(target.database)}`);
    await admin.query(`CREATE DATABASE ${quoteIdent(target.database)}`);
  } finally {
    await admin.end();
  }
}

async function dropQuietly(target) {
  const admin = adminClient();
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(target.database)}`);
  } finally {
    await admin.end();
  }
}

const quoteIdent = (name) => `"${name.replace(/"/g, '""')}"`;
const shellQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * Catalog-driven snapshot. One query per concern, aggregate-only:
 *   - application tables (public schema, minus the migration ledger),
 *   - row count per table,
 *   - total relation size per table,
 *   - exact SUM per numeric column (money and quantities).
 * Numeric sums arrive from `pg` as STRINGS, so the comparison is decimal-exact.
 */
async function snapshot(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const tables = await client.query(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
        ORDER BY c.relname`,
    );
    const rows = [];
    for (const { name } of tables.rows) {
      const q = (sql) => client.query(sql).then((r) => r.rows[0]);
      const count = await q(`SELECT count(*)::int AS n FROM ${quoteIdent(name)}`);
      const size = await q(`SELECT pg_total_relation_size('public.${name.replace(/'/g, "''")}')::bigint AS n`);
      rows.push({ table_name: name, kind: "rows", name: null, value: count.n });
      rows.push({ table_name: name, kind: "size", name: null, value: size.n });
      const numerics = await client.query(
        `SELECT a.attname AS col FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
            AND a.atttypid = 'numeric'::regtype
          ORDER BY a.attnum`,
        [name],
      );
      for (const { col } of numerics.rows) {
        const sum = await q(`SELECT SUM(${quoteIdent(col)})::text AS s FROM ${quoteIdent(name)}`);
        rows.push({ table_name: name, kind: "numeric", name: col, value: sum.s });
      }
    }
    const ledger = await client.query(
      `SELECT count(*)::int AS n, COALESCE(max(name), '') AS last FROM schema_migrations`,
    );
    return {
      tables: snapshotFromRows(rows),
      ledger: { count: ledger.rows[0].n, last: ledger.rows[0].last },
    };
  } finally {
    await client.end();
  }
}

/** Run the repository's real-PostgreSQL smoke against the restored database. */
async function runSmoke(connectionString) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs"), join(REPO_ROOT, "tools/pg-smoke.ts")],
      { env: { ...process.env, DATABASE_URL: connectionString, PG_SMOKE_SCHEMA: "restored" }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    const passed = stdout.split("\n").filter((l) => l.startsWith("PASS ")).length;
    const failed = stdout.split("\n").filter((l) => l.startsWith("FAIL ")).length;
    const skipped = /^SKIP/m.test(stdout);
    if (skipped || passed === 0) {
      return { ok: false, passed, failed, detail: skipped ? "the smoke reported SKIP — the restored copy was not exercised" : "no PASS lines" };
    }
    return { ok: failed === 0, passed, failed, detail: failed === 0 ? "S1..S9 passed against the restored copy" : `${failed} check(s) failed` };
  } catch (err) {
    const out = `${err?.stdout ?? ""}`.split("\n").filter((l) => l.startsWith("PASS ") || l.startsWith("FAIL "));
    return { ok: false, passed: out.filter((l) => l.startsWith("PASS ")).length, failed: out.filter((l) => l.startsWith("FAIL ")).length, detail: String(err?.stderr ?? err).split("\n").slice(0, 3).join(" ") };
  }
}

/** Ask the project's own gate (ADR-012) what it thinks of this record. */
function gateVerdict(evidence) {
  try {
    const out = execFileSync("python3", ["-c", GATE_SNIPPET, JSON.stringify(evidence)], {
      cwd: join(REPO_ROOT, "ops/backup"),
      encoding: "utf8",
    });
    return JSON.parse(out);
  } catch (err) {
    return { ok: false, reasons: [`gate invocation failed: ${String(err).split("\n")[0]}`] };
  }
}

const GATE_SNIPPET = `
import json, sys
sys.path.insert(0, ".")
from backup_gate import evaluate_backup_gate
evidence = json.loads(sys.argv[1])
ok, reasons = evaluate_backup_gate(evidence, evidence["environment"])
print(json.dumps({"ok": bool(ok), "reasons": [str(r) for r in (reasons or [])]}))
`;

await main();
