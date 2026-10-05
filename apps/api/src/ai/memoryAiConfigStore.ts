// The in-memory double of `AiConfigStore`.
//
// Contract-identical, NOT database evidence: the routing, flag and quota rules
// are unit-tested here so they can be exercised without a cluster, and the same
// rules are re-proved against real PostgreSQL in `db/tests/aiCapability.pg.test.ts`.
// The two adapters must agree, which is why the quota ceiling, the window reset
// and the derived `verified` flag are implemented here with the same semantics
// the SQL states — a double that behaves differently is a test that lies.
import type {
  AiConfigStore, AiCredentialStatus, AiFeedbackRow, CredentialMetadata, FeatureFlagRow,
  FeatureRouteRow, QuotaRow, SecretEnvelope, AiSecretKey,
} from "./aiConfigStore.js";
import type { AiCatalogProvider, AiFeature, AiRoute } from "./aiCatalog.js";

interface MutableRoute {
  id: string; feature: AiFeature; provider: AiCatalogProvider; model: string | null;
  priority: number; enabled: boolean; route: AiRoute | null;
}

function startOfToday(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export class MemoryAiConfigStore implements AiConfigStore {
  private routes: MutableRoute[] = [];
  private flags = new Map<string, { enabled: boolean; rollout: number }>();
  private quotaRows = new Map<string, { used: number; limit: number; resetAt: number }>();
  private credentials = new Map<string, CredentialMetadata>();
  private secrets = new Map<AiSecretKey, SecretEnvelope>();
  private settings = new Map<string, string | null>();
  private feedback: AiFeedbackRow[] = [];
  private seq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Seed helper for tests — the same rows 0028 seeds in PostgreSQL. */
  seedLegacyDefaults(): void {
    this.routes = [
      { id: "1", feature: "screenshot_extraction", provider: "gemini", model: null, priority: 1, enabled: true, route: null },
      { id: "2", feature: "screenshot_extraction", provider: "tesseract", model: null, priority: 2, enabled: true, route: null },
    ];
    this.flags = new Map([
      ["ai_screenshot_extraction", { enabled: true, rollout: 100 }],
      ["ai_trade_analysis", { enabled: false, rollout: 0 }],
      ["ai_weekly_report", { enabled: false, rollout: 0 }],
      ["ai_assistant", { enabled: false, rollout: 0 }],
    ]);
    this.quotaRows = new Map([
      ["gemini", { used: 0, limit: 1500, resetAt: startOfToday(this.now()) + 86_400_000 }],
      ["openai", { used: 0, limit: 1500, resetAt: startOfToday(this.now()) + 86_400_000 }],
      ["tesseract", { used: 0, limit: 100_000, resetAt: startOfToday(this.now()) + 86_400_000 }],
    ]);
  }

  private static clone(row: MutableRoute): FeatureRouteRow {
    return { ...row };
  }

  async chainFor(feature: AiFeature): Promise<FeatureRouteRow[]> {
    return this.routes
      .filter((r) => r.feature === feature && r.enabled)
      .sort((a, b) => a.priority - b.priority || Number(a.id) - Number(b.id))
      .map(MemoryAiConfigStore.clone);
  }

  async listRoutes(): Promise<FeatureRouteRow[]> {
    return [...this.routes]
      .sort((a, b) => a.feature.localeCompare(b.feature) || a.priority - b.priority || Number(a.id) - Number(b.id))
      .map(MemoryAiConfigStore.clone);
  }

  async upsertRoute(row: {
    feature: AiFeature; provider: AiCatalogProvider; model: string | null;
    priority: number; enabled: boolean; route: AiRoute | null;
  }): Promise<FeatureRouteRow> {
    const existing = this.routes.find((r) => r.feature === row.feature && r.provider === row.provider);
    if (existing !== undefined) {
      existing.model = row.model; existing.priority = row.priority;
      existing.enabled = row.enabled; existing.route = row.route;
      return MemoryAiConfigStore.clone(existing);
    }
    this.seq += 1;
    const created: MutableRoute = { id: String(this.seq), ...row };
    this.routes.push(created);
    return MemoryAiConfigStore.clone(created);
  }

  async updateRoute(
    id: string,
    patch: { model?: string | null; priority?: number; enabled?: boolean; route?: AiRoute | null },
  ): Promise<FeatureRouteRow | null> {
    const row = this.routes.find((r) => r.id === id);
    if (row === undefined) return null;
    if (patch.model !== undefined) row.model = patch.model;
    if (patch.priority !== undefined) row.priority = patch.priority;
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    if (patch.route !== undefined) row.route = patch.route;
    return MemoryAiConfigStore.clone(row);
  }

  async deleteRoute(id: string): Promise<boolean> {
    const before = this.routes.length;
    this.routes = this.routes.filter((r) => r.id !== id);
    return this.routes.length < before;
  }

  async reorder(feature: AiFeature, orderedIds: readonly string[]): Promise<FeatureRouteRow[]> {
    orderedIds.forEach((id, index) => {
      const row = this.routes.find((r) => r.id === id && r.feature === feature);
      if (row !== undefined) row.priority = index + 1;
    });
    return this.chainFor(feature).then((rows) => rows);
  }

  async flag(featureName: string): Promise<FeatureFlagRow | null> {
    const row = this.flags.get(featureName);
    return row === undefined ? null : { featureName, enabled: row.enabled, rolloutPercentage: row.rollout };
  }

  async listFlags(): Promise<FeatureFlagRow[]> {
    return [...this.flags.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([featureName, v]) => ({ featureName, enabled: v.enabled, rolloutPercentage: v.rollout }));
  }

  async setFlag(featureName: string, enabled: boolean, rolloutPercentage: number): Promise<FeatureFlagRow> {
    this.flags.set(featureName, { enabled, rollout: rolloutPercentage });
    return { featureName, enabled, rolloutPercentage };
  }

  async reserveQuota(provider: string): Promise<QuotaRow | null> {
    const now = this.now().getTime();
    let row = this.quotaRows.get(provider);
    if (row === undefined) {
      // Legacy's `hasQuota` fails OPEN when no row exists (a provider with no
      // configured budget is not a provider with zero budget); the row is created
      // with the catalog default so the spend is still counted.
      row = { used: 0, limit: provider === "tesseract" ? 100_000 : 1500, resetAt: startOfToday(this.now()) + 86_400_000 };
      this.quotaRows.set(provider, row);
    }
    if (row.resetAt <= startOfToday(new Date(now))) {
      row.used = 0;
      row.resetAt = startOfToday(new Date(now)) + 86_400_000;
    }
    if (row.used >= row.limit) return null;
    row.used += 1;
    return { provider, dailyUsed: row.used, quotaLimit: row.limit, resetAt: new Date(row.resetAt).toISOString() };
  }

  async quotas(): Promise<QuotaRow[]> {
    return [...this.quotaRows.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([provider, v]) => ({ provider, dailyUsed: v.used, quotaLimit: v.limit, resetAt: new Date(v.resetAt).toISOString() }));
  }

  async setQuotaLimit(provider: string, limit: number): Promise<QuotaRow> {
    const row = this.quotaRows.get(provider) ?? { used: 0, limit, resetAt: startOfToday(this.now()) + 86_400_000 };
    row.limit = limit;
    this.quotaRows.set(provider, row);
    return { provider, dailyUsed: row.used, quotaLimit: row.limit, resetAt: new Date(row.resetAt).toISOString() };
  }

  async credentialMetadata(provider: string): Promise<CredentialMetadata | null> {
    return this.credentials.get(provider) ?? null;
  }

  async allCredentialMetadata(): Promise<CredentialMetadata[]> {
    return [...this.credentials.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  }

  async recordVerification(input: {
    provider: string; status: AiCredentialStatus; fingerprint?: string | null;
    errorCode?: string | null; latencyMs?: number;
  }): Promise<CredentialMetadata> {
    const previous = this.credentials.get(input.provider);
    const fingerprint = input.fingerprint ?? previous?.fingerprint ?? null;
    const replaced = input.fingerprint != null && previous?.fingerprint != null && input.fingerprint !== previous.fingerprint;
    const next: CredentialMetadata = {
      provider: input.provider,
      status: input.status,
      // Derived, exactly like 0028's coherence constraint: never an independent opinion.
      verified: input.status === "VALID",
      fingerprint,
      verifiedAt: input.status === "VALID" ? this.now().toISOString() : previous?.verifiedAt ?? null,
      lastCheckedAt: this.now().toISOString(),
      errorCode: input.errorCode ?? null,
      latencyMs: input.latencyMs ?? 0,
      version: replaced ? (previous?.version ?? 1) + 1 : previous?.version ?? 1,
    };
    this.credentials.set(input.provider, next);
    return next;
  }

  async readSecret(key: AiSecretKey): Promise<SecretEnvelope | null> {
    return this.secrets.get(key) ?? null;
  }

  async writeSecret(key: AiSecretKey, envelope: SecretEnvelope): Promise<void> {
    this.secrets.set(key, envelope);
  }

  async deleteSecret(key: AiSecretKey): Promise<boolean> {
    return this.secrets.delete(key);
  }

  async secretKeysPresent(): Promise<AiSecretKey[]> {
    return [...this.secrets.keys()].sort();
  }

  async setting(key: string): Promise<string | null> {
    return this.settings.has(key) ? this.settings.get(key) ?? null : null;
  }

  async setSetting(key: string, value: string | null): Promise<void> {
    this.settings.set(key, value);
  }

  async deleteSetting(key: string): Promise<boolean> {
    return this.settings.delete(key);
  }

  async createFeedback(input: {
    userId: string; attemptId: string | null; feature: string;
    original: Record<string, unknown>; corrected: Record<string, unknown>;
    changedFields: readonly string[];
  }): Promise<AiFeedbackRow> {
    if (input.changedFields.length === 0) {
      // 0028 refuses a correction that changes nothing; the double must agree.
      throw new Error("ai_feedback_changed_fields_present");
    }
    this.seq += 1;
    const row: AiFeedbackRow = {
      id: String(this.seq),
      userId: input.userId,
      attemptId: input.attemptId,
      feature: input.feature,
      original: input.original,
      corrected: input.corrected,
      changedFields: [...input.changedFields],
      createdAt: this.now().toISOString(),
    };
    this.feedback.push(row);
    return row;
  }

  async feedbackFor(userId: string, limit: number): Promise<AiFeedbackRow[]> {
    return this.feedback.filter((f) => f.userId === userId).slice(-limit).reverse();
  }
}
