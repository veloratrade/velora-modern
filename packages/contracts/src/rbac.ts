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

  // --- Phase 5 (support). The capability Legacy named `communication.view` /
  // `communication.reply`. Both are granted to `admin` AND `super_admin` in
  // Legacy (api/src/Auth/Role.php: lines 107-108 for admin, 130-131 for
  // super_admin), which is why neither is super-admin-exclusive here.
  /** Read any user's support tickets (the support inbox). */
  "support.tickets.view",
  /** Reply to, close, reopen or archive a support ticket. */
  "support.tickets.manage",

  // --- Phase 6 (admin console). Every name below is a Legacy permission
  // identifier carried over VERBATIM from api/src/Auth/Role.php so the Modern
  // grant table can be diffed against Legacy's by name, not by interpretation.
  // The capability each one guards is implemented in the Phase 6 slice; the
  // Legacy permissions whose capability still has no Modern substrate (AI,
  // integrations, settings, feature flags, billing) are deliberately NOT
  // declared here — a permission with nothing to guard would be a fabricated
  // authorization surface (the same rule the earlier phases applied).
  /** The operator dashboard: platform-wide counts and their breakdowns. */
  "overview.view",
  /** Read-only platform analytics (users / trading) over a bounded range. */
  "analytics.view",
  /** Live system health: database, migrations, and the components that can
   *  actually be attested in this phase. */
  "system.health.view",
  /** Administrative audit trail and the platform-wide signup/login feeds. */
  "audit.view",
  /**
   * SUPER-ADMIN ONLY (Legacy: audit.view_sensitive is one of the six
   * super_admin-exclusive permissions). Gates the RAW network identity
   * (ip_address / user_agent) on every audit and security read: an `admin`
   * holds audit.view and sees the events with those fields OMITTED from the
   * response body; the System Owner and any super_admin receive them.
   */
  "audit.view_sensitive",
  /** Admin-triggered e-mail verification for a user who cannot complete it. */
  "users.verify_email",

  // --- Phase 7 (AI). Legacy names these two WITHOUT dots (`aiManage`,
  // `aiRouteManage`) because `ai.*` is its i18n namespace; the identifiers are
  // carried over verbatim so Role.php can be diffed by name. `admin` holds
  // aiManage (Legacy grants P_AI_MANAGE to admin); only super_admin holds
  // aiRouteManage, which is the privilege-adjacent half: choosing the route,
  // holding the secrets and spending money on a probe.
  /** Read the AI configuration, chains, flags, quotas and usage ledger. */
  "aiManage",
  /** Write the AI route/secrets/relay, and probe a provider. SUPER-ADMIN ONLY. */
  "aiRouteManage",

  // --- Phase 8 (integrations). Legacy Role.php P_INTEGRATIONS_VIEW (admin+SA)
  // and P_INTEGRATIONS_MANAGE (SA only). Read = inventory/status, Write =
  // put/delete/test (secret-bearing, upstream calls).
  /** View integration inventory and per-integration safe status (never secrets). */
  "integrations.view",
  /** Change, clear or test an integration (secret-bearing/upstream). SUPER-ADMIN ONLY. */
  "integrations.manage",

  // --- Phase 9 (admin platform). Legacy Role.php P_SETTINGS_VIEW (admin+SA),
  // P_SETTINGS_MANAGE as system.settings.manage (SA only), P_FEATURE_FLAGS_VIEW
  // (admin+SA), P_FEATURE_FLAGS_EDIT (SA only), P_SYSTEM_LOGS_VIEW (admin+SA),
  // P_BILLING_VIEW (admin+SA). Each guards a REAL admin route landed in 0032.
  /** Read platform settings (supervisory inventory, never secrets). */
  "settings.view",
  /** Change platform settings (strict allowlist, audited). SUPER-ADMIN ONLY. */
  "system.settings.manage",
  /** Read feature flags (closed vocabulary, server-authoritative). */
  "feature_flags.view",
  /** Change feature flag enabled/rollout (server-authoritative switches). SUPER-ADMIN ONLY. */
  "feature_flags.edit",
  /** Read system logs (append-only, redacted). */
  "system.logs.view",
  /** Read billing/subscription observability (honest, provider unavailable). */
  "billing.view",
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
  admin: [
    "rbac.self.view",
    "admin.panel.access",
    "users.view",
    "users.manage_status",
    "support.tickets.view",
    "support.tickets.manage",
    // Phase 6 — Legacy api/src/Auth/Role.php @edede31 grants every one of these
    // to `admin` (lines 95-113). Only users.change_role, audit.view_sensitive,
    // settings.manage, feature_flags.edit, integrations.manage and
    // ai.route_manage are super_admin-exclusive, and none of those is granted
    // here.
    "overview.view",
    "analytics.view",
    "system.health.view",
    "audit.view",
    "users.verify_email",
    // Phase 7 — Legacy grants P_AI_MANAGE to `admin` (Role.php), and withholds
    // P_AI_ROUTE_MANAGE for super_admin only.
    "aiManage",
    // Phase 8 — Legacy grants P_INTEGRATIONS_VIEW to admin (Role.php:107), and
    // P_INTEGRATIONS_MANAGE to super_admin only (Role.php:130).
    "integrations.view",
    // Phase 9 — Legacy grants P_SETTINGS_VIEW, P_FEATURE_FLAGS_VIEW,
    // P_SYSTEM_LOGS_VIEW and P_BILLING_VIEW to admin (Role.php).
    "settings.view",
    "feature_flags.view",
    "system.logs.view",
    "billing.view",
  ],
  super_admin: [
    "rbac.self.view",
    "admin.panel.access",
    "rbac.matrix.view",
    "users.view",
    "users.manage_status",
    // The one user-management permission an `admin` must NOT hold.
    "users.change_role",
    "support.tickets.view",
    "support.tickets.manage",
    "overview.view",
    "analytics.view",
    "system.health.view",
    "audit.view",
    // Super-admin-exclusive (Legacy Role.php line 118): the raw client address
    // on audit/security reads.
    "audit.view_sensitive",
    "users.verify_email",
    // Phase 7 — Legacy grants both AI permissions to super_admin, and
    // aiRouteManage to super_admin ONLY (Role.php: P_AI_ROUTE_MANAGE is one of the
    // six SA-exclusive permissions).
    "aiManage",
    "aiRouteManage",
    // Phase 8 — P_INTEGRATIONS_VIEW and P_INTEGRATIONS_MANAGE (SA only for manage)
    "integrations.view",
    "integrations.manage",
    // Phase 9 — admin grants plus the two SA-exclusive: system.settings.manage, feature_flags.edit
    "settings.view",
    "system.settings.manage",
    "feature_flags.view",
    "feature_flags.edit",
    "system.logs.view",
    "billing.view",
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
