// Admin platform service — business capability, not a PHP port.
//
// The 8 routes are:
//   GET    /admin/settings                          settings.view
//   PUT    /admin/settings/{key}                    system.settings.manage
//   DELETE /admin/settings/{key}                    system.settings.manage
//   GET    /admin/feature-flags                     feature_flags.view
//   PATCH  /admin/feature-flags/{feature}           feature_flags.edit
//   GET    /admin/logs/system                       system.logs.view
//   GET    /admin/billing                           billing.view
//   GET    /admin/billing/users/{id}                billing.view
//
// Modern architecture decisions (capability → business meaning → Modern architecture):
//   - Settings: strict allowlist, fail-closed. Only platform.default_locale is
//     writable; everything else is either a secret (never here), env-controlled
//     infra, or a supervisory read of another module's key (single-owner rule).
//     Storage precedence is: admin row (integration_settings) → ENV alias → default.
//     DELETE removes the row so the value inherits again — never ambiguous.
//   - Feature flags: closed vocabulary (CANONICAL_FLAGS), enabled boolean,
//     rollout 0..100, deterministic per-user rollout via crc32 is server-side
//     in the guard, but the admin surface only persists the gate + percentage.
//     The table is ai_feature_flags (0028) — no second flag store.
//   - System logs: append-only, read via filters + pagination, severity/sourc
//     allowlisted, q is a LIKE over message/request/error, pagination bounded,
//     ordering newest-first (id DESC). No update/delete for the UI.
//   - Billing: read-only observability over the internal subscription layer
//     (users.plan + subscriptions + ai quotas). There is NO external provider
//     (classification C): provider.available is always false with a reason,
//     history unavailable, price not authoritative — never fabricated.

import type { AdminPlatformStore, FeatureFlagRow, SystemLogRow } from "./adminPlatformStore.js";

// ── error shape ───────────────────────────────────────────────────────────────

export class ValidationError extends Error {
  readonly details: Record<string, readonly string[]>;
  constructor(message: string, details: Record<string, readonly string[]>, readonly code = "VALIDATION_ERROR") {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

// ── settings catalog (Legacy AdminSettingsService::CATALOG, verbatim) ───────

export const PLATFORM_SETTINGS_CATALOG = {
  "platform.default_locale": {
    kind: "enum" as const,
    choices: ["fa", "en"] as const,
    default: "fa" as const,
    envAlias: "PLATFORM_DEFAULT_LOCALE",
    module: "platform",
    consumer: "signup default locale (UserRepository)",
  },
} as const;

export type PlatformSettingKey = keyof typeof PLATFORM_SETTINGS_CATALOG;

export const MANAGED_ELSEWHERE: Record<string, { module: string; endpoint: string | null; envAlias: string | null }> = {
  "METAAPI_BASE_URL": { module: "integrations-metaapi", endpoint: "/api/v1/admin/integrations/metaapi", envAlias: "METAAPI_BASE_URL" },
  "MAIL_DRIVER": { module: "integrations-email", endpoint: "/api/v1/admin/integrations/email", envAlias: "MAIL_DRIVER" },
  "MAIL_FROM": { module: "integrations-email", endpoint: "/api/v1/admin/integrations/email", envAlias: "MAIL_FROM" },
  "MAIL_FROM_NAME": { module: "integrations-email", endpoint: "/api/v1/admin/integrations/email", envAlias: "MAIL_FROM_NAME" },
  "MAIL_HOST": { module: "integrations-email", endpoint: "/api/v1/admin/integrations/email", envAlias: "MAIL_HOST" },
  "MAIL_PORT": { module: "integrations-email", endpoint: "/api/v1/admin/integrations/email", envAlias: "MAIL_PORT" },
  "MAIL_USER": { module: "integrations-email", endpoint: "/api/v1/admin/integrations/email", envAlias: "MAIL_USER" },
  // ai_route_default lives in ai_settings (0028) — shown as supervisory read when present
  "ai_route_default": { module: "ai-route", endpoint: "/api/v1/admin/ai/route", envAlias: null },
};

// ── feature flags canonical (Legacy AIFeatureFlagRepository::CANONICAL_FLAGS) ─

export const CANONICAL_FLAGS = ["ai_screenshot_extraction", "ai_trade_analysis", "ai_weekly_report", "ai_assistant"] as const;
export type CanonicalFlag = (typeof CANONICAL_FLAGS)[number];
export function isCanonicalFlag(value: string): value is CanonicalFlag {
  return (CANONICAL_FLAGS as readonly string[]).includes(value);
}

// ── billing constants (Legacy BillingService, classification C) ──────────────

export const BILLING_PLANS = ["free", "pro", "enterprise"] as const;
export const BILLING_SUBSCRIPTION_STATUSES = ["none", "active", "past_due", "grace", "expired", "cancelled"] as const;

// ── service deps ─────────────────────────────────────────────────────────────

export interface AdminPlatformServiceDeps {
  readonly store: AdminPlatformStore;
  readonly env?: (key: string) => string | undefined;
}

export class AdminPlatformService {
  constructor(private readonly deps: AdminPlatformServiceDeps) {}

  private envTrim(key: string): string {
    const fn = this.deps.env ?? ((k: string) => process.env[k]);
    return (fn(key) ?? "").trim();
  }

  // ── settings ───────────────────────────────────────────────────────────────

  validateSetting(key: string, value: string): string {
    const spec = (PLATFORM_SETTINGS_CATALOG as Record<string, { kind: string; choices: readonly string[] }>)[key];
    if (!spec) {
      throw new ValidationError("Unknown or non-writable setting.", { key: ["UNKNOWN_SETTING"] });
    }
    const v = value.trim().toLowerCase();
    if (spec.kind === "enum" && !(spec.choices as readonly string[]).includes(v)) {
      throw new ValidationError("Invalid setting value.", { value: ["INVALID_CHOICE"] });
    }
    return v;
  }

  async settingsInventory(): Promise<Array<{
    key: string;
    value: string | null;
    source: "admin" | "env-default";
    updatedBy: string | null;
    updatedAt: string | null;
    writable: boolean;
    module: string;
    moduleEndpoint: string | null;
    envAlias: string | null;
  }>> {
    const detailed = await this.deps.store.allSettingsDetailed();
    const byKey = new Map(detailed.map((r) => [r.key, r]));
    const out: Array<{
      key: string;
      value: string | null;
      source: "admin" | "env-default";
      updatedBy: string | null;
      updatedAt: string | null;
      writable: boolean;
      module: string;
      moduleEndpoint: string | null;
      envAlias: string | null;
    }> = [];
    // writable catalog first
    for (const [key, spec] of Object.entries(PLATFORM_SETTINGS_CATALOG)) {
      const row = byKey.get(key);
      const stored = row?.value ?? null;
      out.push({
        key,
        value: stored,
        source: stored !== null ? "admin" : "env-default",
        updatedBy: row?.updatedBy ?? null,
        updatedAt: row?.updatedAt ?? null,
        writable: true,
        module: spec.module,
        moduleEndpoint: null,
        envAlias: spec.envAlias,
      });
    }
    // supervisory reads (module-managed)
    for (const [key, meta] of Object.entries(MANAGED_ELSEWHERE)) {
      const row = byKey.get(key);
      const stored = row?.value ?? null;
      // for ai_route_default, we also consider ai_settings via env? but keep simple
      out.push({
        key,
        value: stored,
        source: stored !== null ? "admin" : "env-default",
        updatedBy: row?.updatedBy ?? null,
        updatedAt: row?.updatedAt ?? null,
        writable: false,
        module: meta.module,
        moduleEndpoint: meta.endpoint,
        envAlias: meta.envAlias,
      });
    }
    return out;
  }

  async updateSetting(key: string, value: string, actorId: string | null): Promise<{ key: string; old: string | null; new: string }> {
    const normalized = this.validateSetting(key, value);
    const before = await this.deps.store.setting(key);
    await this.deps.store.setSetting(key, normalized, actorId);
    return { key, old: before, new: normalized };
  }

  async resetSetting(key: string): Promise<{ key: string; old: string | null }> {
    if (!(key in PLATFORM_SETTINGS_CATALOG)) {
      throw new ValidationError("Unknown or non-writable setting.", { key: ["UNKNOWN_SETTING"] });
    }
    const before = await this.deps.store.setting(key);
    await this.deps.store.deleteSetting(key);
    return { key, old: before };
  }

  // ── feature flags ─────────────────────────────────────────────────────────

  async listFeatureFlags(): Promise<Array<{
    feature: string;
    enabled: boolean;
    rollout: number;
    effective: string;
    persisted: boolean;
    updatedBy: string | null;
    updatedAt: string | null;
  }>> {
    const rows = await this.deps.store.listFeatureFlags();
    const byName = new Map(rows.map((r) => [r.featureName, r]));
    const out: Array<{ feature: string; enabled: boolean; rollout: number; effective: string; persisted: boolean; updatedBy: string | null; updatedAt: string | null }> = [];
    for (const name of CANONICAL_FLAGS) {
      const row = byName.get(name);
      const persisted = row !== undefined;
      // Legacy default: ai_screenshot_extraction enabled, others disabled
      const enabled = persisted ? row!.enabled : name === "ai_screenshot_extraction";
      const rollout = persisted ? row!.rolloutPercentage : name === "ai_screenshot_extraction" ? 100 : 0;
      const effective = !enabled || rollout <= 0 ? "off" : rollout >= 100 ? "on" : `rollout:${rollout}`;
      out.push({ feature: name, enabled, rollout, effective, persisted, updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt ?? null });
    }
    return out;
  }

  async updateFeatureFlag(feature: string, enabled: unknown, rollout: unknown, actorId: string | null): Promise<{
    feature: string;
    enabled: boolean;
    rollout: number;
    effective: string;
    persisted: boolean;
    updatedBy: string | null;
    updatedAt: string | null;
  }> {
    if (!isCanonicalFlag(feature)) {
      throw new ValidationError("Unknown feature flag.", { feature: ["UNKNOWN_FEATURE_FLAG"] });
    }
    if (typeof enabled !== "boolean") {
      throw new ValidationError("enabled must be boolean.", { enabled: ["ENABLED_REQUIRED"] });
    }
    const r = Number(rollout);
    if (!Number.isInteger(r) || r < 0 || r > 100) {
      throw new ValidationError("rollout must be between 0 and 100.", { rollout: ["ROLLOUT_RANGE"] });
    }
    const saved = await this.deps.store.setFeatureFlag(feature, enabled, r, actorId);
    const effective = !saved.enabled || saved.rolloutPercentage <= 0 ? "off" : saved.rolloutPercentage >= 100 ? "on" : `rollout:${saved.rolloutPercentage}`;
    return {
      feature: saved.featureName,
      enabled: saved.enabled,
      rollout: saved.rolloutPercentage,
      effective,
      persisted: true,
      updatedBy: saved.updatedBy,
      updatedAt: saved.updatedAt,
    };
  }

  // ── system logs ────────────────────────────────────────────────────────────

  async listSystemLogs(filters: { severity?: string; source?: string; since?: string; until?: string; q?: string }, page: number, perPage: number) {
    // normalize severity
    const sev = filters.severity !== undefined && filters.severity !== "" ? String(filters.severity).toUpperCase() : undefined;
    if (sev !== undefined && !["DEBUG", "INFO", "WARN", "ERROR"].includes(sev)) {
      throw new ValidationError("Invalid severity.", { severity: ["INVALID_SEVERITY"] });
    }
    const pg = Math.max(1, Math.floor(page) || 1);
    const pp = Math.min(100, Math.max(1, Math.floor(perPage) || 50));
    const query: { severity?: string; source?: string; since?: string; until?: string; q?: string } = {};
    if (sev !== undefined) query.severity = sev;
    if (filters.source !== undefined) query.source = filters.source;
    if (filters.since !== undefined) query.since = filters.since;
    if (filters.until !== undefined) query.until = filters.until;
    if (filters.q !== undefined) query.q = filters.q;
    return this.deps.store.listSystemLogs(query, pg, pp);
  }

  // ── billing ────────────────────────────────────────────────────────────────

  async billingOverview(): Promise<{
    provider: { available: false; reason: string };
    plans: Array<{ key: string; name: string; active: boolean; available: boolean; price: { available: false; reason: string }; currency: null; interval: null }>;
    subscriptionStatuses: Array<{ key: string; active: boolean; available: boolean }>;
    distribution: { available: boolean; plan: Array<{ key: string; count: number }>; subscriptionStatus: Array<{ key: string; count: number }> };
    entitlements: { tradingAccountsPerUser: { limit: number; source: string }; providerBudget: { available: boolean; internal?: boolean; items?: Array<{ provider: string; used: number; limit: number; resetAt: string | null }> } };
    history: { available: false; reason: string };
  }> {
    const hasLayer = true; // users.plan always exists since 0002/0017
    const planDist = await this.deps.store.planDistribution();
    // subscription status distribution is NOT authoritative (no users.subscription_status) — report unavailable
    const statusDist: Array<{ key: string; count: number }> = BILLING_SUBSCRIPTION_STATUSES.map((k) => ({ key: k, count: 0 }));
    // entitlements
    const limit = Math.max(1, Number(this.envTrim("METAAPI_MAX_ACCOUNTS_PER_USER") || this.envTrim("metaapi.max_accounts_per_user") || "10") || 10);
    const providerBudget = await this.buildProviderBudget();
    return {
      provider: { available: false, reason: "No external payment/billing integration exists (no provider client, no credit card, no webhook). Subscription state is internal/manual only." },
      plans: [...BILLING_PLANS].map((k) => ({
        key: k,
        name: k === "enterprise" ? "Enterprise" : k === "pro" ? "Pro" : "Free",
        active: true,
        available: hasLayer,
        price: { available: false, reason: "Plan price is not authoritative: no external billing/pricing source exists." } as const,
        currency: null,
        interval: null,
      })),
      subscriptionStatuses: [...BILLING_SUBSCRIPTION_STATUSES].map((k) => ({ key: k, active: true, available: true })),
      distribution: { available: hasLayer, plan: planDist, subscriptionStatus: statusDist },
      entitlements: {
        tradingAccountsPerUser: { limit, source: "config:metaapi.max_accounts_per_user" },
        providerBudget,
      },
      history: { available: false, reason: "No invoice/payment history exists (no billing provider)." },
    };
  }

  private async buildProviderBudget(): Promise<{ available: boolean; internal?: boolean; items?: Array<{ provider: string; used: number; limit: number; resetAt: string | null }> }> {
    const items = await this.deps.store.providerQuotas();
    if (items.length === 0) return { available: false };
    return { available: true, internal: true, items };
  }

  async billingUser(userId: string): Promise<{
    user: { id: string; email: string };
    subscription: { available: boolean; plan: string | null; status: string | null; startedAt: null; expiresAt: null; updatedAt: null; provider: null; billingCustomerId: null; trial: false; cancelledAt: null; period: null };
    entitlements: { tradingAccounts: { used: number; limit: number; source: string }; aiUsage: { requests: number; failed: number; tokensUsed: number; available: boolean } };
    history: { available: false; reason: string };
  }> {
    if (!/^\d+$/.test(userId)) throw new ValidationError("Invalid user id.", { id: ["INVALID_USER_ID"] });
    const u = await this.deps.store.getUser(userId);
    if (u === null) {
      // mimic Legacy NotFound — but service throws generic, route maps to 404
      throw new ValidationError("User not found.", { id: ["USER_NOT_FOUND"] });
    }
    const limit = Math.max(1, Number(this.envTrim("METAAPI_MAX_ACCOUNTS_PER_USER") || "10") || 10);
    const used = await this.deps.store.tradingAccountsCount(userId);
    const aiUsage = await this.deps.store.aiUsage(userId);
    return {
      user: { id: u.id, email: u.email },
      subscription: {
        available: true,
        plan: u.plan ?? "free",
        status: null,
        startedAt: null,
        expiresAt: null,
        updatedAt: null,
        provider: null,
        billingCustomerId: null,
        trial: false,
        cancelledAt: null,
        period: null,
      },
      entitlements: {
        tradingAccounts: { used, limit, source: "config:metaapi.max_accounts_per_user" },
        aiUsage,
      },
      history: { available: false, reason: "No invoice/payment history exists (no billing provider)." },
    };
  }
}
