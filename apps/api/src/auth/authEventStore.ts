// AuthEventStore — authentication-attempt history port (SEC-03, migration 0024).
//
// This is the Modern port of Legacy `api/src/Auth/AuthEventRepository.php`. It is
// NOT the audit trail (see `auditStore.ts` / the 0024 header): audit_log records
// privileged ACTIONS by authenticated actors; this records authentication
// ATTEMPTS, whose principal may not exist at all (a failed login for an unknown
// address).
//
// TWO POLICIES THAT ARE PART OF THE CONTRACT, NOT INCIDENTAL:
//
//   1. WRITES FAIL OPEN. `record()` must NEVER make authentication depend on
//      history: an unreachable or slow history table must not stop a legitimate
//      login. Legacy states this explicitly ("record() swallows its own
//      failures"); the adapter therefore catches its own errors and reports
//      them through a counter/hook instead of throwing. The authentication
//      decision is already made when record() is called, so nothing about
//      authorization can hinge on the write succeeding.
//
//   2. READS FAIL LOUD. The list operation is the opposite case: it feeds a
//      security-review surface, and returning "0 events" because the database
//      was unreachable would state a fact that is not true. Legacy swallowed
//      read failures too; Modern deliberately does NOT, and the divergence is
//      recorded in the capability document.
//
// The port exposes NO update and NO delete: history is append-only at the
// application layer, and db/roles.sql refuses those statements at the privilege
// layer as well.

import type { QueryFn } from "../persistence/pg.js";

/**
 * Event kinds. A closed vocabulary matching the 0024 CHECK: what Legacy wrote.
 * Extending it (logout, refresh, password-change) is a migration + a deliberate
 * decision, never an adapter detail.
 */
export type AuthEventType = "signup" | "login";

export type AuthEventResult = "success" | "failure";

/**
 * Failure causes, mirroring the codes the API returns to the caller. Typed as a
 * union so a new reason cannot be introduced by a typo; the database bounds the
 * column by length only, because the vocabulary belongs to the caller's contract.
 */
export type AuthEventFailureReason = "INVALID_CREDENTIALS" | "ACCOUNT_INACTIVE" | "EMAIL_NOT_VERIFIED";

/** What the recorder accepts. `userId` is null for the unknown-account case. */
export interface AuthEventInput {
  readonly userId: string | null;
  readonly eventType: AuthEventType;
  readonly result: AuthEventResult;
  /** Required for a failure, forbidden for a success (0024 CHECK enforces it). */
  readonly reason?: AuthEventFailureReason | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  /** Injectable clock (TestClock pattern). Defaults to the database's now(). */
  readonly occurredAt?: Date;
}

/** A stored row, in the shape the review surface returns it. */
export interface AuthEventRecord {
  readonly id: string;
  readonly occurredAt: string;
  readonly userId: string | null;
  readonly eventType: AuthEventType;
  readonly result: AuthEventResult;
  readonly reason: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface AuthEventPage {
  readonly events: readonly AuthEventRecord[];
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
}

/** Legacy bounds: per_page 1..100 (AuthEventRepository / UserManagementService). */
export const AUTH_EVENT_MAX_PER_PAGE = 100;
export const AUTH_EVENT_DEFAULT_PER_PAGE = 25;

export interface AuthEventStore {
  /**
   * Append one attempt. Implementations MUST NOT throw: history never breaks
   * authentication. Resolves once the write was attempted (or skipped).
   */
  record(input: AuthEventInput): Promise<void>;

  /**
   * One user's attempt history, newest first. Resolves with an empty page when
   * the user has no events — which is a FACT, unlike a swallowed failure.
   *
   * `result` filters by outcome; an unrecognised value is rejected by the caller
   * before it reaches here (the store types it).
   */
  listForUser(
    userId: string,
    opts?: { readonly page?: number; readonly perPage?: number; readonly result?: AuthEventResult },
  ): Promise<AuthEventPage>;

  /** Optional inspectable failure signal for the fail-open write path (tests). */
  readonly lastWriteError?: () => unknown;
}

/** Shared field normalisation so the PG and memory adapters cannot drift. */
export function normalizeAuthEvent(input: AuthEventInput): {
  userId: string | null;
  eventType: AuthEventType;
  result: AuthEventResult;
  reason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
} {
  const reason = input.result === "success" ? null : (input.reason ?? "INVALID_CREDENTIALS");
  return {
    userId: input.userId,
    // Normalise an id that is semantically absent. `""` is not a user id.
    eventType: input.eventType,
    result: input.result,
    reason,
    ipAddress: bound(input.ipAddress ?? null, 45),
    userAgent: bound(input.userAgent ?? null, 250),
  };
}

/** Trim + cap attacker-controlled text at the bound the column declares. */
function bound(value: string | null, max: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Clamp pagination exactly as Legacy did (page >= 1, perPage 1..100). */
export function clampPagination(opts?: {
  readonly page?: number;
  readonly perPage?: number;
}): { page: number; perPage: number } {
  const rawPage = opts?.page ?? 1;
  const rawPer = opts?.perPage ?? AUTH_EVENT_DEFAULT_PER_PAGE;
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage)) : 1;
  const perPage = Number.isFinite(rawPer)
    ? Math.min(AUTH_EVENT_MAX_PER_PAGE, Math.max(1, Math.trunc(rawPer)))
    : AUTH_EVENT_DEFAULT_PER_PAGE;
  return { page, perPage };
}

/** QueryFn is re-exported so an adapter can be built without importing pg.js. */
export type { QueryFn };
