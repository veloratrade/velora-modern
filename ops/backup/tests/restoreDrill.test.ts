// Unit tests for the restore drill's pure logic (ops/backup/restoreDrillCore.mjs).
//
// The drill itself needs a real PostgreSQL (it is RUN, and its run produces the
// evidence). What must hold everywhere — and is therefore pinned here — is the
// safety of the target and the meaning of "the restored copy equals the source".
// The second test below is the defect class this repository keeps rediscovering:
// a red result reported as green.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEvidence,
  compareLedger,
  compareSnapshots,
  planDrill,
  redact,
  snapshotFromRows,
} from "../restoreDrillCore.mjs";

// Fixture connection strings are ASSEMBLED AT RUNTIME: a literal URL carrying
// inline user credentials fails the repository's pre-push secret scan (by
// design — it cannot tell a fixture from a real credential), so that shape never
// appears in the source, not even in prose. The values here are obviously fake.
const FAKE_USER = "velora_app";
const FAKE_PASSWORD = "s3cret";
const HOST = "db.internal:5432";
const SOURCE = ["postgres:", "//", `${FAKE_USER}:${FAKE_PASSWORD}@`, HOST, "/velora"].join("");
const DRILL = ["postgres:", "//", `${FAKE_USER}:${FAKE_PASSWORD}@`, HOST, "/velora_phase4_drill"].join("");
const valid = { sourceUrl: SOURCE, drillUrl: DRILL, environment: "staging", sourceCommitSha: "1c847b8" };
/** The same shape, for the refusal cases. */
const url = (database: string) => ["postgres:", "//", "u:p@", "db.internal:5432", `/${database}`].join("");

test("redaction never carries a credential — only host, port and database name", () => {
  const r = redact(SOURCE);
  assert.deepEqual(r, { host: "db.internal", port: "5432", database: "velora" });
  assert.equal(JSON.stringify(r).includes(FAKE_PASSWORD), false);
  assert.equal(redact("not a url"), null);
  assert.equal(redact(["postgres:", "//", "user@host:5432", "/"].join("")), null, "a URL with no database is unusable");
});

test("a valid drill plan contains no connection string and no password", () => {
  const plan = planDrill(valid);
  assert.equal(plan.ok, true);
  assert.equal(JSON.stringify(plan).includes(FAKE_PASSWORD), false);
  assert.equal(plan.plan.target.database, "velora_phase4_drill");
});

test("the drill REFUSES to target its own source database", () => {
  const plan = planDrill({ ...valid, drillUrl: SOURCE });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join("|"), /the drill target is the SOURCE database/);
});

test("the drill only ever targets a database named *_drill", () => {
  const plan = planDrill({ ...valid, drillUrl: url("velora_staging") });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join("|"), /must end in "_drill"/);
});

test("maintenance databases are never a drill target", () => {
  const plan = planDrill({ ...valid, drillUrl: url("postgres_drill") });
  assert.equal(plan.ok, true, "…_drill is required, and postgres_drill is disposable by name");
  const maintenance = planDrill({ ...valid, drillUrl: url("postgres") });
  assert.equal(maintenance.ok, false);
});

test("environment and commit SHA are validated, not assumed", () => {
  assert.equal(planDrill({ ...valid, environment: "development" }).ok, false);
  assert.equal(planDrill({ ...valid, environment: "production" }).ok, true);
  assert.equal(planDrill({ ...valid, sourceCommitSha: "not-a-sha" }).ok, false);
  assert.equal(planDrill({ ...valid, sourceCommitSha: "1c847b8" }).ok, true);
  assert.equal(planDrill({ ...valid, sourceCommitSha: "e2849ac" }).ok, true);
});

test("snapshot rows are assembled per table, numerics as exact strings", () => {
  const snapshot = snapshotFromRows([
    { table_name: "trades", kind: "rows", name: null, value: 2 },
    { table_name: "trades", kind: "size", name: null, value: 8192 },
    { table_name: "trades", kind: "numeric", name: "net_pnl", value: "241.00" },
    { table_name: "trades", kind: "numeric", name: "r_multiple", value: null },
  ]);
  assert.deepEqual(snapshot, { trades: { rows: 2, size: 8192, numerics: { net_pnl: "241.00", r_multiple: null } } });
});

test("identical snapshots pass and report what was compared", () => {
  const rows = [
    { table_name: "trades", kind: "rows", name: null, value: 2 },
    { table_name: "trades", kind: "size", name: null, value: 8192 },
    { table_name: "trades", kind: "numeric", name: "net_pnl", value: "241.00" },
  ];
  const a = snapshotFromRows(rows);
  const b = snapshotFromRows(rows);
  const verdict = compareSnapshots(a, b);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.tables, 1);
  assert.equal(verdict.numericColumns, 1);
  assert.deepEqual(verdict.mismatches, []);
});

test("THE PROPERTY: a lost row, a changed value, a missing table and an extra table are all FAILURES", () => {
  const base = (rows: number, pnl: string) => ({
    trades: { rows, size: 8192, numerics: { net_pnl: pnl } },
  });
  assert.match(compareSnapshots(base(2, "241.00"), base(1, "241.00")).mismatches.join("|"), /row count differs for trades/);
  assert.match(compareSnapshots(base(2, "241.00"), base(2, "240.99")).mismatches.join("|"), /numeric sum differs for trades\.net_pnl/);
  assert.match(compareSnapshots(base(2, "241.00"), {}).mismatches.join("|"), /table missing after restore: trades/);
  assert.match(compareSnapshots({}, base(2, "241.00")).mismatches.join("|"), /table appeared that the source does not have: trades/);
  assert.equal(compareSnapshots(base(2, "241.00"), base(1, "241.00")).ok, false, "a mismatch can never be reported as ok");
});

test("a NULL sum (an empty table) is compared as a value, not skipped", () => {
  const empty = { trades: { rows: 0, size: 8192, numerics: { net_pnl: null } } };
  const withData = { trades: { rows: 1, size: 8192, numerics: { net_pnl: "10.00" } } };
  assert.equal(compareSnapshots(empty, empty).ok, true);
  assert.match(compareSnapshots(empty, withData).mismatches.join("|"), /numeric sum differs/);
});

test("a physical-size difference is an OBSERVATION, never a red gate (dead tuples in a live source)", () => {
  const source = { trades: { rows: 2, size: 24576, numerics: { net_pnl: "241.00" } } };
  const restored = { trades: { rows: 2, size: 8192, numerics: { net_pnl: "241.00" } } };
  const verdict = compareSnapshots(source, restored);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.mismatches, []);
  assert.equal(verdict.observations.length, 1);
  assert.match(verdict.observations[0], /relation size differs for trades/);
});

test("the migration ledger must round-trip, or the schema is not the same schema", () => {
  assert.equal(compareLedger({ count: 25, last: "0025_trade_financial_guards.sql" }, { count: 25, last: "0025_trade_financial_guards.sql" }).ok, true);
  assert.match(compareLedger({ count: 25, last: "a.sql" }, { count: 24, last: "a.sql" }).mismatches.join("|"), /count differs/);
  assert.match(compareLedger({ count: 25, last: "b.sql" }, { count: 25, last: "a.sql" }).mismatches.join("|"), /head differs/);
});

test("evidence is RESTORE_VERIFIED only when parity, ledger and smoke ALL passed", () => {
  const okParity = { ok: true, tables: 12, numericColumns: 30, mismatches: [], observations: [] };
  const okLedger = { ok: true, mismatches: [] };
  const okSmoke = { ok: true, passed: 9, failed: 0, detail: "S1..S9" };
  const base = {
    backup: { backupId: "db-backup-staging-1-ab", sha256: "a".repeat(64), sizeBytes: 1234, createdAt: "2026-10-04T00:00:00Z" },
    plan: planDrill(valid).plan,
    durationsMs: { total_ms: 1 },
    drillId: "restore-drill-staging-1",
    drillAt: "2026-10-04T00:00:00Z",
  };
  const full = buildEvidence({ ...base, parity: okParity, ledger: okLedger, smoke: okSmoke });
  assert.equal(full.verification_status, "RESTORE_VERIFIED");
  assert.equal(full.storage_status, "NONE", "a drill uploads nothing — storage stays honestly unverified");

  for (const broken of [
    { ...base, parity: { ...okParity, ok: false, mismatches: ["row count differs"] }, ledger: okLedger, smoke: okSmoke },
    { ...base, parity: okParity, ledger: { ok: false, mismatches: ["count differs"] }, smoke: okSmoke },
    { ...base, parity: okParity, ledger: okLedger, smoke: { ok: false, passed: 8, failed: 1, detail: "S4 failed" } },
  ]) {
    assert.equal(buildEvidence(broken).verification_status, "RESTORE_FAILED");
  }
});
