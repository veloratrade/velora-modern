// ProvisioningStore — durable MetaAPI provisioning operations (OD-MP-1).
//
// THE PROBLEM THIS SOLVES
//   A provisioning request crosses a process boundary we do not control. Every
//   one of these can happen between "we called MetaAPI" and "we recorded the
//   result":
//     • the user double-clicks            • the browser retries
//     • the request times out             • two requests race
//     • the provider succeeds, the DB write fails
//     • the process crashes after the provider succeeded
//   In each case the provider may hold an account we do not know about.
//   Creating a second one would leave an orphan the user pays for.
//
//   The operation row is written BEFORE the provider call and updated after,
//   so an interrupted attempt always leaves a durable trace that can be
//   reconciled by marker instead of retried blindly.
//
// THIS TABLE CARRIES NO SECRET. operation_key and provider_marker are derived
// identifiers; transaction_id is the provider's documented polling identity.
// A broker password, investor password, ciphertext or token must never be
// written here (OD-MP-1 rule 6).
import type { QueryFn } from "../persistence/pg.js";

export type ProvisioningStatus =
  | "PENDING"
  | "ACCEPTED"
  | "COMPLETED"
  | "AMBIGUOUS"
  | "FAILED";

export interface ProvisioningOperation {
  readonly id: string;
  readonly userId: string;
  readonly accountId: string;
  readonly operationKey: string;
  readonly providerMarker: string;
  readonly transactionId: string | null;
  readonly status: ProvisioningStatus;
  readonly providerAccountId: string | null;
  readonly lastErrorCode: string | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProvisioningReserveInput {
  readonly userId: string;
  readonly accountId: string;
  readonly operationKey: string;
  readonly providerMarker: string;
  readonly transactionId: string;
  readonly now: Date;
}

export interface ProvisioningStore {
  /**
   * Reserve (or re-acquire) the operation for this key.
   *
   * Idempotent by construction: the (user_id, operation_key) UNIQUE constraint
   * means a concurrent second caller receives the EXISTING row rather than
   * creating a parallel operation. `created` tells the caller which it got —
   * only the creator may proceed straight to provisioning; a re-acquirer must
   * inspect `operation.status` first.
   */
  reserve(
    input: ProvisioningReserveInput,
  ): Promise<{ readonly operation: ProvisioningOperation; readonly created: boolean }>;

  /** Ownership-scoped lookup. Null when missing OR not owned. */
  findByKey(userId: string, operationKey: string): Promise<ProvisioningOperation | null>;

  /**
   * Record a status transition. `providerAccountId` and `lastErrorCode` are
   * only ever set, never cleared, so evidence of a provider outcome cannot be
   * erased by a later attempt.
   */
  markStatus(
    id: string,
    status: ProvisioningStatus,
    now: Date,
    fields?: {
      readonly providerAccountId?: string | undefined;
      readonly lastErrorCode?: string | undefined;
      readonly incrementAttempts?: boolean | undefined;
    },
    tx?: QueryFn,
  ): Promise<void>;
}
