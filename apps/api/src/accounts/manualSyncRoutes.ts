// Manual sync route — POST /api/v1/accounts/{id}/sync (TRD-06, Legacy
// `AccountController::sync` + the dispatch-level `metaapi-sync` 20/300 throttle).
//
// Shape of the Legacy contract, kept where it carries meaning:
//   - authentication required; ownership resolved by (id, userId) so a foreign
//     account is the SAME non-disclosing 404 as a missing one;
//   - an account without a MetaAPI provider id is a validation failure with the
//     machine-readable detail `account: METAAPI_REQUIRED`, because only a
//     provider-connected account can be synchronized;
//   - the successful answer is a 202 "queued", not a 200 with data: the request
//     started work, it did not perform it.
//
// Documented deltas are in the service's docblock (no queue row id; an explicit
// `up-to-date` answer instead of a no-op job; the Modern validation envelope).
import { fail, ok } from "@velora/contracts";
import { capabilityAbsent, notFound, unauthenticated } from "../routes/responses.js";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";
import type { ManualSyncService } from "./manualSyncService.js";

const PATTERN = /^\/api\/v1\/accounts\/([^/]+)\/sync$/;

export async function handleManualSyncRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  if (ctx.method !== "POST") return null;
  const match = PATTERN.exec(ctx.path);
  if (match === null) return null;

  const service: ManualSyncService | null = ctx.config.manualSync ?? null;
  if (service === null || ctx.config.auth === undefined) return capabilityAbsent(ctx, "account sync");

  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);

  const accountId = decodeURIComponent(match[1] ?? "");
  const result = await service.request(accountId, claims.sub);

  switch (result.kind) {
    case "not-found":
      return notFound(ctx, "Account not found.");
    case "not-metaapi":
      // 422 + the Legacy detail value, on the Modern envelope's validation code.
      return {
        status: 422,
        body: fail("VALIDATION_ERROR", "Only MetaApi accounts can be synchronized.", ctx.requestId, {
          account: "METAAPI_REQUIRED",
        }),
      };
    case "up-to-date":
      return { status: 200, body: ok({ accountId, status: "up-to-date" }) };
    case "queued":
      return {
        status: 202,
        body: ok({
          accountId,
          status: "queued",
          dispatched: result.dispatched,
          deduplicated: !result.dispatched,
          window: result.window,
        }),
      };
  }
}
