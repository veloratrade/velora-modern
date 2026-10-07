// Admin platform persistence — settings, feature flags, system logs, billing reads.
//
// ONE STORE, TWO ADAPTERS: PgAdminPlatformStore over `pg` Pool and
// MemoryAdminPlatformStore as contract-identical double for unit tests.
// The capability covers the remaining MG-ADMIN Phase 9 block:
//   • Platform settings (platform.default_locale, supervisory reads)
//   • Feature flags (ai_* flags, 0028 table, closed vocabulary)
//   • System logs (system_logs, append-only, redacted)
//   • Billing observability (read-only over users/subscriptions/ai_quotas)
//
// NO SECOND TABLE for flags/settings — they reuse ai_feature_flags (0028) and
// integration_settings (0031). Only system_logs is new (0032).

import type { Pool } from "pg";
import { poolQuery } from "../persistence/pg.js";

// ── row types ────────────────────────────────────────────────────────────────

export interface FeatureFlagRow {
  readonly featureName: string;
  readonly enabled: boolean;
  readonly rolloutPercentage: number;
  readonly updatedBy: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface SystemLogRow {
  readonly id: string;
  readonly severity: "DEBUG" | "INFO" | "WARN" | "ERROR";
  readonly source: string;
  readonly message: string | null;
  readonly requestId: string | null;
  readonly correlationId: string | null;
  readonly userId: string | null;
  readonly errorCode: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: string;
}

export interface PlanDistributionRow {
  readonly key: string;
  readonly count: number;
}

export interface UserBillingRow {
  readonly id: string;
  readonly email: string;
  readonly plan: string | null;
}

// ── store interface ─────────────────────────────────────────────────────────

export interface AdminPlatformStore {
  // settings (generic integration_settings rows)
  setting(key: string): Promise<string | null>;
  setSetting(key: string, value: string | null, actorId: string | null): Promise<void>;
  deleteSetting(key: string): Promise<boolean>;
  allSettings(): Promise<Record<string, string | null>>;
  allSettingsDetailed(): Promise<Array<{ key: string; value: string | null; updatedBy: string | null; updatedAt: string | null }>>;

  // feature flags (ai_feature_flags)
  listFeatureFlags(): Promise<FeatureFlagRow[]>;
  getFeatureFlag(feature: string): Promise<FeatureFlagRow | null>;
  setFeatureFlag(feature: string, enabled: boolean, rollout: number, actorId: string | null): Promise<FeatureFlagRow>;

  // system logs (system_logs, read + test-seed)
  listSystemLogs(
    filters: { severity?: string; source?: string; since?: string; until?: string; q?: string },
    page: number,
    perPage: number,
  ): Promise<{ items: SystemLogRow[]; total: number; page: number; per_page: number }>;
  createSystemLog(entry: {
    severity: SystemLogRow["severity"];
    source: string;
    message?: string | null;
    requestId?: string | null;
    correlationId?: string | null;
    userId?: string | null;
    errorCode?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<SystemLogRow>;

  // billing reads
  getUser(userId: string): Promise<UserBillingRow | null>;
  planDistribution(): Promise<PlanDistributionRow[]>;
  userCount(): Promise<number>;
  tradingAccountsCount(userId: string): Promise<number>;
  aiUsage(userId: string): Promise<{ requests: number; failed: number; tokensUsed: number; available: boolean }>;
  providerQuotas(): Promise<Array<{ provider: string; used: number; limit: number; resetAt: string | null }>>;
  subscriptionsCount(): Promise<number>;
}

// ── helpers ─────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
function toRow(r: Row): FeatureFlagRow {
  return {
    featureName: String(r["feature_name"]),
    enabled: Boolean(r["enabled"]),
    rolloutPercentage: Number(r["rollout_percentage"] ?? 0),
    updatedBy: r["updated_by"] === null || r["updated_by"] === undefined ? null : String(r["updated_by"]),
    createdAt: r["created_at"] === null || r["created_at"] === undefined ? null : String(r["created_at"]),
    updatedAt: r["updated_at"] === null || r["updated_at"] === undefined ? null : String(r["updated_at"]),
  };
}
function toLogRow(r: Row): SystemLogRow {
  let meta: Record<string, unknown> | null = null;
  const raw = r["metadata_json"];
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
    } catch {
      meta = null;
    }
  } else if (raw !== null && typeof raw === "object") {
    meta = raw as Record<string, unknown>;
  }
  return {
    id: String(r["id"]),
    severity: String(r["severity"]).toUpperCase() as SystemLogRow["severity"],
    source: String(r["source"]),
    message: r["message"] === null || r["message"] === undefined ? null : String(r["message"]),
    requestId: r["request_id"] === null || r["request_id"] === undefined ? null : String(r["request_id"]),
    correlationId: r["correlation_id"] === null || r["correlation_id"] === undefined ? null : String(r["correlation_id"]),
    userId: r["user_id"] === null || r["user_id"] === undefined ? null : String(r["user_id"]),
    errorCode: r["error_code"] === null || r["error_code"] === undefined ? null : String(r["error_code"]),
    metadata: meta,
    createdAt: String(r["created_at"]),
  };
}

// ── PG adapter ───────────────────────────────────────────────────────────────

export class PgAdminPlatformStore implements AdminPlatformStore {
  private readonly q: ReturnType<typeof poolQuery>;
  constructor(private readonly pool: Pool) {
    this.q = poolQuery(pool);
  }

  // settings — integration_settings
  async setting(key: string): Promise<string | null> {
    const rows = await this.q(`SELECT setting_value FROM integration_settings WHERE setting_key = $1`, [key]);
    return rows.length === 0 ? null : str((rows[0] as Row)["setting_value"]);
  }
  async setSetting(key: string, value: string | null, actorId: string | null): Promise<void> {
    await this.q(
      `INSERT INTO integration_settings (setting_key, setting_value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, value, actorId],
    );
  }
  async deleteSetting(key: string): Promise<boolean> {
    const rows = await this.q(`DELETE FROM integration_settings WHERE setting_key = $1 RETURNING setting_key`, [key]);
    return rows.length > 0;
  }
  async allSettings(): Promise<Record<string, string | null>> {
    const rows = await this.q(`SELECT setting_key, setting_value FROM integration_settings`);
    const out: Record<string, string | null> = {};
    for (const r of rows as Row[]) out[String(r["setting_key"])] = str(r["setting_value"]);
    return out;
  }
  async allSettingsDetailed(): Promise<Array<{ key: string; value: string | null; updatedBy: string | null; updatedAt: string | null }>> {
    const rows = await this.q(`SELECT setting_key, setting_value, updated_by, updated_at FROM integration_settings`);
    return rows.map((r) => {
      const row = r as Row;
      return {
        key: String(row["setting_key"]),
        value: str(row["setting_value"]),
        updatedBy: row["updated_by"] === null || row["updated_by"] === undefined ? null : String(row["updated_by"]),
        updatedAt: row["updated_at"] === null || row["updated_at"] === undefined ? null : String(row["updated_at"]),
      };
    });
  }

  // feature flags — ai_feature_flags
  async listFeatureFlags(): Promise<FeatureFlagRow[]> {
    const rows = await this.q(`SELECT feature_name, enabled, rollout_percentage, updated_by, created_at, updated_at FROM ai_feature_flags ORDER BY feature_name ASC`);
    return rows.map((r) => toRow(r as Row));
  }
  async getFeatureFlag(feature: string): Promise<FeatureFlagRow | null> {
    const rows = await this.q(`SELECT feature_name, enabled, rollout_percentage, updated_by, created_at, updated_at FROM ai_feature_flags WHERE feature_name = $1`, [feature]);
    return rows.length === 0 ? null : toRow(rows[0] as Row);
  }
  async setFeatureFlag(feature: string, enabled: boolean, rollout: number, actorId: string | null): Promise<FeatureFlagRow> {
    const actor = actorId !== null && /^\d+$/.test(actorId) ? Number(actorId) : null;
    // portable upsert via ON CONFLICT (feature_name)
    const rows = await this.q(
      `INSERT INTO ai_feature_flags (feature_name, enabled, rollout_percentage, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (feature_name) DO UPDATE
         SET enabled = EXCLUDED.enabled, rollout_percentage = EXCLUDED.rollout_percentage, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING feature_name, enabled, rollout_percentage, updated_by, created_at, updated_at`,
      [feature, enabled, rollout, actor],
    );
    return toRow(rows[0] as Row);
  }

  // system logs
  async listSystemLogs(
    filters: { severity?: string; source?: string; since?: string; until?: string; q?: string },
    page: number,
    perPage: number,
  ): Promise<{ items: SystemLogRow[]; total: number; page: number; per_page: number }> {
    const p = Math.max(1, page);
    const pp = Math.min(100, Math.max(1, perPage));
    const offset = (p - 1) * pp;
    const where: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (filters.severity !== undefined && filters.severity !== "" && ["DEBUG", "INFO", "WARN", "ERROR"].includes(filters.severity.toUpperCase())) {
      where.push(`severity = $${idx++}`);
      params.push(filters.severity.toUpperCase());
    }
    if (filters.source !== undefined && filters.source !== "") {
      where.push(`source = $${idx++}`);
      params.push(String(filters.source).slice(0, 64));
    }
    if (filters.since !== undefined && filters.since !== "") {
      where.push(`created_at >= $${idx++}`);
      params.push(filters.since);
    }
    if (filters.until !== undefined && filters.until !== "") {
      where.push(`created_at <= $${idx++}`);
      params.push(filters.until);
    }
    if (filters.q !== undefined && filters.q !== "") {
      const like = `%${String(filters.q).replace(/[%_]/g, "\\$&")}%`;
      where.push(`(message LIKE $${idx} OR request_id LIKE $${idx + 1} OR error_code LIKE $${idx + 2})`);
      params.push(like, like, like);
      idx += 3;
    }
    const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const countRows = await this.q(`SELECT COUNT(*)::text AS n FROM system_logs ${clause}`, params);
    const total = Number((countRows[0] as Row)["n"] ?? 0);
    const rows = await this.q(
      `SELECT id, severity, source, message, request_id, correlation_id, user_id, error_code, metadata_json, created_at
         FROM system_logs ${clause} ORDER BY id DESC LIMIT ${pp} OFFSET ${offset}`,
      params,
    );
    return { items: rows.map((r) => toLogRow(r as Row)), total, page: p, per_page: pp };
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
    const metaJson = entry.metadata === null || entry.metadata === undefined ? null : JSON.stringify(entry.metadata).slice(0, 4000);
    const rows = await this.q(
      `INSERT INTO system_logs (severity, source, message, request_id, correlation_id, user_id, error_code, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, severity, source, message, request_id, correlation_id, user_id, error_code, metadata_json, created_at`,
      [entry.severity, entry.source.slice(0, 64), entry.message ?? null, entry.requestId ?? null, entry.correlationId ?? null, entry.userId !== null && entry.userId !== undefined ? Number(entry.userId) : null, entry.errorCode ?? null, metaJson],
    );
    return toLogRow(rows[0] as Row);
  }

  // billing reads
  async getUser(userId: string): Promise<UserBillingRow | null> {
    const rows = await this.q(`SELECT id, email, plan FROM users WHERE id = $1 LIMIT 1`, [Number(userId)]);
    if (rows.length === 0) return null;
    const r = rows[0] as Row;
    return { id: String(r["id"]), email: String(r["email"]), plan: r["plan"] === null || r["plan"] === undefined ? null : String(r["plan"]) };
  }
  async planDistribution(): Promise<PlanDistributionRow[]> {
    const allowed = ["free", "pro", "enterprise"] as const;
    try {
      const rows = await this.q(`SELECT plan AS k, COUNT(*)::text AS n FROM users GROUP BY plan`);
      const byKey = new Map<string, number>();
      for (const r of rows as Row[]) byKey.set(String(r["k"]), Number(r["n"]));
      return allowed.map((k) => ({ key: k, count: byKey.get(k) ?? 0 }));
    } catch {
      return allowed.map((k) => ({ key: k, count: 0 }));
    }
  }
  async userCount(): Promise<number> {
    try {
      const rows = await this.q(`SELECT COUNT(*)::text AS n FROM users`);
      return Number((rows[0] as Row)["n"] ?? 0);
    } catch {
      return 0;
    }
  }
  async tradingAccountsCount(userId: string): Promise<number> {
    try {
      const rows = await this.q(`SELECT COUNT(*)::text AS n FROM trading_accounts WHERE user_id = $1`, [Number(userId)]);
      return Number((rows[0] as Row)["n"] ?? 0);
    } catch {
      return 0;
    }
  }
  async aiUsage(userId: string): Promise<{ requests: number; failed: number; tokensUsed: number; available: boolean }> {
    try {
      const rows = await this.q(
        `SELECT COUNT(*)::text AS total,
                SUM(CASE WHEN outcome IN ('error','refused') OR error_code IS NOT NULL THEN 1 ELSE 0 END)::text AS failed,
                SUM(COALESCE(tokens_in,0)+COALESCE(tokens_out,0))::text AS tokens
           FROM ai_coaching_logs WHERE user_id = $1`,
        [Number(userId)],
      );
      const r = rows[0] as Row;
      return { requests: Number(r["total"] ?? 0), failed: Number(r["failed"] ?? 0), tokensUsed: Number(r["tokens"] ?? 0), available: true };
    } catch {
      return { requests: 0, failed: 0, tokensUsed: 0, available: false };
    }
  }
  async providerQuotas(): Promise<Array<{ provider: string; used: number; limit: number; resetAt: string | null }>> {
    try {
      const rows = await this.q(`SELECT provider, daily_used, quota_limit, reset_at FROM ai_provider_quotas ORDER BY provider`);
      return rows.map((r) => {
        const row = r as Row;
        return { provider: String(row["provider"]), used: Number(row["daily_used"] ?? 0), limit: Number(row["quota_limit"] ?? 0), resetAt: row["reset_at"] === null || row["reset_at"] === undefined ? null : String(row["reset_at"]) };
      });
    } catch {
      return [];
    }
  }
  async subscriptionsCount(): Promise<number> {
    try {
      const rows = await this.q(`SELECT COUNT(*)::text AS n FROM subscriptions`);
      return Number((rows[0] as Row)["n"] ?? 0);
    } catch {
      return 0;
    }
  }
}
