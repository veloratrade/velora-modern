// CredentialStore — the C-22 persistence port for encrypted third-party
// secrets. Narrow by design: create, list metadata, read one metadata row,
// reveal (explicit decrypt), delete. No provider client, no connection flow.
//
// THE CENTRAL TYPE RULE
//   `CredentialRecord` is METADATA ONLY. It has no field that can hold a
//   secret — not plaintext, not ciphertext, not the IV or tag. `list()` and
//   `findById()` return this type, so it is structurally impossible for a
//   routine read to leak a secret, even by mistake.
//
//   The decrypted value is returned ONLY by `reveal()`, whose name makes the
//   sensitive operation explicit at every call site, and which returns a bare
//   string rather than a record so it cannot be accidentally spread into a
//   response body alongside metadata.
//
// OWNERSHIP
//   Every method that touches a specific credential takes `userId` and scopes
//   on it. There is deliberately no "find by id" without an owner, so an
//   administrative caller cannot reach another user's secret through this port
//   at all — the capability simply does not exist. System Owner authority does
//   NOT override this: ownership is the only authorization rule here, and the
//   port exposes no by-id-without-owner method for authority to act through.
import type { QueryFn } from "../persistence/pg.js";

/** Providers whose credentials may be stored. Mirrors the 0010 CHECK. */
export type CredentialProvider = "METAAPI";

/**
 * Credential METADATA. Safe to return from a list/get operation and safe to
 * serialize: by construction it contains no secret, no ciphertext and no
 * crypto parameters.
 */
export interface CredentialRecord {
  readonly id: string;
  readonly userId: string;
  readonly provider: CredentialProvider;
  /** Which master key version protects this row (rotation visibility). */
  readonly keyVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Input for storing a credential. `secret` is plaintext IN MEMORY ONLY. */
export interface CredentialWrite {
  readonly userId: string;
  readonly provider: CredentialProvider;
  /** The plaintext secret. Encrypted before it reaches the database. */
  readonly secret: string;
  readonly now: Date;
}

/** Raised when a user already holds a credential for that provider. */
export class CredentialAlreadyExistsError extends Error {
  constructor() {
    super("A credential for this provider already exists.");
    this.name = "CredentialAlreadyExistsError";
  }
}

/**
 * A deferred audit write executed INSIDE the store's own transaction,
 * immediately after the credential mutation and before commit (the C-34
 * pgUserStore/pgTradeStore convention).
 *
 * It receives the affected credential's METADATA because the audit row needs
 * `credential_id` and `provider`. That matters most for DELETE: the row is hard
 * deleted, so its provider must be captured from the same statement that
 * removed it — reading it beforehand on another connection would be a race
 * (the row could change or vanish between the read and the delete).
 *
 * `record` is CredentialRecord, which by construction carries no secret,
 * ciphertext or crypto parameters, so an audit callback CANNOT be handed secret
 * material even by mistake.
 *
 * If this throws, the store MUST roll the mutation back.
 */
export type CredentialAuditWrite = (
  tx: QueryFn | undefined,
  record: CredentialRecord,
) => Promise<void>;

export interface CredentialStore {
  /**
   * Store a new encrypted credential. The store encrypts; the caller never
   * hands over ciphertext, so no caller can bypass encryption.
   *
   * Throws CredentialAlreadyExistsError on the (user, provider) uniqueness
   * violation, so replacing a credential is an explicit delete-then-create.
   *
   * `tx` enlists the write in an existing transaction (the C-34 /
   * pgTradeStore convention) so credential creation can participate in a
   * larger business mutation without a second transaction framework.
   */
  create(
    input: CredentialWrite,
    tx?: QueryFn,
    audit?: CredentialAuditWrite,
  ): Promise<CredentialRecord>;

  /** Metadata for every credential owned by this user. Never secrets. */
  list(userId: string): Promise<readonly CredentialRecord[]>;

  /** Metadata for one owned credential, or null. Never a secret. */
  findById(id: string, userId: string): Promise<CredentialRecord | null>;

  /**
   * Decrypt and return the plaintext secret for an OWNED credential.
   *
   * Explicitly named: every call site reads as a sensitive operation. Returns
   * null when the credential does not exist OR is not owned by `userId` — the
   * two are indistinguishable, matching the non-disclosing 404 posture used by
   * trades and accounts.
   *
   * The caller must never log, echo, or return this value over HTTP.
   */
  reveal(id: string, userId: string): Promise<string | null>;

  /**
   * Permanently delete an OWNED credential (revocation). Returns true when a
   * row was removed. A hard delete is deliberate: keeping recoverable
   * ciphertext after a user revokes a secret would be the less safe choice.
   */
  delete(
    id: string,
    userId: string,
    tx?: QueryFn,
    audit?: CredentialAuditWrite,
  ): Promise<boolean>;
}
