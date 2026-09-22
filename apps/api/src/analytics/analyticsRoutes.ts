// Analytics routes — v0.5 (roadmap): GET /api/v1/analytics/{summary,equity-curve,heatmap,by-symbol}
//
// AUTHZ: a normal authenticated user sees ONLY their own data, and that is
// expressed structurally — every read is keyed by `claims.sub`, never by a
// request-supplied user id. There is no admin variant on this surface; an admin
// reading another trader's analytics is not a roadmap capability and is not
// invented here.
//
// The optional `account_id` filter narrows the caller's OWN trades. Ownership is
// therefore implied rather than checked separately: the query is `user_id = sub
// AND account_id = ?`, so a foreign account id simply returns nothing instead of
// disclosing that the account exists.
import { fail, ok } from "@velora/contracts";
import { AnalyticsService, WindowError, parseInstant, resolveWindow, type AnalyticsWindow } from "./analyticsService.js";
import { capabilityAbsent, unauthenticated, validation } from "../routes/responses.js";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";

const ROUTES: readonly (readonly [string, string])[] = [
  ["GET", "/api/v1/analytics/summary"],
  ["GET", "/api/v1/analytics/equity-curve"],
  ["GET", "/api/v1/analytics/heatmap"],
  ["GET", "/api/v1/analytics/by-symbol"],
];

function buildService(store: NonNullable<ExtendedRouteContext["config"]["analytics"]>): AnalyticsService {
  return new AnalyticsService(store);
}

function readWindow(ctx: ExtendedRouteContext): AnalyticsWindow {
  const period = ctx.url.searchParams.get("period");
  const explicitFrom = parseInstant(ctx.url.searchParams.get("from"), "from");
  const explicitTo = parseInstant(ctx.url.searchParams.get("to"), "to");
  if (explicitFrom !== null || explicitTo !== null) {
    if (explicitFrom !== null && explicitTo !== null && explicitFrom >= explicitTo) {
      throw new WindowError("from must be earlier than to");
    }
    return { from: explicitFrom, to: explicitTo };
  }
  return resolveWindow(period, new Date());
}

export async function handleAnalyticsRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  const owned = ROUTES.some(([method, path]) => method === ctx.method && path === ctx.path);
  if (!owned) return null;

  const store = ctx.config.analytics ?? null;
  if (store === null) return capabilityAbsent(ctx, "analytics");
  const service = buildService(store);

  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);

  const accountId = ctx.url.searchParams.get("account_id");
  if (accountId !== null && !/^\d+$/.test(accountId)) return validation(ctx, { account_id: "must be a numeric id" });

  let window: AnalyticsWindow;
  try {
    window = readWindow(ctx);
  } catch (err) {
    if (err instanceof WindowError) return validation(ctx, { window: err.message });
    throw err;
  }

  try {
    if (ctx.path === "/api/v1/analytics/summary") {
      return { status: 200, body: ok(await service.summary(claims.sub, window, accountId)) };
    }
    if (ctx.path === "/api/v1/analytics/equity-curve") {
      return { status: 200, body: ok({ points: await service.equityCurve(claims.sub, window, accountId) }) };
    }
    if (ctx.path === "/api/v1/analytics/heatmap") {
      return { status: 200, body: ok({ cells: await service.heatmap(claims.sub, window, accountId) }) };
    }
    return { status: 200, body: ok({ symbols: await service.bySymbol(claims.sub, window, accountId) }) };
  } catch (err) {
    if (err instanceof WindowError) return validation(ctx, { window: err.message });
    // Never leak a driver error to the client; the request id is the join key
    // for the operator's own log line.
    return { status: 500, body: fail("ANALYTICS_FAILED", "Analytics could not be computed.", ctx.requestId) };
  }
}
