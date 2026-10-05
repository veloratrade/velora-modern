#!/usr/bin/env node
// Root test runner: discovers every *.test.ts (excluding node_modules) and runs
// them with the node test runner via tsx. Exit code aggregates failures.
//
// TWO BATCHES, on purpose:
//   1. everything except `db/tests/**` — default file concurrency.
//   2. `db/tests/**` — the PGlite batteries, run with `--test-concurrency=1`.
// PGlite is an in-process WASM PostgreSQL: several instances booting at once in
// a small container spike past the memory limit and the OS SIGKILLs the test
// file, which surfaces as a bare `not ok … signal: SIGKILL` with no assertion
// behind it. That is a harness limitation pretending to be a code failure — the
// files pass one at a time. Serializing only this batch keeps the suite honest
// (every file still runs, nothing is skipped or weakened) without inflating the
// whole run's wall clock.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { batchVerdict, overallVerdict, parseCount, sigkilledTests } from "./lib/testRunnerVerdict.mjs";

const skip = new Set(["node_modules", ".git", "dist", "out", ".next", "coverage", "infra"]);
function walk(dir, out) {
  for (const e of readdirSync(dir)) {
    if (skip.has(e)) continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    // Phase D evidence separation: *.pg.test.ts batteries run ONLY against a
    // real disposable PostgreSQL (postgres-evidence workflow, DATABASE_URL).
    // They are excluded here so the local battery stays PGlite/dev-only and
    // never reports real-PG skips as if something was verified locally.
    else if (e.endsWith(".test.ts") && !e.endsWith(".pg.test.ts")) out.push(p);
  }
  return out;
}
const files = walk(".", []);
if (files.length === 0) { console.error("no test files found"); process.exit(1); }

const dbFiles = files.filter((f) => f.startsWith("db" + "/") || f.startsWith("./db/"));
const rest = files.filter((f) => !dbFiles.includes(f));
console.log(`running ${files.length} test files (${rest.length} general + ${dbFiles.length} PGlite):\n  ${files.join("\n  ")}`);

const tsxCli = ["node_modules/tsx/dist/cli.mjs", "node_modules/tsx/dist/cli.js"].find((p) => existsSync(p));
if (!tsxCli) { console.error("tsx not installed — run npm install"); process.exit(1); }

function run(batch, extraArgs) {
  if (batch.length === 0) return { ok: true, output: "" };
  try {
    // Captured rather than inherited: a SIGKILLed file has to be recognised in
    // the runner's own output (see the OOM retry below), and `stdio: inherit`
    // would throw that away.
    const output = execFileSync(process.execPath, [tsxCli, "--test", ...extraArgs, ...batch], {
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
      encoding: "utf8",
    });
    process.stdout.write(output);
    return { ok: true, output };
  } catch (err) {
    const out = `${err?.stdout ?? ""}${err?.stderr ?? ""}`;
    process.stdout.write(out);
    return { ok: false, output: out };
  }
}

/*
 * OOM RETRY — the ONE failure class that is not a test result.
 *
 * PGlite is an in-process WASM PostgreSQL. In a small container the OS can kill
 * a test file outright (SIGKILL, no assertion behind it); the runner already
 * serializes the PGlite batch for that reason, and this adds the last mile: a
 * file killed by a SIGNAL is re-run alone, once. An ASSERTION failure is never
 * retried — that would be hiding a result, not stabilising a harness. Nothing is
 * skipped: a file that fails its retry still fails the run.
 *
 * The DECISION itself lives in `tools/lib/testRunnerVerdict.mjs` and is unit
 * tested (`tools/runTestsVerdict.test.ts`), because the inline version silently
 * excused a whole red batch (see that file's header).
 */

/** Map a SIGKILLed TEST NAME back to the file that declared it. */
function mapKilledToFiles(batch, testNames) {
  const files = [];
  let unresolved = 0;
  for (const name of testNames) {
    const file = batch.find((f) => {
      try {
        return readFileSync(f, "utf8").includes(name);
      } catch {
        return false;
      }
    });
    if (file === undefined) unresolved += 1;
    else if (!files.includes(file)) files.push(file);
  }
  return { files, unresolved };
}

function decide(label, batch, result) {
  const killedTests = result.ok ? [] : sigkilledTests(result.output);
  const mapped = mapKilledToFiles(batch, killedTests);
  const verdict = batchVerdict({
    ok: result.ok,
    output: result.output,
    killedFiles: mapped.files,
    unresolvedKills: mapped.unresolved,
  });
  const failCount = parseCount(result.output, "fail");
  console.log(
    `${label}: exit=${result.ok ? 0 : "non-zero"} tests=${parseCount(result.output, "tests") ?? "?"} ` +
      `pass=${parseCount(result.output, "pass") ?? "?"} fail=${failCount ?? "?"} ` +
      `skipped=${parseCount(result.output, "skipped") ?? "?"} killed=${killedTests.length} → ${verdict.decision} (${verdict.reason})`,
  );
  return verdict;
}

function runKilled(label, files) {
  let ok = true;
  for (const file of files) {
    console.log(`\nRETRY (OOM): ${file} — the previous run was SIGKILLed, not failed; re-running it alone.`);
    const attempt = run([file], ["--test-concurrency=1"]);
    const failures = attempt.ok ? 0 : parseCount(attempt.output, "fail");
    if (attempt.ok && failures === 0) {
      console.log(`RETRY PASS: ${file}`);
    } else {
      console.error(`RETRY FAIL: ${file}`);
      ok = false;
    }
  }
  return ok;
}

const generalResult = run(rest, []);
const generalVerdict = decide("general batch", rest, generalResult);
let generalOk = generalVerdict.decision === "pass";
if (generalVerdict.decision === "retry") generalOk = runKilled("general batch", generalVerdict.retry);

const pgliteResult = run(dbFiles, ["--test-concurrency=1"]);
const pgliteVerdict = decide("PGlite batch", dbFiles, pgliteResult);
let pgliteOk = pgliteVerdict.decision === "pass";
if (pgliteVerdict.decision === "retry") pgliteOk = runKilled("PGlite batch", pgliteVerdict.retry);

const verdict = overallVerdict([
  { name: "general batch", decision: generalOk ? "pass" : "fail", reason: generalVerdict.reason },
  { name: "PGlite batch", decision: pgliteOk ? "pass" : "fail", reason: pgliteVerdict.reason },
]);
if (verdict.ok) {
  const excused = generalVerdict.decision === "retry" || pgliteVerdict.decision === "retry";
  console.log(excused ? "ALL TEST FILES PASSED (after re-running OS-killed files individually)" : "ALL TEST FILES PASSED");
} else {
  console.error(verdict.summary);
  process.exit(1);
}
