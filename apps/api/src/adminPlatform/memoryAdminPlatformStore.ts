// Memory double for AdminPlatformStore — contract-identical, no I/O.

import type { AdminPlatformStore, FeatureFlagRow, SystemLogRow, UserBillingRow, PlanDistributionRow } from "./adminPlatformStore.js";

export class MemoryAdminPlatformStore implements AdminPlatformStore {
  private settings = new Map<string, { value: string | null; updatedBy: string | null; updatedAt: string }>();
  private flags = new Map<string, FeatureFlagRow>();
  private logs: SystemLogRow[] = [];
  private users = new Map<string, UserBillingRow & { tradingAccounts: number; aiUsage: { requests: number; failed: number; tokensUsed: number } }>();
  private seq = 1;

  constructor(seed?: {
    users?: Array<{ id: string; email: string; plan?: string | null; tradingAccounts?: number }>;
  }) {
    // seed canonical flags with defaults (mirrors 0028 seed)
    for (const name of ["ai_screenshot_extraction", "ai_trade_analysis", "ai_weekly_report", "ai_assistant"] as const) {
      this.flags.set(name, {
        featureName: name,
        enabled: name === "ai_screenshot_extraction",
        rolloutPercentage: name === "ai_screenshot_extraction" ? 100 : 0,
        updatedBy: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    if (seed?.users) {
      for (const u of seed.users) {
        this.users.set(u.id, { id: u.id, email: u.email, plan: u.plan ?? "free", tradingAccounts: u.tradingAccounts ?? 0, aiUsage: { requests: 0, failed: 0, tokensUsed: 0 } });
      }
    }
  }

  // settings
  async setting(key: string): Promise<string | null> {
    return this.settings.get(key)?.value ?? null;
  }
  async setSetting(key: string, value: string | null, actorId: string | null): Promise<void> {
    this.settings.set(key, { value, updatedBy: actorId, updatedAt: new Date().toISOString() });
  }
  async deleteSetting(key: string): Promise<boolean> {
    return this.settings.delete(key);
  }
  async allSettings(): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const [k, v] of this.settings.entries()) out[k] = v.value;
    return out;
  }
  async allSettingsDetailed(): Promise<Array<{ key: string; value: string | null; updatedBy: string | null; updatedAt: string | null }>> {
    const out: Array<{ key: string; value: string | null; updatedBy: string | null; updatedAt: string | null }> = [];
    for (const [k, v] of this.settings.entries()) out.push({ key: k, value: v.value, updatedBy: v.updatedBy, updatedAt: v.updatedAt });
    return out;
  }

  // feature flags
  async listFeatureFlags(): Promise<FeatureFlagRow[]> {
    return [...this.flags.values()].sort((a, b) => a.featureName.localeCompare(b.featureName));
  }
  async getFeatureFlag(feature: string): Promise<FeatureFlagRow | null> {
    return this.flags.get(feature) ?? null;
  }
  async setFeatureFlag(feature: string, enabled: boolean, rollout: number, actorId: string | null): Promise<FeatureFlagRow> {
    const row: FeatureFlagRow = {
      featureName: feature,
      enabled,
      rolloutPercentage: rollout,
      updatedBy: actorId,
      createdAt: this.flags.get(feature)?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.flags.set(feature, row);
    return row;
  }

  // system logs
  async listSystemLogs(
    filters: { severity?: string; source?: string; since?: string; until?: string; q?: string },
    page: number,
    perPage: number,
  ): Promise<{ items: SystemLogRow[]; total: number; page: number; per_page: number }> {
    let items = [...this.logs];
    if (filters.severity !== undefined && filters.severity !== "" && ["DEBUG", "INFO", "WARN", "ERROR"].includes(filters.severity.toUpperCase())) {
      const sev = filters.severity.toUpperCase();
      items = items.filter((r) => r.severity === sev);
    }
    if (filters.source !== undefined && filters.source !== "") {
      items = items.filter((r) => r.source === String(filters.source).slice(0, 64));
    }
    if (filters.since !== undefined && filters.since !== "") items = items.filter((r) => r.createdAt >= String(filters.since));
    if (filters.until !== undefined && filters.until !== "") items = items.filter((r) => r.createdAt <= String(filters.until));
    if (filters.q !== undefined && filters.q !== "") {
      const q = String(filters.q).toLowerCase();
      items = items.filter((r) => (r.message ?? "").toLowerCase().includes(q) || (r.requestId ?? "").toLowerCase().includes(q) || (r.errorCode ?? "").toLowerCase().includes(q));
    }
    items.sort((a, b) => Number(b.id) - Number(a.id));
    const total = items.length;
    const p = Math.max(1, page);
    const pp = Math.min(100, Math.max(1, perPage));
    const start = (p - 1) * pp;
    return { items: items.slice(start, start + pp), total, page: p, per_page: pp };
  }
  async createSystemLog(entry: {
    severity: SystemLogRow["severity"];
    source: string;
    message?: string | null;
    requestId?: string | null;
    correlationId?: string | null;
    userId?: string | null;
    errorCode?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<SystemLogRow> {
    const row: SystemLogRow = {
      id: String(this.seq++),
      severity: entry.severity,
      source: entry.source.slice(0, 64),
      message: entry.message ?? null,
      requestId: entry.requestId ?? null,
      correlationId: entry.correlationId ?? null,
      userId: entry.userId ?? null,
      errorCode: entry.errorCode ?? null,
      metadata: entry.metadata ?? null,
      createdAt: new Date().toISOString(),
    };
    this.logs.push(row);
    return row;
  }

  // billing reads
  async getUser(userId: string): Promise<UserBillingRow | null> {
    const u = this.users.get(userId);
    return u ? { id: u.id, email: u.email, plan: u.plan } : null;
  }
  async planDistribution(): Promise<PlanDistributionRow[]> {
    const allowed = ["free", "pro", "enterprise"] as const;
    const counts = new Map<string, number>(allowed.map((k) => [k, 0]));
    for (const u of this.users.values()) counts.set(u.plan ?? "free", (counts.get(u.plan ?? "free") ?? 0) + 1);
    return allowed.map((k) => ({ key: k, count: counts.get(k) ?? 0 }));
  }
  async userCount(): Promise<number> {
    return this.users.size;
  }
  async tradingAccountsCount(userId: string): Promise<number> {
    return this.users.get(userId)?.tradingAccounts ?? 0;
  }
  async aiUsage(userId: string): Promise<{ requests: number; failed: number; tokensUsed: number; available: boolean }> {
    const u = this.users.get(userId);
    if (!u) return { requests: 0, failed: 0, tokensUsed: 0, available: true };
    return { requests: u.aiUsage.requests, failed: u.aiUsage.failed, tokensUsed: u.aiUsage.tokensUsed, available: true };
  }
  async providerQuotas(): Promise<Array<{ provider: string; used: number; limit: number; resetAt: string | null }>> {
    return [
      { provider: "gemini", used: 0, limit: 1500, resetAt: new Date().toISOString() },
      { provider: "openai", used: 0, limit: 1500, resetAt: new Date().toISOString() },
    ];
  }
  async subscriptionsCount(): Promise<number> {
    return 0;
  }

  // test helper
  seedUser(user: { id: string; email: string; plan?: string | null }) {
    this.users.set(user.id, { id: user.id, email: user.email, plan: user.plan ?? "free", tradingAccounts: 0, aiUsage: { requests: 0, failed: 0, tokensUsed: 0 } });
  }
}
