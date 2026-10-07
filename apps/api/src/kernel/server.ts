// API kernel — thin delivery shell (ADR-010: apps are thin; domain/contracts
// own the logic). Implements the frozen external tier: health envelope (C-01),
// locale routing + headers (C-02/C-03/D-14), cache classes, origin guard.
import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { z } from "zod";
import {
  ok,
  fail,
  resolvePublicRoute,
  CACHE_POLICY,
  LOCALE_HEADER,
  phpUtcTimestamp,
  registerRequest,
  loginRequest,
  type RateLimitKey,
  APP_ROLES,
  type AppRole,
  type Permission,
  can,
  normalizeRole,
  permissionsFor,
  canAct,
  authorityPermissions,
  type AuthorityContext,
} from "@velora/contracts";
import { newSecurityContext, buildCsp, SECURITY_HEADERS, originAllowed } from "./security.js";
import { dispatchExtendedRoutes } from "../routes/extendedRoutes.js";
import { AuthService, AuthError } from "../auth/authService.js";
import { AdminUserService, type ActorContext } from "../auth/adminUserService.js";
import { OwnershipService } from "../auth/ownershipService.js";
import type { AuthEventStore } from "../auth/authEventStore.js";
import { AccountService, AccountError } from "../accounts/accountService.js";
import { TradeService, TradeError } from "../trades/tradeService.js";
import { CredentialService, CredentialError } from "../credentials/credentialService.js";
import {
  MetaApiProvisioningService,
  ProvisioningServiceError,
} from "../metaapi/provisioningService.js";
import { EntitlementError } from "../entitlements/entitlementService.js";
import { resolveClientIp, type RateLimitDecision } from "@velora/domain";
import { FixedWindowRateLimiter, type RateLimiter } from "../ratelimits/rateLimiter.js";
import { MemoryRateLimitStore } from "../ratelimits/memoryRateLimitStore.js";

export interface HealthChecks {
  database(): Promise<"ok" | "fail">;
}

export interface ApiConfig {
  allowedOrigins: readonly string[];
  checks: HealthChecks;
  /** Phase C identity capability. Absent → auth routes fail closed (503). */
  readonly auth?: AuthService;
  /** Phase C accounts capability. Absent → account routes fail closed (503). */
  readonly accounts?: AccountService;
  /** Phase C trades capability (increment 3). Absent → trade routes fail closed (503). */
  readonly trades?: TradeService;
  /** Phase 3B-4 admin user management. Absent → admin user routes fail closed (503). */
  readonly adminUsers?: AdminUserService;
  /**
   * Authentication-attempt history (SEC-03, migration 0024). Absent → the
   * login-history route fails closed (503) rather than answering "no events",
   * which would state a fact it cannot know.
   */
  readonly authEvents?: AuthEventStore;
  /** System Owner bootstrap. Absent → ownership routes fail closed (503). */
  readonly ownership?: OwnershipService;
  /**
   * B-1 credential access layer (C-22 store). Absent → credential routes fail
   * closed (503). Absence is the NORMAL state when CREDENTIAL_MASTER_KEY is
   * missing or invalid: the capability disappears rather than degrading.
   */
  readonly credentials?: CredentialService;
  /**
   * OD-MP-1 MetaAPI provisioning / account binding. Absent → the connect and
   * disconnect routes fail closed (503). Absence is the NORMAL state when
   * either the credential capability or METAAPI_PLATFORM_TOKEN is missing.
   */
  readonly provisioning?: MetaApiProvisioningService;
  /** Phase C rate limiting (inc 7). Absent → createApp builds a default
   *  fixed-window limiter on a per-process memory store (PHP applies
   *  throttling unconditionally at dispatch; a per-app instance preserves
   *  the established per-test-server isolation). */
  readonly rateLimiter?: RateLimiter;
  /** Trusted reverse-proxy CIDRs for X-Forwarded-For (PHP parity). Default:
   *  none — the header is never honored (fail-closed). */
  readonly trustedProxyCidrs?: readonly string[];
  // ------------------------------------------------------------------------
  // Backend migration (directive t) capability slots.
  //
  // Each slot is OPTIONAL and carries the identical fail-closed contract the
  // Phase C slots already use: absent ⇒ the migrated route answers 503 rather
  // than degrading to an unauthenticated or unbounded path. The kernel never
  // constructs these services itself — `server-main.ts` is the single
  // composition root, so a capability's dependencies stay visible in one place.
  // ------------------------------------------------------------------------
  /** v0.2 MetaAPI webhook ingress (signature-authenticated, no bearer). */
  readonly webhooks?: import("../webhooks/metaApiWebhookService.js").MetaApiWebhookService;
  /** v0.2 connection status monitor. */
  readonly syncStatus?: import("../accounts/syncStatusService.js").SyncStatusStore;
  /**
   * v0.2 user-triggered sync (TRD-06). Absent ⇒ POST /accounts/{id}/sync answers
   * the documented fail-closed 503 rather than silently accepting a request no
   * queue will ever see.
   */
  readonly manualSync?: import("../accounts/manualSyncService.js").ManualSyncService;
  /** v0.5 analytics reads. */
  readonly analytics?: import("../analytics/analyticsStore.js").AnalyticsStore;
  /** v0.5 journal tags. */
  readonly tags?: import("../tags/tagService.js").TagStore;
  /** v0.5 trade attachments (screenshots). */
  readonly attachments?: import("../attachments/attachmentService.js").AttachmentService;
  /** Phase 5: the support ticket capability (Legacy api/src/Support/, migrated). */
  readonly support?: import("../support/supportService.js").SupportService;
  /** v1.0 subscriptions (Stripe). */
  readonly subscriptions?: import("../billing/subscriptionService.js").SubscriptionStore;
  /** v1.0 AI coach insight store + consent. */
  readonly aiCoach?: import("../aicoach/aiCoachRoutes.js").AiCoachStore;
  /** v1.0 admin read surface (audit trail + platform KPIs). */
  readonly admin?: import("../admin/adminRoutes.js").AdminStore;
  /**
   * Phase 6 admin console (overview, analytics, system health, security feeds,
   * the per-user account operations and the platform-wide lists).
   *
   * Absent → every console route answers the documented fail-closed 503. It is a
   * SEPARATE slot from `admin` above because the two have different lifetimes: the
   * audit/KPI store is a leaf read port, while the console composes that store's
   * neighbourhood with the admin user service and the ownership resolver.
   */
  readonly adminConsole?: import("../admin/adminConsoleRoutes.js").AdminConsoleCapability;
  /** Phase 7 — the AI capability: analysis, report, feedback, status, ledger reads. */
  readonly ai?: import("../ai/aiRoutes.js").AiCapability;
  /** Phase 7 — the admin AI configuration surface (chains, secrets, route, relay, usage). */
  readonly aiAdmin?: import("../ai/aiAdminRoutes.js").AiAdminCapability;
  /** Phase 7 — the support console's AI assists (translate, copilot, draft). */
  readonly supportAi?: import("../support/supportAiRoutes.js").SupportAiCapability;
  /** v1.5 portfolio / prop drawdown / FX reads. */
  readonly portfolio?: import("../portfolio/portfolioRoutes.js").PortfolioStore;
  /**
   * Telegram journal client (ADR-018 / migration 0023): linking, the bot
   * surface and the webhook ingress, composed in one place because they share
   * one store, one config resolution and one update pipeline.
   *
   * Absent when the bot token is missing, or when `TELEGRAM_UPDATE_MODE` does
   * not name a consumer, or when polling was refused in production — the whole
   * surface then answers its documented fail-closed 503 and the rest of the
   * product is unaffected.
   */
  readonly telegram?: import("../telegram/telegramRoutes.js").TelegramCapability;
  /** v2.0 EA ingestion store. */
  readonly ea?: import("../ea/eaRoutes.js").EaStore;
  /** v2.0 sync dispatch used by EA ingestion (falls back to durable-only). */
  readonly eaSync?: import("../ea/eaRoutes.js").SyncTriggerPort;
  /** v2.0 push registration encryptor (credential master key). */
  readonly deviceTokens?: import("../ea/eaRoutes.js").DeviceTokenEncryptor;
  /** v2.5 public profiles + copy relationships. */
  readonly tenancy?: import("../tenancy/tenancyRoutes.js").TenancyStore;
  /** v3.0 developer API keys + ML prediction reads. */
  readonly developer?: import("../developer/developerRoutes.js").DeveloperStore;
  /**
   * v3.0 developer-key AUTHENTICATION (the secondary credential class).
   *
   * Absent ⇒ keys can still be created, listed and revoked, but nothing accepts
   * one: the lifecycle is intact and the surface simply does not exist, which is
   * the fail-closed reading of "no authentication configured".
   */
  readonly developerKeys?: import("../developer/developerAuth.js").DeveloperKeyAuth;
}

/**
 * Throttled routes with a STATIC path.
 *
 * Started (inc 7) as the Local auth routes with PHP dispatch-level limits
 * (C-14); SEC-02 added the provider/ingress routes, so the name is no longer
 * auth-only. Phase H/I/J routes still have no Local route — their C-14 defaults
 * light up when those routes land. Dynamic paths live in
 * THROTTLED_PATTERN_ROUTES below; `throttleKeyFor()` reads both.
 */
export const THROTTLED_ROUTES: Readonly<Record<string, RateLimitKey>> = {
  "POST /api/v1/auth/register": "auth:register",
  "POST /api/v1/auth/login": "auth:login",
  "POST /api/v1/auth/refresh": "auth:refresh",
  "POST /api/v1/auth/verify-email": "auth:verify-email",
  "POST /api/v1/auth/change-password": "auth:change-password",
  // Phase 3B-1. Values are the owner-approved defaults already declared in
  // packages/contracts (resend-verification = 4/3600 per OD-14).
  "POST /api/v1/auth/resend-verification": "auth:resend-verification",
  "POST /api/v1/auth/forgot-password": "auth:forgot-password",
  "POST /api/v1/auth/reset-password": "auth:reset-password",
  // SEC-02: routes whose work leaves the process — a provider login check and
  // an ingress that a third party drives. Legacy throttled both at dispatch.
  "POST /api/v1/accounts/detect-server": "accounts:detect-server",
  "POST /api/v1/webhooks/metaapi": "webhooks:metaapi",
  // Phase 5: support writes (create / reply / reopen). Opening a ticket and
  // replying are the two operations that can be used to flood the inbox, so they
  // share one bucket per user. Reads are unbounded but cheap and ownership-scoped.
  "POST /api/v1/support/tickets": "support:write",
  // Phase 7: the three AI operations whose work leaves the process and costs
  // money. Legacy's per-user limits, carried over verbatim (AIController):
  // analyze 10/3600, weekly report 5/3600, feedback 20/3600.
  "POST /api/v1/ai/analyze-trades": "ai:analyze",
  "POST /api/v1/ai/weekly-report": "ai:report",
  "POST /api/v1/ai/feedback": "ai:feedback",
};

/**
 * Throttled routes with a DYNAMIC segment (SEC-02).
 *
 * PHP matched these with `preg_match('~\A/api/v1/accounts/\d+/sync\z~D', …)`;
 * the exact-match map above cannot express a path that carries a resource id,
 * so dynamic paths get their own ordered rule list. Rules are tried in order and
 * the FIRST match wins, so a more specific rule must be listed before a broader
 * one. The method is part of every rule for the same reason it is part of the
 * map key: throttling must not accidentally cover a read.
 *
 * `throttleKeyFor()` is the single lookup both the dispatcher and the tests use,
 * so the table cannot drift from the behaviour it claims to describe.
 */
export const THROTTLED_PATTERN_ROUTES: readonly {
  readonly method: string;
  readonly pattern: RegExp;
  readonly key: RateLimitKey;
}[] = [
  // The provisioning call: it verifies a broker login against the provider and
  // is the expensive, abuse-worthy operation Legacy limited to 5 per 15 min
  // ("metaapi-connect"). `[^/]+` matches Modern's account-id contract (ids are
  // opaque strings, not integers as in PHP).
  // TRD-06: Legacy throttled POST /accounts/{id}/sync at 20/300. It is a cheap
  // route (it enqueues; the WORKER does the provider call) but an unbounded one
  // would let a single user hammer the queue, so the bucket is carried over
  // verbatim now that the route exists.
  // Phase 5: the id-bearing support writes. `messages` and `reopen` mutate a
  // ticket's state (and `reopen` is the loop that could be used to re-open a
  // closed ticket forever), so they carry the same bucket as creation.
  { method: "POST", pattern: /^\/api\/v1\/support\/tickets\/[^/]+\/(messages|reopen)$/, key: "support:write" },
  { method: "POST", pattern: /^\/api\/v1\/admin\/communications\/tickets\/[^/]+\/(messages|status)$/, key: "support:write" },
  { method: "POST", pattern: /^\/api\/v1\/accounts\/[^/]+\/sync$/, key: "accounts:sync" },
  { method: "POST", pattern: /^\/api\/v1\/accounts\/[^/]+\/metaapi\/connect$/, key: "accounts:metaapi-connect" },
  // SEC-02: Legacy threw `admin-user-action` (30/300) inside the two handlers
  // that mutate a user — setStatus and setRole — rather than at dispatch. Modern
  // has the same two operations, so the same limit covers the same surface; the
  // ids are opaque strings here, hence a pattern rather than the exact map.
  { method: "PATCH", pattern: /^\/api\/v1\/admin\/users\/[^/]+\/role$/, key: "admin:user-action" },
  { method: "PATCH", pattern: /^\/api\/v1\/admin\/users\/[^/]+\/status$/, key: "admin:user-action" },
];

/** The bucket a request falls into, or undefined when the route is unthrottled. */
export function throttleKeyFor(method: string, path: string): RateLimitKey | undefined {
  const exact = THROTTLED_ROUTES[`${method} ${path}`];
  if (exact !== undefined) return exact;
  for (const rule of THROTTLED_PATTERN_ROUTES) {
    if (rule.method === method && rule.pattern.test(path)) return rule.key;
  }
  return undefined;
}

type RouteResult = { status: number; body: unknown; headers?: Record<string, string | string[]> };

class BodyParseError extends Error {}

/** Read + parse a JSON object body (1 MiB cap); {} when absent. */
async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_048_576) throw new BodyParseError("request body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BodyParseError("request body must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BodyParseError("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Bearer access-token authentication for protected routes (fail-closed).
 *
 * The returned `role` is trustworthy because it is read ONLY from a payload
 * whose HS256 signature has already been verified by the JWT service — a
 * client cannot supply or alter it. Any value outside the frozen OD-9 role set
 * degrades to the least-privileged role (normalizeRole), so a tampered or
 * future-dated claim can never escalate. Request body, query string and
 * arbitrary headers are NEVER consulted for authorization.
 */
function authenticateRequest(
  req: IncomingMessage,
  auth: AuthService,
): { sub: string; role: AppRole } | null {
  const bearer = req.headers.authorization;
  if (bearer === undefined || !bearer.startsWith("Bearer ")) return null;
  const payload = auth.verifyAccessToken(bearer.slice("Bearer ".length));
  if (payload === null) return null;
  return { sub: payload.sub, role: normalizeRole(payload.role) };
}

async function resolveAuthority(
  claims: { sub: string; role: AppRole } | null,
  ownership: OwnershipService | undefined,
): Promise<(AuthorityContext & { sub: string }) | null> {
  if (claims === null) return null;
  let isSystemOwner = false;
  if (ownership !== undefined) {
    const state = await ownership.status();
    isSystemOwner = state.claimed && state.ownerUserId === claims.sub;
  }
  return { sub: claims.sub, role: claims.role, isSystemOwner };
}

/**
 * Owner-aware authorization guard.
 *
 * Identical to requirePermission for ordinary roles; the System Owner satisfies
 * every permission, including ones that do not exist yet, because ownership is
 * the highest application authority rather than an enumerated role.
 */
function requireAuthority(
  authority: (AuthorityContext & { sub: string }) | null,
  permission: Permission,
  requestId: string,
): RouteResult | null {
  if (authority === null) {
    return { status: 401, body: fail("UNAUTHENTICATED", "Authentication required.", requestId) };
  }
  if (!canAct(authority, permission)) {
    return { status: 403, body: fail("FORBIDDEN", "Insufficient role.", requestId) };
  }
  return null;
}

function validationFailure(error: z.ZodError, requestId: string): RouteResult {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    details[issue.path.join(".") || "_"] = issue.message;
  }
  return { status: 400, body: fail("VALIDATION_FAILED", "Validation failed.", requestId, details) };
}

/** ApiConfig with the rate limiter materialized (createApp guarantees it). */
type EffectiveApiConfig = ApiConfig & { readonly rateLimiter: RateLimiter };

async function route(req: IncomingMessage, config: EffectiveApiConfig, sec: { requestId: string; nonce: string }): Promise<RouteResult> {
  // ---- Phase C identity route helpers (Remote-verified cookie/body contracts) ----
  // SEC-04 — the refresh credential's cookie contract, now Legacy's.
  //
  // Legacy (api/src/Core/Response.php, source-read) emits its refresh credential
  // as `__Host-velora_refresh` with Path=/, Secure, HttpOnly, SameSite=Strict.
  // Modern emitted `refresh_token` with SameSite=Lax. Two of those three
  // differences are security-relevant, so they are closed here:
  //
  //   * the `__Host-` PREFIX is enforced by the BROWSER, not by us: a cookie
  //     carrying it must be Secure, must have Path=/, and must have NO Domain,
  //     so a subdomain (or a MITM on a sibling subdomain) cannot overwrite it.
  //     That is strictly stronger than any attribute we can set by hand.
  //   * SameSite=Strict, not Lax: the refresh call is a same-site fetch, so the
  //     cookie is still sent on it, while a cross-site request can no longer
  //     carry it at all.
  //
  // RENAME TRANSITION: the old name is CLEARED alongside the new one (see
  // LEGACY_REFRESH_COOKIE_CLEAR) instead of being read as a fallback. A stale
  // cookie from the previous contract must not survive in any browser, and no
  // compatibility read path is introduced.
  const REFRESH_COOKIE_NAME = "__Host-velora_refresh";
  const LEGACY_REFRESH_COOKIE_NAME = "refresh_token";
  const REFRESH_COOKIE_MAX_AGE = 2_592_000; // 30 days (Remote + PHP jwt_refresh_ttl_sec)
  const REFRESH_COOKIE_ATTRS = "Path=/; HttpOnly; Secure; SameSite=Strict";
  const REFRESH_COOKIE_CLEAR = `${REFRESH_COOKIE_NAME}=; ${REFRESH_COOKIE_ATTRS}; Max-Age=0`;
  /** Expire the pre-SEC-04 cookie name so the rename leaves nothing behind. */
  const LEGACY_REFRESH_COOKIE_CLEAR = `${LEGACY_REFRESH_COOKIE_NAME}=; ${REFRESH_COOKIE_ATTRS}; Max-Age=0`;
  const refreshCookie = (token: string): string =>
    `${REFRESH_COOKIE_NAME}=${token}; ${REFRESH_COOKIE_ATTRS}; Max-Age=${REFRESH_COOKIE_MAX_AGE}`;
  const extractRefreshToken = (
    cookieHeader: string | undefined,
  ): string | undefined => {
    if (cookieHeader !== undefined) {
      for (const part of cookieHeader.split(";")) {
        const idx = part.indexOf("=");
        if (idx > 0 && part.slice(0, idx).trim() === REFRESH_COOKIE_NAME) {
          return part.slice(idx + 1).trim();
        }
      }
    }
    return undefined;
  };
  /** Legacy refreshTokenFromRequest: tokens longer than 128 chars are invalid,
   *  never routed to the store (AuthController.php:346, VERIFIED @ edede31). */
  const REFRESH_TOKEN_MAX_LENGTH = 128;
  const authRouteResult = (fn: (auth: AuthService) => Promise<RouteResult>): Promise<RouteResult> => {
    if (config.auth === undefined) {
      return Promise.resolve({
        status: 503,
        body: fail("SERVICE_UNAVAILABLE", "auth not configured", sec.requestId),
      });
    }
    return fn(config.auth).catch((err: unknown) => {
      if (err instanceof AuthError) {
        return { status: err.status, body: fail(err.code, err.message, sec.requestId, err.details) };
      }
      if (err instanceof BodyParseError) {
        return { status: 400, body: fail("VALIDATION_FAILED", err.message, sec.requestId) };
      }
      throw err;
    });
  };
  const url = new URL(req.url ?? "/", "http://internal");
  const method = req.method ?? "GET";
  const path = url.pathname;

  if (method === "GET" && path === "/health") {
    // PHP reference contract (OD-3, VERIFIED api/index.php:43-45): liveness with
    // data {status:'ok', time:<gmdate('c')>}. Durability is reported by /ready.
    return { status: 200, body: ok({ status: "ok", time: phpUtcTimestamp() }) };
  }

  if (method === "GET" && path === "/ready") {
    const db = await config.checks.database();
    const ready = db === "ok";
    return {
      status: ready ? 200 : 503,
      body: ok({ status: ready ? "ready" : "not_ready", checks: { database: db } }),
    };
  }

  // Public routes: locale routing + per-class cache policy (ADR-009)
  if (method === "GET") {
    const pub = resolvePublicRoute(path);
    if (pub) {
      return {
        status: 200,
        body: ok({ locale: pub.locale, routeClass: pub.routeClass }),
        headers: {
          [LOCALE_HEADER]: pub.locale,
          "Cache-Control": CACHE_POLICY[pub.routeClass],
        },
      };
    }
  }

  // SEC-04 edge gate: "is the presented refresh cookie a live session?"
  //
  // This exists because Legacy's HTML layer decided whether to serve a protected
  // page with a READ of the session table (locale-router.php: `SELECT … FROM
  // user_sessions … WHERE` before any protected file, 302 to the login page and
  // `no-store` otherwise, and the same answer when the query failed). Modern's
  // web tier has no database credentials by contract, so the question travels
  // over HTTP — and it must NOT be asked with POST /auth/refresh, which rotates
  // the token (a page view would then spend the 30/300 refresh bucket and turn
  // every navigation into a rotation event).
  //
  // READ-ONLY: no writes, no rotation, no auth event, no rate-limit bucket of
  // its own (it runs once per protected page load, which is exactly what Legacy
  // ran once per protected page load). `no-store` because the answer is a
  // function of the caller's credential.
  //
  // The response is deliberately narrow: `{authenticated, role|null}`. It names
  // the caller's OWN role because the admin-route gate needs it — the same
  // server-authoritative rule Legacy applied ("the Admin shell must never be
  // delivered to a signed-in non-admin, regardless of client-side guards").
  // No id, no email, no reason for a refusal: an anonymous visitor learns only
  // that they are not authenticated.
  if (method === "GET" && path === "/api/v1/auth/session") {
    return authRouteResult(async (auth) => {
      const probe = await auth.sessionProbe(extractRefreshToken(req.headers.cookie) ?? "");
      return {
        status: 200,
        body: ok(probe.authenticated ? { authenticated: true, role: probe.role } : { authenticated: false, role: null }),
        headers: { "Cache-Control": "no-store" },
      };
    });
  }

  // State-changing routes: same-origin guard (verified PHP behavior parity)
  if (method === "POST" && path === "/api/v1/auth/logout") {
    const origin = req.headers.origin;
    if (!originAllowed(origin, config.allowedOrigins)) {
      return { status: 403, body: fail("ORIGIN_REJECTED", "origin not allowed", sec.requestId) };
    }
    return authRouteResult(async (auth) => {
      const refreshToken = extractRefreshToken(req.headers.cookie);
      if (refreshToken !== undefined && refreshToken.length <= REFRESH_TOKEN_MAX_LENGTH) {
        await auth.logout(refreshToken);
      }
      return {
        status: 200,
        body: ok({ loggedOut: true }),
        headers: { "Set-Cookie": [REFRESH_COOKIE_CLEAR, LEGACY_REFRESH_COOKIE_CLEAR] },
      };
    });
  }

  // ---- Rate limiting (inc 7 + SEC-02 — PHP dispatch-level, C-14 limits) ----
  // PHP parity: applied BEFORE validation/auth/capability checks — attempts
  // count even when the request would fail them (brute-force semantics).
  const throttleKey = throttleKeyFor(method, path);
  if (throttleKey !== undefined) {
    const xffHeader = req.headers["x-forwarded-for"];
    const clientIp = resolveClientIp(
      {
        remoteAddress: req.socket.remoteAddress,
        xForwardedFor: Array.isArray(xffHeader) ? xffHeader[0] : xffHeader,
      },
      config.trustedProxyCidrs ?? [],
    );
    let decision: RateLimitDecision;
    try {
      decision = await config.rateLimiter.hit(throttleKey, clientIp);
    } catch {
      // Fail-closed (Remote non-test invariant + PHP ServiceUnavailableException):
      // a broken limiter store must never silently disable throttling.
      return { status: 503, body: fail("SERVICE_UNAVAILABLE", "rate limiter unavailable", sec.requestId) };
    }
    if (!decision.allowed) {
      return {
        status: 429,
        body: fail("TOO_MANY_REQUESTS", "Too many requests.", sec.requestId, {
          messageKey: "errors.rateLimited",
        }),
        headers: { "Retry-After": String(decision.retryAfterSec) },
      };
    }
  }

  // ---- v3.0 developer-key authentication (secondary credential class) -------
  // Runs BEFORE every authenticated branch, and before any body is read.
  //
  // A request carrying a developer key is either accepted for its scoped
  // surface (and then continues as that key's OWNER, at the least privileged
  // role) or terminated here — it never falls through to session verification,
  // so a revoked key cannot be reinterpreted as anything else. A request whose
  // bearer is not key-shaped is untouched, so the Phase C session path is
  // byte-for-byte what it was.
  let developerPrincipal: { sub: string; role: AppRole } | null = null;
  if (config.developerKeys !== undefined) {
    const decision = await config.developerKeys.guard({
      req,
      method,
      path,
      requestId: sec.requestId,
    });
    if (decision.blocked !== null) return decision.blocked;
    developerPrincipal = decision.principal;
  }
  /**
   * The single identity resolver for every protected branch below.
   *
   * `developerPrincipal` can only be non-null for a route the guard verified to
   * be inside the developer surface WITH the matching scope, so no branch needs
   * a second check — the guard is the authorization point, this function is only
   * how the result reaches the route.
   */
  const principalFor = (): { sub: string; role: AppRole } | null =>
    developerPrincipal ?? (config.auth === undefined ? null : authenticateRequest(req, config.auth));

  // ---- Phase C identity routes (Remote/PHP-verified contracts) ----
  if (method === "POST" && path === "/api/v1/auth/register") {
    return authRouteResult(async (auth) => {
      const body = await parseJsonBody(req);
      const parsed = registerRequest.safeParse(body);
      if (!parsed.success) return validationFailure(parsed.error, sec.requestId);
      const result = await auth.register(parsed.data);
      return { status: 201, body: ok(result) };
    });
  }

  if (method === "POST" && path === "/api/v1/auth/login") {
    return authRouteResult(async (auth) => {
      const body = await parseJsonBody(req);
      const parsed = loginRequest.safeParse(body);
      if (!parsed.success) return validationFailure(parsed.error, sec.requestId);
      const { refreshToken, ...tokens } = await auth.login({
        email: parsed.data.email,
        password: parsed.data.password,
        userAgent: req.headers["user-agent"],
      });
      return {
        status: 200,
        body: ok({ tokens }), // refresh credential only in the cookie, never the body
        headers: { "Set-Cookie": [refreshCookie(refreshToken), LEGACY_REFRESH_COOKIE_CLEAR] },
      };
    });
  }

  if (method === "POST" && path === "/api/v1/auth/refresh") {
    return authRouteResult(async (auth) => {
      // S1 closure: the refresh credential is accepted ONLY from the HttpOnly
      // cookie — the request body is never a token source. Legacy's body
      // exchange was a time-boxed 7-day migration window
      // (auth.legacy_body_refresh_enabled, AuthController.php:352-386) that has
      // long expired; its standing behavior is cookie-only, and so is this.
      const refreshToken = extractRefreshToken(req.headers.cookie);
      if (refreshToken === undefined) {
        return {
          status: 401,
          body: fail("REFRESH_COOKIE_MISSING", "Refresh cookie is missing.", sec.requestId),
          headers: { "Set-Cookie": [REFRESH_COOKIE_CLEAR, LEGACY_REFRESH_COOKIE_CLEAR] },
        };
      }
      if (refreshToken.length > REFRESH_TOKEN_MAX_LENGTH) {
        return {
          status: 401,
          body: fail("INVALID_TOKEN", "Invalid token.", sec.requestId),
          headers: { "Set-Cookie": [REFRESH_COOKIE_CLEAR, LEGACY_REFRESH_COOKIE_CLEAR] },
        };
      }
      try {
        const { refreshToken: rotated, ...tokens } = await auth.refresh(
          refreshToken,
          undefined,
          req.headers["user-agent"],
        );
        return {
          status: 200,
          body: ok({ tokens }),
          headers: { "Set-Cookie": [refreshCookie(rotated), LEGACY_REFRESH_COOKIE_CLEAR] },
        };
      } catch (err) {
        // Remote-verified: any refresh failure clears the HttpOnly cookie.
        if (err instanceof AuthError) {
          return {
            status: err.status,
            body: fail(err.code, err.message, sec.requestId, err.details),
            headers: { "Set-Cookie": [REFRESH_COOKIE_CLEAR, LEGACY_REFRESH_COOKIE_CLEAR] },
          };
        }
        throw err;
      }
    });
  }

  if (method === "POST" && path === "/api/v1/auth/verify-email") {
    return authRouteResult(async (auth) => {
      const body = await parseJsonBody(req);
      const parsed = z.object({ token: z.string().min(20) }).safeParse(body);
      if (!parsed.success) return validationFailure(parsed.error, sec.requestId);
      const result = await auth.verifyEmail(parsed.data.token);
      return { status: 200, body: ok(result) };
    });
  }

  // --- Phase 3B-1: password reset + verification resend ---------------------

  if (method === "POST" && path === "/api/v1/auth/resend-verification") {
    return authRouteResult(async (auth) => {
      const body = await parseJsonBody(req);
      const parsed = z.object({ email: z.string().email() }).safeParse(body);
      if (!parsed.success) return validationFailure(parsed.error, sec.requestId);
      const result = await auth.resendVerification({ email: parsed.data.email });
      return { status: 200, body: ok(result) };
    });
  }

  if (method === "POST" && path === "/api/v1/auth/forgot-password") {
    return authRouteResult(async (auth) => {
      const body = await parseJsonBody(req);
      const parsed = z.object({ email: z.string().email() }).safeParse(body);
      if (!parsed.success) return validationFailure(parsed.error, sec.requestId);
      const result = await auth.forgotPassword({ email: parsed.data.email });
      return { status: 200, body: ok(result) };
    });
  }

  if (method === "POST" && path === "/api/v1/auth/reset-password") {
    return authRouteResult(async (auth) => {
      const body = await parseJsonBody(req);
      const parsed = z
        .object({ token: z.string().min(20), newPassword: z.string().min(1) })
        .safeParse(body);
      if (!parsed.success) return validationFailure(parsed.error, sec.requestId);
      const result = await auth.resetPassword({
        token: parsed.data.token,
        newPassword: parsed.data.newPassword,
      });
      return { status: 200, body: ok(result) };
    });
  }

  if (method === "GET" && path === "/api/v1/auth/me") {
    return authRouteResult(async (auth) => {
      const bearer = req.headers.authorization;
      if (bearer === undefined || !bearer.startsWith("Bearer ")) {
        return { status: 401, body: fail("UNAUTHENTICATED", "Unauthenticated.", sec.requestId) };
      }
      const payload = auth.verifyAccessToken(bearer.slice("Bearer ".length));
      if (payload === null) {
        return { status: 401, body: fail("UNAUTHENTICATED", "Unauthenticated.", sec.requestId) };
      }
      const user = await auth.me(payload.sub);
      return { status: 200, body: ok({ user }) };
    });
  }

  // ---- Phase C increment 2: identity completion (Remote/PHP-verified) ----
  if (method === "POST" && path === "/api/v1/auth/change-password") {
    return authRouteResult(async (auth) => {
      const claims = authenticateRequest(req, auth);
      if (claims === null) {
        return { status: 401, body: fail("UNAUTHENTICATED", "Unauthenticated.", sec.requestId) };
      }
      const body = await parseJsonBody(req);
      if (typeof body.currentPassword !== "string" || typeof body.newPassword !== "string") {
        return {
          status: 400,
          body: fail("VALIDATION_FAILED", "Current password and new password are required.", sec.requestId, {
            ...(body.currentPassword === undefined ? { currentPassword: "Current password is required." } : {}),
            ...(body.newPassword === undefined ? { newPassword: "New password is required." } : {}),
          }),
        };
      }
      const result = await auth.changePassword(claims.sub, {
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
      });
      return { status: 200, body: ok(result) };
    });
  }

  if (method === "PATCH" && path === "/api/v1/auth/me/preferences") {
    return authRouteResult(async (auth) => {
      const claims = authenticateRequest(req, auth);
      if (claims === null) {
        return { status: 401, body: fail("UNAUTHENTICATED", "Unauthenticated.", sec.requestId) };
      }
      const body = await parseJsonBody(req);
      const locale = body.locale;
      const aiConsent = body.ai_consent;
      if (locale === undefined && aiConsent === undefined) {
        return {
          status: 400,
          body: fail("VALIDATION_FAILED", "No valid preference field provided.", sec.requestId),
        };
      }
      if (locale !== undefined && locale !== "fa" && locale !== "en") {
        return {
          status: 400,
          body: fail("VALIDATION_FAILED", "locale must be fa or en.", sec.requestId, { locale: "locale must be fa or en." }),
        };
      }
      if (aiConsent !== undefined && typeof aiConsent !== "boolean") {
        return {
          status: 400,
          body: fail("VALIDATION_FAILED", "ai_consent must be a boolean.", sec.requestId, { ai_consent: "ai_consent must be a boolean." }),
        };
      }
      const result = await auth.updatePreferences(claims.sub, {
        ...(locale !== undefined ? { locale } : {}),
        ...(aiConsent !== undefined ? { ai_consent: aiConsent } : {}),
      });
      return { status: 200, body: ok(result) };
    });
  }

  if (method === "GET" && path === "/api/v1/auth/email-preferences") {
    return authRouteResult(async (auth) => {
      const claims = authenticateRequest(req, auth);
      if (claims === null) {
        return { status: 401, body: fail("UNAUTHENTICATED", "Unauthenticated.", sec.requestId) };
      }
      return { status: 200, body: ok(await auth.getEmailPreferences(claims.sub)) };
    });
  }

  if (method === "PUT" && path === "/api/v1/auth/email-preferences") {
    return authRouteResult(async (auth) => {
      const claims = authenticateRequest(req, auth);
      if (claims === null) {
        return { status: 401, body: fail("UNAUTHENTICATED", "Unauthenticated.", sec.requestId) };
      }
      const body = await parseJsonBody(req);
      const result = await auth.updateEmailPreferences(claims.sub, body);
      return { status: 200, body: ok(result) };
    });
  }

  // ---- Phase C increment 2 (wave 3): accounts (ownership-scoped resource) ----
  const accountsRoute = (fn: (accounts: AccountService, claims: { sub: string }) => Promise<RouteResult>): Promise<RouteResult> => {
    if (config.auth === undefined || config.accounts === undefined) {
      return Promise.resolve({
        status: 503,
        body: fail("SERVICE_UNAVAILABLE", "accounts not configured", sec.requestId),
      });
    }
    const claims = principalFor();
    if (claims === null) {
      return Promise.resolve({
        status: 401,
        body: fail("UNAUTHENTICATED", "Unauthenticated.", sec.requestId),
      });
    }
    return fn(config.accounts, claims).catch((err: unknown) => {
      if (err instanceof AccountError) {
        return { status: err.status, body: fail(err.code, err.message, sec.requestId, err.details) };
      }
      if (err instanceof EntitlementError) {
        // fail-closed plan/entitlement lookup failures surface as their own status
        return { status: err.status, body: fail(err.code, err.message, sec.requestId, err.details) };
      }
      if (err instanceof AuthError) {
        return { status: err.status, body: fail(err.code, err.message, sec.requestId, err.details) };
      }
      throw err;
    });
  };

  if (method === "GET" && path === "/api/v1/accounts") {
    return accountsRoute(async (accounts, claims) => {
      const list = await accounts.listAccounts(claims.sub);
      return { status: 200, body: ok({ accounts: list }) };
    });
  }

  if (method === "POST" && path === "/api/v1/accounts") {
    return accountsRoute(async (accounts, claims) => {
      const body = await parseJsonBody(req);
      const account = await accounts.createAccount(claims.sub, body);
      return { status: 201, body: ok({ account }) };
    });
  }

  if (method === "POST" && path === "/api/v1/accounts/detect-server") {
    return accountsRoute(async (accounts) => {
      const body = await parseJsonBody(req);
      const login = body.mt_login ?? body.accountNumber;
      const result = accounts.detectServer(login);
      return { status: 200, body: ok(result) };
    });
  }

  if (method === "PATCH" && /^\/api\/v1\/accounts\/[^/]+\/timezone$/.test(path)) {
    return accountsRoute(async (accounts, claims) => {
      const id = decodeURIComponent(path.split("/")[4] ?? "");
      const body = await parseJsonBody(req);
      const account = await accounts.updateTimezone(id, claims.sub, body.timezone);
      return { status: 200, body: ok({ account }) };
    });
  }

  if (method === "DELETE" && /^\/api\/v1\/accounts\/[^/]+$/.test(path)) {
    return accountsRoute(async (accounts, claims) => {
      const id = decodeURIComponent(path.split("/")[4] ?? "");
      const result = await accounts.deleteAccount(id, claims.sub);
      return { status: 200, body: ok(result) };
    });
  }

  // ---- MetaAPI provisioning / binding (OD-MP-1, OD-MP-3) -------------------
  //
  // OWNERSHIP, NOT RBAC — the same rule the credential routes use, and for the
  // same reason (ADR-016): this server resolves a System Owner who satisfies
  // every permission, so a permission check here would hand that owner the
  // ability to spend another user's broker credential. The owner is ALWAYS
  // `claims.sub`, and NO route accepts a user id from the client.
  const provisioningRoute = (
    fn: (
      provisioning: MetaApiProvisioningService,
      claims: { sub: string },
    ) => Promise<RouteResult>,
  ): Promise<RouteResult> => {
    if (config.auth === undefined || config.provisioning === undefined) {
      return Promise.resolve({
        status: 503,
        body: fail("SERVICE_UNAVAILABLE", "provisioning not configured", sec.requestId),
      });
    }
    const claims = principalFor();
    if (claims === null) {
      return Promise.resolve({
        status: 401,
        body: fail("UNAUTHENTICATED", "Unauthenticated.", sec.requestId),
      });
    }
    return fn(config.provisioning, claims).catch((err: unknown) => {
      if (err instanceof ProvisioningServiceError) {
        return { status: err.status, body: fail(err.code, err.message, sec.requestId, err.details) };
      }
      throw err;
    });
  };

  if (method === "POST" && /^\/api\/v1\/accounts\/[^/]+\/metaapi\/connect$/.test(path)) {
    return provisioningRoute(async (provisioning, claims) => {
      const id = decodeURIComponent(path.split("/")[4] ?? "");
      const body = await parseJsonBody(req);
      // claims.sub is the ONLY identity source; `id` is validated by ownership
      // inside the service, never trusted from the path alone.
      const result = await provisioning.connect({ id: claims.sub, requestId: sec.requestId }, id, body);
      return { status: 200, body: ok(result) };
    });
  }

  if (method === "POST" && /^\/api\/v1\/accounts\/[^/]+\/metaapi\/disconnect$/.test(path)) {
    return provisioningRoute(async (provisioning, claims) => {
      const id = decodeURIComponent(path.split("/")[4] ?? "");
      const body = await parseJsonBody(req);
      const result = await provisioning.disconnect(
        { id: claims.sub, requestId: sec.requestId },
        id,
        body,
      );
      return { status: 200, body: ok(result) };
    });
  }

  // ---- Credentials (B-1: authenticated self-service over the C-22 store) ----
  //
  // OWNERSHIP, NOT RBAC. These routes are gated on AUTHENTICATION only and the
  // owner is always `claims.sub`. That is deliberate and load-bearing: this
  // server resolves a System Owner who satisfies EVERY permission, so gating
  // credentials behind a permission check would silently hand the System Owner
  // access to other users' secrets. Ownership is the only authorization rule
  // here (ADR-016), so no route accepts a user id from the client.
  //
  // There is NO reveal route: secret disclosure has no production consumer yet.
  const credentialsRoute = (
    fn: (credentials: CredentialService, claims: { sub: string }) => Promise<RouteResult>,
  ): Promise<RouteResult> => {
    if (config.auth === undefined || config.credentials === undefined) {
      return Promise.resolve({
        status: 503,
        body: fail("SERVICE_UNAVAILABLE", "credentials not configured", sec.requestId),
      });
    }
    const claims = principalFor();
    if (claims === null) {
      return Promise.resolve({
        status: 401,
        body: fail("UNAUTHENTICATED", "Unauthenticated.", sec.requestId),
      });
    }
    return fn(config.credentials, claims).catch((err: unknown) => {
      if (err instanceof CredentialError) {
        return { status: err.status, body: fail(err.code, err.message, sec.requestId, err.details) };
      }
      throw err;
    });
  };

  if (method === "GET" && path === "/api/v1/credentials") {
    return credentialsRoute(async (credentials, claims) => {
      const list = await credentials.listCredentials({ id: claims.sub, requestId: sec.requestId });
      return { status: 200, body: ok({ credentials: list }) };
    });
  }

  if (method === "POST" && path === "/api/v1/credentials") {
    return credentialsRoute(async (credentials, claims) => {
      const body = await parseJsonBody(req);
      const credential = await credentials.createCredential(
        { id: claims.sub, requestId: sec.requestId },
        body,
      );
      return { status: 201, body: ok({ credential }) };
    });
  }

  if (method === "DELETE" && /^\/api\/v1\/credentials\/[^/]+$/.test(path)) {
    return credentialsRoute(async (credentials, claims) => {
      const id = decodeURIComponent(path.split("/")[4] ?? "");
      const result = await credentials.deleteCredential(
        { id: claims.sub, requestId: sec.requestId },
        id,
      );
      return { status: 200, body: ok(result) };
    });
  }

  // ---- Trades (Phase C increment 3; ADR-002 ledger) ----------------------
  const tradesRoute = (fn: (trades: TradeService, claims: { sub: string }) => Promise<RouteResult>): Promise<RouteResult> => {
    if (config.auth === undefined || config.trades === undefined) {
      return Promise.resolve({
        status: 503,
        body: fail("SERVICE_UNAVAILABLE", "trades not configured", sec.requestId),
      });
    }
    const claims = principalFor();
    if (claims === null) {
      return Promise.resolve({
        status: 401,
        body: fail("UNAUTHENTICATED", "Unauthenticated.", sec.requestId),
      });
    }
    return fn(config.trades, claims).catch((err: unknown) => {
      if (err instanceof TradeError) {
        return { status: err.status, body: fail(err.code, err.message, sec.requestId, err.details) };
      }
      if (err instanceof AuthError) {
        return { status: err.status, body: fail(err.code, err.message, sec.requestId, err.details) };
      }
      throw err;
    });
  };

  // NOTE: /trades/symbols and /trades/exits/:exitId are matched BEFORE the
  // generic /trades/:id pattern (PHP route-order evidence, api/index.php).
  if (method === "GET" && path === "/api/v1/trades") {
    return tradesRoute(async (trades, claims) => {
      const q = url.searchParams;
      const result = await trades.searchTrades(claims.sub, {
        symbol: q.get("symbol") ?? undefined,
        direction: q.get("direction") ?? undefined,
        from: q.get("from") ?? undefined,
        to: q.get("to") ?? undefined,
        q: q.get("q") ?? undefined, // journal search (PHP evidence): symbol | strategy | notes
        order: q.get("order") ?? undefined, // PHP whitelist: open_time|close_time|profit_loss
        page: q.get("page") ?? undefined,
        limit: q.get("limit") ?? undefined,
      });
      return { status: 200, body: ok(result) };
    });
  }

  if (method === "POST" && path === "/api/v1/trades") {
    return tradesRoute(async (trades, claims) => {
      const body = await parseJsonBody(req);
      const trade = await trades.createTrade(claims.sub, body);
      return { status: 201, body: ok(trade) };
    });
  }

  if (method === "GET" && path === "/api/v1/trades/symbols") {
    return tradesRoute(async (trades, claims) => {
      return { status: 200, body: ok(await trades.listSymbols(claims.sub)) };
    });
  }

  if (method === "DELETE" && /^\/api\/v1\/trades\/exits\/[^/]+$/.test(path)) {
    return tradesRoute(async (trades, claims) => {
      const exitId = decodeURIComponent(path.split("/")[5] ?? "");
      const result = await trades.deleteExit(exitId, claims.sub);
      return { status: 200, body: ok(result) };
    });
  }

  if (method === "GET" && /^\/api\/v1\/trades\/[^/]+$/.test(path)) {
    return tradesRoute(async (trades, claims) => {
      const id = decodeURIComponent(path.split("/")[4] ?? "");
      return { status: 200, body: ok(await trades.getTrade(id, claims.sub)) };
    });
  }

  if (method === "PUT" && /^\/api\/v1\/trades\/[^/]+$/.test(path)) {
    return tradesRoute(async (trades, claims) => {
      const id = decodeURIComponent(path.split("/")[4] ?? "");
      const body = await parseJsonBody(req);
      return { status: 200, body: ok(await trades.updateTrade(id, claims.sub, body)) };
    });
  }

  if (method === "DELETE" && /^\/api\/v1\/trades\/[^/]+$/.test(path)) {
    return tradesRoute(async (trades, claims) => {
      const id = decodeURIComponent(path.split("/")[4] ?? "");
      // OD-2: optimistic concurrency is mandatory on delete. The expected
      // version may arrive as `If-Match` or as a JSON body `version`.
      const ifMatch = req.headers["if-match"];
      const headerVersion = typeof ifMatch === "string" ? ifMatch.replace(/^W\/|"/g, "").trim() : undefined;
      const body = await parseJsonBody(req).catch(() => ({}) as Record<string, unknown>);
      const expected = headerVersion !== undefined && headerVersion !== "" ? headerVersion : body.version;
      await trades.deleteTrade(id, claims.sub, expected);
      // OD-2: successful tombstone => 204 No Content (empty body).
      return { status: 204, body: null };
    });
  }

  if (method === "GET" && /^\/api\/v1\/trades\/[^/]+\/exits$/.test(path)) {
    return tradesRoute(async (trades, claims) => {
      const id = decodeURIComponent(path.split("/")[4] ?? "");
      return { status: 200, body: ok(await trades.listExits(id, claims.sub)) };
    });
  }

  if (method === "POST" && /^\/api\/v1\/trades\/[^/]+\/exits$/.test(path)) {
    return tradesRoute(async (trades, claims) => {
      const id = decodeURIComponent(path.split("/")[4] ?? "");
      const body = await parseJsonBody(req);
      return { status: 201, body: ok(await trades.createExit(id, claims.sub, body)) };
    });
  }

  // ---- Phase 3B-3: application RBAC (OD-9) ----------------------------------
  // Strictly READ-ONLY diagnostics. No user management, no role mutation, no
  // state change of any kind — Phase 3B-4 owns administrative user operations.
  // These exist so the authorization primitive is observable and testable
  // rather than dormant, and they enforce server-side.

  // Caller's own effective authority. Every authenticated role may read this.
  if (method === "GET" && path === "/api/v1/admin/rbac/self") {
    if (config.auth === undefined) {
      return { status: 503, body: fail("SERVICE_UNAVAILABLE", "auth not configured", sec.requestId) };
    }
    const claims = principalFor();
    const authority = await resolveAuthority(claims, config.ownership);
    const denied = requireAuthority(authority, "rbac.self.view", sec.requestId);
    if (denied !== null) return denied;
    return {
      status: 200,
      body: ok({
        role: authority!.role,
        isSystemOwner: authority!.isSystemOwner,
        permissions: authorityPermissions(authority!),
      }),
    };
  }

  // Full role/permission matrix — super_admin only (the smallest honest
  // example of an operation an `admin` must NOT reach).
  if (method === "GET" && path === "/api/v1/admin/rbac/matrix") {
    if (config.auth === undefined) {
      return { status: 503, body: fail("SERVICE_UNAVAILABLE", "auth not configured", sec.requestId) };
    }
    const claims = principalFor();
    const authority = await resolveAuthority(claims, config.ownership);
    const denied = requireAuthority(authority, "rbac.matrix.view", sec.requestId);
    if (denied !== null) return denied;
    return {
      status: 200,
      body: ok({
        roles: APP_ROLES,
        permissions: Object.fromEntries(APP_ROLES.map((r: AppRole) => [r, permissionsFor(r)])),
      }),
    };
  }

  // ---- Admin user management (Phase 3B-4) --------------------------------
  // Two independent layers run on every one of these routes:
  //   1. requireAuthority(...)  — may this AUTHORITY (role, or System Owner)
  //      reach the operation at all?
  //   2. AdminUserService guards — is this ACTOR allowed to act on this TARGET?
  // A permission bit cannot express the pair-rules (self-action, privileged
  // target, escalation), so neither layer is redundant.
  const adminUsersRoute = (
    permission: Permission,
    fn: (svc: AdminUserService, actor: ActorContext) => Promise<RouteResult>,
  ): Promise<RouteResult> => {
    if (config.auth === undefined || config.adminUsers === undefined) {
      return Promise.resolve({
        status: 503,
        body: fail("SERVICE_UNAVAILABLE", "admin user management not configured", sec.requestId),
      });
    }
    const claims = principalFor();
    // Ownership is resolved from storage; the System Owner passes every
    // permission check even though their stored RBAC role may be `admin`.
    return resolveAuthority(claims, config.ownership)
      .then((authority) => {
        const denied = requireAuthority(authority, permission, sec.requestId);
        if (denied !== null) return denied;
        return fn(config.adminUsers!, {
          id: authority!.sub,
          role: authority!.role,
          isSystemOwner: authority!.isSystemOwner,
          // C-34 correlation id — server-generated per request, audit metadata
          // only. Never read from the client.
          requestId: sec.requestId,
        });
      })
      .catch(
      (err: unknown) => {
        if (err instanceof AuthError) {
          return {
            status: err.status,
            body: fail(err.code, err.message, sec.requestId, err.details),
          };
        }
        throw err;
      },
    );
  };

  if (method === "GET" && path === "/api/v1/admin/users") {
    return adminUsersRoute("users.view", async (svc) => {
      const q = url.searchParams;
      const num = (raw: string | null): number | undefined =>
        raw === null || raw.trim() === "" || !Number.isFinite(Number(raw))
          ? undefined
          : Number(raw);
      const str = (raw: string | null): string | undefined => (raw === null ? undefined : raw);
      const result = await svc.listUsers({
        ...(str(q.get("search")) !== undefined ? { search: str(q.get("search"))! } : {}),
        ...(str(q.get("role")) !== undefined ? { role: str(q.get("role"))! } : {}),
        ...(str(q.get("status")) !== undefined ? { status: str(q.get("status"))! } : {}),
        ...(num(q.get("page")) !== undefined ? { page: num(q.get("page"))! } : {}),
        ...(num(q.get("perPage")) !== undefined ? { perPage: num(q.get("perPage"))! } : {}),
      });
      return { status: 200, body: ok(result) };
    });
  }

  if (method === "GET" && /^\/api\/v1\/admin\/users\/[^/]+$/.test(path)) {
    return adminUsersRoute("users.view", async (svc) => {
      const id = decodeURIComponent(path.split("/")[5] ?? "");
      return { status: 200, body: ok({ user: await svc.getUser(id) }) };
    });
  }

  // SEC-03 — a user's authentication history, for the admin review surface.
  //
  // The capability is Legacy's `GET /api/v1/admin/users/{id}/login-history`
  // (UserManagementController::loginHistory + AuthEventRepository::listForUser),
  // including its three contract details: the target must exist (404 otherwise),
  // the `result` filter is a closed vocabulary (anything else is a validation
  // error, not a silently empty page), and pagination is bounded 1..100.
  //
  // ONE DELIBERATE DIVERGENCE, recorded in the capability document: Legacy
  // returned raw IP/user-agent to any holder of `users.view` on this endpoint
  // while it masked them for plain admins on the GLOBAL login listing (its
  // decision D3: a super_admin-only sensitive view). Modern applies the SAME
  // rule here, because "who may see the raw address" should not depend on which
  // of two endpoints the reviewer happened to open: the fields are omitted from
  // the response body itself for non-super_admin callers (never hidden in the
  // client), while super_admin and the System Owner receive them.
  if (method === "GET" && /^\/api\/v1\/admin\/users\/[^/]+\/login-history$/.test(path)) {
    if (config.authEvents === undefined) {
      return {
        status: 503,
        body: fail("SERVICE_UNAVAILABLE", "auth events not configured", sec.requestId),
      };
    }
    const authEvents = config.authEvents;
    return adminUsersRoute("users.view", async (svc, actor) => {
      const id = decodeURIComponent(path.split("/")[5] ?? "");
      // Existence first: a missing user is a 404, NOT an empty history.
      await svc.getUser(id);

      const q = url.searchParams;
      const rawResult = q.get("result");
      const resultFilter =
        rawResult === null || rawResult.trim() === "" ? undefined : rawResult.trim();
      if (resultFilter !== undefined && resultFilter !== "success" && resultFilter !== "failure") {
        return {
          status: 400,
          body: fail("VALIDATION_FAILED", "Invalid result filter.", sec.requestId, {
            result: "INVALID_CHOICE",
          }),
        };
      }
      const num = (raw: string | null): number | undefined => {
        if (raw === null || raw.trim() === "" || !Number.isFinite(Number(raw))) return undefined;
        return Number(raw);
      };
      const page = await authEvents.listForUser(id, {
        ...(num(q.get("page")) !== undefined ? { page: num(q.get("page"))! } : {}),
        ...(num(q.get("perPage")) !== undefined ? { perPage: num(q.get("perPage"))! } : {}),
        ...(resultFilter !== undefined ? { result: resultFilter } : {}),
      });

      const maySeeSensitive = actor.isSystemOwner || actor.role === "super_admin";
      return {
        status: 200,
        body: ok({
          events: page.events.map((e) => ({
            id: e.id,
            eventType: e.eventType,
            result: e.result,
            reason: e.reason,
            createdAt: e.occurredAt,
            // Omitted (not null) for a caller who may not see them, so the
            // response cannot be mistaken for "the address was not recorded".
            ...(maySeeSensitive ? { ipAddress: e.ipAddress, userAgent: e.userAgent } : {}),
          })),
          pagination: {
            total: page.total,
            page: page.page,
            perPage: page.perPage,
            hasMore: page.page * page.perPage < page.total,
          },
        }),
      };
    });
  }

  // Role assignment is the privilege-granting operation: super_admin only.
  if (method === "PATCH" && /^\/api\/v1\/admin\/users\/[^/]+\/role$/.test(path)) {
    return adminUsersRoute("users.change_role", async (svc, actor) => {
      const id = decodeURIComponent(path.split("/")[5] ?? "");
      const body = await parseJsonBody(req);
      const result = await svc.setRole(id, String(body.role ?? ""), actor);
      return { status: 200, body: ok(result) };
    });
  }

  if (method === "PATCH" && /^\/api\/v1\/admin\/users\/[^/]+\/status$/.test(path)) {
    return adminUsersRoute("users.manage_status", async (svc, actor) => {
      const id = decodeURIComponent(path.split("/")[5] ?? "");
      const body = await parseJsonBody(req);
      const result = await svc.setStatus(id, String(body.status ?? ""), actor);
      return { status: 200, body: ok(result) };
    });
  }

  // ---- System Owner bootstrap (installation-level ownership) --------------
  // Ownership is NOT an RBAC role and is NOT reachable through role assignment.
  // There is deliberately no permission that grants ownership: the ONLY path is
  // this one-time claim, which the database permanently closes after it wins.

  // Whether ownership has been claimed. Readable by any authenticated caller so
  // a setup UI can branch; exposes no secret and no password state.
  if (method === "GET" && path === "/api/v1/admin/ownership/status") {
    if (config.auth === undefined || config.ownership === undefined) {
      return {
        status: 503,
        body: fail("SERVICE_UNAVAILABLE", "ownership not configured", sec.requestId),
      };
    }
    const claims = principalFor();
    if (claims === null) {
      return { status: 401, body: fail("UNAUTHENTICATED", "Authentication required.", sec.requestId) };
    }
    return { status: 200, body: ok(await config.ownership.status()) };
  }

  // The one-time claim. Authorization is NOT a permission check: eligibility is
  // re-derived from the PERSISTED user row inside the service, so a stale or
  // forged JWT role cannot influence it. Only the token SUBJECT is trusted here.
  if (method === "POST" && path === "/api/v1/admin/ownership/claim") {
    if (config.auth === undefined || config.ownership === undefined) {
      return {
        status: 503,
        body: fail("SERVICE_UNAVAILABLE", "ownership not configured", sec.requestId),
      };
    }
    const claims = principalFor();
    if (claims === null) {
      return { status: 401, body: fail("UNAUTHENTICATED", "Authentication required.", sec.requestId) };
    }
    const body = await parseJsonBody(req);
    const xff = req.headers["x-forwarded-for"];
    const ua = req.headers["user-agent"];
    try {
      // Only actorId (from the verified token), password and confirm are read.
      // Any client-supplied role / ownerUserId / system_owner field in the body
      // is ignored entirely — it is never passed on and never consulted.
      const result = await config.ownership.claim({
        actorId: claims.sub,
        password: typeof body.password === "string" ? body.password : "",
        confirm: typeof body.confirm === "string" ? body.confirm : "",
        ipAddress: resolveClientIp(
          {
            remoteAddress: req.socket.remoteAddress,
            xForwardedFor: Array.isArray(xff) ? xff[0] : xff,
          },
          config.trustedProxyCidrs ?? [],
        ),
        userAgent: typeof ua === "string" ? ua : null,
        requestId: sec.requestId, // C-34 correlation id (server-generated)
      });
      return { status: 201, body: ok(result) };
    } catch (err: unknown) {
      if (err instanceof AuthError) {
        return { status: err.status, body: fail(err.code, err.message, sec.requestId, err.details) };
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------------
  // Backend migration (directive t) — delegated capability surface.
  //
  // Placed immediately BEFORE the terminal 404 so the Phase C routes above keep
  // precedence and a migrated handler can never shadow an existing route. A
  // handler returns `null` for the (method, path) pairs it does not own, and
  // control falls through to the 404 exactly as before.
  //
  // The context exposes only what a migrated route needs: the verified bearer
  // claims (reusing THIS function's single verification implementation), the
  // kernel's body readers, and the System Owner predicate. No route re-derives
  // identity, and no route reads ownership state directly.
  // ------------------------------------------------------------------------
  // ---- Debug helper (development only): create a pre-verified user for UI E2E ----
  // Gated on APP_ENV=development; never reachable in staging/production boot.
  if (process.env.APP_ENV === "development" && method === "POST" && url.pathname === "/api/v1/debug/create-verified-user") {
    try {
      const body = await parseJsonBody(req);
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const fullName = typeof body.fullName === "string" ? body.fullName : "Debug User";
      const locale = body.locale === "en" ? "en" : "fa";
      if (!email || !password) return { status: 400, body: fail("VALIDATION_FAILED", "email and password required", sec.requestId) };
      const authAny: any = config.auth;
      const store: any = authAny?.deps?.store;
      if (!store) return { status: 503, body: fail("SERVICE_UNAVAILABLE", "user store unavailable", sec.requestId) };
      let user = await store.findUserByEmail(email);
      if (!user) {
        const { VeloraHasher } = await import("../auth/hashing.js");
        const hash = await new VeloraHasher().hash(password);
        user = await store.createUser({ email, passwordHash: hash, fullName, timezone: "UTC", locale, now: new Date() });
      }
      await store.markEmailVerified(user.id, new Date());
      if (store.deleteVerifications) await store.deleteVerifications(user.id).catch(() => undefined);
      const updated = await store.findUserById(user.id);
      // Never echo passwordHash (secret) even in dev.
      const { passwordHash: _ignored, ...safe } = (updated ?? user) as Record<string, unknown>;
      return { status: 201, body: ok({ user: safe }) };
    } catch (e: any) {
      return { status: 400, body: fail(e?.code || "DEBUG_FAILED", e?.message || "debug create failed", sec.requestId) };
    }
  }

  const extended = await dispatchExtendedRoutes({
    req,
    method,
    path: url.pathname,
    url,
    config,
    requestId: sec.requestId,
    authenticate: () => principalFor(),
    readBody: parseJsonBody,
    readRawBody,
    isSystemOwner: async (userId: string) => {
      if (config.ownership === undefined) return false;
      const state = await config.ownership.status();
      return state.claimed && state.ownerUserId === userId;
    },
  });
  if (extended !== null) return extended;

  return { status: 404, body: fail("NOT_FOUND", "no such route", sec.requestId) };
}

/**
 * Read the raw request bytes (backend migration).
 *
 * Separate from `parseJsonBody` on purpose: HMAC verification is over the bytes
 * the provider signed, and re-encoding a parsed object would produce different
 * bytes. `maxBytes` defaults to the 1 MiB JSON cap; an attachment upload passes
 * its own 5 MiB bound.
 */
async function readRawBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new BodyParseError("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function createApp(config: ApiConfig): Server {
  // Always-on throttling (PHP dispatch evidence): a default per-app limiter
  // when none is injected; per-app instance = per-test-server isolation.
  const effective: EffectiveApiConfig = {
    ...config,
    rateLimiter: config.rateLimiter ?? new FixedWindowRateLimiter(new MemoryRateLimitStore()),
  };
  return httpCreateServer((req: IncomingMessage, res: ServerResponse) => {
    const sec = newSecurityContext();
    void route(req, effective, sec)
      .then((r) => {
        const headers: Record<string, string | string[]> = {
          "Content-Type": "application/json; charset=utf-8",
          "X-Request-Id": sec.requestId,
          "Content-Security-Policy": buildCsp(sec.nonce),
          ...SECURITY_HEADERS,
          ...r.headers,
        };
        // RFC 9110 §15.3.5: a 204 carries no body. OD-2 mandates 204 for a
        // successful trade tombstone, so the envelope is suppressed (and with
        // it Content-Type/Content-Length) rather than serialized as "null".
        if (r.status === 204) {
          delete headers["Content-Type"];
          res.writeHead(204, headers);
          res.end();
          return;
        }
        if (Buffer.isBuffer(r.body)) {
          // Binary payload (an attachment's bytes). The handler already set the
          // exact Content-Type/Length; the JSON envelope does not apply.
          headers["Content-Type"] = (r.headers?.["Content-Type"] as string | undefined) ?? "application/octet-stream";
          res.writeHead(r.status, headers);
          res.end(r.body);
          return;
        }
        res.writeHead(r.status, headers);
        res.end(JSON.stringify(r.body));
      })
      .catch(() => {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "X-Request-Id": sec.requestId });
        res.end(JSON.stringify(fail("INTERNAL", "internal error", sec.requestId)));
      });
  });
}

export function listen(app: Server, port = 0, host = "127.0.0.1"): Promise<number> {
  // Host is configurable for deployed environments (Railway/container platforms
  // require binding the external interface — a loopback bind passes in-container
  // healthchecks but the edge proxy gets connection-refused → 502; discovered
  // by the Phase D Railway staging test, 2026-09-13). Default keeps the
  // established local-dev behavior byte-identical.
  return new Promise((resolvePromise) => {
    app.listen(port, host, () => {
      const addr = app.address();
      resolvePromise(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}
