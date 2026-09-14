// AuditStore — append-only security audit trail port (C-34).
//
// Deliberately tiny. This is NOT an event bus, NOT a logging framework and NOT
// a replacement for the trade ledger (ADR-002): nothing folds or replays these
// records to derive state. It exists so that privileged actions which already
// happen in this application leave an attributable trail.
//
// The port intentionally exposes NO update and NO delete. An absent method
// cannot be called by mistake, so the application layer cannot rewrite history
// even if a future caller wanted to. The database enforces the same rule
// independently (db/roles.sql REVOKEs UPDATE/DELETE/TRUNCATE).
//
// SECURITY: an AuditEntry NEVER carries a password, password hash, raw or
// hashed token, refresh token, API key or Authorization header. `beforeState`
// and `afterState` hold low-cardinality lifecycle values only (a role name or
// an account status).

import type { QueryFn } from "../persistence/pg.js";

/**
 * A transaction handle: the QueryFn of an ALREADY-OPEN database transaction
 * (persistence/pg.ts withTransaction). Passing it makes the audit INSERT part
 * of that transaction, so the audit row and the business mutation commit or
 * roll back together. Adapters that have no database ignore it.
 */
export type AuditTx = QueryFn;

/**
 * A deferred audit write handed to a store so it can be executed INSIDE the
 * store's own transaction, immediately after the business mutation and before
 * commit. The store passes its transaction handle (or undefined when it has no
 * database). If this throws, the store MUST roll the mutation back.
 *
 * This is the same shape as the existing mutation+event convention in
 * pgTradeStore.createTrade(record, event): the store owns atomicity, the caller
 * owns the content of the record.
 */
export type AuditWrite = (tx: AuditTx | undefined) => Promise<void>;

/** Actions recorded by this phase. Mirrors the 0009 CHECK constraint. */
export type AuditAction =
  | "OWNERSHIP_CLAIMED"
  | "USER_ROLE_CHANGED"
  | "USER_STATUS_CHANGED";

/** A single append-only audit record as written by the application. */
export interface AuditEntry {
  readonly action: AuditAction;
  /**
   * Server-derived authenticated actor (authority.sub). NEVER a value taken
   * from a request body, header or query parameter.
   */
  readonly actorUserId: string;
  /** Account the action was performed against, when one applies. */
  readonly targetUserId: string | null;
  /** Prior lifecycle value (role/status), or null when there is none. */
  readonly beforeState: string | null;
  /** Resulting lifecycle value (role/status), or null when not applicable. */
  readonly afterState: string | null;
  /** Correlation id from the per-request security context, when available. */
  readonly requestId: string | null;
  readonly occurredAt: Date;
}

/** A persisted audit record (read back for verification/tests only). */
export interface AuditRecord {
  readonly id: string;
  readonly action: AuditAction;
  readonly actorUserId: string;
  readonly targetUserId: string | null;
  readonly beforeState: string | null;
  readonly afterState: string | null;
  readonly outcome: "success";
  readonly requestId: string | null;
  readonly occurredAt: string;
}

export interface AuditStore {
  /**
   * Append one record. Only SUCCESSFUL privileged actions are appended: a
   * rejected mutation never reaches this call.
   *
   * Errors PROPAGATE deliberately. There is no catch-and-ignore here: a caller
   * that has already committed its mutation must not be able to claim an audit
   * record exists when it does not.
   */
  append(entry: AuditEntry, tx?: AuditTx): Promise<AuditRecord>;

  /**
   * Read the trail newest-first. Not exposed through any HTTP route in this
   * phase — it exists so tests can verify what was written. No admin audit API
   * or UI is built here.
   */
  list(): Promise<readonly AuditRecord[]>;
}
