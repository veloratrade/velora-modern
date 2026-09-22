// Sync-status route — GET /api/v1/accounts/{id}/sync-status (roadmap v0.2
// "Connection Status Monitor"; Legacy `AccountController::syncStatus`).
//
// Ownership is enforced by the (accountId, userId) read, so a foreign account is
// the same non-disclosing 404 as a missing one — identical to every other
// ownership-scoped resource in this codebase.
import { fail, ok } from "@velora/contracts";
import { capabilityAbsent, unauthenticated } from "../routes/responses.js";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";

const PATTERN = /^\/api\/v1\/accounts\/([^/]+)\/sync-status$/;

export async function handleSyncStatusRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  if (ctx.method !== "GET") return null;
  const match = PATTERN.exec(ctx.path);
  if (match === null) return null;

  const store = ctx.config.syncStatus ?? null;
  if (store === null || ctx.config.auth === undefined) return capabilityAbsent(ctx, "sync status");

  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);

  const accountId = decodeURIComponent(match[1] ?? "");
  const view = await store.findForUser(accountId, claims.sub);
  if (view === null) {
    return { status: 404, body: fail("NOT_FOUND", "Account not found.", ctx.requestId) };
  }
  return { status: 200, body: ok(view) };
}
