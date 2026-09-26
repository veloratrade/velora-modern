#!/usr/bin/env node
// VELORA-MODERN — Agent Context verifier (ADR-017).
//
// Session-start tool. Answers, from repository evidence alone:
//   1. Is the historical audit baseline present and byte-intact?
//   2. Where are both repository HEADs relative to the last verified state?
//   3. What changed since then, and is it governance-only or application?
//   4. Do the gap-register/state files validate?
//
// Usage:   node tools/agent-context.mjs [--json] [--legacy-path <path>]
// Env:     VELORA_LEGACY_PATH overrides the legacy checkout location.
// Exit:    0 = CURRENT (incl. governance-only delta, all logged)
//          1 = DRIFTED or validation failure — curate state before proceeding
//          2 = usage error
//
// Dependency-free by design (Node stdlib only). No CI workflow runs this
// (GitHub Actions is disabled per the owner cost policy); it is executed by
// agents at session start and reported to the owner.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = join(REPO_ROOT, "docs", "state", "current-state.json");
const GAPS_FILE = join(REPO_ROOT, "docs", "state", "migration-gap-register.json");
const CHANGE_LOG = join(REPO_ROOT, "docs", "state", "CHANGE_LOG.md");

const VERIFICATION_STATES = new Set([
  "STATIC",
  "RECORDED_RUNTIME",
  "CURRENT_RUNTIME_VERIFIED",
  "NOT_VERIFIED",
  "OWNER_DECISION_REQUIRED",
]);
const GAP_STATUSES = new Set(["OPEN", "PARTIAL", "CLOSED"]);

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const legacyFlagIdx = args.indexOf("--legacy-path");
const legacyOverride =
  legacyFlagIdx !== -1 && args[legacyFlagIdx + 1]
    ? args[legacyFlagIdx + 1]
    : process.env.VELORA_LEGACY_PATH || null;

function fail(msg) {
  if (asJson) console.log(JSON.stringify({ verdict: "ERROR", errors: [msg] }, null, 2));
  else console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function git(args_, cwd = REPO_ROOT) {
  return execFileSync("git", args_, { cwd, encoding: "utf8" }).trim();
}

function classifyPaths(paths, policy) {
  // A commit is governance-only iff EVERY changed path falls under a
  // governance prefix/rule. Anything else is application-affecting.
  return paths.every((p) =>
    policy.governance_only_paths.some((g) =>
      g.endsWith("/") ? p.startsWith(g) : p === g
    )
  );
}

// ---------- 1. State files ----------
if (!existsSync(STATE_FILE)) fail(`missing ${STATE_FILE}`);
if (!existsSync(GAPS_FILE)) fail(`missing ${GAPS_FILE}`);

let state, gaps;
try {
  state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
} catch (e) {
  fail(`current-state.json does not parse: ${e.message}`);
}
try {
  gaps = JSON.parse(readFileSync(GAPS_FILE, "utf8"));
} catch (e) {
  fail(`migration-gap-register.json does not parse: ${e.message}`);
}

const errors = [];
const warnings = [];

// ---------- 2. Historical audit integrity ----------
const auditInfo = state.historical_baseline?.audit;
if (!auditInfo?.path) fail("current-state.json: historical_baseline.audit.path missing");
const auditPath = isAbsolute(auditInfo.path)
  ? auditInfo.path
  : join(REPO_ROOT, auditInfo.path);
let auditOk = false;
if (existsSync(auditPath)) {
  const sha = createHash("sha256").update(readFileSync(auditPath)).digest("hex");
  auditOk = sha === auditInfo.sha256;
  if (!auditOk) {
    errors.push(
      `AUDIT INTEGRITY FAILURE: ${auditInfo.path} sha256 ${sha} != recorded ${auditInfo.sha256} — the immutable audit was modified. Restore it from git history.`
    );
  }
} else {
  errors.push(`AUDIT MISSING: ${auditInfo.path} not found.`);
}

// ---------- 3. Gap-register validation ----------
const gapList = Array.isArray(gaps.gaps) ? gaps.gaps : [];
const seenIds = new Set();
for (const g of gapList) {
  if (!g.id) errors.push("gap without id");
  if (seenIds.has(g.id)) errors.push(`duplicate gap id ${g.id}`);
  seenIds.add(g.id);
  if (!GAP_STATUSES.has(g.status)) errors.push(`${g.id}: invalid status '${g.status}'`);
  if (!VERIFICATION_STATES.has(g.verification_state))
    errors.push(`${g.id}: invalid verification_state '${g.verification_state}'`);
  for (const ev of g.evidence || []) {
    const p = ev.split("#")[0];
    if (p && !existsSync(join(REPO_ROOT, p)))
      errors.push(`${g.id}: evidence path does not exist: ${p}`);
  }
}
for (const v of gaps.verified_complete || []) {
  if (!VERIFICATION_STATES.has(v.verification_state))
    errors.push(`verified_complete '${v.area}': invalid verification_state '${v.verification_state}'`);
}
const closed = gapList.filter((g) => g.status === "CLOSED").length;
const open = gapList.filter((g) => g.status === "OPEN").length;
const partial = gapList.filter((g) => g.status === "PARTIAL").length;

// ---------- 4. Modern drift ----------
const baseline = state.historical_baseline?.modern?.sha;
const verified = state.current_verified?.modern_sha;
if (!baseline || !verified) fail("current-state.json: modern SHAs missing");

let modernHead;
try {
  modernHead = git(["rev-parse", "HEAD"]);
} catch {
  fail("not a git repository / git unavailable");
}

const commitSince = (from, to) => {
  try {
    return git(["rev-list", "--reverse", `${from}..${to}`]).split("\n").filter(Boolean);
  } catch {
    return null; // from-SHA not reachable (history rewrite?) — caller handles
  }
};

function analyzeRepo(name, head, verifiedSha, baselineSha, policy) {
  const result = { name, head, verdict: "CURRENT", delta: [], unlogged: [], unreachable: false };
  if (head === verifiedSha) return result;
  const shas = commitSince(verifiedSha, head);
  if (shas === null) {
    result.verdict = "DRIFTED";
    result.unreachable = true;
    return result;
  }
  const changeLogText = existsSync(CHANGE_LOG) ? readFileSync(CHANGE_LOG, "utf8") : "";
  let appCommits = 0;
  for (const sha of shas) {
    const subject = git(["log", "-1", "--format=%s", sha]);
    const paths = git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha])
      .split("\n")
      .filter(Boolean);
    const gov = classifyPaths(paths, policy);
    if (!gov) appCommits++;
    const logged = changeLogText.includes(sha) || changeLogText.includes(subject);
    result.delta.push({ sha: sha.slice(0, 12), subject, governance_only: gov, logged });
    if (!logged) result.unlogged.push(sha.slice(0, 12));
  }
  if (appCommits > 0) {
    result.verdict = "DRIFTED";
  } else {
    result.verdict = "CURRENT_GOVERNANCE_DELTA";
    if (state.drift_policy?.require_change_log_entry && result.unlogged.length > 0) {
      result.verdict = "DRIFTED"; // governance commits must still be CHANGE_LOG-logged
      result.reason = "governance-only commits missing CHANGE_LOG entries";
    }
  }
  return result;
}

const policy = state.drift_policy || { governance_only_paths: [] };
const modern = analyzeRepo("modern", modernHead, verified, baseline, policy);

// ---------- 5. Legacy drift ----------
let legacy = null;
const legacyPath = legacyOverride
  ? resolve(REPO_ROOT, legacyOverride)
  : join(REPO_ROOT, state.legacy_checkout?.expected_path || "../veloratrade");
if (existsSync(legacyPath)) {
  try {
    const legacyHead = git(["rev-parse", "HEAD"], legacyPath);
    legacy = analyzeRepo(
      "legacy",
      legacyHead,
      state.current_verified?.legacy_sha,
      state.historical_baseline?.legacy?.sha,
      policy
    );
  } catch (e) {
    warnings.push(`legacy checkout at ${legacyPath} not usable: ${e.message}`);
    legacy = { name: "legacy", verdict: "NOT_CHECKED" };
  }
} else {
  legacy = { name: "legacy", verdict: "NOT_CHECKED", note: `no checkout at ${legacyPath} (set --legacy-path or VELORA_LEGACY_PATH); legacy state is NOT_VERIFIED this session` };
}

// ---------- 6. Verdict ----------
const overall =
  errors.length > 0 || modern.verdict === "DRIFTED" || legacy.verdict === "DRIFTED"
    ? "DRIFTED"
    : "CURRENT";

const report = {
  tool: "tools/agent-context.mjs",
  system: "velora-agent-context",
  generated_at: new Date().toISOString(),
  overall,
  exit_code: overall === "CURRENT" ? 0 : 1,
  audit_integrity: auditOk ? "OK" : "FAILED",
  audit: { path: auditInfo.path, sha256: auditInfo.sha256, date: auditInfo.audit_date, verdict: auditInfo.verdict },
  migration_summary: state.summary || {},
  gap_register: { total: gapList.length, open, partial, closed },
  modern,
  legacy,
  errors,
  warnings,
  session_start_instructions: overall === "CURRENT"
    ? "State is CURRENT. Proceed within owner-authorized scope; update docs/state/ in the same change if your work alters migration state."
    : "State is DRIFTED or invalid. Before acting: (1) fix any errors, (2) curate CHANGE_LOG entries for unlogged commits, (3) re-verify or explicitly mark stale evidence in the gap register, (4) update current-state.json current_verified SHAs. Do not treat recorded evidence as current until then.",
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const line = "─".repeat(72);
  console.log(line);
  console.log("VELORA AGENT CONTEXT — session-start state verification");
  console.log(line);
  console.log(`Historical audit : ${report.audit.date} — integrity ${report.audit_integrity}`);
  console.log(`  ${report.audit.path}`);
  console.log(`  verdict: ${report.audit.verdict}`);
  console.log(`Migration        : ${state.summary?.migration_closure} — gaps: ${open} OPEN / ${partial} PARTIAL / ${closed} CLOSED`);
  console.log(`Modern HEAD      : ${modern.head}`);
  console.log(`  verified SHA   : ${verified}`);
  console.log(`  verdict        : ${modern.verdict}${modern.reason ? ` (${modern.reason})` : ""}`);
  for (const d of modern.delta) {
    console.log(`    ${d.sha} ${d.governance_only ? "gov " : "APP"} ${d.logged ? "logged  " : "UNLOGGED"} ${d.subject}`);
  }
  if (modern.unreachable)
    console.log("    verified SHA unreachable — possible history rewrite; investigate before proceeding");
  if (legacy.verdict === "NOT_CHECKED") {
    console.log(`Legacy           : NOT CHECKED — ${legacy.note || ""}`);
  } else {
    console.log(`Legacy HEAD      : ${legacy.head}`);
    console.log(`  verdict        : ${legacy.verdict}`);
    for (const d of legacy.delta || []) {
      console.log(`    ${d.sha} ${d.governance_only ? "gov " : "APP"} ${d.logged ? "logged  " : "UNLOGGED"} ${d.subject}`);
    }
  }
  for (const e of errors) console.log(`ERROR: ${e}`);
  for (const w of warnings) console.log(`WARN : ${w}`);
  console.log(line);
  console.log(`OVERALL: ${overall}`);
  console.log(report.session_start_instructions);
  console.log(line);
}

process.exit(overall === "CURRENT" ? 0 : 1);
