// Admin console routes — Phase 6. The operator's platform-wide surface, migrated
// by CAPABILITY from Legacy's admin panel (`api/index.php` lines 109-251,
// `api/src/Admin/*`). Route STRUCTURE follows Modern's conventions; the
// capability map (docs/audits/2026-10-04-PHASE6-ADMIN-CAPABILITY-MAP.md) records
// every Legacy admin route and where it went.
//
//   GET  /api/v1/admin/overview                        overview.view
//   GET  /api/v1/admin/analytics/users                 analytics.view
//   GET  /api/v1/admin/analytics/trading               analytics.view
//   GET  /api/v1/admin/system/health                   system.health.view
//   GET  /api/v1/admin/security/signups                audit.view   (sensitive-gated)
//   GET  /api/v1/admin/security/logins                 audit.view   (sensitive-gated)
//   GET  /api/v1/admin/trades                          users.view
//   GET  /api/v1/admin/trading-accounts                users.view
//   GET  /api/v1/admin/users/{id}/sessions             users.view   (sensitive-gated)
//   GET  /api/v1/admin/users/{id}/devices              users.view
//   GET  /api/v1/admin/users/{id}/accounts             users.view
//   GET  /api/v1/admin/users/{id}/trades               users.view
//   POST /api/v1/admin/users/{id}/session-revocations  users.manage_status  {sessionId?}
//   POST /api/v1/admin/users/{id}/email-verification   users.verify_email
//
// TWO DELIBERATE STRUCTURAL DIVERGENCES, both recorded in the capability map:
//
//   1. ONE revoke endpoint with an optional `sessionId`, where Legacy had
//      `/sessions/{id}/revoke` AND `/revoke-sessions`. Both are the same operation
//      at two scopes, and two paths meant two authorization decisions that could
//      drift; the pair-rule guards (owner, peer, self) now run in exactly one
//      place. `{sessionId: null}` = every session.
//   2. The per-user AUDIT trail is served by the existing
//      `GET /api/v1/admin/audit-logs?targetUserId={id}` rather than a second
//      per-user route, so there is exactly ONE implementation of "read the trail"
//      (see the note at the top of admin/adminRoutes.ts).
//
// EVERY route here resolves authority from the verified bearer claims plus
// authoritative ownership storage, and every failure is fail-closed: no
// capability → 503, no token → 401, no permission → 403. The permission names are
// Legacy's own (overview.view / analytics.view / system.health.view / audit.view /
// users.view / users.manage_status / users.verify_email).
import { fail, ok } from "@velora/contracts";
import { canAct, type AuthorityContext, type Permission } from "@velora/contracts";
import { AuthError } from "../auth/authService.js";
import type { AdminUserService } from "../auth/adminUserService.js";
import type { AdminConsoleService } from "./adminConsoleService.js";
import { capabilityAbsent, forbidden, unauthenticated } from "../routes/responses.js";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";

const OVERVIEW = "/api/v1/admin/overview";
const ANALYTICS_USERS = "/api/v1/admin/analytics/users";
const ANALYTICS_TRADING = "/api/v1/admin/analytics/trading";
const ANALYTICS_OVERVIEW = "/api/v1/admin/analytics/overview";
const ANALYTICS_AI = "/api/v1/admin/analytics/ai";
const ANALYTICS_OPERATIONS = "/api/v1/admin/analytics/operations";
const ANALYTICS_REVENUE = "/api/v1/admin/analytics/revenue";
const SYSTEM_HEALTH = "/api/v1/admin/system/health";
const SECURITY_SIGNUPS = "/api/v1/admin/security/signups";
const SECURITY_LOGINS = "/api/v1/admin/security/logins";
const PLATFORM_TRADES = "/api/v1/admin/trades";
const PLATFORM_ACCOUNTS = "/api/v1/admin/trading-accounts";

const USER_SESSIONS = /^\/api\/v1\/admin\/users\/([^/]+)\/sessions$/;
const USER_DEVICES = /^\/api\/v1\/admin\/users\/([^/]+)\/devices$/;
const USER_ACCOUNTS = /^\/api\/v1\/admin\/users\/([^/]+)\/accounts$/;
const USER_TRADES = /^\/api\/v1\/admin\/users\/([^/]+)\/trades$/;
const USER_SESSION_REVOCATIONS = /^\/api\/v1\/admin\/users\/([^/]+)\/session-revocations$/;
const USER_EMAIL_VERIFICATION = /^\/api\/v1\/admin\/users\/([^/]+)\/email-verification$/;

const READ_ROUTES: ReadonlyArray<{ readonly path: string; readonly permission: Permission }> = [
  { path: OVERVIEW, permission: "overview.view" },
  { path: ANALYTICS_USERS, permission: "analytics.view" },
  { path: ANALYTICS_TRADING, permission: "analytics.view" },
  { path: ANALYTICS_OVERVIEW, permission: "analytics.view" },
  { path: ANALYTICS_AI, permission: "analytics.view" },
  { path: ANALYTICS_OPERATIONS, permission: "analytics.view" },
  { path: ANALYTICS_REVENUE, permission: "analytics.view" },
  { path: SYSTEM_HEALTH, permission: "system.health.view" },
  { path: SECURITY_SIGNUPS, permission: "audit.view" },
  { path: SECURITY_LOGINS, permission: "audit.view" },
  { path: PLATFORM_TRADES, permission: "users.view" },
  { path: PLATFORM_ACCOUNTS, permission: "users.view" },
];

/**
 * The console capability the kernel injects. Absent → every console route answers
 * the documented fail-closed 503 instead of degrading to an unauthenticated or
 * unbounded read.
 */
export interface AdminConsoleCapability {
  readonly console: AdminConsoleService;
  /** The canonical admin user service: ownership of the per-user operations and
   *  their pair-rules stays there, so the console cannot restate them. */
  readonly users: AdminUserService;
}

function consoleError(ctx: ExtendedRouteContext, err: AuthError): RouteResult {
  return { status: err.status, body: fail(err.code, err.message, ctx.requestId, err.details) };
}

function validation(ctx: ExtendedRouteContext, details: Record<string, string>): RouteResult {
  return { status: 422, body: fail("VALIDATION_FAILED", "Validation failed.", ctx.requestId, details) };
}

export async function handleAdminConsoleRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  const capability: AdminConsoleCapability | null = ctx.config.adminConsole ?? null;

  // PATH-based ownership, checked BEFORE the method: a write to a read-only
  // console path is a 405 from the surface that owns it, not a 404 that would
  // suggest the capability does not exist. The method is then honoured below.
  const readRoute = READ_ROUTES.find((r) => r.path === ctx.path) ?? null;
  const isRead = readRoute !== null;
  const sessionsMatch = USER_SESSIONS.exec(ctx.path);
  const devicesMatch = USER_DEVICES.exec(ctx.path);
  const accountsMatch = USER_ACCOUNTS.exec(ctx.path);
  const tradesMatch = USER_TRADES.exec(ctx.path);
  const revokeMatch = USER_SESSION_REVOCATIONS.exec(ctx.path);
  const verifyMatch = USER_EMAIL_VERIFICATION.exec(ctx.path);

  // Not ours → hand the request back to the dispatcher (which falls through to
  // the kernel's 404). This check runs BEFORE the capability check so an absent
  // console cannot answer 503 for paths it never owned.
  const owns =
    isRead ||
    sessionsMatch !== null ||
    devicesMatch !== null ||
    accountsMatch !== null ||
    tradesMatch !== null ||
    revokeMatch !== null ||
    verifyMatch !== null;
  if (!owns) return null;

  if (capability === null) return capabilityAbsent(ctx, "adminConsole");

  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);
  const authority: AuthorityContext = {
    role: claims.role,
    isSystemOwner: await ctx.isSystemOwner(claims.sub),
  };

  const permission: Permission | null = readRoute !== null
    ? readRoute.permission
    : sessionsMatch !== null || devicesMatch !== null || accountsMatch !== null || tradesMatch !== null
      ? "users.view"
      : revokeMatch !== null
        ? "users.manage_status"
        : "users.verify_email";
  if (permission === null) return null;
  if (!canAct(authority, permission)) return forbidden(ctx);

  const { console: svc, users } = capability;
  const actor = {
    // Identity comes from the VERIFIED claims, never from a body/query value.
    id: claims.sub,
    role: authority.role,
    isSystemOwner: authority.isSystemOwner,
    requestId: ctx.requestId,
  };

  try {
    if (ctx.method === "GET") {
      if (ctx.path === OVERVIEW) {
        return { status: 200, body: ok(await svc.overview()) };
      }
      if (ctx.path === ANALYTICS_USERS) {
        return { status: 200, body: ok(await svc.usersAnalytics(svc.resolveRange(ctx.url.searchParams))) };
      }
      if (ctx.path === ANALYTICS_TRADING) {
        return { status: 200, body: ok(await svc.tradingAnalytics(svc.resolveRange(ctx.url.searchParams))) };
      }
      if (ctx.path === ANALYTICS_OVERVIEW) {
        return { status: 200, body: ok(await svc.analyticsOverview(svc.resolveRange(ctx.url.searchParams))) };
      }
      if (ctx.path === ANALYTICS_AI) {
        return { status: 200, body: ok(await svc.aiAnalytics(svc.resolveRange(ctx.url.searchParams))) };
      }
      if (ctx.path === ANALYTICS_OPERATIONS) {
        return { status: 200, body: ok(await svc.operationsAnalytics(svc.resolveRange(ctx.url.searchParams))) };
      }
      if (ctx.path === ANALYTICS_REVENUE) {
        return { status: 200, body: ok(await svc.revenueAnalytics()) };
      }
      if (ctx.path === SYSTEM_HEALTH) {
        return { status: 200, body: ok(await svc.health()) };
      }
      if (ctx.path === SECURITY_SIGNUPS || ctx.path === SECURITY_LOGINS) {
        const feed = ctx.path === SECURITY_SIGNUPS ? "signup" : "login";
        return { status: 200, body: ok(await svc.securityFeed(feed, ctx.url.searchParams, authority)) };
      }
      if (ctx.path === PLATFORM_TRADES) {
        return { status: 200, body: ok(await svc.platformTrades(ctx.url.searchParams)) };
      }
      if (ctx.path === PLATFORM_ACCOUNTS) {
        return { status: 200, body: ok(await svc.platformAccounts(ctx.url.searchParams)) };
      }
      if (sessionsMatch !== null) {
        const id = decodeURIComponent(sessionsMatch[1] ?? "");
        const result = await users.listSessions(id, {
          ...(numberParam(ctx, "page") !== undefined ? { page: numberParam(ctx, "page")! } : {}),
          ...(numberParam(ctx, "perPage") !== undefined ? { perPage: numberParam(ctx, "perPage")! } : {}),
        });
        // The raw network identity follows the SAME rule as the per-user login
        // history (kernel SEC-03), INCLUDING its shape: for a caller without
        // audit.view_sensitive the two keys are OMITTED rather than set to null,
        // so the response cannot be mistaken for "the address was not recorded"
        // — which is a different fact from "you may not see it".
        const sensitive = canAct(authority, "audit.view_sensitive");
        const items = sensitive
          ? result.items
          : result.items.map((s) => ({
              id: s.id,
              createdAt: s.createdAt,
              expiresAt: s.expiresAt,
              revokedAt: s.revokedAt,
            }));
        return { status: 200, body: ok({ ...result, items, sensitive }) };
      }
      if (devicesMatch !== null) {
        const id = decodeURIComponent(devicesMatch[1] ?? "");
        return { status: 200, body: ok({ items: await users.listDevices(id) }) };
      }
      if (accountsMatch !== null) {
        const id = decodeURIComponent(accountsMatch[1] ?? "");
        return { status: 200, body: ok(await svc.userAccounts(id, ctx.url.searchParams)) };
      }
      if (tradesMatch !== null) {
        const id = decodeURIComponent(tradesMatch[1] ?? "");
        return { status: 200, body: ok(await svc.userTrades(id, ctx.url.searchParams)) };
      }
    }

    if (ctx.method === "POST" && revokeMatch !== null) {
      const id = decodeURIComponent(revokeMatch[1] ?? "");
      const body = await ctx.readBody(ctx.req);
      const raw = body["sessionId"];
      if (raw !== undefined && raw !== null && typeof raw !== "string") {
        return validation(ctx, { sessionId: "must be a string or null" });
      }
      const sessionId = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
      const result = await users.revokeSessions(id, actor, sessionId);
      return {
        status: 200,
        body: ok({
          revoked: result.revoked,
          scope: result.scope,
          ...(result.scope === "session" ? { sessionId } : {}),
        }),
      };
    }

    if (ctx.method === "POST" && verifyMatch !== null) {
      const id = decodeURIComponent(verifyMatch[1] ?? "");
      const result = await users.verifyEmail(id, actor);
      return { status: 200, body: ok({ user: result.user, changed: result.changed }) };
    }
  } catch (err: unknown) {
    if (err instanceof AuthError) return consoleError(ctx, err);
    throw err;
  }

  // Owned path, wrong method.
  return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
}

/** A positive-integer query parameter, or undefined when absent. Non-numeric
 *  values are rejected by the service (422), not silently coerced to NaN. */
function numberParam(ctx: ExtendedRouteContext, key: string): number | undefined {
  const raw = ctx.url.searchParams.get(key);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : NaN;
}
