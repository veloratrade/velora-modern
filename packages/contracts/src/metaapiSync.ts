// MetaAPI historical-sync contract — the shapes crossing the worker boundary.
//
// GOVERNANCE BASIS (nothing here is invented):
//   - D-7 (§2E): historical sync is the documented read
//       GET /users/current/accounts/{accountId}/history-deals/time/{from}/{to}
//     which documents ONLY the `auth-token` header. There is no documented
//     request-level idempotency mechanism on this path, so none is modelled:
//     no `Idempotency-Key`, no `transaction-id`. Duplicate protection is
//     Velora-internal — UNIQUE (account_id, external_deal_id).
//   - D-2 (§2A): sync is credential-free. The only provider identity in these
//     types is the NON-SECRET `metaapiAccountId`. A broker login, investor
//     password, credential ciphertext or CREDENTIAL_MASTER_KEY must never
//     appear in any type in this file.
//   - TZ-M1/D-5: a deal carries TWO distinct timestamp fields — offset-explicit
//     `time` and naive `brokerTime` — and they are modelled separately because
//     one column/field cannot represent both.

import type { SafeJobPayload } from "./jobs.js";

/** The job class of the scheduled historical-sync job. */
export const METAAPI_SYNC_JOB_CLASS = "metaapi.sync-account";

/**
 * Payload of a historical-sync job.
 *
 * Constrained to `SafeJobPayload` (flat scalars) so the compiler rejects a
 * nested/credential-shaped payload. pg-boss persists payloads and they survive
 * into retries and the DLQ, so this rule is load-bearing (ADR-007 §Security).
 *
 * Every field below is an IDENTIFIER or a window bound. There is deliberately
 * no token field, no credential field, and no provider-response field.
 */
export interface MetaApiSyncPayload extends SafeJobPayload {
  /** Velora `trading_accounts.id`. Ownership is re-derived from it server-side. */
  readonly accountId: string;
  /** NON-SECRET MetaAPI provider account identifier (D-2). Never a credential. */
  readonly metaapiAccountId: string;
  /**
   * Inclusive start of the requested window, ISO-8601 with explicit `Z`.
   * Derived from the account's durable cursor, never from client input.
   */
  readonly from: string;
  /** Exclusive end of the requested window, ISO-8601 with explicit `Z`. */
  readonly to: string;
}

/**
 * One MetaAPI history deal, as consumed after transport-level validation.
 *
 * Field names mirror the provider's documented response. Everything is
 * optional/nullable because a provider response is UNTRUSTED input: the
 * normalizer decides what is usable and quarantines the rest rather than
 * assuming a shape.
 */
export interface MetaApiDeal {
  readonly id?: unknown;
  readonly positionId?: unknown;
  readonly entryType?: unknown;
  readonly type?: unknown;
  readonly symbol?: unknown;
  readonly volume?: unknown;
  readonly price?: unknown;
  readonly profit?: unknown;
  readonly commission?: unknown;
  readonly swap?: unknown;
  /** Offset-explicit instant (trailing `Z` or ±HH:MM) — MAY resolve to UTC. */
  readonly time?: unknown;
  /** NAIVE broker wall clock — evidence ONLY, never an instant (D-5). */
  readonly brokerTime?: unknown;
}

/**
 * A provider deal after normalization: the exact shape persisted to
 * `sync_fills`.
 *
 * TIMESTAMP MODEL (D-5, enforced by this type's shape):
 *   - `occurredAtUtc` is non-null ONLY when `time` carried an explicit
 *     offset and parsed deterministically. Otherwise it is null.
 *   - `timeStatus` mirrors that and nothing else.
 *   - `rawTimeText` is the verbatim offset-explicit `time`.
 *   - `brokerTimeText` is the verbatim naive `brokerTime`.
 * The last two are independent evidence fields: either, both or neither may be
 * present, and neither is ever derived from the other.
 */
export interface NormalizedFill {
  readonly externalDealId: string;
  readonly positionId: string | null;
  readonly entryType: "in" | "out" | null;
  readonly direction: "buy" | "sell" | null;
  readonly symbol: string | null;
  readonly volume: string | null;
  readonly price: string | null;
  /** Provider-reported profit — AUTHORITATIVE under D-4. Never recomputed. */
  readonly profit: string | null;
  readonly commission: string | null;
  readonly swap: string | null;
  readonly occurredAtUtc: string | null;
  readonly timeStatus: "resolved_utc" | "unresolved";
  readonly rawTimeText: string | null;
  readonly brokerTimeText: string | null;
}

/**
 * Fixed, non-secret outcome codes for a sync attempt.
 *
 * These are the ONLY values written to `trading_accounts.last_sync_error_code`
 * and `sync_fills.skip_reason`, both of which are constrained by a database
 * CHECK to `^[A-Z0-9_]{1,48}$`. Provider free text is never persisted (G-3).
 */
export const SYNC_ERROR_CODES = [
  "NO_METAAPI_ACCOUNT_ID", // account is not MetaAPI-provisioned — never guessed
  "RESERVATION_HELD", // another attempt already owns the lease
  "PROVIDER_REJECTED", // terminal 4xx from the provider
  "PROVIDER_UNAVAILABLE", // retryable 5xx / transport failure
  "PROVIDER_MALFORMED", // response was not the documented shape
  "NOT_CONFIGURED", // METAAPI_PLATFORM_TOKEN absent/invalid
] as const;
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

/** Fixed reasons a normalized fill is not folded into a trade. */
export const FILL_SKIP_REASONS = [
  "UNRESOLVED_TIME", // no offset-explicit instant — excluded from time analytics
  "MISSING_IDENTITY", // no usable deal id
  "MALFORMED_NUMERIC", // price/volume unparseable or non-positive
  "UNKNOWN_DIRECTION", // provider type not buy/sell
  "NON_TRADE_DEAL", // balance/credit deal — not a fill
] as const;
export type FillSkipReason = (typeof FILL_SKIP_REASONS)[number];
