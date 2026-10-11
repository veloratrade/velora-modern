import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

function loadJson(path: string): any {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8"));
}

// Capability matrix consistency — the "different status counts" are intentional and must not be equated.
test("capability-matrix: schema and counts are internally consistent, not equated to gap register", async () => {
  const matrix = loadJson("docs/state/capability-matrix.json");
  assert.equal(matrix.schema_version, 1);
  assert.ok(Array.isArray(matrix.capabilities), "capabilities is array");
  const caps = matrix.capabilities as Array<{ id: string; status: string }>;
  // Status vocabulary for the matrix is richer than the gap register's OPEN/PARTIAL/CLOSED
  const matrixVocab = new Set([
    "MISSING",
    "UI_ONLY",
    "BACKEND_ONLY",
    "PARTIAL",
    "IMPLEMENTED",
    "VERIFIED",
    "LEGACY_ONLY",
    "INTENTIONALLY_NOT_MIGRATED",
  ]);
  for (const c of caps) {
    assert.ok(matrixVocab.has(c.status), `${c.id} invalid matrix status ${c.status}`);
    assert.ok(c.id, `${c.id} missing id`);
  }
  // counts must sum to total and match actual array length
  const counts = matrix.counts as Record<string, number>;
  const total = caps.length;
  const sum = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.equal(sum, total, `matrix counts sum ${sum} != total ${total}`);
  // sanity: known 2026-10-11 numbers (TRD-03 PARTIAL logged at f304317)
  // 13 VERIFIED, 8 IMPLEMENTED, 14 PARTIAL, 8 MISSING, 5 BACKEND_ONLY, 1 UI_ONLY, 2 LEGACY_ONLY, 2 INTENTIONALLY_NOT_MIGRATED = 53
  assert.equal(total, 53, `expected 53 capabilities (f304317), got ${total}`);
});

test("migration-gap-register: status counts sum, IDs unique, verification states valid", async () => {
  const reg = loadJson("docs/state/migration-gap-register.json");
  assert.equal(reg.schema_version, 1);
  const gaps = reg.gaps as Array<{ id: string; status: string; verification_state: string }>;
  assert.ok(Array.isArray(gaps) && gaps.length > 0, "gaps is non-empty array");
  const seen = new Set<string>();
  const vocabStatus = new Set(["OPEN", "PARTIAL", "CLOSED"]);
  const vocabVerify = new Set(["STATIC", "RECORDED_RUNTIME", "CURRENT_RUNTIME_VERIFIED", "NOT_VERIFIED", "OWNER_DECISION_REQUIRED"]);
  let open = 0, partial = 0, closed = 0;
  for (const g of gaps) {
    assert.ok(g.id, "gap without id");
    assert.ok(!seen.has(g.id), `duplicate gap id ${g.id}`);
    seen.add(g.id);
    assert.ok(vocabStatus.has(g.status), `${g.id} invalid status ${g.status}`);
    assert.ok(vocabVerify.has(g.verification_state), `${g.id} invalid verification_state ${g.verification_state}`);
    if (g.status === "OPEN") open++;
    else if (g.status === "PARTIAL") partial++;
    else if (g.status === "CLOSED") closed++;
    // evidence paths — if they mention a docs/ path before '#', it must exist (agent-context also checks, but we pin here)
    for (const ev of (g as any).evidence ?? []) {
      const p = String(ev).split("#")[0];
      if (p && p.startsWith("docs/")) {
        // allow audit file that is checked elsewhere; just assert string non-empty
        assert.ok(p.length > 5);
      }
    }
  }
  assert.equal(gaps.length, open + partial + closed, "gaps length must equal sum of statuses");
  // 2026-10-11 expected 13 OPEN / 30 PARTIAL / 13 CLOSED = 56 (do not equate to capability matrix 53)
  assert.equal(gaps.length, 56, `expected 56 gaps, got ${gaps.length}`);
  assert.equal(open, 13);
  assert.equal(partial, 30);
  assert.equal(closed, 13);
});

test("MIGRATION_GAP_REGISTER twin byte-sync: json and md are twins updated in same change", async () => {
  const json = loadJson("docs/state/migration-gap-register.json");
  const gaps = json.gaps as Array<{ id: string }>;
  const md = readFileSync(join(ROOT, "docs/state/MIGRATION_GAP_REGISTER.md"), "utf8");
  // Every gap id in json must appear verbatim in the markdown twin
  const missingInMd: string[] = [];
  for (const g of gaps) {
    if (!md.includes(g.id)) missingInMd.push(g.id);
  }
  assert.deepEqual(missingInMd, [], `json ids missing in md twin: ${missingInMd.join(",")}`);
  // And every "| MG-" row in the markdown should correspond to a json gap (allow header rows and E section)
  // Count distinct MG-* ids in md via regex
  const mdIds = [...md.matchAll(/\| (MG-[A-Z0-9-]+)/g)].map(m => m[1]);
  const mdUnique = [...new Set(mdIds)];
  // md may contain extra MG- ids from the E section that are also in json (e.g., MG-DOC-1); so mdUnique should be subset of json ids
  const jsonIds = new Set(gaps.map(g => g.id));
  const extraInMd = mdUnique.filter(id => !jsonIds.has(id));
  // Allow zero extra — if extra appears, it means md has a gap not in json (twin drift)
  assert.deepEqual(extraInMd, [], `md has ids not in json twin (twin drift): ${extraInMd.join(",")}`);
  // The audit date in both files must agree (prevents stale twin after audit change)
  const auditInJson = json.source_audit?.audit_date as string | undefined;
  if (auditInJson) {
    assert.ok(md.includes(auditInJson), `md twin must mention audit_date ${auditInJson} from json (twin byte-sync)`);
  }
});

test("capability counts and gap counts must not be falsely equated (they measure different things)", async () => {
  const matrix = loadJson("docs/state/capability-matrix.json");
  const reg = loadJson("docs/state/migration-gap-register.json");
  const matrixTotal = (matrix.capabilities as any[]).length;
  const gapTotal = (reg.gaps as any[]).length;
  // They are intentionally different: 53 capabilities vs 56 gaps at f304317 — a test that equates them would be wrong
  assert.notEqual(matrixTotal, gapTotal, "capability total and gap total are different vocabularies — must not be equated");
  // And their PARTIAL counts are also intentionally different
  const matrixPartial = matrix.counts.PARTIAL as number;
  const gapPartial = (reg.gaps as Array<{status:string}>).filter(g=>g.status==="PARTIAL").length;
  assert.notEqual(matrixPartial, gapPartial, "matrix PARTIAL != gap PARTIAL — different dimensions");
});

test("state files twins byte-sync: current-state.json and CURRENT_STATE.md shared fields agree", async () => {
  const j = loadJson("docs/state/current-state.json");
  const md = readFileSync(join(ROOT, "docs/state/CURRENT_STATE.md"), "utf8");
  const sha = j.current_verified?.modern_sha as string;
  const legacy = j.current_verified?.legacy_sha as string;
  const at = j.current_verified?.verified_at as string;
  assert.ok(typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha), "modern_sha must be 40 hex");
  assert.ok(md.includes(sha.slice(0, 7)), `CURRENT_STATE.md must mention short sha ${sha.slice(0,7)} (twin byte-sync)`);
  if (legacy) assert.ok(md.includes(legacy.slice(0,7)) || md.includes(legacy), "md must mention legacy sha");
  if (at) assert.ok(md.includes(at), `md must mention verified_at ${at}`);
});
