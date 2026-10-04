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
import { existsSync } from "node:fs";

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
  if (batch.length === 0) return true;
  try {
    execFileSync(process.execPath, [tsxCli, "--test", ...extraArgs, ...batch], { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

const generalOk = run(rest, []);
const pgliteOk = run(dbFiles, ["--test-concurrency=1"]);

if (generalOk && pgliteOk) {
  console.log("ALL TEST FILES PASSED");
} else {
  console.error("TEST RUN FAILED", `(general batch ok=${generalOk}, PGlite batch ok=${pgliteOk})`);
  process.exit(1);
}
