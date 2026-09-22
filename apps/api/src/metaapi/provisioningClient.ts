// MetaAPI provisioning client (OD-MP-1) — the API-side, CREDENTIALED boundary.
//
// WHY THIS IS A SEPARATE CLIENT FROM apps/worker/src/metaapi/historyDealsClient
//   They are different trust classes and must not share an abstraction:
//     • history-deals (worker) is CREDENTIAL-FREE — platform token + a
//       non-secret account id (D-2). It runs in a process that has no access to
//       user_credentials and no CREDENTIAL_MASTER_KEY.
//     • provisioning (here) CONSUMES A USER'S BROKER CREDENTIAL. It may only
//       ever run inside the API.
//   A shared client would make it possible to pass a broker password through a
//   worker-reachable code path by accident. Keeping them separate makes that
//   mistake impossible to express.
//
// THE CONTRACT, AND NOTHING BEYOND IT (D-7 §2E, verified against official docs):
//
//   POST {provisioningBaseUrl}/users/current/accounts
//     auth-token:     <METAAPI_PLATFORM_TOKEN>     (required)
//     transaction-id: <32 random chars>            (required — documented)
//     accept / content-type: application/json
//
//   GET {provisioningBaseUrl}/users/current/accounts?query=<marker>
//     auth-token only (documented) — reconciliation.
//
//   DELETE {provisioningBaseUrl}/users/current/accounts/{id}
//     auth-token only (documented) — provider-side deletion.
//
// `Idempotency-Key` IS NEVER SENT. It is documented NOWHERE by MetaAPI; the
// legacy PHP system sends it on create/deploy/delete, which D-7 established as
// a legacy defect. Sending an undocumented header and relying on it would be
// assuming provider deduplication that is NOT PROVEN.
//
// SECRET HANDLING (OD-MP-1 rule 6, ADR-016):
//   - The broker password is placed in the request body and nowhere else. It
//     is never logged, never interpolated into a URL, never attached to an
//     error, and never returned.
//   - Provider response bodies are never logged. Only documented fields are
//     read; failures surface as a CODE.
//   - A transport error object is never inspected: a fetch error can embed the
//     full request, including the auth header AND the body.
import { randomBytes } from "node:crypto";

/**
 * Default MetaAPI PROVISIONING host. Distinct from the client/history host —
 * the legacy system derives one from the other by string replacement
 * (MetaApiService.php:55-56); Modern states both explicitly instead.
 */
export const DEFAULT_PROVISIONING_BASE_URL =
  "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";

/** Non-secret classification of a provisioning failure. Safe to log/persist. */
export type ProvisioningErrorCode =
  | "PROVIDER_REJECTED" // terminal 4xx — retrying cannot help
  | "PROVIDER_UNAVAILABLE" // 5xx/429/transport — retryable, outcome UNKNOWN
  | "PROVIDER_MALFORMED" // response was not the documented shape
  | "PROVIDER_TIMEOUT" // no response within the budget — outcome UNKNOWN
  | "NOT_CONFIGURED"; // platform token absent

/**
 * A provider failure carrying a CODE only.
 *
 * `ambiguous` marks the outcomes where the provider MAY have created the
 * account even though we did not learn its id (legacy requireSuccess:1103-1115
 * encodes the same distinction). An ambiguous failure must be reconciled by
 * marker, never retried blindly, or we would create a duplicate provider
 * account.
 */
export class ProvisioningError extends Error {
  constructor(
    readonly code: ProvisioningErrorCode,
    readonly ambiguous: boolean,
    message: string,
  ) {
    super(message);
    this.name = "ProvisioningError";
  }
}

/** Broker identity + secret for ONE provisioning call. In memory only. */
export interface ProvisionRequest {
  /** Broker login (account number). Not secret on its own, but never logged. */
  readonly login: string;
  /** THE SECRET. Present only for the lifetime of this call. */
  readonly password: string;
  /** Broker server name, e.g. "ICMarkets-Demo". */
  readonly server: string;
  /** MetaTrader platform. Mirrors the provider's documented vocabulary. */
  readonly platform: "mt4" | "mt5";
  /** Deterministic, secret-free provider-side account name (the marker). */
  readonly marker: string;
}

export interface ProvisioningClientOptions {
  readonly baseUrl?: string | undefined;
  /** Injected so tests never touch the network and never need a real token. */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

/** Outcome of a create call. */
export type ProvisionOutcome =
  | { readonly kind: "created"; readonly providerAccountId: string }
  /**
   * Documented 202 AcceptedError: the request was accepted but the result is
   * not yet available. The SAME transaction id must be reused to poll.
   */
  | { readonly kind: "accepted"; readonly retryAfterMs: number | null };

/**
 * Same charset the 0013 CHECK and the worker client enforce. Applied to any
 * identifier that reaches a URL path, so a provider value can never redirect
 * the request to a different endpoint.
 */
const SAFE_ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** The documented marker shape: `velora-` + 32 hex. Contains no secret. */
const SAFE_MARKER = /^velora-[a-f0-9]{32}$/;

/**
 * Generate the documented `transaction-id`: "a random 32-character
 * transaction id" (MetaAPI createAccount). Cryptographically random; hex keeps
 * it URL- and header-safe. It is a POLLING IDENTITY, not a dedup token.
 */
export function newTransactionId(): string {
  return randomBytes(16).toString("hex");
}

function requireToken(token: string): void {
  if (token.trim() === "") {
    throw new ProvisioningError("NOT_CONFIGURED", false, "platform token absent");
  }
}

/**
 * Classify a non-2xx response. 4xx (except 408/429) is terminal: the provider
 * rejected the request and no account was created. 5xx/408/429 leave the
 * outcome UNKNOWN, so they are ambiguous and require reconciliation.
 */
function classifyStatus(status: number): ProvisioningError {
  const ambiguous = status >= 500 || status === 408 || status === 429 || status === 425;
  return new ProvisioningError(
    ambiguous ? "PROVIDER_UNAVAILABLE" : "PROVIDER_REJECTED",
    ambiguous,
    `status ${status}`,
  );
}

async function send(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  /** True when a lost/failed request may still have mutated provider state. */
  mutating: boolean,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
  } catch {
    // The caught error is deliberately NOT inspected, logged or wrapped: a
    // fetch error can embed the whole request — auth-token header AND the
    // broker password in the body.
    throw new ProvisioningError(
      "PROVIDER_TIMEOUT",
      mutating, // a lost mutating request may still have created the account
      "transport failure or timeout",
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read `Retry-After` (seconds) or the documented
 * `metadata.recommendedRetryTime` from an AcceptedError body.
 * Returns null when the provider gave no usable hint.
 */
function retryHintMs(headerValue: string | null, body: unknown): number | null {
  if (headerValue !== null) {
    const seconds = Number(headerValue);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  if (typeof body === "object" && body !== null) {
    const meta = (body as { metadata?: unknown }).metadata;
    if (typeof meta === "object" && meta !== null) {
      const rec = (meta as { recommendedRetryTime?: unknown }).recommendedRetryTime;
      if (typeof rec === "number" && Number.isFinite(rec) && rec >= 0) {
        // Documented as a delay in seconds.
        return Math.round(rec * 1000);
      }
      if (typeof rec === "string") {
        const at = Date.parse(rec);
        if (Number.isFinite(at)) return Math.max(0, at - Date.now());
      }
    }
  }
  return null;
}

/** Extract the account id from a documented provider payload. */
function readAccountId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const rec = body as Record<string, unknown>;
  // createAccount documents `id`; readAccounts returns `_id`. Accept both, but
  // ONLY these two — never guess at another field.
  const raw = typeof rec["id"] === "string" ? rec["id"] : rec["_id"];
  if (typeof raw !== "string" || !SAFE_ACCOUNT_ID.test(raw)) return null;
  return raw;
}

/**
 * Create a MetaAPI account for the user's broker credentials.
 *
 * @param token   platform bearer token (never read from process.env here)
 * @param txnId   the documented transaction id; REUSE the same value when
 *                polling after a 202, which is the only documented retry
 *                semantic (D-7). It is not a deduplication guarantee.
 */
export async function createMetaApiAccount(
  token: string,
  req: ProvisionRequest,
  txnId: string,
  options: ProvisioningClientOptions = {},
): Promise<ProvisionOutcome> {
  requireToken(token);
  if (!SAFE_MARKER.test(req.marker)) {
    throw new ProvisioningError("PROVIDER_REJECTED", false, "unsafe marker");
  }
  if (!/^[A-Za-z0-9]{32}$/.test(txnId)) {
    throw new ProvisioningError("PROVIDER_REJECTED", false, "malformed transaction id");
  }

  const base = options.baseUrl ?? DEFAULT_PROVISIONING_BASE_URL;
  const doFetch = options.fetchImpl ?? fetch;

  const response = await send(
    doFetch,
    `${base}/users/current/accounts`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "auth-token": token,
        // Documented as Required on account creation. NOT Idempotency-Key.
        "transaction-id": txnId,
      },
      // Only the documented fields. `name` is the reconciliation marker, which
      // is how an ambiguous outcome is recovered without provider dedup.
      body: JSON.stringify({
        login: req.login,
        password: req.password,
        server: req.server,
        platform: req.platform,
        name: req.marker,
        magic: 0,
        manualTrades: true,
      }),
    },
    options.timeoutMs ?? 30_000,
    true,
  );

  // 202 = documented AcceptedError: accepted, outcome not yet available.
  if (response.status === 202) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null; // a missing/unparseable hint is not itself a failure
    }
    return { kind: "accepted", retryAfterMs: retryHintMs(response.headers.get("retry-after"), body) };
  }

  if (!response.ok) throw classifyStatus(response.status);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Created but unreadable: the account may exist, so this is ambiguous.
    throw new ProvisioningError("PROVIDER_MALFORMED", true, "unparseable body");
  }

  const providerAccountId = readAccountId(body);
  if (providerAccountId === null) {
    throw new ProvisioningError("PROVIDER_MALFORMED", true, "response had no usable account id");
  }
  return { kind: "created", providerAccountId };
}

/**
 * Reconcile by marker: find the provider account this operation created.
 *
 * Used after an AMBIGUOUS outcome, and before any retry, so a lost response
 * can never cause a second account to be created. The `query` parameter is
 * documented to search over _id, name, server and login; the marker is matched
 * EXACTLY on `name` afterwards, because `query` is a search, not an equality
 * filter.
 *
 * Returns null when no account carries the marker. Throws on MORE than one —
 * an ambiguity that must never be resolved by guessing (legacy
 * METAAPI_MARKER_NOT_UNIQUE, MetaApiService.php:834-862).
 */
export async function findAccountByMarker(
  token: string,
  marker: string,
  options: ProvisioningClientOptions = {},
): Promise<string | null> {
  requireToken(token);
  if (!SAFE_MARKER.test(marker)) {
    throw new ProvisioningError("PROVIDER_REJECTED", false, "unsafe marker");
  }

  const base = options.baseUrl ?? DEFAULT_PROVISIONING_BASE_URL;
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${base}/users/current/accounts?query=${encodeURIComponent(marker)}`;

  // A read: a failure here mutates nothing, so it is not ambiguous by itself.
  const response = await send(
    doFetch,
    url,
    { method: "GET", headers: { accept: "application/json", "auth-token": token } },
    options.timeoutMs ?? 30_000,
    false,
  );
  if (!response.ok) throw classifyStatus(response.status);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ProvisioningError("PROVIDER_MALFORMED", false, "unparseable body");
  }

  // Documented shapes: a bare array (api-version 1) or { items: [...] } (v2).
  const items: unknown[] = Array.isArray(body)
    ? body
    : typeof body === "object" && body !== null && Array.isArray((body as { items?: unknown }).items)
      ? (body as { items: unknown[] }).items
      : [];

  const matches: string[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    if ((item as { name?: unknown }).name !== marker) continue; // EXACT match only
    const id = readAccountId(item);
    if (id !== null) matches.push(id);
  }

  if (matches.length > 1) {
    // Never pick one. Two provider accounts carrying one operation's marker is
    // a state a human must resolve.
    throw new ProvisioningError("PROVIDER_REJECTED", false, "marker matched multiple accounts");
  }
  return matches[0] ?? null;
}

/**
 * Delete a provider-side account (OD-MP-3 B: provider deletion, a DISTINCT
 * operation from local unbinding and from credential revocation).
 *
 * `auth-token` only — the documented delete endpoint takes no transaction-id
 * and no Idempotency-Key.
 *
 * 404 HANDLING, EXPLICIT (OD-MP-3 G): a missing account is treated as SUCCESS.
 * The postcondition of "delete" is "the account does not exist at the
 * provider", which a 404 already satisfies. Treating it as an error would make
 * a retried disconnect fail forever on an account that is already gone.
 */
export async function deleteMetaApiAccount(
  token: string,
  providerAccountId: string,
  options: ProvisioningClientOptions = {},
): Promise<void> {
  requireToken(token);
  if (!SAFE_ACCOUNT_ID.test(providerAccountId)) {
    throw new ProvisioningError("PROVIDER_REJECTED", false, "unsafe account identifier");
  }

  const base = options.baseUrl ?? DEFAULT_PROVISIONING_BASE_URL;
  const doFetch = options.fetchImpl ?? fetch;

  const response = await send(
    doFetch,
    `${base}/users/current/accounts/${encodeURIComponent(providerAccountId)}`,
    { method: "DELETE", headers: { accept: "application/json", "auth-token": token } },
    options.timeoutMs ?? 30_000,
    true,
  );

  if (response.status === 404) return; // already absent — the goal state
  if (!response.ok) throw classifyStatus(response.status);
}
