// AdminUserService — Phase 3B-4 (administrative user management).
//
// AUTHORIZATION MODEL (OD-9, frozen in packages/contracts/src/rbac.ts):
//   Route-level `requirePermission` decides whether the caller may reach an
//   operation at all (users.view / users.manage_status / users.change_role).
//   This service enforces the ADDITIONAL relational rules that a permission
//   bit cannot express — rules about the actor/target PAIR. Both layers run;
//   neither replaces the other.
//
// The guards reproduce the SEMANTICS verified by source-reading the Legacy
// authorization model (api/src/Admin/UserManagementService.php, capability
// reference only — no code copied, no data read, nothing migrated):
//   1. self-action denied            -> SELF_ACTION_DENIED
//   2. unknown target                -> USER_NOT_FOUND (404)
//   3. admin may not touch a privileged target -> PRIVILEGED_TARGET
//   4. granting a privileged role requires super_admin
//                                    -> PRIVILEGE_ESCALATION_DENIED
//   5. invalid role/status value     -> INVALID_ROLE / INVALID_STATUS (400)
//
// NEVER LEAKS SECRETS: UserRecord carries passwordHash. Every value returned
// from this service goes through toAdminUser(), which builds a fresh object
// from an explicit field list, so a future column added to UserRecord cannot
// silently reach an API response.
import { normalizeRole, type AppRole } from "@velora/contracts";
import { AuthError } from "./authService.js";
import type { UserRecord, UserStore, AppRoleName } from "./userStore.js";

/** Account states (0007_user_status.sql; Legacy parity: enum('active','suspended')). */
export const USER_STATUSES = ["active", "suspended"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export function isUserStatus(v: unknown): v is UserStatus {
  return typeof v === "string" && (USER_STATUSES as readonly string[]).includes(v);
}

/** Roles that confer administrative authority. Demotion/promotion across this
 *  boundary is the privilege-granting act and is super_admin-only. */
export function isPrivilegedRole(role: string): boolean {
  return role === "admin" || role === "super_admin";
}

export const ADMIN_USER_PAGE_SIZE_DEFAULT = 25;
export const ADMIN_USER_PAGE_SIZE_MAX = 100;

/** The admin-facing projection of a user. Deliberately has NO passwordHash. */
export interface AdminUserView {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: AppRole;
  readonly status: string;
  readonly plan: string;
  readonly locale: "fa" | "en";
  readonly timezone: string;
  readonly emailVerifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Build the safe projection by explicit enumeration (allow-list, never a
 * spread-and-delete). Mirrors the Legacy userProjection column list, which
 * likewise excludes password_hash.
 */
export function toAdminUser(u: UserRecord): AdminUserView {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    role: normalizeRole(u.role),
    status: u.status,
    plan: u.plan,
    locale: u.locale,
    timezone: u.timezone,
    emailVerifiedAt: u.emailVerifiedAt,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export interface AdminUserServiceDeps {
  readonly store: UserStore;
  /** Injectable clock (service convention). */
  readonly now?: () => Date;
}

export interface ActorContext {
  readonly id: string;
  readonly role: AppRole;
}

export class AdminUserService {
  private readonly now: () => Date;

  constructor(private readonly deps: AdminUserServiceDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  /** Paginated listing. Caller must already hold users.view. */
  async listUsers(query: {
    search?: string;
    role?: string;
    status?: string;
    page?: number;
    perPage?: number;
  }): Promise<{
    items: readonly AdminUserView[];
    total: number;
    page: number;
    perPage: number;
  }> {
    if (query.role !== undefined && !isAppRoleName(query.role)) {
      throw new AuthError(400, "INVALID_ROLE", "Unknown role filter.", { role: query.role });
    }
    if (query.status !== undefined && !isUserStatus(query.status)) {
      throw new AuthError(400, "INVALID_STATUS", "Unknown status filter.", {
        status: query.status,
      });
    }
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const perPage = Math.min(
      ADMIN_USER_PAGE_SIZE_MAX,
      Math.max(1, Math.trunc(query.perPage ?? ADMIN_USER_PAGE_SIZE_DEFAULT)),
    );
    const { items, total } = await this.deps.store.listUsers({
      ...(query.search !== undefined ? { search: query.search } : {}),
      ...(query.role !== undefined ? { role: query.role } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      limit: perPage,
      offset: (page - 1) * perPage,
    });
    return { items: items.map(toAdminUser), total, page, perPage };
  }

  /** Single user. Caller must already hold users.view. */
  async getUser(userId: string): Promise<AdminUserView> {
    const user = await this.deps.store.findUserById(userId);
    if (user === null) throw notFound();
    return toAdminUser(user);
  }

  /**
   * Change a user's application role. Requires users.change_role
   * (super_admin only) at the route layer; the pair-rules are enforced here.
   *
   * Sessions of the target are revoked on a real change: the access token is a
   * stateless 15-minute JWT that embeds `role`, so revoking the refresh chain
   * is the existing mechanism that stops the old authority being renewed. No
   * new token semantics are invented (see the phase report, H4).
   */
  async setRole(
    targetId: string,
    newRole: string,
    actor: ActorContext,
  ): Promise<{ user: AdminUserView; sessionsRevoked: boolean }> {
    if (!isAppRoleName(newRole)) {
      throw new AuthError(400, "INVALID_ROLE", "Unknown role.", { role: newRole });
    }
    // Self-action first: a super_admin must not be able to demote themselves,
    // which is also the only single-actor path to locking out the last one.
    if (targetId === actor.id) {
      throw new AuthError(403, "SELF_ACTION_DENIED", "Changing your own role is not allowed.");
    }
    const target = await this.deps.store.findUserById(targetId);
    if (target === null) throw notFound();

    if (actor.role !== "super_admin" && isPrivilegedRole(target.role)) {
      throw new AuthError(403, "PRIVILEGED_TARGET", "Cannot modify a privileged user.");
    }
    if (isPrivilegedRole(newRole) && actor.role !== "super_admin") {
      throw new AuthError(
        403,
        "PRIVILEGE_ESCALATION_DENIED",
        "Only a super admin may grant admin-level roles.",
      );
    }

    // No-op: return current state without revoking sessions (a redundant call
    // must not log the target out).
    if (target.role === newRole) {
      return { user: toAdminUser(target), sessionsRevoked: false };
    }

    const now = this.now();
    const updated = await this.deps.store.updateUserRole(targetId, newRole, now);
    if (updated === null) throw notFound();
    await this.deps.store.revokeAllSessionsForUser(targetId, now);
    return { user: toAdminUser(updated), sessionsRevoked: true };
  }

  /**
   * Suspend or reactivate an account. Requires users.manage_status.
   *
   * Suspension is already load-bearing in the existing auth flow: login
   * (authService login) and refresh both reject status !== "active". Revoking
   * sessions here makes the suspension immediate rather than waiting for the
   * access token to expire.
   */
  async setStatus(
    targetId: string,
    newStatus: string,
    actor: ActorContext,
  ): Promise<{ user: AdminUserView; sessionsRevoked: boolean }> {
    if (!isUserStatus(newStatus)) {
      throw new AuthError(400, "INVALID_STATUS", "Unknown account status.", {
        status: newStatus,
      });
    }
    if (targetId === actor.id) {
      throw new AuthError(403, "SELF_ACTION_DENIED", "Action on your own account is not allowed.");
    }
    const target = await this.deps.store.findUserById(targetId);
    if (target === null) throw notFound();

    if (actor.role !== "super_admin" && isPrivilegedRole(target.role)) {
      throw new AuthError(403, "PRIVILEGED_TARGET", "Cannot modify a privileged user.");
    }
    if (target.status === newStatus) {
      return { user: toAdminUser(target), sessionsRevoked: false };
    }

    const now = this.now();
    const updated = await this.deps.store.updateUserStatus(targetId, newStatus, now);
    if (updated === null) throw notFound();

    // Reactivation must NOT revoke sessions (there are none to protect against);
    // suspension must, so the account stops being usable immediately.
    if (newStatus === "suspended") {
      await this.deps.store.revokeAllSessionsForUser(targetId, now);
      return { user: toAdminUser(updated), sessionsRevoked: true };
    }
    return { user: toAdminUser(updated), sessionsRevoked: false };
  }
}

function isAppRoleName(v: string): v is AppRoleName {
  return v === "user" || v === "admin" || v === "super_admin";
}

/** Uniform 404 for an unknown target (no distinction that could enumerate ids). */
function notFound(): AuthError {
  return new AuthError(404, "USER_NOT_FOUND", "User not found.");
}
