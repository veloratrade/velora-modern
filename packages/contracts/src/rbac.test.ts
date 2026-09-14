// Phase 3B-3 — application RBAC contract tests (OD-9).
//
// Pure-contract evidence: the permission map itself, hierarchy as a PROVEN
// property, and fail-closed behaviour on every unrecognised input.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APP_ROLES, PERMISSIONS, ROLE_PERMISSIONS,
  can, isAppRole, permissionsFor, normalizeRole,
  type AppRole, type Permission,
} from "./rbac.js";

test("OD-9: exactly three application roles, least → most privileged", () => {
  assert.deepEqual(APP_ROLES, ["user", "admin", "super_admin"]);
  // The frozen set — no guest, no owner, and none of the ADR-010 DB identities.
  for (const dbIdentity of ["velora_owner", "velora_migrator", "app_readwrite", "velora_worker", "velora_readonly", "guest", "root", "postgres"]) {
    assert.equal(isAppRole(dbIdentity), false, `${dbIdentity} must not be an application role`);
  }
});

test("hierarchy super_admin ⊇ admin ⊇ user holds as a PROVEN property", () => {
  const u = new Set(ROLE_PERMISSIONS.user);
  const a = new Set(ROLE_PERMISSIONS.admin);
  const s = new Set(ROLE_PERMISSIONS.super_admin);

  for (const p of u) assert.ok(a.has(p), `admin must retain user permission ${p}`);
  for (const p of a) assert.ok(s.has(p), `super_admin must retain admin permission ${p}`);
  // Strict: each tier adds something, otherwise the tier is pointless.
  assert.ok(a.size > u.size, "admin must exceed user");
  assert.ok(s.size > a.size, "super_admin must exceed admin");
});

test("a plain user holds NO administrative permission", () => {
  assert.equal(can("user", "admin.panel.access"), false);
  assert.equal(can("user", "rbac.matrix.view"), false);
  // ...but does hold the self-diagnostic grant.
  assert.equal(can("user", "rbac.self.view"), true);
});

test("admin cannot reach super_admin-only permissions", () => {
  assert.equal(can("admin", "admin.panel.access"), true);
  assert.equal(can("admin", "rbac.matrix.view"), false, "matrix is super_admin only");
  assert.equal(can("super_admin", "rbac.matrix.view"), true);
});

test("FAIL CLOSED: unknown/invalid/tampered role values grant nothing", () => {
  const hostile: unknown[] = [
    "superadmin", "SUPER_ADMIN", "super_admin ", " admin", "ADMIN", "root", "owner",
    "", null, undefined, 0, 1, true, false, {}, [], { role: "admin" },
    "user,admin", "admin;--", "*", "__proto__", "constructor", "toString",
  ];
  for (const role of hostile) {
    for (const p of PERMISSIONS) {
      assert.equal(can(role, p), false, `role ${JSON.stringify(role)} must not grant ${p}`);
    }
    assert.deepEqual(permissionsFor(role), [], `role ${JSON.stringify(role)} must have no permissions`);
  }
});

test("prototype-chain keys cannot be smuggled in as roles or permissions", () => {
  // ROLE_PERMISSIONS is a plain object; ensure inherited keys are not treated
  // as grants (can() must go through isAppRole, not a bare property read).
  assert.equal(can("toString", "rbac.self.view" as Permission), false);
  assert.equal(can("hasOwnProperty", "rbac.self.view" as Permission), false);
  assert.equal(isAppRole("__proto__"), false);
});

test("normalizeRole degrades unknown values to the LEAST privileged role", () => {
  assert.equal(normalizeRole("super_admin"), "super_admin");
  assert.equal(normalizeRole("admin"), "admin");
  assert.equal(normalizeRole("user"), "user");
  // Anything else — corrupt storage, a future role, a hostile claim — → 'user'.
  for (const bad of ["root", "SUPER_ADMIN", "", null, undefined, 42, {}]) {
    assert.equal(normalizeRole(bad), "user", `${JSON.stringify(bad)} must degrade to user`);
  }
});

test("every declared permission is granted to at least one role, and none is unknown", () => {
  const declared = new Set<string>(PERMISSIONS);
  const granted = new Set<string>();
  for (const role of APP_ROLES) {
    for (const p of ROLE_PERMISSIONS[role]) {
      assert.ok(declared.has(p), `${role} grants undeclared permission ${p}`);
      granted.add(p);
    }
  }
  for (const p of declared) assert.ok(granted.has(p), `permission ${p} is declared but never granted`);
});

test("the permission map covers every role explicitly (no implicit inheritance)", () => {
  for (const role of APP_ROLES) {
    assert.ok(Array.isArray(ROLE_PERMISSIONS[role satisfies AppRole]), `${role} missing from the map`);
  }
  assert.deepEqual(Object.keys(ROLE_PERMISSIONS).sort(), [...APP_ROLES].sort());
});
