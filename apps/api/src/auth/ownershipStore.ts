// OwnershipStore — installation-level System Owner state (singleton).
//
// This is deliberately a SEPARATE port from UserStore: ownership is
// installation governance state, not a user attribute. Keeping it separate
// means no ordinary user-management code path can reach it by accident.
//
// The port intentionally exposes NO update and NO delete. Ownership transfer,
// ownership deletion and successor selection are out of scope by product
// decision, and an absent method cannot be called by mistake.

/** The installation ownership record. At most one exists, ever. */
export interface OwnershipRecord {
  readonly ownerUserId: string;
  readonly claimedByUserId: string;
  readonly claimedAt: string;
  readonly claimedIp: string | null;
  readonly claimedUserAgent: string | null;
}

/**
 * Raised when a claim is attempted while ownership already exists.
 *
 * Adapters MUST map the database's unique-violation to this error rather than
 * relying on a prior read: the read-then-write sequence is racy, and the
 * singleton constraint is the real guarantee.
 */
export class OwnershipAlreadyClaimedError extends Error {
  constructor() {
    super("Installation ownership has already been claimed.");
    this.name = "OwnershipAlreadyClaimedError";
  }
}

export interface OwnershipStore {
  /** The current ownership record, or null when ownership is unclaimed. */
  getOwnership(): Promise<OwnershipRecord | null>;

  /**
   * Claim ownership. Succeeds at most once for the lifetime of the
   * installation; every later call throws OwnershipAlreadyClaimedError,
   * including under concurrent execution.
   */
  claimOwnership(input: {
    ownerUserId: string;
    claimedByUserId: string;
    claimedIp: string | null;
    claimedUserAgent: string | null;
    now: Date;
  }): Promise<OwnershipRecord>;
}
