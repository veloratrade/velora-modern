// SEC-01 — the RBAC capability map guard.
//
// A mapping document that nobody checks is a document that is wrong within a
// month. This test READS `docs/security/RBAC-CAPABILITY-MAP.md`, extracts every
// Legacy permission id it claims to answer for, and cross-checks it against:
//
//   * the 24 permission identifiers Legacy actually declares
//     (`api/src/Auth/Role.php` — supplied below as a literal, because the Legacy
//     tree is a read-only reference and must not be a build dependency), and
//   * Modern's own permission vocabulary (`@velora/contracts`), so a row cannot
//     claim an ENFORCED status for a permission that does not exist in code.
//
// What it catches: a Legacy permission silently missing from the map, a row
// duplicated, a claimed enforcement point that no `PERMISSIONS` entry backs, and
// a map that lost its rule about bringing permissions with capabilities.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PERMISSIONS, ROLE_PERMISSIONS, can, APP_ROLES } from "@velora/contracts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAP_PATH = join(HERE, "..", "..", "..", "..", "docs", "security", "RBAC-CAPABILITY-MAP.md");

/** The 24 constants in Legacy `api/src/Auth/Role.php` @edede31, in source order. */
const LEGACY_PERMISSIONS = [
  "overview.view",
  "users.view",
  "users.suspend",
  "users.activate",
  "users.change_role",
  "users.manage_subscription",
  "users.verify_email",
  "users.create",
  "audit.view",
  "audit.view_sensitive",
  "system.health.view",
  "system.logs.view",
  "settings.view",
  "system.settings.manage",
  "communication.view",
  "communication.reply",
  "billing.view",
  "feature_flags.view",
  "feature_flags.edit",
  "integrations.view",
  "integrations.manage",
  "analytics.view",
  "aiManage",
  "aiRouteManage",
] as const;

function mapDocument(): string {
  return readFileSync(MAP_PATH, "utf8");
}

/** Rows of the table that carries one row per Legacy permission. */
function legacyRows(doc: string): { id: string; status: string; line: string }[] {
  const rows: { id: string; status: string; line: string }[] = [];
  for (const line of doc.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    // | # | permission | meaning | owner | status | enforcement | evidence |
    if (cells.length < 8) continue;
    const id = cells[2]!.replace(/`/g, "");
    if (!(LEGACY_PERMISSIONS as readonly string[]).includes(id)) continue;
    rows.push({ id, status: cells[5]!, line });
  }
  return rows;
}

test("SEC-01: the map answers for all 24 Legacy permissions, exactly once each", () => {
  const rows = legacyRows(mapDocument());
  assert.equal(rows.length, LEGACY_PERMISSIONS.length, `expected ${LEGACY_PERMISSIONS.length} rows, found ${rows.length}`);
  const ids = rows.map((r) => r.id);
  assert.deepEqual([...new Set(ids)].length, ids.length, "a permission is listed twice");
  for (const legacy of LEGACY_PERMISSIONS) {
    assert.ok(ids.includes(legacy), `the map does not answer for ${legacy}`);
  }
});

test("SEC-01: an ENFORCED row names a permission that actually exists in code", () => {
  const doc = mapDocument();
  const rows = legacyRows(doc);
  const enforced = rows.filter((r) => r.status.includes("ENFORCED"));
  // The mapping decisions this phase made: rows 1 (overview), 2 (users.view),
  // 3+4 (Legacy's suspend/activate pair, merged into one status operation),
  // 5 (change_role) and 10 (audit.view_sensitive, delivered by SEC-03). If a
  // future phase enforces more, this number grows WITH the map.
  assert.ok(enforced.length >= 6, `expected at least 6 enforced rows, found ${enforced.length}`);

  // Every Modern permission referenced anywhere in an enforcement cell must be a
  // real member of the vocabulary — a map cannot invent enforcement.
  for (const line of doc.split("\n")) {
    for (const m of line.matchAll(/→\s*`([^`]+)`/g)) {
      const named = m[1]!;
      if (!named.includes(".")) continue; // e.g. `markEmailVerified` (a method, not a permission)
      if (named.startsWith("/") || named.startsWith("api/")) continue; // a route path
      assert.ok(
        (PERMISSIONS as readonly string[]).includes(named) ||
          (LEGACY_PERMISSIONS as readonly string[]).includes(named),
        `the map claims enforcement by "${named}", which is neither a Modern nor a Legacy permission`,
      );
    }
  }
});

test("SEC-01: the enforced subset matches the contract's actual grants", () => {
  // users.view — admin AND super_admin (Legacy: admin + super_admin).
  assert.equal(can("admin", "users.view"), true);
  assert.equal(can("super_admin", "users.view"), true);
  assert.equal(can("user", "users.view"), false);
  // users.change_role — super_admin ONLY (Legacy's six SA-exclusive permissions
  // include this one; two of the others are enforced here as the sensitive view
  // and the role matrix).
  assert.equal(can("admin", "users.change_role"), false);
  assert.equal(can("super_admin", "users.change_role"), true);
  // users.manage_status stands in for Legacy's suspend + activate pair.
  assert.equal(can("admin", "users.manage_status"), true);
  assert.equal(can("super_admin", "users.manage_status"), true);
  assert.equal(can("user", "users.manage_status"), false);
});

test("SEC-01: the map states the rule that keeps it from drifting", () => {
  const doc = mapDocument();
  // The governance sentence: a capability brings its permission with it.
  assert.ok(
    doc.includes("a capability brings its permission with it") || doc.includes("**a capability brings its permission with it.**"),
    "the map must state who must update it when a deferred capability lands",
  );
  // And it must name the guard that enforces the map (this file).
  assert.ok(doc.includes("rbacCapabilityMap.test.ts"), "the map must name its own guard test");
});

test("SEC-01: the permission vocabulary has no orphans and no unknown grants", () => {
  for (const p of PERMISSIONS) {
    const holders = APP_ROLES.filter((r) => ROLE_PERMISSIONS[r].includes(p));
    assert.ok(holders.length > 0, `${p} is declared but granted to no role`);
  }
  for (const role of APP_ROLES) {
    for (const p of ROLE_PERMISSIONS[role]) {
      assert.ok((PERMISSIONS as readonly string[]).includes(p), `${role} is granted unknown permission ${p}`);
    }
  }
});
