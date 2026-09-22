// MetaAPI webhook ingress route — POST /api/v1/webhooks/metaapi.
//
// UNAUTHENTICATED BY BEARER, AUTHENTICATED BY SIGNATURE. This is the only
// migrated route that does not require a JWT; it is protected by the HMAC
// contract instead, which is why it is registered FIRST in the dispatcher and
// never passes through the kernel's bearer guard.
//
// The route is a thin adapter: it hands the raw bytes and headers to the
// service and maps the service's verdict onto the frozen external codes. All
// decision-making lives in `metaApiWebhookService.ts` so it can be tested
// without an HTTP server.
//
// Legacy test endpoint (`GET /api/v1/webhooks/metaapi/test`) is deliberately NOT
// ported: it existed to replay a fixture through the ingest path and would be a
// production-accessible write path guarded only by the secret. Recorded as a
// deliberate non-port in the migration report.
import { fail, ok } from "@velora/contracts";
import type { MetaApiWebhookService } from "./metaApiWebhookService.js";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";

const WEBHOOK_PATH = "/api/v1/webhooks/metaapi";

function webhookService(ctx: ExtendedRouteContext): MetaApiWebhookService | null {
  return ctx.config.webhooks ?? null;
}

export async function handleWebhookRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  if (ctx.path !== WEBHOOK_PATH) return null;

  if (ctx.method !== "POST") {
    // The path exists but the method does not: 405 with an Allow hint rather
    // than a 404, so a provider misconfiguration is diagnosable.
    return {
      status: 405,
      body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId),
      headers: { Allow: "POST" },
    };
  }

  const service = webhookService(ctx);
  if (service === null) {
    // No secret configured ⇒ the capability is absent. Mirrors Legacy's
    // WEBHOOK_SECRET_MISSING (503) rather than accepting unverifiable events.
    return {
      status: 503,
      body: fail("WEBHOOK_SECRET_MISSING", "Webhook authentication is not configured.", ctx.requestId),
    };
  }

  const raw = await ctx.readRawBody(ctx.req);
  const outcome = await service.handle({ rawBody: raw, headers: ctx.req.headers });

  if (outcome.result === "rejected" || outcome.result === "quarantined") {
    return { status: outcome.status, body: fail(outcome.code, outcome.message, ctx.requestId) };
  }
  return { status: outcome.status, body: ok(outcome.body) };
}
