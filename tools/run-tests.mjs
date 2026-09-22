#!/usr/bin/env node
// Root test runner: discovers every *.test.ts (excluding node_modules) and runs
// them with the node test runner via tsx. Exit code aggregates failures.
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
console.log(`running ${files.length} test files:\n  ${files.join("\n  ")}`);

const tsxCli = ["node_modules/tsx/dist/cli.mjs", "node_modules/tsx/dist/cli.js"].find((p) => existsSync(p));
if (!tsxCli) { console.error("tsx not installed — run npm install"); process.exit(1); }

try {
  execFileSync(process.execPath, [tsxCli, "--test", ...files], { stdio: "inherit" });
  console.log("ALL TEST FILES PASSED");
} catch (err) {
  console.error("TEST RUN FAILED", err instanceof Error && err.message ? `(${err.message.split("\n")[0]})` : "");
  process.exit(1);
}
