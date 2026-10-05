// The admin AI HTTP surface.
//
//   GET    /api/v1/admin/ai/overview                       aiManage
//   GET    /api/v1/admin/ai/feature-providers              aiManage
//   POST   /api/v1/admin/ai/feature-providers              aiManage
//   POST   /api/v1/admin/ai/feature-providers/reorder      aiManage
//   PATCH  /api/v1/admin/ai/feature-providers/{id}         aiManage
//   DELETE /api/v1/admin/ai/feature-providers/{id}         aiManage
//   GET    /api/v1/admin/ai/flags                          aiManage
//   PUT    /api/v1/admin/ai/flags/{name}                   aiManage
//   GET    /api/v1/admin/ai/quotas                         aiManage
//   PUT    /api/v1/admin/ai/quotas/{provider}              aiRouteManage
//   GET    /api/v1/admin/ai/route                          aiManage
//   PUT    /api/v1/admin/ai/route                          aiRouteManage
//   DELETE /api/v1/admin/ai/route                          aiRouteManage
//   GET    /api/v1/admin/ai/relay                          aiManage
//   PUT    /api/v1/admin/ai/relay                          aiRouteManage
//   DELETE /api/v1/admin/ai/relay                          aiRouteManage
//   POST   /api/v1/admin/ai/credentials/{key}              aiRouteManage
//   DELETE /api/v1/admin/ai/credentials/{key}              aiRouteManage
//   POST   /api/v1/admin/providers/{provider}/verify          aiRouteManage
//   POST   /api/v1/admin/providers/{provider}/test-connection aiRouteManage
//   GET    /api/v1/admin/ai-usage                          aiManage
//
// THE PATHS ARE LEGACY'S, with two recorded differences (capability map §3): the
// relay configuration lives at `/admin/ai/relay` instead of
// `/admin/integrations/relay/config` (it configures an AI transport, and
// `integrations.*` permissions do not exist until phase 8), and the two probe
// routes keep Legacy's `/admin/providers/{provider}/…` shape exactly.
//
// AUTHORIZATION. `aiManage` reads; `aiRouteManage` writes anything that can spend
// money or move a secret — the split Legacy drew in Role.php, where P_AI_MANAGE is
// an admin permission and P_AI_ROUTE_MANAGE is super-admin-exclusive. A caller
// without the permission gets 403 BEFORE any body is read, and a deployment
// without the AI capability wired gets the documented fail-closed 503 rather than
// a 404 that would suggest the feature does not exist.
//
// NO SECRET EVER LEAVES. Writes return a fingerprint and a status; reads return
// `configured`, `source` and, for the relay, the HOST — never the URL, never the
// token, never a key.

import { fail, ok, canAct, type AuthorityContext, type Permission } from "@velora/contracts";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";
import { capabilityAbsent, forbidden, unauthenticated } from "../routes/responses.js";
import { AI_PROVIDER_NAMES, isAiProvider, type AiCatalogProvider } from "./aiCatalog.js";
import { AiConfigValidationError, type AiAdminService } from "./aiAdminService.js";
import { AiSecretMasterKeyMissingError, AiSecretValueInvalidError } from "./aiSecrets.js";

export const AI_ADMIN_OVERVIEW = "/api/v1/admin/ai/overview";
export const AI_ADMIN_FEATURE_PROVIDERS = "/api/v1/admin/ai/feature-providers";
export const AI_ADMIN_FEATURE_PROVIDERS_REORDER = "/api/v1/admin/ai/feature-providers/reorder";
export const AI_ADMIN_FLAGS = "/api/v1/admin/ai/flags";
export const AI_ADMIN_QUOTAS = "/api/v1/admin/ai/quotas";
export const AI_ADMIN_ROUTE = "/api/v1/admin/ai/route";
export const AI_ADMIN_RELAY = "/api/v1/admin/ai/relay";
export const AI_ADMIN_USAGE = "/api/v1/admin/ai-usage";

const FEATURE_PROVIDER_ID = /^\/api\/v1\/admin\/ai\/feature-providers\/([^/]+)$/u;
const FLAG_NAME = /^\/api\/v1\/admin\/ai\/flags\/([^/]+)$/u;
const QUOTA_PROVIDER = /^\/api\/v1\/admin\/ai\/quotas\/([^/]+)$/u;
const CREDENTIAL_KEY = /^\/api\/v1\/admin\/ai\/credentials\/([^/]+)$/u;
const PROVIDER_PROBE = /^\/api\/v1\/admin\/providers\/([^/]+)\/(verify|test-connection)$/u;

const READ_ROUTES: ReadonlyArray<{ readonly path: string; readonly permission: Permission }> = [
  { path: AI_ADMIN_OVERVIEW, permission: "aiManage" },
  { path: AI_ADMIN_FEATURE_PROVIDERS, permission: "aiManage" },
  { path: AI_ADMIN_FLAGS, permission: "aiManage" },
  { path: AI_ADMIN_QUOTAS, permission: "aiManage" },
  { path: AI_ADMIN_ROUTE, permission: "aiManage" },
  { path: AI_ADMIN_RELAY, permission: "aiManage" },
  { path: AI_ADMIN_USAGE, permission: "aiManage" },
];

export interface AiAdminCapability {
  readonly admin: AiAdminService;
}

export async function handleAiAdminRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  const capability: AiAdminCapability | null = ctx.config.aiAdmin ?? null;

  const readRoute = READ_ROUTES.find((r) => r.path === ctx.path) ?? null;
  const featureIdMatch = FEATURE_PROVIDER_ID.exec(ctx.path);
  const flagMatch = FLAG_NAME.exec(ctx.path);
  const quotaMatch = QUOTA_PROVIDER.exec(ctx.path);
  const credentialMatch = CREDENTIAL_KEY.exec(ctx.path);
  const probeMatch = PROVIDER_PROBE.exec(ctx.path);
  const isReorder = ctx.path === AI_ADMIN_FEATURE_PROVIDERS_REORDER;

  const owns = readRoute !== null || featureIdMatch !== null || flagMatch !== null || quotaMatch !== null ||
    credentialMatch !== null || probeMatch !== null || isReorder ||
    (ctx.path === AI_ADMIN_FEATURE_PROVIDERS && ctx.method !== "GET");
  if (!owns) return null;

  if (capability === null) return capabilityAbsent(ctx, "aiAdmin");

  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);
  const authority: AuthorityContext = { role: claims.role, isSystemOwner: await ctx.isSystemOwner(claims.sub) };

  // The permission is decided BEFORE the body is read: an unauthorized caller must
  // not get a validation error that describes the shape of a body they may not
  // send.
  const permission = permissionFor(ctx, readRoute?.permission ?? null, featureIdMatch, flagMatch, quotaMatch, credentialMatch, probeMatch, isReorder);
  if (!canAct(authority, permission)) return forbidden(ctx);

  const service = capability.admin;
  const actorId = claims.sub;

  try {
    // ── reads ────────────────────────────────────────────────────────────────
    if (ctx.path === AI_ADMIN_OVERVIEW && ctx.method === "GET") {
      return { status: 200, body: ok(await service.overview()) };
    }
    if (ctx.path === AI_ADMIN_FEATURE_PROVIDERS && ctx.method === "GET") {
      return { status: 200, body: ok({ items: await service.listFeatureRoutes() }) };
    }
    if (ctx.path === AI_ADMIN_FLAGS && ctx.method === "GET") {
      return { status: 200, body: ok({ items: await service.listFlags() }) };
    }
    if (ctx.path === AI_ADMIN_QUOTAS && ctx.method === "GET") {
      return { status: 200, body: ok({ items: await service.quotas() }) };
    }
    if (ctx.path === AI_ADMIN_ROUTE && ctx.method === "GET") {
      return { status: 200, body: ok(await service.route()) };
    }
    if (ctx.path === AI_ADMIN_RELAY && ctx.method === "GET") {
      return { status: 200, body: ok(await service.relayStatus()) };
    }
    if (ctx.path === AI_ADMIN_USAGE && ctx.method === "GET") {
      const limit = clampLimit(ctx.url.searchParams.get("limit"), 25, 100);
      if (limit === null) return validation(ctx, { limit: "1..100" });
      return {
        status: 200,
        body: ok(await service.usage({
          feature: ctx.url.searchParams.get("feature"),
          provider: ctx.url.searchParams.get("provider"),
          outcome: ctx.url.searchParams.get("outcome"),
          since: ctx.url.searchParams.get("since"),
          before: ctx.url.searchParams.get("before"),
          limit,
        })),
      };
    }

    // ── chains ───────────────────────────────────────────────────────────────
    if (ctx.path === AI_ADMIN_FEATURE_PROVIDERS && ctx.method === "POST") {
      const body = await ctx.readBody(ctx.req);
      const created = await service.createFeatureRoute({
        feature: String(body["feature"] ?? ""),
        provider: String(body["provider"] ?? ""),
        model: body["model"] === null || body["model"] === undefined ? null : String(body["model"]),
        priority: body["priority"] === undefined ? 1 : Number(body["priority"]),
        enabled: body["enabled"] === undefined ? true : Boolean(body["enabled"]),
        route: body["route"] === null || body["route"] === undefined ? null : String(body["route"]),
      });
      return { status: 201, body: ok(created) };
    }
    if (isReorder && ctx.method === "POST") {
      const body = await ctx.readBody(ctx.req);
      const ids = body["ids"];
      if (!Array.isArray(ids) || !ids.every((v) => typeof v === "string")) {
        return validation(ctx, { ids: "required, array of ids" });
      }
      const items = await service.reorderFeatureRoutes(String(body["feature"] ?? ""), ids as string[]);
      return { status: 200, body: ok({ items }) };
    }
    if (featureIdMatch !== null && ctx.method === "PATCH") {
      const body = await ctx.readBody(ctx.req);
      const patch: { model?: string | null; priority?: number; enabled?: boolean; route?: string | null } = {};
      if (Object.prototype.hasOwnProperty.call(body, "model")) patch.model = body["model"] === null ? null : String(body["model"]);
      if (Object.prototype.hasOwnProperty.call(body, "priority")) patch.priority = Number(body["priority"]);
      if (Object.prototype.hasOwnProperty.call(body, "enabled")) patch.enabled = Boolean(body["enabled"]);
      if (Object.prototype.hasOwnProperty.call(body, "route")) patch.route = body["route"] === null ? null : String(body["route"]);
      const updated = await service.updateFeatureRoute(featureIdMatch[1]!, patch);
      if (updated === null) return notFound(ctx, "AI_FEATURE_ROUTE_NOT_FOUND");
      return { status: 200, body: ok(updated) };
    }
    if (featureIdMatch !== null && ctx.method === "DELETE") {
      const removed = await service.deleteFeatureRoute(featureIdMatch[1]!);
      if (!removed) return notFound(ctx, "AI_FEATURE_ROUTE_NOT_FOUND");
      return { status: 200, body: ok({ removed: true }) };
    }

    // ── flags and budgets ────────────────────────────────────────────────────
    if (flagMatch !== null && ctx.method === "PUT") {
      const body = await ctx.readBody(ctx.req);
      if (typeof body["enabled"] !== "boolean" || body["rollout_percentage"] === undefined) {
        return validation(ctx, { enabled: "must be a boolean", rollout_percentage: "required, 0..100" });
      }
      const row = await service.setFlag(flagMatch[1]!, body["enabled"], Number(body["rollout_percentage"]), actorId);
      return { status: 200, body: ok(row) };
    }
    if (quotaMatch !== null && ctx.method === "PUT") {
      const body = await ctx.readBody(ctx.req);
      if (body["quota_limit"] === undefined) return validation(ctx, { quota_limit: "required, integer >= 0" });
      const row = await service.setQuotaLimit(quotaMatch[1]!, Number(body["quota_limit"]));
      return { status: 200, body: ok(row) };
    }

    // ── route ────────────────────────────────────────────────────────────────
    if (ctx.path === AI_ADMIN_ROUTE && ctx.method === "PUT") {
      const body = await ctx.readBody(ctx.req);
      const saved = await service.saveRoute(String(body["route"] ?? ""), actorId);
      return { status: 200, body: ok(saved) };
    }
    if (ctx.path === AI_ADMIN_ROUTE && ctx.method === "DELETE") {
      return { status: 200, body: ok(await service.clearRoute()) };
    }

    // ── relay ────────────────────────────────────────────────────────────────
    if (ctx.path === AI_ADMIN_RELAY && ctx.method === "PUT") {
      const body = await ctx.readBody(ctx.req);
      const saved = await service.saveRelay(String(body["url"] ?? ""), String(body["token"] ?? ""), actorId);
      // The response carries the host and the shape — never the URL or the token.
      return { status: 200, body: ok(saved) };
    }
    if (ctx.path === AI_ADMIN_RELAY && ctx.method === "DELETE") {
      return { status: 200, body: ok(await service.clearRelay()) };
    }

    // ── credentials ──────────────────────────────────────────────────────────
    if (credentialMatch !== null && ctx.method === "POST") {
      const body = await ctx.readBody(ctx.req);
      const value = typeof body["value"] === "string" ? body["value"] : "";
      const written = await service.replaceSecret(credentialMatch[1]!, value, actorId);
      return { status: 200, body: ok({ key: written.key, fingerprint: written.fingerprint, configured: true }) };
    }
    if (credentialMatch !== null && ctx.method === "DELETE") {
      const removed = await service.deleteSecret(credentialMatch[1]!);
      return { status: 200, body: ok(removed) };
    }

    // ── probes ───────────────────────────────────────────────────────────────
    if (probeMatch !== null && ctx.method === "POST") {
      const result = await service.probe(probeMatch[1]!, probeMatch[2] === "verify" ? "verify" : "test-connection", actorId);
      return { status: 200, body: ok(result) };
    }

    return methodNotAllowed(ctx);
  } catch (err) {
    if (err instanceof AiConfigValidationError) {
      return validation(ctx, { [err.field]: err.reason });
    }
    if (err instanceof AiSecretValueInvalidError) {
      return validation(ctx, { value: err.reason === "empty" ? "must not be empty" : "exceeds the managed size bound" });
    }
    if (err instanceof AiSecretMasterKeyMissingError) {
      // 503, not 500: the platform is healthy, the credential capability is not
      // configured. An operator must be able to tell those apart.
      return { status: 503, body: fail("CREDENTIAL_STORE_UNAVAILABLE", "Admin-managed AI secrets are unavailable without a master key.", ctx.requestId) };
    }
    throw err;
  }
}

function permissionFor(
  ctx: ExtendedRouteContext,
  readPermission: Permission | null,
  featureIdMatch: RegExpExecArray | null,
  flagMatch: RegExpExecArray | null,
  quotaMatch: RegExpExecArray | null,
  credentialMatch: RegExpExecArray | null,
  probeMatch: RegExpExecArray | null,
  isReorder: boolean,
): Permission {
  if (readPermission !== null && ctx.method === "GET") return readPermission;
  // Everything that can spend money or move a secret is super-admin-exclusive.
  if (credentialMatch !== null || probeMatch !== null || quotaMatch !== null) return "aiRouteManage";
  if (ctx.path === AI_ADMIN_ROUTE && ctx.method !== "GET") return "aiRouteManage";
  if (ctx.path === AI_ADMIN_RELAY && ctx.method !== "GET") return "aiRouteManage";
  if (isReorder || featureIdMatch !== null || flagMatch !== null || ctx.path === AI_ADMIN_FEATURE_PROVIDERS) return "aiManage";
  return "aiManage";
}

function clampLimit(raw: string | null, fallback: number, max: number): number | null {
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) return null;
  return value;
}

function validation(ctx: ExtendedRouteContext, details: Record<string, string>): RouteResult {
  return { status: 422, body: fail("VALIDATION_FAILED", "Validation failed.", ctx.requestId, details) };
}

function notFound(ctx: ExtendedRouteContext, code: string): RouteResult {
  return { status: 404, body: fail(code, "Not found.", ctx.requestId) };
}

function methodNotAllowed(ctx: ExtendedRouteContext): RouteResult {
  return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
}

export { AI_PROVIDER_NAMES, isAiProvider };
export type { AiCatalogProvider };
