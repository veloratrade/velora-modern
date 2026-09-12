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
} from "@velora/contracts";
import { newSecurityContext, buildCsp, SECURITY_HEADERS, originAllowed } from "./security.js";
import { AuthService, AuthError } from "../auth/authService.js";
import { AccountService, AccountError } from "../accounts/accountService.js";
import { TradeService, TradeError } from "../trades/tradeService.js";
import { EntitlementError } from "../entitlements/entitlementService.js";

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
}

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

/** Bearer access-token authentication for protected routes (fail-closed). */
function authenticateRequest(
  req: IncomingMessage,
  auth: AuthService,
): { sub: string } | null {
  const bearer = req.headers.authorization;
  if (bearer === undefined || !bearer.startsWith("Bearer ")) return null;
  const payload = auth.verifyAccessToken(bearer.slice("Bearer ".length));
  return payload === null ? null : { sub: payload.sub };
}

function validationFailure(error: z.ZodError, requestId: string): RouteResult {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    details[issue.path.join(".") || "_"] = issue.message;
  }
  return { status: 400, body: fail("VALIDATION_FAILED", "Validation failed.", requestId, details) };
}

async function route(req: IncomingMessage, config: ApiConfig, sec: { requestId: string; nonce: string }): Promise<RouteResult> {
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
      return { status: 200, body: ok(await trades.deleteTrade(id, claims.sub)) };
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

  return { status: 404, body: fail("NOT_FOUND", "no such route", sec.requestId) };
}

export function createApp(config: ApiConfig): Server {
  return httpCreateServer((req: IncomingMessage, res: ServerResponse) => {
    const sec = newSecurityContext();
    void route(req, config, sec)
      .then((r) => {
        const headers: Record<string, string> = {
          "Content-Type": "application/json; charset=utf-8",
          "X-Request-Id": sec.requestId,
          "Content-Security-Policy": buildCsp(sec.nonce),
          ...SECURITY_HEADERS,
          ...r.headers,
        };
        res.writeHead(r.status, headers);
        res.end(JSON.stringify(r.body));
      })
      .catch(() => {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "X-Request-Id": sec.requestId });
        res.end(JSON.stringify(fail("INTERNAL", "internal error", sec.requestId)));
      });
  });
}

export function listen(app: Server, port = 0): Promise<number> {
  return new Promise((resolvePromise) => {
    app.listen(port, "127.0.0.1", () => {
      const addr = app.address();
      resolvePromise(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}
