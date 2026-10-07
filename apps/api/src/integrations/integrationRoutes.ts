// Admin integrations HTTP surface — the 12 routes (§4.2, MG-ADMIN).
//
//   GET    /api/v1/admin/integrations                         integrations.view
//   GET    /api/v1/admin/integrations/metaapi                 integrations.view
//   PUT    /api/v1/admin/integrations/metaapi                 integrations.manage
//   DELETE /api/v1/admin/integrations/metaapi                 integrations.manage
//   POST   /api/v1/admin/integrations/metaapi/test            integrations.manage
//   GET    /api/v1/admin/integrations/email                   integrations.view
//   PUT    /api/v1/admin/integrations/email                   integrations.manage
//   DELETE /api/v1/admin/integrations/email                   integrations.manage
//   POST   /api/v1/admin/integrations/email/test              integrations.manage
//   GET    /api/v1/admin/integrations/relay/config            integrations.view
//   PUT    /api/v1/admin/integrations/relay/config            integrations.manage
//   DELETE /api/v1/admin/integrations/relay/config            integrations.manage
//
// AUTHORIZATION. integrations.view reads safe status (never secrets); integrations.manage
// writes/clears/tests (secret-bearing or upstream). A caller without the permission
// gets 403 BEFORE any body is read.
//
// NO SECRET EVER LEAVES in the response: writes return safe status + fingerprint,
// reads return configured/has*/safe host — never the token/password/key.

import { fail, ok, canAct, type AuthorityContext } from "@velora/contracts";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";
import { capabilityAbsent, forbidden, unauthenticated } from "../routes/responses.js";
import { IntegrationService, ValidationError, MasterKeyMissingError } from "./integrationService.js";
import type { AiAdminService } from "../ai/aiAdminService.js";

// Exported for tests and for the dispatcher. The dispatcher matches on these
// constants so a rename never silently drifts from the route table.
export const INTEGRATIONS_INVENTORY = "/api/v1/admin/integrations";
export const INTEGRATIONS_METAAPI = "/api/v1/admin/integrations/metaapi";
export const INTEGRATIONS_METAAPI_TEST = "/api/v1/admin/integrations/metaapi/test";
export const INTEGRATIONS_EMAIL = "/api/v1/admin/integrations/email";
export const INTEGRATIONS_EMAIL_TEST = "/api/v1/admin/integrations/email/test";
export const INTEGRATIONS_RELAY_CONFIG = "/api/v1/admin/integrations/relay/config";

export interface IntegrationsCapability {
  readonly integrations: IntegrationService;
  /** Relay alias reuses the existing AI relay store — same rows, same envelope. */
  readonly aiAdmin?: AiAdminService | null;
}

export async function handleIntegrationRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  const isInventory = ctx.path === INTEGRATIONS_INVENTORY;
  const isMetaApi = ctx.path === INTEGRATIONS_METAAPI;
  const isMetaApiTest = ctx.path === INTEGRATIONS_METAAPI_TEST;
  const isEmail = ctx.path === INTEGRATIONS_EMAIL;
  const isEmailTest = ctx.path === INTEGRATIONS_EMAIL_TEST;
  const isRelay = ctx.path === INTEGRATIONS_RELAY_CONFIG;

  const owns = isInventory || isMetaApi || isMetaApiTest || isEmail || isEmailTest || isRelay;
  if (!owns) return null;

  const integrationsCap = (ctx.config as unknown as Record<string, unknown>)["integrations"] as IntegrationsCapability | undefined;
  if (integrationsCap === undefined || integrationsCap === null) {
    return capabilityAbsent(ctx, "integrations");
  }

  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);
  const authority: AuthorityContext = { role: claims.role, isSystemOwner: await ctx.isSystemOwner(claims.sub) };

  const permission = permissionFor(ctx.method, isInventory, isMetaApi, isMetaApiTest, isEmail, isEmailTest, isRelay);
  if (!canAct(authority, permission)) return forbidden(ctx);

  const service: IntegrationService = integrationsCap.integrations;

  try {
    // ── inventory ──────────────────────────────────────────────────────────
    if (isInventory && ctx.method === "GET") {
      const inv = await service.inventory();
      return { status: 200, body: ok({ integrations: inv }) };
    }

    // ── metaapi ────────────────────────────────────────────────────────────
    if (isMetaApi && ctx.method === "GET") {
      const s = await service.metaApiStatus();
      return { status: 200, body: ok({ integration: s }) };
    }
    if (isMetaApi && ctx.method === "PUT") {
      const body = await ctx.readBody(ctx.req);
      const saved = await service.updateMetaApi(
        {
          token: typeof body["token"] === "string" ? body["token"] : undefined,
          webhookSecret: typeof body["webhook_secret"] === "string" ? body["webhook_secret"] : undefined,
          baseUrl: typeof body["base_url"] === "string" ? body["base_url"] : undefined,
        },
        claims.sub,
      );
      return { status: 200, body: ok({ integration: saved }) };
    }
    if (isMetaApi && ctx.method === "DELETE") {
      const s = await service.clearMetaApi();
      return { status: 200, body: ok({ integration: s }) };
    }
    if (isMetaApiTest && ctx.method === "POST") {
      const probe = await service.testMetaApi();
      const status = await service.metaApiStatus();
      return { status: 200, body: ok({ test: probe, integration: status }) };
    }

    // ── email ──────────────────────────────────────────────────────────────
    if (isEmail && ctx.method === "GET") {
      const s = await service.emailStatus();
      return { status: 200, body: ok({ integration: s }) };
    }
    if (isEmail && ctx.method === "PUT") {
      const body = await ctx.readBody(ctx.req);
      const saved = await service.updateEmail(
        {
          driver: typeof body["driver"] === "string" ? body["driver"] : undefined,
          from: typeof body["from"] === "string" ? body["from"] : undefined,
          fromName: typeof body["from_name"] === "string" ? body["from_name"] : undefined,
          host: typeof body["smtp_host"] === "string" ? body["smtp_host"] : undefined,
          port: body["smtp_port"] === undefined || body["smtp_port"] === null ? undefined : String(body["smtp_port"]),
          user: typeof body["smtp_user"] === "string" ? body["smtp_user"] : undefined,
          smtpPassword: typeof body["smtp_password"] === "string" ? body["smtp_password"] : undefined,
          resendApiKey: typeof body["resend_api_key"] === "string" ? body["resend_api_key"] : undefined,
        },
        claims.sub,
      );
      return { status: 200, body: ok({ integration: saved }) };
    }
    if (isEmail && ctx.method === "DELETE") {
      const s = await service.clearEmail();
      return { status: 200, body: ok({ integration: s }) };
    }
    if (isEmailTest && ctx.method === "POST") {
      const probe = await service.testEmail();
      const status = await service.emailStatus();
      return { status: 200, body: ok({ test: probe, integration: status }) };
    }

    // ── relay alias (delegates to the existing AI relay) ─────────────────
    if (isRelay) {
      // No aiAdmin capability means the AI substrate is not wired; the integrations
      // relay alias cannot function alone because the rows live in ai_platform_secrets.
      const relayCap = (ctx.config as unknown as Record<string, unknown>)["aiAdmin"] as { admin: AiAdminService } | undefined;
      const relayAdmin: AiAdminService | null = relayCap?.admin ?? null;
      if (relayAdmin === null) return capabilityAbsent(ctx, "aiAdmin");
      if (ctx.method === "GET") {
        const status = await relayAdmin.relayStatus();
        return { status: 200, body: ok({ config: status }) };
      }
      if (ctx.method === "PUT") {
        const body = await ctx.readBody(ctx.req);
        const url = typeof body["url"] === "string" ? body["url"] : "";
        const token = typeof body["token"] === "string" ? body["token"] : "";
        if (url.trim() === "" && token.trim() === "") {
          return validation(ctx, { config: "RELAY_CONFIG_EMPTY" });
        }
        const saved = await relayAdmin.saveRelay(url, token, claims.sub);
        return { status: 200, body: ok({ config: saved }) };
      }
      if (ctx.method === "DELETE") {
        const cleared = await relayAdmin.clearRelay();
        return { status: 200, body: ok({ config: cleared }) };
      }
    }

    return methodNotAllowed(ctx);
  } catch (err) {
    if (err instanceof ValidationError) {
      // Preserve Legacy codes where they exist (INTEGRATION_CONFIG_EMPTY, RELAY_CONFIG_EMPTY)
      // and use the structured details map for field-level errors.
      const details: Record<string, string> = {};
      for (const [k, codes] of Object.entries(err.details)) details[k] = codes.join(",");
      return validation(ctx, details);
    }
    if (err instanceof MasterKeyMissingError) {
      return { status: 503, body: fail("CREDENTIAL_STORE_UNAVAILABLE", err.message, ctx.requestId) };
    }
    // Re-throw as unhandled — the dispatcher will surface as 500, which is
    // the correct signal for an invariant violation rather than a client error.
    throw err;
  }
}

function permissionFor(
  method: string,
  isInventory: boolean,
  isMetaApi: boolean,
  isMetaApiTest: boolean,
  isEmail: boolean,
  isEmailTest: boolean,
  isRelay: boolean,
): "integrations.view" | "integrations.manage" {
  if (method === "GET" && (isInventory || isMetaApi || isEmail || isRelay)) return "integrations.view";
  return "integrations.manage";
}

function validation(ctx: ExtendedRouteContext, details: Record<string, string>): RouteResult {
  return { status: 422, body: fail("VALIDATION_FAILED", "Validation failed.", ctx.requestId, details) };
}

function methodNotAllowed(ctx: ExtendedRouteContext): RouteResult {
  return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
}
