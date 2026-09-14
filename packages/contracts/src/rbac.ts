// Application RBAC contract — Phase 3B-3 (owner decision OD-9, FROZEN).
//
// SCOPE BOUNDARY (read this before touching anything here):
//   These are APPLICATION roles, held by rows in `users.role`. They are NOT the
//   PostgreSQL identities from ADR-010 (velora_owner, velora_migrator,
//   app_readwrite, velora_worker, velora_readonly), which are connection /
//   ownership identities defined in db/roles.sql. A `super_admin` application
//   user gains NO database privilege of any kind. The two models never meet.
//
// DESIGN — explicit enumeration, NOT implicit inheritance.
//   Verified against the Legacy authorization model (api/src/Auth/Role.php,
//   source-read 2026-09-14, capability reference only — no code copied, no
//   data read): `can()` is a flat `in_array(permission, map[role] ?? [])`
//   lookup. There is no inheritance operator; `super_admin` redeclares every
//   admin permission explicitly (admin = 18, super_admin = 24, admin minus
//   super_admin = empty set). The `?? []` fallback fails closed for unknown
//   roles.
//
//   We reproduce those SEMANTICS (not the code): every grant is written out, so
//   the full authority of a role is auditable in one table and a permission can
//   never be acquired by accident through a hierarchy rule. The recommended
//   ordering super_admin >= admin >= user therefore holds as a PROVEN PROPERTY
//   (asserted in rbac.test.ts) rather than as an implicit runtime rule.
//
// Frontend hiding is NOT authorization; plan/subscription NEVER authorizes
// (plan drives quota only — see entitlementService).

/** The three frozen application roles (OD-9). Order is least → most privileged. */
export const APP_ROLES = ["user", "admin", "super_admin"] as const;
export type AppRole = (typeof APP_ROLES)[number];

/**
 * Permissions with a REAL operation to guard in this phase.
 *
 * Deliberately minimal. The Legacy model enumerates 24 permissions, but most
 * name capabilities that are deferred in Modern (AI, billing, integrations,
 * support, feature flags) or belong to Phase 3B-4 (user management). Declaring
 * grants for operations that do not exist would fabricate an authorization
 * surface and invite false confidence, so the deferred vocabulary is recorded
 * in the phase report instead of being enforced here.
 */
export const PERMISSIONS = [
  /** Read the caller's own effective role + permission set (diagnostic). */
  "rbac.self.view",
  /** Read-only administrative visibility that the panel entry point requires. */
  "admin.panel.access",
  /** Super-admin-only: inspect the effective authority of ANY role. */
  "rbac.matrix.view",

  // --- Phase 3B-4 (user management). Each one guards a REAL endpoint. ---
  /** List/inspect user accounts through the admin surface (never secrets). */
  "users.view",
  /** Suspend or reactivate an account (users.status). */
  "users.manage_status",
  /**
   * Change another user's application role.
   *
   * SUPER-ADMIN ONLY, matching the Legacy authorization model where
   * users.change_role is one of the six super_admin-exclusive permissions
   * (source-read of api/src/Auth/Role.php, capability reference only). Role
   * assignment is the privilege-granting operation, so it is deliberately NOT
   * delegated to `admin`.
   */
  "users.change_role",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * The explicit permission map. Every grant is listed for every role.
 * A role absent from this map, or an unknown role string, has NO permissions.
 */
export const ROLE_PERMISSIONS: Readonly<Record<AppRole, readonly Permission[]>> = {
  // A normal user holds ZERO administrative permissions (Legacy: `user => []`).
  // Ownership of their own resources is a separate mechanism and is unaffected.
  user: ["rbac.self.view"],
  admin: ["rbac.self.view", "admin.panel.access", "users.view", "users.manage_status"],
  super_admin: [
    "rbac.self.view",
    "admin.panel.access",
    "rbac.matrix.view",
    "users.view",
    "users.manage_status",
    // The one user-management permission an `admin` must NOT hold.
    "users.change_role",
  ],
};

/** True when `value` is one of the three frozen roles. Fails closed. */
export function isAppRole(value: unknown): value is AppRole {
  return typeof value === "string" && (APP_ROLES as readonly string[]).includes(value);
}

/**
 * Server-side authorization predicate.
 *
 * Fails closed on EVERY unrecognised input: an unknown role, a tampered value,
 * `undefined`, `null`, or a non-string all yield false. There is no wildcard,
 * no "allow by default", and no inheritance fallthrough.
 */
export function can(role: unknown, permission: Permission): boolean {
  if (!isAppRole(role)) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** The effective permission set of a role ([] for anything unrecognised). */
export function permissionsFor(role: unknown): readonly Permission[] {
  return isAppRole(role) ? ROLE_PERMISSIONS[role] : [];
}

/**
 * Authorization context: ordinary RBAC role PLUS installation ownership.
 *
 * `isSystemOwner` MUST be resolved server-side from the installation ownership
 * record (installation_ownership, migration 0008) keyed by the authenticated
 * subject. It must NEVER be read from a token claim, a header, a query
 * parameter or a request body: a JWT saying `systemOwner=true` is not evidence,
 * and a JWT saying `role=super_admin` is not evidence when storage disagrees.
 */
export interface AuthorityContext {
  readonly role: AppRole;
  readonly isSystemOwner: boolean;
}

/**
 * The authorization predicate used by administrative operations.
 *
 * SYSTEM OWNER IS THE HIGHEST APPLICATION AUTHORITY. Ownership is not an RBAC
 * role and is not enumerated in ROLE_PERMISSIONS; instead the owner satisfies
 * EVERY permission, including permissions that do not exist yet. That is
 * deliberate and is the whole point of modelling ownership separately: a new
 * capability added in a future phase cannot accidentally exclude the owner
 * because their stored role happens to be `admin`, and no hardcoded
 * owner-permission list can drift out of date.
 *
 * SCOPE OF "FULL AUTHORITY" — this grants the highest APPLICATION authority.
 * It is NOT a bypass of anything else:
 *   - authentication still applies (an unauthenticated caller has no context);
 *   - per-user data ownership (IDOR) boundaries are a separate mechanism and
 *     are NOT affected — owner does not gain access to another user's rows;
 *   - system safety invariants (e.g. the last-active-super-admin rule) are not
 *     waived merely because the caller is the owner;
 *   - PostgreSQL identities (ADR-010) are untouched — an owner gains no
 *     database privilege whatsoever.
 */
export function canAct(ctx: AuthorityContext | null | undefined, permission: Permission): boolean {
  if (ctx === null || ctx === undefined) return false;
  if (ctx.isSystemOwner) return true; // highest authority, present and future
  return can(ctx.role, permission);
}

/**
 * Effective permissions for an authority context: the complete permission set
 * for the system owner, otherwise the role's enumerated grants.
 */
export function authorityPermissions(ctx: AuthorityContext): readonly Permission[] {
  return ctx.isSystemOwner ? PERMISSIONS : permissionsFor(ctx.role);
}

/**
 * Normalize a role value arriving from storage or a verified token.
 *
 * Anything unrecognised degrades to the LEAST privileged role rather than
 * throwing, so a corrupt or future-dated value can never escalate. Callers
 * that must distinguish "absent" from "invalid" should use isAppRole first.
 */
export function normalizeRole(value: unknown): AppRole {
  return isAppRole(value) ? value : "user";
}
