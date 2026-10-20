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

/**
 * Every action this trail may hold, as DATA rather than as a type-only union.
 *
 * WHY AN ARRAY AND NOT JUST A UNION: `audit_log_action_check` in PostgreSQL is REPLACED by every
 * migration that needs a new action (a CHECK cannot be extended), and 0036 quietly lost two actions that
 * 0027 had added — the union kept them, the database refused them, and nothing noticed for three
 * migrations because no test wrote those rows. An enumerable vocabulary lets
 * `auditVocabulary.test.ts` compare this list against the last CHECK in `db/migrations/` on every run,
 * which turns "someone rewrote the constraint and dropped a name" from a production surprise into a red
 * test. Add an action HERE, in the SQL, and in that test's expectation — all three, or the build says so.
 *
 * The order is the historical one (0009 → 0041), so a reviewer can read the list as a changelog.
 */
export const AUDIT_ACTIONS = [
  // 0009 — the original three: ownership and account lifecycle.
  "OWNERSHIP_CLAIMED",
  "USER_ROLE_CHANGED",
  "USER_STATUS_CHANGED",
  // 0011 — B-2 credential lifecycle. Representable here; the CredentialService wiring is B-3.
  "CREDENTIAL_CREATED",
  "CREDENTIAL_DELETED",
  // 0014 — OD-MP-2. Authorized credential CONSUMPTION and binding lifecycle for MetaAPI provisioning.
  //
  // CREDENTIAL_REVEALED remains deliberately absent, and its absence now means something stronger than it
  // did in 0011: a production consumer exists, but it does not REVEAL anything. The plaintext is used
  // server-side against MetaAPI on the owning user's behalf and is never disclosed to any caller, so an
  // action named "revealed" would describe a capability the system does not have. OD-MP-2 selects
  // CREDENTIAL_USED for exactly that reason.
  "CREDENTIAL_USED",
  // Bind AND unbind. Direction is carried by beforeState/afterState rather than by two action names —
  // the same shape USER_ROLE_CHANGED already uses.
  "ACCOUNT_BINDING_CHANGED",
  // 0023 — Telegram journal client. Linking is an account-affecting privilege change and belongs in this
  // SAME trail; the widening rationale (six actions, and why a nonexistent token has no row at all) is
  // in 0023 §7.
  "TELEGRAM_LINK_STARTED",
  "TELEGRAM_LINK_COMPLETED",
  "TELEGRAM_LINK_FAILED",
  "TELEGRAM_UNLINKED",
  "TELEGRAM_CHANNEL_BOUND",
  "TELEGRAM_CHANNEL_UNBOUND",
  // 0027 — Phase 6 admin console. Both act on ANOTHER user's account without changing their role or
  // status, which is precisely the class of operation that would otherwise leave no trace at all: a
  // revoked session looks to the user like an unexplained logout, and an admin-granted verification is an
  // authorization grant. `beforeState`/`afterState` carry the direction (how many sessions were live) and
  // the prior verification state, so neither needs a second action name.
  //
  // These two are the pair 0036 dropped from the CHECK while keeping them here. Restored by 0040.
  "USER_SESSIONS_REVOKED",
  "USER_EMAIL_VERIFIED",
  // 0036 — the daily checklist's saved state: a record the user can revise, so an admin or support
  // change to it must not be invisible.
  "JOURNAL_CHECKLIST_SAVED",
  // 0040 — publishing is the one Telegram action that reaches past the user: it puts content in front of a
  // channel's subscribers using a token the PLATFORM holds. 0023 already audits the binding of that
  // channel for the same reason; the send itself had no row, so "who published what to the audience" was
  // answerable only from the outbox table, which records the post, not the authority that acted.
  // `afterState` carries `post:<id> message:<telegram message id>` — correlation, not a copy: the body and
  // its hash belong to 0037's row, and duplicating them here would only create a second truth.
  "TELEGRAM_POST_PUBLISHED",
  // 0041 — an operator pressing "validate" on a tool is not a config change, but it IS an action that
  // leaves the platform: it spends a provider request, and its verdict is what the panel then shows the
  // rest of the team. Without a row, "who decided this search key was fine, and when" is unanswerable —
  // and a stale green badge has no provenance. `afterState` carries `tool:<name> verdict:<ok|code>`.
  "AI_TOOL_VALIDATED",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Result of the audited attempt. Mirrors the 0011 outcome CHECK.
 *
 * `denied` exists for credential access, where the REFUSED attempt carries
 * more security signal than the successful one. Only AUTHENTICATED denials are
 * recordable: `actor_user_id` is NOT NULL, so an unattributable attempt has no
 * row to write.
 */
export type AuditOutcome = "success" | "denied";

/**
 * Providers that may appear on an audit record. Mirrors 0010/0011, widened by
 * 0023 to the second provider this platform actually talks to.
 *
 * Still a VOCABULARY, never a secret: what goes in the column is the provider's
 * name, not its credential.
 */
export type AuditProvider = "METAAPI" | "TELEGRAM";

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
  /**
   * Outcome of the attempt. OPTIONAL: omitted means `"success"`, which keeps
   * every existing call site correct without modification — the three
   * account-lifecycle events are only ever appended after the mutation
   * succeeded.
   */
  readonly outcome?: AuditOutcome;
  /**
   * B-2 credential metadata — OPTIONAL and METADATA ONLY.
   *
   * `credentialId` is a HISTORICAL identifier, not a live reference: it has no
   * foreign key because credential deletion is a hard delete and the trail must
   * outlive the credential (see migration 0011).
   *
   * SECURITY: these two fields are the ONLY credential-related data an audit
   * record may carry. A secret, ciphertext, master key, IV or auth tag must
   * NEVER be placed here, nor in beforeState/afterState, which keep their
   * original meaning of low-cardinality lifecycle values.
   */
  readonly credentialId?: string | null;
  readonly provider?: AuditProvider | null;
  /**
   * OD-MP-2 / migration 0014 — OPTIONAL, METADATA ONLY.
   *
   * Which trading account a binding change applies to. Required because
   * `targetUserId` identifies the USER, and a user may hold several accounts,
   * so a binding row would otherwise be ambiguous about WHICH account changed.
   *
   * Like `credentialId` this is a HISTORICAL identifier with no foreign key:
   * account deletion is a hard delete, and the audit trail must outlive the
   * account it describes (see migration 0014 for the full rationale).
   *
   * SECURITY: never a secret. The MetaAPI account id itself is non-secret, but
   * it belongs in beforeState/afterState as a lifecycle value, not here.
   */
  readonly tradingAccountId?: string | null;
}

/** A persisted audit record (read back for verification/tests only). */
export interface AuditRecord {
  readonly id: string;
  readonly action: AuditAction;
  readonly actorUserId: string;
  readonly targetUserId: string | null;
  readonly beforeState: string | null;
  readonly afterState: string | null;
  readonly outcome: AuditOutcome;
  readonly requestId: string | null;
  readonly occurredAt: string;
  /** Credential metadata when the action is a credential event; else null. */
  readonly credentialId: string | null;
  readonly provider: AuditProvider | null;
  /** Account reference when the action is a binding event; else null. */
  readonly tradingAccountId: string | null;
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
