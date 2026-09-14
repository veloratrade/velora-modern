// OwnershipService — the one-time System Owner bootstrap.
//
// PRODUCT MODEL:
//   SYSTEM OWNER  >  SUPER ADMIN <-> SUPER ADMIN (peers)  >  ADMIN  >  USER
//
//   System Owner is INSTALLATION OWNERSHIP STATE, not an RBAC role. It is
//   established exactly once, during initial bootstrap, by an explicit action.
//   It is NOT granted by registration, by being the first row, by account
//   creation order, by email address, by plan, or by any client-supplied field.
//
// WHY THERE IS NO `system_owner.assign` PERMISSION:
//   Ownership must not be an ordinary RBAC promotion target. If a permission
//   existed that granted ownership, any holder could mint an owner. Instead the
//   ONLY way ownership is ever established is this bootstrap claim, and the
//   claim is permanently closed the instant it succeeds — enforced by a
//   single-row database constraint, not by an application convention.
//
// AFTER BOOTSTRAP every claim fails, regardless of the caller's role:
//   Admin -> System Owner        rejected
//   Super Admin -> System Owner  rejected
//   User -> System Owner         rejected
//
// DELIBERATELY NOT IMPLEMENTED (out of scope by product decision): ownership
// transfer, ownership deletion, successor selection, multiple owners, recovery
// or emergency owner, any database backdoor.
import type { PasswordHasher } from "@velora/domain";
import { AuthError } from "./authService.js";
import type { UserStore } from "./userStore.js";
import type { AuditStore } from "./auditStore.js";
import {
  type OwnershipRecord,
  type OwnershipStore,
  OwnershipAlreadyClaimedError,
} from "./ownershipStore.js";

/** Public view of ownership state. Exposes no user secrets. */
export interface OwnershipStatusView {
  readonly claimed: boolean;
  readonly ownerUserId: string | null;
  readonly claimedAt: string | null;
}

export interface OwnershipClaimView {
  readonly ownerUserId: string;
  readonly claimedAt: string;
}

export interface OwnershipServiceDeps {
  readonly ownership: OwnershipStore;
  readonly users: UserStore;
  readonly hasher: PasswordHasher;
  readonly now?: () => Date;
  /**
   * Append-only security audit trail (C-34). REQUIRED for the same reason as
   * the owner resolver elsewhere: an omitted store would silently stop
   * recording the single most privileged action in the system, with no runtime
   * signal. Append errors propagate — never swallowed.
   */
  readonly audit: AuditStore;
}

export class OwnershipService {
  private readonly now: () => Date;

  constructor(private readonly deps: OwnershipServiceDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  /** Whether ownership has been claimed. Safe to expose; carries no secret. */
  async status(): Promise<OwnershipStatusView> {
    const owned = await this.deps.ownership.getOwnership();
    return owned === null
      ? { claimed: false, ownerUserId: null, claimedAt: null }
      : { claimed: true, ownerUserId: owned.ownerUserId, claimedAt: owned.claimedAt };
  }

  /**
   * Claim System Ownership for the calling account. One-time, explicit,
   * server-side.
   *
   * Every precondition is re-derived from PERSISTED state — the caller's role
   * is read from the database, never from the JWT, so a stale or forged token
   * claiming an elevated role cannot influence the outcome. The `actorId` comes
   * from a signature-verified token subject and nothing else.
   *
   * Preconditions, in this order:
   *   1. ownership not already claimed        -> 409 OWNERSHIP_ALREADY_CLAIMED
   *   2. explicit confirmation phrase present -> 400 CONFIRMATION_REQUIRED
   *   3. acting account exists                -> 401 UNAUTHENTICATED
   *   4. STORED role is exactly 'admin'       -> 403 OWNERSHIP_CLAIM_FORBIDDEN
   *   5. account active + email verified      -> 403 OWNERSHIP_CLAIM_FORBIDDEN
   *   6. password re-authentication correct   -> 401 INVALID_CREDENTIALS
   *
   * Ordering note: the already-claimed check runs FIRST so that a post-bootstrap
   * attempt cannot be used as a password oracle against the acting account.
   */
  async claim(input: {
    actorId: string;
    password: string;
    confirm: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    /** Correlation id from the per-request security context (audit metadata). */
    requestId?: string | null;
  }): Promise<OwnershipClaimView> {
    // 1. Permanently closed after bootstrap, whatever the caller's role.
    const existing = await this.deps.ownership.getOwnership();
    if (existing !== null) throw alreadyClaimed();

    // 2. The action must be deliberate, never an accidental or replayed call.
    if (input.confirm !== OWNERSHIP_CLAIM_CONFIRMATION) {
      throw new AuthError(
        400,
        "CONFIRMATION_REQUIRED",
        "Explicit confirmation is required to claim system ownership.",
      );
    }

    // 3. Identity is resolved from storage, not from token claims.
    const actor = await this.deps.users.findUserById(input.actorId);
    if (actor === null) {
      throw new AuthError(401, "UNAUTHENTICATED", "Authentication required.");
    }

    // 4/5. Authority and account state come from the DATABASE row. A stale JWT
    // that still says super_admin, or a forged body field, changes nothing.
    // Bootstrap is reserved for the initial administrator: role must be exactly
    // 'admin'. A uniform error code avoids disclosing which precondition failed.
    const eligible =
      actor.role === "admin" && actor.status === "active" && actor.emailVerifiedAt !== null;
    if (!eligible) {
      throw new AuthError(
        403,
        "OWNERSHIP_CLAIM_FORBIDDEN",
        "This account may not claim system ownership.",
      );
    }

    // 6. Strong re-authentication using the EXISTING hasher (no new auth system).
    if (!(await this.deps.hasher.verify(input.password, actor.passwordHash))) {
      throw new AuthError(401, "INVALID_CREDENTIALS", "Invalid credentials.");
    }

    try {
      const now = this.now();
      // C-34: the audit row is written by the STORE, inside the same
      // transaction as the singleton INSERT. It is reached ONLY when that
      // INSERT succeeds, so a duplicate or racing claim (which throws and is
      // mapped to 409 below) can never produce a successful OWNERSHIP_CLAIMED
      // record. The actor is the re-authenticated server-side identity; this is
      // a self-claim, so the target is the same account. Errors propagate — if
      // the audit write fails the claim rolls back and ownership stays
      // unclaimed rather than committing with no trail.
      const claimed: OwnershipRecord = await this.deps.ownership.claimOwnership(
        {
          ownerUserId: actor.id,
          claimedByUserId: actor.id,
          claimedIp: input.ipAddress ?? null,
          claimedUserAgent: input.userAgent ?? null,
          now,
        },
        async (tx) => {
          await this.deps.audit.append(
            {
              action: "OWNERSHIP_CLAIMED",
              actorUserId: actor.id,
              targetUserId: actor.id, // self-claim: actor and new owner are the same account
              beforeState: null, // ownership was unclaimed: there is no prior state
              afterState: "claimed",
              requestId: input.requestId ?? null,
              occurredAt: now,
            },
            tx,
          );
        },
      );
      return { ownerUserId: claimed.ownerUserId, claimedAt: claimed.claimedAt };
    } catch (err: unknown) {
      // Lost a concurrent race: the database singleton rejected this INSERT.
      // Surfaces as the same 409 as the precondition check, so two simultaneous
      // claims can never both report success.
      if (err instanceof OwnershipAlreadyClaimedError) throw alreadyClaimed();
      throw err;
    }
  }
}

/** The exact phrase a claimant must send. Makes the action unambiguous. */
export const OWNERSHIP_CLAIM_CONFIRMATION = "CLAIM SYSTEM OWNERSHIP";

function alreadyClaimed(): AuthError {
  return new AuthError(
    409,
    "OWNERSHIP_ALREADY_CLAIMED",
    "System ownership has already been claimed for this installation.",
  );
}
