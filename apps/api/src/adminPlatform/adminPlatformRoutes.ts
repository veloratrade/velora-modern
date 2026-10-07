// Admin platform HTTP surface — Phase 9 remaining MG-ADMIN block.
//
//   GET    /api/v1/admin/settings                       settings.view
//   PUT    /api/v1/admin/settings/{key}                 system.settings.manage
//   DELETE /api/v1/admin/settings/{key}                 system.settings.manage
//   GET    /api/v1/admin/feature-flags                  feature_flags.view
//   PATCH  /api/v1/admin/feature-flags/{feature}        feature_flags.edit
//   GET    /api/v1/admin/logs/system                    system.logs.view
//   GET    /api/v1/admin/billing                        billing.view
//   GET    /api/v1/admin/billing/users/{id}             billing.view
//
// AUTHORIZATION: server-side, permission-checked before body read.
// No secret ever leaves. Validation is fail-closed (422 with structured details).

import { fail, ok, canAct, type AuthorityContext, type Permission } from "@velora/contracts";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";
import { capabilityAbsent, forbidden, unauthenticated } from "../routes/responses.js";
import { AdminPlatformService, ValidationError } from "./adminPlatformService.js";
import type { AdminPlatformStore } from "./adminPlatformStore.js";

export const ADMIN_SETTINGS = "/api/v1/admin/settings";
export const ADMIN_FEATURE_FLAGS = "/api/v1/admin/feature-flags";
export const ADMIN_SYSTEM_LOGS = "/api/v1/admin/logs/system";
export const ADMIN_BILLING = "/api/v1/admin/billing";

const SETTINGS_KEY = /^\/api\/v1\/admin\/settings\/([^/]+)$/u;
const FEATURE_FLAG_KEY = /^\/api\/v1\/admin\/feature-flags\/([^/]+)$/u;
const BILLING_USER = /^\/api\/v1\/admin\/billing\/users\/([^/]+)$/u;

export interface AdminPlatformCapability {
  readonly platform: AdminPlatformService;
  readonly store: AdminPlatformStore;
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

export async function handleAdminPlatformRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  const cap: AdminPlatformCapability | null = (ctx.config as unknown as { adminPlatform?: AdminPlatformCapability }).adminPlatform ?? null;

  const isSettings = ctx.path === ADMIN_SETTINGS;
  const settingsMatch = SETTINGS_KEY.exec(ctx.path);
  const isFeatureFlags = ctx.path === ADMIN_FEATURE_FLAGS;
  const flagMatch = FEATURE_FLAG_KEY.exec(ctx.path);
  const isSystemLogs = ctx.path === ADMIN_SYSTEM_LOGS;
  const isBilling = ctx.path === ADMIN_BILLING;
  const billingUserMatch = BILLING_USER.exec(ctx.path);

  const owns =
    isSettings ||
    settingsMatch !== null ||
    isFeatureFlags ||
    flagMatch !== null ||
    isSystemLogs ||
    isBilling ||
    billingUserMatch !== null;
  if (!owns) return null;

  if (cap === null) return capabilityAbsent(ctx, "adminPlatform");

  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);
  const authority: AuthorityContext = { role: claims.role, isSystemOwner: await ctx.isSystemOwner(claims.sub) };

  // permission before body read
  let permission: Permission | null = null;
  if (isSettings) permission = "settings.view";
  else if (settingsMatch !== null) permission = "system.settings.manage";
  else if (isFeatureFlags) permission = "feature_flags.view";
  else if (flagMatch !== null) permission = "feature_flags.edit";
  else if (isSystemLogs) permission = "system.logs.view";
  else if (isBilling || billingUserMatch !== null) permission = "billing.view";

  if (permission !== null && !canAct(authority, permission)) return forbidden(ctx);

  const service = cap.platform;
  const actorId = claims.sub;

  try {
    // ── settings ────────────────────────────────────────────────────────────
    if (isSettings && ctx.method === "GET") {
      const items = await service.settingsInventory();
      return { status: 200, body: ok({ settings: items }) };
    }
    if (settingsMatch !== null && ctx.method === "PUT") {
      const key = decodeURIComponent(settingsMatch[1]!);
      const body = await ctx.readBody(ctx.req);
      const value = typeof body["value"] === "string" ? body["value"] : "";
      if (value.trim() === "") return validation(ctx, { value: "must not be empty" });
      const result = await service.updateSetting(key, value, actorId);
      return { status: 200, body: ok({ setting: { key: result.key, value: result.new, source: "admin", writable: true } }) };
    }
    if (settingsMatch !== null && ctx.method === "DELETE") {
      const key = decodeURIComponent(settingsMatch[1]!);
      await service.resetSetting(key);
      return { status: 200, body: ok({ setting: { key, value: null, source: "env-default", writable: true } }) };
    }

    // ── feature flags ───────────────────────────────────────────────────────
    if (isFeatureFlags && ctx.method === "GET") {
      const flags = await service.listFeatureFlags();
      return { status: 200, body: ok({ flags, environment: (process.env["APP_ENV"] ?? "production").toLowerCase(), allowed: ["ai_screenshot_extraction", "ai_trade_analysis", "ai_weekly_report", "ai_assistant"] }) };
    }
    if (flagMatch !== null && ctx.method === "PATCH") {
      const feature = decodeURIComponent(flagMatch[1]!);
      const body = await ctx.readBody(ctx.req);
      const enabled = body["enabled"];
      const rollout = body["rollout"] !== undefined ? body["rollout"] : body["rollout_percentage"] !== undefined ? body["rollout_percentage"] : undefined;
      if (typeof enabled !== "boolean") return validation(ctx, { enabled: "must be a boolean" });
      if (rollout === undefined) return validation(ctx, { rollout: "required, 0..100" });
      const updated = await service.updateFeatureFlag(feature, enabled, rollout, actorId);
      return { status: 200, body: ok({ flag: updated }) };
    }

    // ── system logs ─────────────────────────────────────────────────────────
    if (isSystemLogs && ctx.method === "GET") {
      const q = ctx.url.searchParams;
      const page = Number(q.get("page") ?? "1");
      const perPage = Number(q.get("per_page") ?? q.get("perPage") ?? "50");
      if (!Number.isFinite(page) || page < 1) return validation(ctx, { page: "must be >= 1" });
      if (!Number.isFinite(perPage) || perPage < 1 || perPage > 100) return validation(ctx, { per_page: "1..100" });
      const filters: { severity?: string; source?: string; since?: string; until?: string; q?: string } = {};
      const sev = q.get("severity");
      if (sev !== null && sev !== "") filters.severity = sev;
      const src = q.get("source");
      if (src !== null && src !== "") filters.source = src;
      const since = q.get("since");
      if (since !== null && since !== "") filters.since = since;
      const until = q.get("until");
      if (until !== null && until !== "") filters.until = until;
      const qq = q.get("q");
      if (qq !== null && qq !== "") filters.q = qq;
      const result = await service.listSystemLogs(
        filters,
        Number.isFinite(page) ? page : 1,
        Number.isFinite(perPage) ? perPage : 50,
      );
      return { status: 200, body: ok(result) };
    }

    // ── billing ─────────────────────────────────────────────────────────────
    if (isBilling && ctx.method === "GET") {
      const overview = await service.billingOverview();
      return { status: 200, body: ok(overview) };
    }
    if (billingUserMatch !== null && ctx.method === "GET") {
      const userId = decodeURIComponent(billingUserMatch[1]!);
      if (!/^\d+$/.test(userId)) return validation(ctx, { id: "must be numeric" });
      try {
        const data = await service.billingUser(userId);
        return { status: 200, body: ok(data) };
      } catch (e) {
        if (e instanceof ValidationError && (e.details["id"]?.includes("USER_NOT_FOUND") || (e.details as Record<string, readonly string[]>)["id"]?.[0] === "USER_NOT_FOUND")) {
          return notFound(ctx, "USER_NOT_FOUND");
        }
        if (e instanceof ValidationError && e.message === "User not found.") return notFound(ctx, "USER_NOT_FOUND");
        throw e;
      }
    }

    return methodNotAllowed(ctx);
  } catch (err) {
    if (err instanceof ValidationError) {
      // map known codes to structured details
      const details: Record<string, string> = {};
      for (const [k, v] of Object.entries(err.details)) details[k] = Array.isArray(v) ? v.join(", ") : String(v);
      // special case: USER_NOT_FOUND should be 404, but validation path is 422
      if (details["id"] === "USER_NOT_FOUND" || err.message === "User not found.") {
        return notFound(ctx, "USER_NOT_FOUND");
      }
      return validation(ctx, details);
    }
    throw err;
  }
}
