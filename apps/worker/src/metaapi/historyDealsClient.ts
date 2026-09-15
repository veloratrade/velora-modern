// MetaAPI history-deals client — the ONLY provider call this worker makes.
//
// THE CONTRACT, AND NOTHING BEYOND IT (D-7, §2E, ratified from official docs):
//
//   GET {baseUrl}/users/current/accounts/{accountId}/history-deals/time/{from}/{to}
//   header: auth-token: <METAAPI_PLATFORM_TOKEN>
//
// That endpoint documents `auth-token` and nothing else. Accordingly this
// client sends NO other header. Specifically it does NOT send:
//   - `Idempotency-Key` — NOT a documented MetaAPI mechanism anywhere (the
//     legacy PHP system sends it on provisioning calls; that is a legacy
//     defect, verified by exhaustive documentation search, and is not copied).
//   - `transaction-id` — documented ONLY for provisioning writes (account and
//     replica creation), never for this historical READ.
// Duplicate protection for this path is Velora-internal and DB-enforced:
// UNIQUE (account_id, external_deal_id). Provider-side request idempotency is
// NOT assumed for historical reads.
//
// NOT INVENTED HERE: no query parameters, no pagination cursor, no sort-order
// assumption, no retry-budget negotiation. `offset`/`limit` exist on the
// documented endpoint but are not used, because a paging loop needs a
// termination guarantee the documentation does not give us for this shape;
// the window is bounded by time instead, which the endpoint does define.
//
// SECURITY (B5/G-3, binding):
//   - The token is read through a holder and passed straight to the header. It
//     is never logged, never interpolated into a URL, never put in an error.
//   - Provider response bodies are NEVER logged and never attached to an
//     error. Failures surface as a ClassifiedError carrying a CODE only.
import { ClassifiedError } from "../observability/safeError.js";

/** Default public MetaAPI client host (ADR-014 §5 — explicit, not guessed). */
export const DEFAULT_METAAPI_BASE_URL = "https://mt-client-api-v1.new-york.agiliumtrade.ai";

export interface HistoryDealsRequest {
  /** NON-SECRET provider account identifier (D-2). Never a credential. */
  readonly metaapiAccountId: string;
  /** Inclusive window start, ISO-8601 with explicit Z. */
  readonly from: string;
  /** Exclusive window end, ISO-8601 with explicit Z. */
  readonly to: string;
}

export interface HistoryDealsClientOptions {
  readonly baseUrl?: string | undefined;
  /** Injected so tests never touch the network and never need a real token. */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Rejects an account id that could alter the request path.
 *
 * The id is interpolated into a URL path, so anything outside this charset
 * (notably `/`, `?`, `#`, `..`) could redirect the call to a different
 * endpoint. Same charset as the 0013 database CHECK, enforced twice on
 * purpose: the DB guards storage, this guards egress.
 */
const SAFE_ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Fetch history deals for one account and time window.
 *
 * @param token the platform bearer token. Supplied by the caller from the
 *   environment; this function never reads `process.env` itself, so the token's
 *   provenance stays a single reviewable call site.
 */
export async function fetchHistoryDeals(
  token: string,
  req: HistoryDealsRequest,
  options: HistoryDealsClientOptions = {},
): Promise<unknown[]> {
  if (!SAFE_ACCOUNT_ID.test(req.metaapiAccountId)) {
    // Never interpolate an unvalidated identifier into a provider URL.
    throw new ClassifiedError("PROVIDER_REJECTED", "unsafe account identifier");
  }
  if (token.trim() === "") {
    throw new ClassifiedError("NOT_CONFIGURED", "platform token absent");
  }

  const base = options.baseUrl ?? DEFAULT_METAAPI_BASE_URL;
  const doFetch = options.fetchImpl ?? fetch;
  const url =
    `${base}/users/current/accounts/${encodeURIComponent(req.metaapiAccountId)}` +
    `/history-deals/time/${encodeURIComponent(req.from)}/${encodeURIComponent(req.to)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "GET",
      // `auth-token` is the ONLY header the endpoint documents.
      headers: { "auth-token": token, accept: "application/json" },
      signal: controller.signal,
    });
  } catch {
    // Transport failure. The caught error is deliberately NOT inspected: a
    // fetch error can embed the full request, including the auth header.
    throw new ClassifiedError("PROVIDER_UNAVAILABLE", "transport failure");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Status code only — the body is never read, so it can never be logged.
    // 4xx is terminal (retrying a rejected request cannot succeed); 5xx and
    // 429 are retryable.
    const retryable = response.status >= 500 || response.status === 429;
    throw new ClassifiedError(
      retryable ? "PROVIDER_UNAVAILABLE" : "PROVIDER_REJECTED",
      `status ${response.status}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ClassifiedError("PROVIDER_MALFORMED", "unparseable body");
  }

  // The documented response is a JSON array of deals. Some deployments wrap it
  // as { deals: [...] } (the legacy client reads that shape), so both are
  // accepted — anything else is malformed rather than silently treated as
  // "zero deals", which would wrongly advance the cursor over real data.
  if (Array.isArray(body)) return body;
  if (typeof body === "object" && body !== null && Array.isArray((body as { deals?: unknown }).deals)) {
    return (body as { deals: unknown[] }).deals;
  }
  throw new ClassifiedError("PROVIDER_MALFORMED", "unexpected response shape");
}
