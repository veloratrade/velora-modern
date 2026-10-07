// Phase 3B-3 — application RBAC contract tests (OD-9).
//
// Pure-contract evidence: the permission map itself, hierarchy as a PROVEN
// property, and fail-closed behaviour on every unrecognised input.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APP_ROLES, PERMISSIONS, ROLE_PERMISSIONS,
  can, isAppRole, permissionsFor, normalizeRole,
  canAct, authorityPermissions,
  type AppRole, type Permission, type AuthorityContext,
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

// --- Phase 3B-4 additions: user-management permissions -----------------------

test("3B-4: user management permissions are granted to exactly the right roles", () => {
  // A plain user holds NO user-management authority of any kind.
  assert.equal(can("user", "users.view"), false);
  assert.equal(can("user", "users.manage_status"), false);
  assert.equal(can("user", "users.change_role"), false);

  // An admin may see and suspend, but may NOT assign roles.
  assert.equal(can("admin", "users.view"), true);
  assert.equal(can("admin", "users.manage_status"), true);
  assert.equal(can("admin", "users.change_role"), false);

  // A super_admin holds all three.
  assert.equal(can("super_admin", "users.view"), true);
  assert.equal(can("super_admin", "users.manage_status"), true);
  assert.equal(can("super_admin", "users.change_role"), true);
});

test("3B-4: users.change_role is the super_admin-exclusive permission", () => {
  const adminOnly = ROLE_PERMISSIONS.super_admin.filter(
    (p) => !ROLE_PERMISSIONS.admin.includes(p),
  );
  assert.ok(adminOnly.includes("users.change_role"));
  // The role ordering property still holds after the 3B-4 additions:
  // every admin grant is still a super_admin grant.
  for (const p of ROLE_PERMISSIONS.admin) {
    assert.ok(ROLE_PERMISSIONS.super_admin.includes(p), `super_admin must retain ${p}`);
  }
  for (const p of ROLE_PERMISSIONS.user) {
    assert.ok(ROLE_PERMISSIONS.admin.includes(p), `admin must retain ${p}`);
  }
});

test("3B-4: the new permissions still fail closed for unknown roles", () => {
  for (const p of ["users.view", "users.manage_status", "users.change_role"] as const) {
    assert.equal(can("root", p), false);
    assert.equal(can(undefined, p), false);
    assert.equal(can(null, p), false);
    assert.equal(can("", p), false);
  }
});

// --- System Owner: highest application authority ------------------------------

test("owner authority: the System Owner satisfies every permission", () => {
  const owner: AuthorityContext = { role: "admin", isSystemOwner: true };
  for (const p of PERMISSIONS) assert.equal(canAct(owner, p), true);
  assert.deepEqual([...authorityPermissions(owner)], [...PERMISSIONS]);
});

test("owner authority: ownership is orthogonal to the RBAC role", () => {
  // Ownership is NOT a role: APP_ROLES stays exactly three values, and
  // 'system_owner' is not among them.
  assert.deepEqual(APP_ROLES, ["user", "admin", "super_admin"]);
  assert.equal(isAppRole("system_owner"), false);
  assert.equal(normalizeRole("system_owner"), "user");
});

test("owner authority: non-owners are evaluated by ordinary RBAC, unchanged", () => {
  for (const role of APP_ROLES) {
    const ctx: AuthorityContext = { role, isSystemOwner: false };
    for (const p of PERMISSIONS) assert.equal(canAct(ctx, p), can(role, p));
    assert.deepEqual([...authorityPermissions(ctx)], [...permissionsFor(role)]);
  }
});

test("owner authority: fails closed for a missing context", () => {
  for (const p of PERMISSIONS) {
    assert.equal(canAct(null, p), false);
    assert.equal(canAct(undefined, p), false);
  }
});

test("owner authority: a permission that does not exist yet still resolves for the owner", () => {
  const future = "some.future.capability" as unknown as Permission;
  assert.equal(canAct({ role: "admin", isSystemOwner: true }, future), true);
  assert.equal(canAct({ role: "super_admin", isSystemOwner: false }, future), false);
});

// ── AC-34 (MG-RBAC-VOCAB): the Legacy-24 → Modern vocabulary reconciliation ──
// Source of truth for the legacy side: api/src/Auth/Role.php @edede31
// (READ-ONLY source-read 2026-10-06). These tests PIN the reconciliation so a
// future permission cannot appear/disappear silently:
//   - the 10 legacy names carried over VERBATIM exist and are granted
//   - users.suspend + users.activate are deliberately MERGED into
//     users.manage_status (one status-mutation operation, documented)
//   - communication.view/reply are the support.tickets.* pair (Phase 5 rename)
//   - of Legacy's six super-admin-exclusive permissions, exactly the four
//     whose operations exist today are landed — and landed SA-ONLY; the other
//     two (system.settings.manage, feature_flags.edit)
//     must NOT exist until their operations do (no fabricated surface)
//   - the two settings permissions were DEAD IN LEGACY (declared, zero
//     enforcement points) and stay unported
test("AC-34: the ten verbatim legacy permissions exist in Modern", () => {
  // Phase 8 added integrations.view/manage as the 11th/12th verbatim names.
  // Phase 9 adds the remaining platform verbatim names (settings, feature_flags, logs, billing) → 18.
  const verbatim = [
    "overview.view",
    "users.view",
    "users.change_role",
    "users.verify_email",
    "audit.view",
    "audit.view_sensitive",
    "system.health.view",
    "analytics.view",
    "aiManage",
    "aiRouteManage",
    "integrations.view",
    "integrations.manage",
    "settings.view",
    "system.settings.manage",
    "feature_flags.view",
    "feature_flags.edit",
    "system.logs.view",
    "billing.view",
  ] as const;
  for (const name of verbatim) {
    assert.ok((PERMISSIONS as readonly string[]).includes(name), `missing verbatim: ${name}`);
  }
});

test("AC-34: users.suspend/activate are merged into users.manage_status", () => {
  assert.ok((PERMISSIONS as readonly string[]).includes("users.manage_status"));
  // the merged operation is the ONLY status permission; legacy granted both
  // halves to admin AND super_admin, so the merge must be granted to both too
  assert.ok(ROLE_PERMISSIONS.admin.includes("users.manage_status"));
  assert.ok(ROLE_PERMISSIONS.super_admin.includes("users.manage_status"));
});

test("AC-34: communication.view/reply live on as support.tickets.* (Phase 5 rename)", () => {
  assert.ok((PERMISSIONS as readonly string[]).includes("support.tickets.view"));
  assert.ok((PERMISSIONS as readonly string[]).includes("support.tickets.manage"));
  // legacy granted communication.* to admin AND super_admin (Role.php 107-108)
  assert.ok(ROLE_PERMISSIONS.admin.includes("support.tickets.view"));
  assert.ok(ROLE_PERMISSIONS.admin.includes("support.tickets.manage"));
  assert.ok(ROLE_PERMISSIONS.super_admin.includes("support.tickets.view"));
  assert.ok(ROLE_PERMISSIONS.super_admin.includes("support.tickets.manage"));
});

test("AC-34: exactly the four landed SA-exclusive (phase 8: integrations.manage) legacy permissions exist, SA-only", () => {
  // Legacy SA-exclusive six (Role.php): users.change_role, audit.view_sensitive,
  // system.settings.manage, feature_flags.edit, integrations.manage, aiRouteManage.
  // Phase 9 lands the remaining two (system.settings.manage, feature_flags.edit), so 6 of 6 are now present.
  const landedSA = ["users.change_role", "audit.view_sensitive", "aiRouteManage", "integrations.manage", "system.settings.manage", "feature_flags.edit"] as const;
  for (const p of landedSA) {
    assert.ok((PERMISSIONS as readonly string[]).includes(p), `${p} should be landed`);
    assert.ok(!ROLE_PERMISSIONS.admin.includes(p), `${p} must stay super_admin-only`);
    assert.ok(ROLE_PERMISSIONS.super_admin.includes(p));
  }
});

test("AC-34: dead-in-legacy permissions stay unported (settings.* had zero enforcement points)", () => {
  // Role.php declared P_SETTINGS_VIEW + P_SETTINGS_MANAGE as "reserved (Module
  // K)" — phase 9 now implements the strict-allowlist store, so they are no
  // longer dead. Same for logs/billing/flags (landed in phase 9).
  const unported = [
    "users.create",             // OD-gated (admin create-user policy)
    "users.manage_subscription",// OD-AC-SUBMAP
  ] as const;
  for (const p of unported) {
    assert.ok(!(PERMISSIONS as readonly string[]).includes(p), `${p} must not be declared yet`);
  }
  // the platform permissions landed in phase 9 must now exist
  for (const p of ["settings.view", "system.settings.manage", "feature_flags.view", "feature_flags.edit", "system.logs.view", "billing.view"] as const) {
    assert.ok((PERMISSIONS as readonly string[]).includes(p), `${p} must be declared after phase 9`);
  }
});

test("AC-34: legacy grant parity for every landed permission (no widening)", () => {
  // Legacy Role.php grants, for the landed vocabulary (admin list lines 95-113
  // minus the unported names; super_admin redeclares everything). Phase 9 adds
  // the platform grants (settings, feature_flags, logs, billing) which legacy
  // also granted to admin (Role.php 105-110).
  const legacyAdmin = new Set([
    "overview.view", "users.view", "users.manage_status" /* suspend+activate */,
    "users.verify_email", "audit.view", "system.health.view", "analytics.view",
    "support.tickets.view", "support.tickets.manage", "aiManage", "integrations.view",
    "settings.view", "feature_flags.view", "system.logs.view", "billing.view",
  ]);
  const modernAdminOnly = ROLE_PERMISSIONS.admin.filter(
    (p) => !(legacyAdmin.has(p) || p === "rbac.self.view" || p === "admin.panel.access"),
  );
  assert.deepEqual(modernAdminOnly, [], "admin holds nothing legacy did not grant (except the two modern diagnostics)");
  // and everything legacy granted admin (that is landed) is granted:
  for (const p of legacyAdmin) {
    assert.ok(ROLE_PERMISSIONS.admin.includes(p as Permission), `admin lost: ${p}`);
  }
});
