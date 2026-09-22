// Shared HTTP responses for the migrated capability surface (directive t).
//
// WHY A LEAF MODULE. These helpers are used by every migrated handler, while
// `extendedRoutes.ts` imports those handlers to register them. Keeping the
// helpers in the dispatcher would create an import cycle (routes → dispatcher →
// routes) — it resolves at runtime, but it makes module loading order
// significant and it hides the actual dependency direction. A leaf module keeps
// the graph acyclic: handlers depend on `responses.ts`, the dispatcher depends
// on the handlers, and nothing depends on the dispatcher.
//
// The shapes are NOT invented here: they mirror the Phase C conventions in
// `kernel/server.ts` exactly (4-field envelope, fail-closed 503, non-disclosing
// 404, `VALIDATION_FAILED` with a details object).
import { fail } from "@velora/contracts";
import type { ExtendedRouteContext, RouteResult } from "./types.js";

/** Capability absent (service not wired) — always 503, never a degraded path. */
export function capabilityAbsent(ctx: ExtendedRouteContext, capability: string): RouteResult {
  return {
    status: 503,
    body: fail("SERVICE_UNAVAILABLE", `${capability} not configured`, ctx.requestId),
  };
}

/** Missing/invalid bearer token. */
export function unauthenticated(ctx: ExtendedRouteContext): RouteResult {
  return { status: 401, body: fail("UNAUTHENTICATED", "Unauthenticated.", ctx.requestId) };
}

/** Non-disclosing 404: "missing" and "not yours" are the same response. */
export function notFound(ctx: ExtendedRouteContext, message = "Not found."): RouteResult {
  return { status: 404, body: fail("NOT_FOUND", message, ctx.requestId) };
}

export function forbidden(ctx: ExtendedRouteContext, message = "Insufficient role."): RouteResult {
  return { status: 403, body: fail("FORBIDDEN", message, ctx.requestId) };
}

export function validation(ctx: ExtendedRouteContext, details: Record<string, string | number>): RouteResult {
  return { status: 400, body: fail("VALIDATION_FAILED", "Validation failed.", ctx.requestId, details) };
}
