#!/usr/bin/env node
// Parity runner (foundation) — executes declarative specs (parity/specs/*.json)
// against a target base URL using SEMANTIC comparison with an explicit
// tolerance allowlist (docs/parity-plan.md: no naive raw diffing).
//
// Usage: node parity/run.mjs --target http://127.0.0.1:PORT
//
// TARGETS:
//   - modern local/dev: fully supported (this is the Phase 1 smoke)
//   - modern staging:   supported once staging exists
//   - php staging:      INTENTIONALLY NOT RUN FROM SANDBOX — the PHP host
//     firewall silent-drops non-Iranian IPs (OC-1) and live testing requires
//       owner authorization; differential runs happen from authorized
//       environments only (documented in parity/README.md).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const targetArg = args[args.indexOf("--target") + 1];
// Deep-containment match: every key in `exp` must exist in `act` with the same
// value (objects recurse; extra keys in `act` are ALLOWED — the spec asserts
// the contractual subset, not the full envelope).
function deepContains(exp, act) {
  if (exp !== null && typeof exp === "object" && !Array.isArray(exp)) {
    if (act === null || typeof act !== "object" || Array.isArray(act)) return false;
    return Object.entries(exp).every(([k, v]) => deepContains(v, act[k]));
  }
  return exp === act;
}
function pathExists(root, dotted) {
  let cur = root;
  for (const seg of dotted.split(".")) {
    if (cur === null || typeof cur !== "object") return false;
    cur = cur[seg];
  }
  return cur !== undefined;
}

export async function runSpecs(base) {
let pass = 0, fail = 0;
const specsDir = join(import.meta.dirname, "specs");
for (const file of readdirSync(specsDir).filter((f) => f.endsWith(".json")).sort()) {
  const spec = JSON.parse(readFileSync(join(specsDir, file), "utf8"));
  const cases = spec.cases ?? [ { request: spec.request, expect: spec.expect } ];
  for (const c of cases) {
    const res = await fetch(base + c.request.path, {
      method: c.request.method,
      signal: AbortSignal.timeout(5000), // never hang the runner
    });
    let ok = res.status === c.expect.status;
    if (ok && c.expect.headers) {
      for (const [h, v] of Object.entries(c.expect.headers)) {
        if (res.headers.get(h) !== v) ok = false;
      }
    }
    if (ok && (c.expect.json || c.expect.jsonContains)) {
      const body = await res.json();
      if (c.expect.json && !deepContains(c.expect.json, body)) ok = false;
      if (ok && c.expect.jsonContains) {
        for (const p of c.expect.jsonContains) if (!pathExists(body, p)) ok = false;
      }
    }
    console.log(`${ok ? "PASS" : "FAIL"}  ${spec.name}  ${c.request.method} ${c.request.path}`);
    ok ? pass++ : fail++;
  }
}
console.log(`\nparity: ${pass} pass, ${fail} fail (target: ${base})`);
return { pass, fail };
}

// CLI guard — allows in-process import (tools/parity-smoke.ts) AND standalone
// `node parity/run.mjs --target URL` (CI/staging). NOTE: in this dev sandbox,
// cross-process loopback HTTP is blocked (child→parent connections dropped);
// the in-process path exists for exactly that reason.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!targetArg || !/^https?:\/\//.test(targetArg)) {
    console.error("usage: node parity/run.mjs --target http://host:port");
    process.exit(2);
  }
  const { fail } = await runSpecs(targetArg.replace(/\/+$/, ""));
  process.exit(fail === 0 ? 0 : 1);
}
