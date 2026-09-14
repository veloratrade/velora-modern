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
import type { AuditStore, AuditEntry, AuditTx } from "./auditStore.js";

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
  /**
   * Resolves the installation's System Owner user id from authoritative
   * storage (installation_ownership), or null when ownership is unclaimed.
   *
   * REQUIRED, deliberately. Owner immutability is enforced in this service, so
   * a construction site that omitted the resolver would silently lose that
   * protection with no runtime signal. Making it mandatory turns that mistake
   * into a COMPILE-TIME error (TS2741) instead. There is intentionally no
   * default and no fallback: a resolver that cannot be supplied must be written
   * out explicitly as `async () => null` by a caller that has genuinely no
   * ownership capability. It is NEVER derived from a token, header or body.
   */
  readonly getSystemOwnerUserId: () => Promise<string | null>;
  /**
   * Append-only security audit trail (C-34).
   *
   * REQUIRED, deliberately — same rule as getSystemOwnerUserId. A construction
   * site that omitted it would silently stop recording privileged role/status
   * changes with no runtime signal; making it mandatory turns that into a
   * COMPILE-TIME error instead. A caller that genuinely has no audit capability
   * must say so explicitly by passing a MemoryAuditStore.
   *
   * Append errors PROPAGATE (see setRole/setStatus): the audit write is part of
   * the operation, not best-effort telemetry.
   */
  readonly audit: AuditStore;
}

export interface ActorContext {
  readonly id: string;
  readonly role: AppRole;
  /**
   * Whether this actor is the installation System Owner. Resolved server-side
   * from storage by the caller; never from a client-supplied value.
   */
  readonly isSystemOwner?: boolean;
  /**
   * Correlation id from the per-request security context (kernel/security.ts),
   * recorded on audit entries. Optional: service-level callers without an HTTP
   * request have none. It is metadata only — it never affects authorization,
   * and like every other field here it is supplied by the server, not the
   * client.
   */
  readonly requestId?: string;
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

    // OWNER IMMUTABILITY — checked before every other target rule so that NO
    // ordinary actor (admin, super_admin, or even the owner themselves through
    // this surface) can suspend, demote or otherwise disable the System Owner.
    // Resolved from authoritative storage, never from a client value.
    await this.assertNotSystemOwner(targetId);

    if (!hasSuperAuthority(actor) && isPrivilegedRole(target.role)) {
      throw new AuthError(403, "PRIVILEGED_TARGET", "Cannot modify a privileged user.");
    }
    // PEER PROTECTION: super admins are peers, with no hierarchy between them.
    // One super admin may never demote another through normal user management.
    if (target.role === "super_admin") {
      throw new AuthError(
        403,
        "SUPER_ADMIN_PEER_PROTECTED",
        "A super admin cannot modify another super admin.",
      );
    }
    if (isPrivilegedRole(newRole) && !hasSuperAuthority(actor)) {
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

    // LAST-ACTIVE-SUPER-ADMIN INVARIANT (independent of peer protection).
    // Demoting an active super admin must never leave zero active super admins.
    // Evaluated on ACTIVE accounts only, excluding the target itself.
    await this.assertSuperAdminRemains(target, newRole !== "super_admin");

    const now = this.now();
    const previousRole = target.role; // captured BEFORE the mutation
    // C-34: the audit row is written by the STORE, inside the same transaction
    // as the UPDATE. Only a SUCCESSFUL change is recorded — every rejection
    // above threw before reaching this point. The actor is the server-derived
    // authenticated identity, never a client-supplied id. Errors propagate
    // deliberately (no catch-and-ignore): if the audit write fails the role
    // change rolls back rather than committing without a trail.
    const updated = await this.deps.store.updateUserRole(targetId, newRole, now, (tx) =>
      this.recordAudit(tx, {
        action: "USER_ROLE_CHANGED",
        actorUserId: actor.id,
        targetUserId: targetId,
        beforeState: previousRole,
        afterState: newRole,
        requestId: actor.requestId ?? null,
        occurredAt: now,
      }),
    );
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

    // OWNER IMMUTABILITY — checked before every other target rule so that NO
    // ordinary actor (admin, super_admin, or even the owner themselves through
    // this surface) can suspend, demote or otherwise disable the System Owner.
    // Resolved from authoritative storage, never from a client value.
    await this.assertNotSystemOwner(targetId);

    if (!hasSuperAuthority(actor) && isPrivilegedRole(target.role)) {
      throw new AuthError(403, "PRIVILEGED_TARGET", "Cannot modify a privileged user.");
    }
    // PEER PROTECTION: one super admin may never suspend another.
    if (target.role === "super_admin") {
      throw new AuthError(
        403,
        "SUPER_ADMIN_PEER_PROTECTED",
        "A super admin cannot modify another super admin.",
      );
    }
    if (target.status === newStatus) {
      return { user: toAdminUser(target), sessionsRevoked: false };
    }

    // LAST-ACTIVE-SUPER-ADMIN INVARIANT: suspending an active super admin must
    // never leave zero active super admins.
    await this.assertSuperAdminRemains(target, newStatus !== "active");

    const now = this.now();
    const previousStatus = target.status; // captured BEFORE the mutation
    // C-34: successful status changes only (rejections threw above), written
    // transactionally by the store together with the UPDATE.
    const updated = await this.deps.store.updateUserStatus(targetId, newStatus, now, (tx) =>
      this.recordAudit(tx, {
        action: "USER_STATUS_CHANGED",
        actorUserId: actor.id,
        targetUserId: targetId,
        beforeState: previousStatus,
        afterState: newStatus,
        requestId: actor.requestId ?? null,
        occurredAt: now,
      }),
    );
    if (updated === null) throw notFound();

    // Reactivation must NOT revoke sessions (there are none to protect against);
    // suspension must, so the account stops being usable immediately.
    if (newStatus === "suspended") {
      await this.deps.store.revokeAllSessionsForUser(targetId, now);
      return { user: toAdminUser(updated), sessionsRevoked: true };
    }
    return { user: toAdminUser(updated), sessionsRevoked: false };
  }

  /**
   * Append one audit record, enlisted in the caller's transaction when the
   * store provides one. Errors are NOT caught: the store rolls the mutation
   * back, which is the whole point of writing it here.
   */
  private async recordAudit(tx: AuditTx | undefined, entry: AuditEntry): Promise<void> {
    await this.deps.audit.append(entry, tx);
  }

  /**
   * Reject any ordinary user-management mutation whose TARGET is the System
   * Owner.
   *
   * The owner's stored RBAC role is ordinarily `admin`, so neither
   * PRIVILEGED_TARGET nor the super-admin peer rule would protect them: without
   * this guard a super_admin could suspend the owner and leave an installation
   * whose owner cannot authenticate (the ownership row would survive, because
   * ON DELETE RESTRICT protects row deletion only, not account state).
   *
   * Enforced at the SERVICE layer, which is the single chokepoint: both
   * updateUserRole and updateUserStatus have exactly one caller each, and both
   * are in this class (verified by route audit).
   */
  private async assertNotSystemOwner(targetId: string): Promise<void> {
    const ownerId = await this.deps.getSystemOwnerUserId();
    if (ownerId !== null && ownerId === targetId) {
      throw new AuthError(
        403,
        "SYSTEM_OWNER_PROTECTED",
        "The system owner cannot be modified through user management.",
      );
    }
  }

  /**
   * Enforce "the installation always retains at least one ACTIVE super admin".
   *
   * Deliberately separate from peer protection: peer protection is about WHO
   * may act on whom, this is a system-wide invariant that must hold no matter
   * who acts — including when the actor is the target, and including any future
   * caller that bypasses the peer rule. Counting active accounts only is
   * essential: a suspended super_admin cannot authenticate, so counting by role
   * alone could leave the installation with no usable administrator.
   */
  private async assertSuperAdminRemains(
    target: UserRecord,
    losesActiveSuperAdmin: boolean,
  ): Promise<void> {
    if (!losesActiveSuperAdmin) return;
    if (target.role !== "super_admin" || target.status !== "active") return;
    const remaining = await this.deps.store.countActiveUsersByRole("super_admin", target.id);
    if (remaining === 0) {
      throw new AuthError(
        409,
        "LAST_SUPER_ADMIN",
        "The installation must retain at least one active super admin.",
      );
    }
  }
}

/**
 * Whether the actor wields at least super-admin authority.
 *
 * The System Owner is the highest application authority, so they satisfy this
 * even when their stored RBAC role is only `admin`. Without this, a guard
 * written as `actor.role !== "super_admin"` would silently exclude the owner —
 * exactly the "a future capability accidentally excludes the owner" failure
 * mode that ownership is modelled separately to avoid.
 *
 * This widens who may ACT. It never widens who may be acted UPON: owner
 * immutability, super-admin peer protection and the last-active-super-admin
 * invariant are all enforced independently and are unaffected.
 */
function hasSuperAuthority(actor: ActorContext): boolean {
  return actor.role === "super_admin" || actor.isSystemOwner === true;
}

function isAppRoleName(v: string): v is AppRoleName {
  return v === "user" || v === "admin" || v === "super_admin";
}

/** Uniform 404 for an unknown target (no distinction that could enumerate ids). */
function notFound(): AuthError {
  return new AuthError(404, "USER_NOT_FOUND", "User not found.");
}
