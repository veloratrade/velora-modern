// Developer-key AUTHENTICATION — the secondary credential class (v3.0).
//
// ============================================================
// WHY THIS EXISTS (and why it is not a new policy)
// ============================================================
// Pass 2 implemented the key LIFECYCLE (create / list / revoke) and reported the
// remaining question as "which routes may a developer key authenticate
// against?" — an apparent product-policy gap (R-5/J-6a). Reading the authority
// hierarchy, the answer is already fixed upstream of this file:
//
//   * ROADMAP v3.0: "OAuth2 scoped tokens", "100 req/min" for the developer API.
//   * CAPABILITY CONTRACT (0021): `scopes TEXT[] CHECK (scopes <@
//     ARRAY['trades:read','trades:write','analytics:read','accounts:read'])`,
//     `rate_limit_per_min ∈ [1, 10000]` DEFAULT 100.
//
// 0021's scope vocabulary is not decorative: it NAMES the four surfaces, in
// resource:action form, and the platform already exposes exactly one route
// family per name. So the mapping is derived, not invented:
//
//   trades:read     → GET  /api/v1/trades[…]
//   trades:write    → POST/PUT/DELETE /api/v1/trades[…]
//   analytics:read  → GET  /api/v1/analytics/{summary,equity-curve,heatmap}
//   accounts:read   → GET  /api/v1/accounts
//
// EVERYTHING ELSE IS REFUSED. The table below is an ALLOW-LIST: a route that is
// not in it cannot be reached with a key (`403`), including routes that merely
// look related (`/trades/{id}/tags`, `/trades/{id}/attachments`,
// `/accounts/{id}/sync-status`): those capabilities have no scope in the frozen
// vocabulary, and widening the vocabulary is a migration, not a decision this
// module may take.
//
// ============================================================
// THE KEY IS NOT A SESSION — THREE CONSEQUENCES
// ============================================================
// 1. NO ROLE. A key authenticates as its OWNER at the LEAST privileged role
//    (`user`). Ownership (admin, super_admin) is deliberately not transferable
//    into a long-lived programmatic credential, and admin surfaces are not in
//    the allow-list anyway.
// 2. NO FALLBACK. A bearer that has the shape of a developer key but does not
//    resolve (unknown or revoked) is `401`. It is never re-interpreted as a
//    session token, so revoking a key cannot leave a second way in.
// 3. SCOPE BEFORE WORK. The scope check runs before the route executes and
//    before any body is read, so a key cannot reach a handler and be refused
//    afterwards (authorization-before-sensitive-operations).
//
// ============================================================
// RATE LIMITING IS REAL, NOT STORED DECORATION
// ============================================================
// `rate_limit_per_min` is enforced per KEY (bucket `devkey:{id}`, 60-second
// fixed window) using the SAME limiter primitive as the auth routes
// (`RateLimitStore` + `evaluateRateLimit`), so one implementation defines what a
// window means across the product. In production the store is the PostgreSQL one
// (`PgRateLimitStore`), which makes the limit hold across processes rather than
// per instance.
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { fail, type AppRole } from "@velora/contracts";
import { evaluateRateLimit, type RateLimitStore } from "@velora/domain";
import type { QueryFn } from "../persistence/pg.js";
import type { RouteResult } from "../routes/types.js";

/** 0021's vocabulary, verbatim (the CHECK is the authority). */
export const DEV_SCOPE_VOCABULARY = [
  "trades:read",
  "trades:write",
  "analytics:read",
  "accounts:read",
] as const;
export type DevScope = (typeof DEV_SCOPE_VOCABULARY)[number];

/**
 * The exact shape `generateApiKey()` mints: 8 hex prefix + `_` + 32 base64url
 * characters. Session tokens are JWTs (three dot-separated segments) and EA keys
 * are 43 base64url characters with no underscore, so the three credential
 * classes are disjoint by construction — this test cannot mistake one for
 * another.
 */
const KEY_SHAPE = /^[0-9a-f]{8}_[A-Za-z0-9_-]{32}$/;

export function looksLikeDeveloperKey(presented: string): boolean {
  return KEY_SHAPE.test(presented);
}

export function hashDeveloperKey(presented: string): string {
  return createHash("sha256").update(presented).digest("hex");
}

/** `{id}` segments this module treats as resource identifiers. */
const NUMERIC_ID = /^\d{1,19}$/;

/**
 * The developer surface: (method, path) → required scope. `null` = not exposed.
 *
 * ORDER MATTERS: `/trades/symbols` and `/trades/exits/{id}` are matched before
 * the `{id}` rules, so `symbols` cannot be read as an id and an exit id cannot be
 * read as a trade id.
 */
export function requiredScopeFor(method: string, path: string): DevScope | null {
  // ---- trades -------------------------------------------------------------
  if (path === "/api/v1/trades") {
    if (method === "GET") return "trades:read";
    if (method === "POST") return "trades:write";
    return null;
  }
  if (path === "/api/v1/trades/symbols") return method === "GET" ? "trades:read" : null;
  const exitId = /^\/api\/v1\/trades\/exits\/([^/]+)$/.exec(path);
  if (exitId !== null) {
    if (!NUMERIC_ID.test(exitId[1] ?? "")) return null;
    return method === "DELETE" ? "trades:write" : null;
  }
  const tradeExits = /^\/api\/v1\/trades\/([^/]+)\/exits$/.exec(path);
  if (tradeExits !== null) {
    if (!NUMERIC_ID.test(tradeExits[1] ?? "")) return null;
    if (method === "GET") return "trades:read";
    if (method === "POST") return "trades:write";
    return null;
  }
  const trade = /^\/api\/v1\/trades\/([^/]+)$/.exec(path);
  if (trade !== null) {
    if (!NUMERIC_ID.test(trade[1] ?? "")) return null;
    if (method === "GET") return "trades:read";
    if (method === "PUT" || method === "DELETE") return "trades:write";
    return null;
  }

  // ---- accounts -----------------------------------------------------------
  // READ ONLY: the vocabulary has no `accounts:write`, so creating or editing an
  // account with a key is refused rather than quietly permitted.
  if (path === "/api/v1/accounts") return method === "GET" ? "accounts:read" : null;

  // ---- analytics ----------------------------------------------------------
  if (path === "/api/v1/analytics/summary") return method === "GET" ? "analytics:read" : null;
  if (path === "/api/v1/analytics/equity-curve") return method === "GET" ? "analytics:read" : null;
  if (path === "/api/v1/analytics/heatmap") return method === "GET" ? "analytics:read" : null;

  return null;
}

export interface DeveloperKeyPrincipal {
  readonly keyId: string;
  readonly userId: string;
  /** Exactly what 0021 stores for this key (never widened by a caller). */
  readonly scopes: readonly string[];
  readonly rateLimitPerMin: number;
}

export interface DeveloperKeyLookup {
  /** Resolve a LIVE key (revoked keys resolve to null, never to a disabled key). */
  findByHash(hash: string): Promise<DeveloperKeyPrincipal | null>;
  /** Bookkeeping only — never an authorization input (see the guard). */
  touchLastUsed(keyId: string): Promise<void>;
}

export class PgDeveloperKeyLookup implements DeveloperKeyLookup {
  constructor(private readonly q: QueryFn) {}

  async findByHash(hash: string): Promise<DeveloperKeyPrincipal | null> {
    const rows = await this.q(
      `SELECT id::text AS id, user_id::text AS user_id, scopes, rate_limit_per_min
         FROM developer_api_keys
        WHERE key_hash = $1 AND revoked_at IS NULL
        LIMIT 1`,
      [hash],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      keyId: String(row["id"]),
      userId: String(row["user_id"]),
      // A non-array is an unreadable row, not an empty scope set: refusing it
      // (empty scopes → every scope check fails) is the fail-closed reading.
      scopes: Array.isArray(row["scopes"]) ? (row["scopes"] as unknown[]).map(String) : [],
      rateLimitPerMin: Number(row["rate_limit_per_min"] ?? 0),
    };
  }

  async touchLastUsed(keyId: string): Promise<void> {
    // THROTTLED ON PURPOSE. The column answers "is this key still in use?", which
    // does not need per-request precision, and an UPDATE per request would add a
    // write to every read. At most one touch per minute per key.
    await this.q(
      `UPDATE developer_api_keys SET last_used_at = now()
        WHERE id = $1::bigint
          AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`,
      [keyId],
    );
  }
}

/** In-memory double (contract-identical; not database evidence). */
export class MemoryDeveloperKeyLookup implements DeveloperKeyLookup {
  readonly #byHash = new Map<string, DeveloperKeyPrincipal>();
  readonly touches: string[] = [];

  add(hash: string, principal: DeveloperKeyPrincipal): void {
    this.#byHash.set(hash, principal);
  }

  remove(hash: string): void {
    this.#byHash.delete(hash);
  }

  async findByHash(hash: string): Promise<DeveloperKeyPrincipal | null> {
    return this.#byHash.get(hash) ?? null;
  }

  async touchLastUsed(keyId: string): Promise<void> {
    this.touches.push(keyId);
  }
}

export interface DeveloperGuardInput {
  readonly req: IncomingMessage;
  readonly method: string;
  readonly path: string;
  readonly requestId: string;
}

export interface DeveloperGuardDecision {
  /** Non-null ⇒ the request is terminated here (401/403/429). */
  readonly blocked: RouteResult | null;
  /** Non-null ⇒ a developer key authenticated this request. */
  readonly principal: { readonly sub: string; readonly role: AppRole } | null;
}

/** Fixed window for per-key limits (the roadmap's unit is requests/minute). */
export const DEVELOPER_RATE_WINDOW_SEC = 60;

export class DeveloperKeyAuth {
  constructor(
    private readonly deps: {
      readonly lookup: DeveloperKeyLookup;
      readonly limiter: RateLimitStore;
      readonly now?: () => number;
      readonly log?: (event: Record<string, unknown>) => void;
    },
  ) {}

  async guard(input: DeveloperGuardInput): Promise<DeveloperGuardDecision> {
    const presented = bearerOf(input.req);
    // Not key-shaped ⇒ this request is not ours: the session path continues
    // unchanged (a JWT is never hashed and looked up as a key).
    if (presented === null || !looksLikeDeveloperKey(presented)) {
      return { blocked: null, principal: null };
    }

    const hash = hashDeveloperKey(presented);
    const key = await this.deps.lookup.findByHash(hash);
    if (key === null) {
      // Shape-matched but unresolvable: revoked, deleted, or invented. No
      // disclosure of which, and no fallback to session verification.
      return {
        blocked: { status: 401, body: fail("UNAUTHENTICATED", "Unknown or revoked API key.", input.requestId) },
        principal: null,
      };
    }

    const scope = requiredScopeFor(input.method, input.path);
    if (scope === null) {
      return {
        blocked: {
          status: 403,
          body: fail(
            "FORBIDDEN",
            "This route is not available to developer API keys.",
            input.requestId,
          ),
        },
        principal: null,
      };
    }
    if (!key.scopes.includes(scope)) {
      return {
        blocked: {
          status: 403,
          body: fail("FORBIDDEN", "API key is missing the required scope.", input.requestId, { required_scope: scope }),
        },
        principal: null,
      };
    }

    const nowMs = (this.deps.now ?? (() => Date.now()))();
    const decision = await (async () => {
      const state = await this.deps.limiter.hit(
        `devkey:${key.keyId}`,
        { windowSec: DEVELOPER_RATE_WINDOW_SEC },
        nowMs,
      );
      return evaluateRateLimit(state, { limit: key.rateLimitPerMin, windowSec: DEVELOPER_RATE_WINDOW_SEC }, nowMs);
    })();
    if (!decision.allowed) {
      return {
        blocked: {
          status: 429,
          body: fail("TOO_MANY_REQUESTS", "Too many requests.", input.requestId),
          headers: { "Retry-After": String(decision.retryAfterSec) },
        },
        principal: null,
      };
    }

    // Bookkeeping, after the request is authorized: a failure to record
    // `last_used_at` must not turn a valid request into a 500, and the value is
    // never read back as an authorization input.
    try {
      await this.deps.lookup.touchLastUsed(key.keyId);
    } catch {
      this.deps.log?.({ level: "warn", event: "developer.key_touch_failed" });
    }

    return { blocked: null, principal: { sub: key.userId, role: "user" } };
  }
}

function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) return null;
  const value = header.slice("Bearer ".length).trim();
  return value === "" ? null : value;
}
