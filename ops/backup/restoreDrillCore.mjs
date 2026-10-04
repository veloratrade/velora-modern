// Pure logic for the PostgreSQL restore drill — MG-BACKUP-RESTORE.
//
// THE GAP THIS ADDRESSES, in the audit's words: "No real backup taken; no restore
// drill run" and MG-G13 "Operational tooling, backup and restore proven". The
// chain that exists (`ops/backup/create_pg_backup.sh` -> verify -> store ->
// storage verify -> `backup_gate.py`) proves the artifact was CREATED and can be
// STORED. Nothing proves it can be RESTORED: "A backup that was never restored is
// not a backup" (infra/backup/DR-RUNBOOK.md, quoting the policy).
//
// This module holds the parts of the drill that must be true regardless of
// environment, so they can be tested without a database: what makes a drill
// target legitimate, and what "the restored copy equals the source" means.
//
// TWO DELIBERATE, FAIL-CLOSED RULES
// =================================
// 1. SAFETY. A restore drill DROPS and RECREATES its target. The target must
//    therefore be obviously disposable: its database name must end in `_drill`
//    and must not be the source database. There is no flag to bypass this; a
//    drill that can be pointed at `velora` is a drill that will one day delete
//    production.
// 2. NO CREDENTIALS IN EVIDENCE. The drill handles two connection strings and
//    must never write either of them — not into the evidence file, not into a
//    log line. Everything below returns a REDACTED descriptor (host, port,
//    database name only) and the artifact digest; `redact()` is the single place
//    a connection string is parsed, and it never returns the password.
//
// What parity means (and why it is catalog-driven): tables and numeric columns are
// DISCOVERED from `pg_catalog`, not hard-coded, so a future migration cannot
// silently fall outside the comparison. Per table the drill compares the row
// count, and per numeric column the exact decimal SUM as a string — the same
// discipline the money rules use everywhere else in this repository — so a restore
// that drops rows and a restore that changes values are both caught.
//
// PHYSICAL SIZE IS AN OBSERVATION, NOT A GATE. It is recorded in the evidence and
// any difference is reported, but it does not decide the verdict: a live source
// accumulates dead tuples (every UPDATE leaves one), so `pg_total_relation_size`
// on a written-to source legitimately exceeds the freshly-restored copy. Gating on
// it would produce a drill that fails for a benign reason — the fastest way to
// make a safety check ignored. Logical equality (rows + exact sums) is the
// property that matters, and unlike size it cannot drift for maintenance reasons.
//
// Intentionally NOT compared: row ORDER (a restored heap has no order),
// `created_at`-style default timestamps (not stored), and physical file layout.

export const DRILL_SUFFIX = "_drill";
export const DRILL_ENVIRONMENTS = ["staging", "production"];
const SHA_RE = /^[0-9a-f]{7,64}$/;

/**
 * Parse a connection string into a REDACTED descriptor.
 * Returns `null` when the string is unusable. The password is read only to
 * build a throwaway object and is never part of the returned value.
 */
export function redact(connectionString) {
  try {
    const url = new URL(connectionString);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (database === "") return null;
    return {
      host: url.hostname,
      port: url.port === "" ? "5432" : url.port,
      database,
    };
  } catch {
    return null;
  }
}

/**
 * Validate a drill request. Returns `{ ok, errors[], plan }`; `plan` exists only
 * when `ok` is true, and contains no credentials.
 */
export function planDrill({ sourceUrl, drillUrl, environment, sourceCommitSha }) {
  const errors = [];
  const source = redact(sourceUrl ?? "");
  const target = redact(drillUrl ?? "");

  if (source === null) errors.push("DATABASE_URL is missing or is not a usable PostgreSQL connection string");
  if (target === null) errors.push("DRILL_DATABASE_URL is missing or is not a usable PostgreSQL connection string");
  if (!DRILL_ENVIRONMENTS.includes(environment ?? "")) {
    errors.push(`ENVIRONMENT must be one of ${DRILL_ENVIRONMENTS.join("|")} (got ${environment ?? "nothing"})`);
  }
  if (!SHA_RE.test(sourceCommitSha ?? "")) errors.push("SOURCE_COMMIT_SHA must be a git SHA (7..64 hex)");

  if (source !== null && target !== null) {
    if (source.database === target.database && source.host === target.host && source.port === target.port) {
      errors.push("the drill target is the SOURCE database — a drill never restores over its own source");
    }
    if (!target.database.endsWith(DRILL_SUFFIX)) {
      errors.push(`the drill target database name must end in "${DRILL_SUFFIX}" (got "${target.database}") — the drill DROPs and recreates it`);
    }
    if (target.database === "postgres" || target.database === "template1") {
      errors.push(`refusing to use the maintenance database "${target.database}" as a drill target`);
    }
  }

  if (errors.length > 0) return { ok: false, errors, plan: null };
  return { ok: true, errors: [], plan: { source, target, environment, sourceCommitSha } };
}

/**
 * Turn a catalog dump from one database into a comparable snapshot.
 *
 * `rows` are (table_name, kind, name, value) tuples produced by the drill's
 * catalog queries:
 *   kind "rows"    value = row count
 *   kind "numeric" name  = column, value = exact decimal sum (string) or null
 *   kind "size"    value = pg_total_relation_size in bytes
 */
export function snapshotFromRows(rows) {
  const tables = {};
  for (const row of rows) {
    const table = tables[row.table_name] ?? (tables[row.table_name] = { rows: null, numerics: {}, size: null });
    if (row.kind === "rows") table.rows = Number(row.value);
    else if (row.kind === "size") table.size = Number(row.value);
    else if (row.kind === "numeric") table.numerics[row.name] = row.value === null ? null : String(row.value);
  }
  return tables;
}

/**
 * Compare the source snapshot with the restored one. Returns every difference,
 * named precisely — a drill that says only "mismatch" is not evidence.
 */
export function compareSnapshots(source, restored) {
  const checks = [];
  const mismatches = [];
  const observations = [];

  const sourceTables = Object.keys(source).sort();
  const restoredTables = Object.keys(restored).sort();
  for (const t of sourceTables) {
    if (!restoredTables.includes(t)) mismatches.push(`table missing after restore: ${t}`);
  }
  for (const t of restoredTables) {
    if (!sourceTables.includes(t)) mismatches.push(`table appeared that the source does not have: ${t}`);
  }

  let numericColumns = 0;
  for (const t of sourceTables) {
    const a = source[t];
    const b = restored[t];
    if (b === undefined) continue;
    checks.push(`table ${t}`);
    if (a.rows !== b.rows) mismatches.push(`row count differs for ${t}: source ${a.rows}, restored ${b.rows}`);
    if (a.size !== b.size) {
      observations.push(
        `relation size differs for ${t}: source ${a.size}, restored ${b.size} (dead tuples in a live source; not a gate)`,
      );
    }
    const cols = Object.keys(a.numerics).sort();
    for (const c of cols) {
      numericColumns += 1;
      const x = a.numerics[c];
      const y = b.numerics[c];
      if (x !== y) mismatches.push(`numeric sum differs for ${t}.${c}: source ${x}, restored ${y}`);
    }
  }

  return { ok: mismatches.length === 0, checks, mismatches, observations, tables: sourceTables.length, numericColumns };
}

/** The migration ledger must survive the round-trip too, or the schema is not the same schema. */
export function compareLedger(source, restored) {
  const mismatches = [];
  if (source.count !== restored.count) {
    mismatches.push(`schema_migrations count differs: source ${source.count}, restored ${restored.count}`);
  }
  if (source.last !== restored.last) {
    mismatches.push(`schema_migrations head differs: source ${source.last}, restored ${restored.last}`);
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Assemble the evidence record.
 *
 * `verification_status` is `RESTORE_VERIFIED` only when BOTH the parity gates and
 * the application-level smoke passed. `storage_status` is carried through
 * unchanged from the backup producer: a restore drill does not upload anything,
 * and claiming STORAGE_VERIFIED here would be exactly the kind of false
 * completion ADR-012 forbids.
 */
export function buildEvidence({ backup, plan, parity, ledger, smoke, durationsMs, drillId, drillAt, gate }) {
  const restoreVerified = parity.ok && ledger.ok && smoke.ok;
  return {
    schema: "velora-backup/2",
    backup_id: backup.backupId,
    environment: plan.environment,
    backup_type: "database",
    source_commit_sha: plan.sourceCommitSha,
    created_at: backup.createdAt,
    sha256: backup.sha256,
    size_bytes: backup.sizeBytes,
    db_engine: "postgresql",
    verification_status: restoreVerified ? "RESTORE_VERIFIED" : "RESTORE_FAILED",
    storage_status: backup.storageStatus ?? "NONE",
    stored_at: null,
    release_tag: null,
    backup_repo: "veloratrade/velora-backups",
    creation_mechanism: "pg_dump custom+gzip via ops/backup/create_pg_backup.sh",
    restore_drill: {
      drill_id: drillId,
      drill_at: drillAt,
      restored_into: `${plan.target.host}:${plan.target.port}/${plan.target.database}`,
      source: `${plan.source.host}:${plan.source.port}/${plan.source.database}`,
      durations_ms: durationsMs,
      parity: {
        ok: parity.ok,
        tables_compared: parity.tables,
        numeric_columns_compared: parity.numericColumns,
        mismatches: parity.mismatches,
        observations: parity.observations ?? [],
      },
      ledger: { ok: ledger.ok, mismatches: ledger.mismatches },
      smoke: { ok: smoke.ok, passed: smoke.passed, failed: smoke.failed, detail: smoke.detail },
      backup_gate: gate ?? null,
      notes: [
        "Parity gates on row counts and exact decimal SUMs per numeric column, discovered from pg_catalog; physical relation sizes are recorded as observations only (a live source accumulates dead tuples).",
        "storage_status is NOT_NONE only after an uploader re-hashes the stored bytes (ADR-012); this drill does not upload.",
      ],
    },
  };
}

if (process.argv[1] && process.argv[1].endsWith("restoreDrillCore.mjs")) {
  console.log(JSON.stringify(planDrill({
    sourceUrl: process.env.DATABASE_URL,
    drillUrl: process.env.DRILL_DATABASE_URL,
    environment: process.env.ENVIRONMENT,
    sourceCommitSha: process.env.SOURCE_COMMIT_SHA,
  }), null, 2));
}
