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
import { AuthService, AuthError } from "../auth/authService.js";
import { AdminUserService, type ActorContext } from "../auth/adminUserService.js";
import { OwnershipService } from "../auth/ownershipService.js";
import { AccountService, AccountError } from "../accounts/accountService.js";
import { TradeService, TradeError } from "../trades/tradeService.js";
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
  /** System Owner bootstrap. Absent → ownership routes fail closed (503). */
  readonly ownership?: OwnershipService;
  /** Phase C rate limiting (inc 7). Absent → createApp builds a default
   *  fixed-window limiter on a per-process memory store (PHP applies
   *  throttling unconditionally at dispatch; a per-app instance preserves
   *  the established per-test-server isolation). */
  readonly rateLimiter?: RateLimiter;
  /** Trusted reverse-proxy CIDRs for X-Forwarded-For (PHP parity). Default:
   *  none — the header is never honored (fail-closed). */
  readonly trustedProxyCidrs?: readonly string[];
}

/** Throttled routes (inc 7): the implemented Local auth routes with
 * PHP-verified dispatch-level limits (C-14). Phase H/I/J routes have no Local
 * route yet — their C-14 defaults light up when those routes land. */
export const THROTTLED_AUTH_ROUTES: Readonly<Record<string, RateLimitKey>> = {
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
};

type RouteResult = { status: number; body: unknown; headers?: Record<string, string> };

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
  const REFRESH_COOKIE_NAME = "refresh_token";
  const REFRESH_COOKIE_MAX_AGE = 2_592_000; // 30 days (Remote + PHP jwt_refresh_ttl_sec)
  const REFRESH_COOKIE_ATTRS = "Path=/; HttpOnly; Secure; SameSite=Lax";
  const REFRESH_COOKIE_CLEAR = `${REFRESH_COOKIE_NAME}=; ${REFRESH_COOKIE_ATTRS}; Max-Age=0`;
  const refreshCookie = (token: string): string =>
    `${REFRESH_COOKIE_NAME}=${token}; ${REFRESH_COOKIE_ATTRS}; Max-Age=${REFRESH_COOKIE_MAX_AGE}`;
  const extractRefreshToken = (
    cookieHeader: string | undefined,
    body: Record<string, unknown>,
  ): string | undefined => {
    if (cookieHeader !== undefined) {
      for (const part of cookieHeader.split(";")) {
        const idx = part.indexOf("=");
        if (idx > 0 && part.slice(0, idx).trim() === REFRESH_COOKIE_NAME) {
          return part.slice(idx + 1).trim();
        }
      }
    }
    const fromBody = body.refreshToken;
    return typeof fromBody === "string" && fromBody !== "" ? fromBody : undefined;
  };
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

  // State-changing routes: same-origin guard (verified PHP behavior parity)
  if (method === "POST" && path === "/api/v1/auth/logout") {
    const origin = req.headers.origin;
    if (!originAllowed(origin, config.allowedOrigins)) {
      return { status: 403, body: fail("ORIGIN_REJECTED", "origin not allowed", sec.requestId) };
    }
    return authRouteResult(async (auth) => {
      const body = await parseJsonBody(req);
      const refreshToken = extractRefreshToken(req.headers.cookie, body);
      if (refreshToken !== undefined) await auth.logout(refreshToken);
      return {
        status: 200,
        body: ok({ loggedOut: true }),
        headers: { "Set-Cookie": REFRESH_COOKIE_CLEAR },
      };
    });
  }

  // ---- Rate limiting (inc 7 — PHP dispatch-level, C-14 verified limits) ----
  // PHP parity: applied BEFORE validation/auth/capability checks — attempts
  // count even when the request would fail them (brute-force semantics).
  const throttleKey = THROTTLED_AUTH_ROUTES[`${method} ${path}`];
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
        headers: { "Set-Cookie": refreshCookie(refreshToken) },
      };
    });
  }

  if (method === "POST" && path === "/api/v1/auth/refresh") {
    return authRouteResult(async (auth) => {
      const body = await parseJsonBody(req);
      const refreshToken = extractRefreshToken(req.headers.cookie, body);
      if (refreshToken === undefined) {
        return {
          status: 401,
          body: fail("REFRESH_COOKIE_MISSING", "Refresh cookie is missing.", sec.requestId),
          headers: { "Set-Cookie": REFRESH_COOKIE_CLEAR },
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
          headers: { "Set-Cookie": refreshCookie(rotated) },
        };
      } catch (err) {
        // Remote-verified: any refresh failure clears the HttpOnly cookie.
        if (err instanceof AuthError) {
          return {
            status: err.status,
            body: fail(err.code, err.message, sec.requestId, err.details),
            headers: { "Set-Cookie": REFRESH_COOKIE_CLEAR },
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
    const claims = authenticateRequest(req, config.auth);
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

  // ---- Trades (Phase C increment 3; ADR-002 ledger) ----------------------
  const tradesRoute = (fn: (trades: TradeService, claims: { sub: string }) => Promise<RouteResult>): Promise<RouteResult> => {
    if (config.auth === undefined || config.trades === undefined) {
      return Promise.resolve({
        status: 503,
        body: fail("SERVICE_UNAVAILABLE", "trades not configured", sec.requestId),
      });
    }
    const claims = authenticateRequest(req, config.auth);
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
    const claims = authenticateRequest(req, config.auth);
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
    const claims = authenticateRequest(req, config.auth);
    const authority = await resolveAuthority(claims, config.ownership);
    const denied = requireAuthority(authority, "rbac.matrix.view", sec.requestId);
    if (denied !== null) return denied;
    return {
      status: 200,
      body: ok({
        roles: APP_ROLES,
        permissions: Object.fromEntries(APP_ROLES.map((r) => [r, permissionsFor(r)])),
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
    const claims = authenticateRequest(req, config.auth);
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
    const claims = authenticateRequest(req, config.auth);
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
    const claims = authenticateRequest(req, config.auth);
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
      });
      return { status: 201, body: ok(result) };
    } catch (err: unknown) {
      if (err instanceof AuthError) {
        return { status: err.status, body: fail(err.code, err.message, sec.requestId, err.details) };
      }
      throw err;
    }
  }

  return { status: 404, body: fail("NOT_FOUND", "no such route", sec.requestId) };
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
        const headers: Record<string, string> = {
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
