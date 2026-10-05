// AI configuration persistence — the substrate the router, the guard and the
// admin surface all read.
//
// ONE STORE, TWO ADAPTERS (the repository's established shape): `PgAiConfigStore`
// is the durable adapter over the same `pg` pool everything else uses, and
// `MemoryAiConfigStore` is a contract-identical double so the routing and
// governance rules are testable without a database. Neither adapter invents
// behaviour the other does not have.
//
// TWO RULES THIS FILE EXISTS TO PROTECT
//
//   1. THE QUOTA RESERVATION IS ONE STATEMENT. Legacy's own comment on
//      `tryReserveQuota` records that a check-then-increment was a race. Here the
//      reset, the increment and the ceiling test happen in a single UPDATE that
//      takes the row lock, so two concurrent calls cannot both spend the last
//      unit of a provider's daily budget.
//
//   2. A SECRET NEVER COMES BACK OUT AS TEXT. `readSecret` returns the envelope
//      for the caller that holds the master key (the manager, at call time);
//      every read path that serves an HTTP response goes through
//      `credentialMetadata`, which has no secret field to leak. The fingerprint
//      stored alongside is an HMAC — non-reversible, and the only thing about the
//      value that is ever shown.
import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import { poolQuery, withTransaction, type QueryFn } from "../persistence/pg.js";
import type { CredentialEnvelope } from "../credentials/credentialCrypto.js";
import type { AiCatalogProvider, AiFeature, AiRoute } from "./aiCatalog.js";

/** Secret keys the admin surface may manage (0028's closed CHECK). */
export const AI_SECRET_KEYS = ["GEMINI_API_KEY", "OPENAI_API_KEY", "GEMINI_RELAY_URL", "GEMINI_RELAY_TOKEN"] as const;
export type AiSecretKey = (typeof AI_SECRET_KEYS)[number];

export const AI_CREDENTIAL_STATUSES = [
  "VALID", "INVALID_CREDENTIAL", "EXPIRED", "REVOKED", "DISABLED", "INSUFFICIENT_PERMISSION",
  "QUOTA_EXCEEDED", "RATE_LIMITED", "PROVIDER_UNAVAILABLE", "REGION_RESTRICTED", "NETWORK_ERROR",
  "UNKNOWN", "UNVERIFIED",
] as const;
export type AiCredentialStatus = (typeof AI_CREDENTIAL_STATUSES)[number];

/** The global route setting key Legacy names (`AiRouteResolver::SETTING_GLOBAL_ROUTE`). */
export const AI_ROUTE_SETTING = "ai_route_default";

export interface FeatureRouteRow {
  readonly id: string;
  readonly feature: AiFeature;
  readonly provider: AiCatalogProvider;
  readonly model: string | null;
  readonly priority: number;
  readonly enabled: boolean;
  readonly route: AiRoute | null;
}

export interface FeatureFlagRow {
  readonly featureName: string;
  readonly enabled: boolean;
  readonly rolloutPercentage: number;
}

export interface CredentialMetadata {
  readonly provider: string;
  readonly status: AiCredentialStatus;
  readonly verified: boolean;
  readonly fingerprint: string | null;
  readonly verifiedAt: string | null;
  readonly lastCheckedAt: string | null;
  readonly errorCode: string | null;
  readonly latencyMs: number;
  readonly version: number;
}

/**
 * The stored secret IS `credentialCrypto`'s envelope — the same type the user
 * credential vault uses, with the same typed BYTEA columns (0010's convention,
 * repeated in 0028 rather than reinvented as a JSON blob). Reusing the type is
 * what keeps one encryption implementation in this repository.
 */
export type SecretEnvelope = CredentialEnvelope;

export interface QuotaRow {
  readonly provider: string;
  readonly dailyUsed: number;
  readonly quotaLimit: number;
  readonly resetAt: string;
}

export interface AiFeedbackRow {
  readonly id: string;
  readonly userId: string;
  readonly attemptId: string | null;
  readonly feature: string;
  readonly original: Record<string, unknown>;
  readonly corrected: Record<string, unknown>;
  readonly changedFields: readonly string[];
  readonly createdAt: string;
}

export interface AiConfigStore {
  // ── chains ────────────────────────────────────────────────────────────────
  chainFor(feature: AiFeature): Promise<FeatureRouteRow[]>;
  listRoutes(): Promise<FeatureRouteRow[]>;
  upsertRoute(row: {
    feature: AiFeature; provider: AiCatalogProvider; model: string | null;
    priority: number; enabled: boolean; route: AiRoute | null;
  }): Promise<FeatureRouteRow>;
  updateRoute(id: string, patch: { model?: string | null; priority?: number; enabled?: boolean; route?: AiRoute | null }): Promise<FeatureRouteRow | null>;
  deleteRoute(id: string): Promise<boolean>;
  /** Replace the ordering of one feature's chain in a single transaction. */
  reorder(feature: AiFeature, orderedIds: readonly string[]): Promise<FeatureRouteRow[]>;

  // ── flags ─────────────────────────────────────────────────────────────────
  flag(featureName: string): Promise<FeatureFlagRow | null>;
  listFlags(): Promise<FeatureFlagRow[]>;
  setFlag(featureName: string, enabled: boolean, rolloutPercentage: number, actorId: string | null): Promise<FeatureFlagRow>;

  // ── budgets ───────────────────────────────────────────────────────────────
  /**
   * Spend one unit of a provider's daily budget. Returns the row after the
   * reservation, or null when the ceiling was reached — the answer is atomic, so
   * a null is a real "no budget left", never a lost race.
   */
  reserveQuota(provider: string): Promise<QuotaRow | null>;
  quotas(): Promise<QuotaRow[]>;
  setQuotaLimit(provider: string, limit: number): Promise<QuotaRow>;

  // ── credentials ───────────────────────────────────────────────────────────
  credentialMetadata(provider: string): Promise<CredentialMetadata | null>;
  allCredentialMetadata(): Promise<CredentialMetadata[]>;
  recordVerification(input: {
    provider: string; status: AiCredentialStatus; fingerprint?: string | null;
    errorCode?: string | null; latencyMs?: number;
  }): Promise<CredentialMetadata>;
  /** Envelope in, envelope out — never plaintext. */
  readSecret(key: AiSecretKey): Promise<SecretEnvelope | null>;
  writeSecret(key: AiSecretKey, envelope: SecretEnvelope, actorId: string | null): Promise<void>;
  deleteSecret(key: AiSecretKey): Promise<boolean>;
  secretKeysPresent(): Promise<AiSecretKey[]>;

  // ── settings ──────────────────────────────────────────────────────────────
  setting(key: string): Promise<string | null>;
  setSetting(key: string, value: string | null, actorId: string | null): Promise<void>;
  deleteSetting(key: string): Promise<boolean>;

  // ── feedback ──────────────────────────────────────────────────────────────
  createFeedback(input: {
    userId: string; attemptId: string | null; feature: string;
    original: Record<string, unknown>; corrected: Record<string, unknown>;
    changedFields: readonly string[];
  }): Promise<AiFeedbackRow>;
  feedbackFor(userId: string, limit: number): Promise<AiFeedbackRow[]>;
}

/**
 * The non-reversible fingerprint of a secret: HMAC-SHA256 under the master key.
 * Legacy calls the same thing `CredentialFingerprint` and stores it so an
 * operator can tell "the key changed" from "the key is the same" without ever
 * seeing the key.
 */
export function secretFingerprint(plaintext: string, masterKey: Buffer): string {
  return createHmac("sha256", masterKey).update(plaintext, "utf8").digest("hex");
}

type Row = Record<string, unknown>;

/** pg hands back BYTEA as a Buffer; anything else is treated as empty. */
function toBuffer(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : "");
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function routeRow(r: Row): FeatureRouteRow {
  return {
    id: String(r["id"]),
    feature: String(r["feature"]) as AiFeature,
    provider: String(r["provider"]) as AiCatalogProvider,
    model: str(r["model"]),
    priority: Number(r["priority"]),
    enabled: Boolean(r["enabled"]),
    route: str(r["route"]) as AiRoute | null,
  };
}

function flagRow(r: Row): FeatureFlagRow {
  return {
    featureName: String(r["feature_name"]),
    enabled: Boolean(r["enabled"]),
    rolloutPercentage: Number(r["rollout_percentage"]),
  };
}

function quotaRow(r: Row): QuotaRow {
  return {
    provider: String(r["provider"]),
    dailyUsed: Number(r["daily_used"]),
    quotaLimit: Number(r["quota_limit"]),
    resetAt: String(r["reset_at"]),
  };
}

function credentialRow(r: Row): CredentialMetadata {
  return {
    provider: String(r["provider"]),
    status: String(r["status"]) as AiCredentialStatus,
    verified: Boolean(r["verified"]),
    fingerprint: str(r["fingerprint"]),
    verifiedAt: str(r["verified_at"]),
    lastCheckedAt: str(r["last_checked_at"]),
    errorCode: str(r["error_code"]),
    latencyMs: Number(r["latency_ms"]),
    version: Number(r["version"]),
  };
}

/** pg returns JSONB already parsed; a driver or a test double may hand back text. */
function json(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return value;
}

function feedbackRow(r: Row): AiFeedbackRow {
  const original = json(r["original"]);
  const corrected = json(r["corrected"]);
  const changed = json(r["changed_fields"]);
  return {
    id: String(r["id"]),
    userId: String(r["user_id"]),
    attemptId: str(r["attempt_id"]),
    feature: String(r["feature"]),
    original: (original !== null && typeof original === "object" ? original : {}) as Record<string, unknown>,
    corrected: (corrected !== null && typeof corrected === "object" ? corrected : {}) as Record<string, unknown>,
    changedFields: Array.isArray(changed) ? changed.filter((v): v is string => typeof v === "string") : [],
    createdAt: String(r["created_at"]),
  };
}

export class PgAiConfigStore implements AiConfigStore {
  private readonly q: QueryFn;

  /** The Pool, not a QueryFn: `reorder` is multi-statement and must be atomic. */
  constructor(private readonly pool: Pool) {
    this.q = poolQuery(pool);
  }

  async chainFor(feature: AiFeature): Promise<FeatureRouteRow[]> {
    const rows = await this.q(
      `SELECT id, feature, provider, model, priority, enabled, route
         FROM ai_feature_routes
        WHERE feature = $1 AND enabled
        ORDER BY priority ASC, id ASC`,
      [feature],
    );
    return rows.map(routeRow);
  }

  async listRoutes(): Promise<FeatureRouteRow[]> {
    const rows = await this.q(
      `SELECT id, feature, provider, model, priority, enabled, route
         FROM ai_feature_routes ORDER BY feature ASC, priority ASC, id ASC`,
    );
    return rows.map(routeRow);
  }

  async upsertRoute(row: {
    feature: AiFeature; provider: AiCatalogProvider; model: string | null;
    priority: number; enabled: boolean; route: AiRoute | null;
  }): Promise<FeatureRouteRow> {
    const rows = await this.q(
      `INSERT INTO ai_feature_routes (feature, provider, model, priority, enabled, route)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (feature, provider) DO UPDATE
          SET model = EXCLUDED.model, priority = EXCLUDED.priority,
              enabled = EXCLUDED.enabled, route = EXCLUDED.route, updated_at = now()
       RETURNING id, feature, provider, model, priority, enabled, route`,
      [row.feature, row.provider, row.model, row.priority, row.enabled, row.route],
    );
    return routeRow(rows[0]!);
  }

  async updateRoute(
    id: string,
    patch: { model?: string | null; priority?: number; enabled?: boolean; route?: AiRoute | null },
  ): Promise<FeatureRouteRow | null> {
    const rows = await this.q(
      `UPDATE ai_feature_routes
          SET model = COALESCE($2, model),
              priority = COALESCE($3, priority),
              enabled = COALESCE($4, enabled),
              route = CASE WHEN $5::text IS NULL THEN route ELSE $5::text END,
              updated_at = now()
        WHERE id = $1
        RETURNING id, feature, provider, model, priority, enabled, route`,
      [id, patch.model ?? null, patch.priority ?? null, patch.enabled ?? null, patch.route ?? null],
    );
    return rows.length === 0 ? null : routeRow(rows[0]!);
  }

  async deleteRoute(id: string): Promise<boolean> {
    const rows = await this.q(`DELETE FROM ai_feature_routes WHERE id = $1 RETURNING id`, [id]);
    return rows.length > 0;
  }

  async reorder(feature: AiFeature, orderedIds: readonly string[]): Promise<FeatureRouteRow[]> {
    // One statement per position inside ONE transaction: a half-applied ordering
    // would leave two providers at the same priority, and "which one runs first"
    // would then depend on the tie-break rather than on the operator's intent.
    return withTransaction(this.pool, async (tx) => {
      for (let i = 0; i < orderedIds.length; i += 1) {
        await tx(
          `UPDATE ai_feature_routes SET priority = $2, updated_at = now()
            WHERE id = $1 AND feature = $3`,
          [orderedIds[i]!, i + 1, feature],
        );
      }
      const rows = await tx(
        `SELECT id, feature, provider, model, priority, enabled, route
           FROM ai_feature_routes WHERE feature = $1 ORDER BY priority ASC, id ASC`,
        [feature],
      );
      return rows.map(routeRow);
    });
  }

  async flag(featureName: string): Promise<FeatureFlagRow | null> {
    const rows = await this.q(
      `SELECT feature_name, enabled, rollout_percentage FROM ai_feature_flags WHERE feature_name = $1`,
      [featureName],
    );
    return rows.length === 0 ? null : flagRow(rows[0]!);
  }

  async listFlags(): Promise<FeatureFlagRow[]> {
    const rows = await this.q(
      `SELECT feature_name, enabled, rollout_percentage FROM ai_feature_flags ORDER BY feature_name ASC`,
    );
    return rows.map(flagRow);
  }

  async setFlag(featureName: string, enabled: boolean, rolloutPercentage: number, actorId: string | null): Promise<FeatureFlagRow> {
    const rows = await this.q(
      `INSERT INTO ai_feature_flags (feature_name, enabled, rollout_percentage, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (feature_name) DO UPDATE
          SET enabled = EXCLUDED.enabled, rollout_percentage = EXCLUDED.rollout_percentage,
              updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING feature_name, enabled, rollout_percentage`,
      [featureName, enabled, rolloutPercentage, actorId],
    );
    return flagRow(rows[0]!);
  }

  async reserveQuota(provider: string): Promise<QuotaRow | null> {
    // ONE statement: reset the window if it has rolled over, then spend a unit
    // only while the ceiling holds. The WHERE clause evaluates the SAME
    // "has the window rolled over" test as the SET, so a stale counter can never
    // refuse a call that a fresh window would allow, and two concurrent callers
    // can never both take the last unit.
    const rows = await this.q(
      `UPDATE ai_provider_quotas
          SET daily_used = CASE WHEN reset_at <= date_trunc('day', now()) THEN 1 ELSE daily_used + 1 END,
              reset_at   = CASE WHEN reset_at <= date_trunc('day', now())
                                THEN date_trunc('day', now()) + interval '1 day'
                                ELSE reset_at END,
              updated_at = now()
        WHERE provider = $1
          AND (CASE WHEN reset_at <= date_trunc('day', now()) THEN 0 ELSE daily_used END) < quota_limit
        RETURNING provider, daily_used, quota_limit, reset_at`,
      [provider],
    );
    return rows.length === 0 ? null : quotaRow(rows[0]!);
  }

  async quotas(): Promise<QuotaRow[]> {
    const rows = await this.q(
      `SELECT provider, daily_used, quota_limit, reset_at FROM ai_provider_quotas ORDER BY provider ASC`,
    );
    return rows.map(quotaRow);
  }

  async setQuotaLimit(provider: string, limit: number): Promise<QuotaRow> {
    const rows = await this.q(
      `INSERT INTO ai_provider_quotas (provider, quota_limit) VALUES ($1, $2)
       ON CONFLICT (provider) DO UPDATE SET quota_limit = EXCLUDED.quota_limit, updated_at = now()
       RETURNING provider, daily_used, quota_limit, reset_at`,
      [provider, limit],
    );
    return quotaRow(rows[0]!);
  }

  async credentialMetadata(provider: string): Promise<CredentialMetadata | null> {
    const rows = await this.q(
      `SELECT provider, status, verified, fingerprint, verified_at, last_checked_at, error_code, latency_ms, version
         FROM ai_provider_credentials WHERE provider = $1`,
      [provider],
    );
    return rows.length === 0 ? null : credentialRow(rows[0]!);
  }

  async allCredentialMetadata(): Promise<CredentialMetadata[]> {
    const rows = await this.q(
      `SELECT provider, status, verified, fingerprint, verified_at, last_checked_at, error_code, latency_ms, version
         FROM ai_provider_credentials ORDER BY provider ASC`,
    );
    return rows.map(credentialRow);
  }

  async recordVerification(input: {
    provider: string; status: AiCredentialStatus; fingerprint?: string | null;
    errorCode?: string | null; latencyMs?: number;
  }): Promise<CredentialMetadata> {
    // `verified` is DERIVED from the status (0028's coherence constraint), so a
    // caller cannot claim a credential is verified while its status says
    // otherwise. A replacement bumps the version; a re-check of the same
    // fingerprint does not.
    const rows = await this.q(
      `INSERT INTO ai_provider_credentials AS c
         (provider, status, verified, fingerprint, verified_at, last_checked_at, error_code, latency_ms, version)
       VALUES ($1, $2, $2 = 'VALID', $3, CASE WHEN $2 = 'VALID' THEN now() ELSE NULL END, now(), $4, COALESCE($5, 0), 1)
       ON CONFLICT (provider) DO UPDATE
          SET status = EXCLUDED.status,
              verified = EXCLUDED.status = 'VALID',
              fingerprint = COALESCE(EXCLUDED.fingerprint, c.fingerprint),
              verified_at = CASE WHEN EXCLUDED.status = 'VALID' THEN now() ELSE c.verified_at END,
              last_checked_at = now(),
              error_code = EXCLUDED.error_code,
              latency_ms = EXCLUDED.latency_ms,
              version = CASE WHEN EXCLUDED.fingerprint IS NOT NULL
                              AND (c.fingerprint IS NULL OR c.fingerprint <> EXCLUDED.fingerprint)
                             THEN c.version + 1 ELSE c.version END,
              updated_at = now()
       RETURNING provider, status, verified, fingerprint, verified_at, last_checked_at, error_code, latency_ms, version`,
      [input.provider, input.status, input.fingerprint ?? null, input.errorCode ?? null, input.latencyMs ?? 0],
    );
    return credentialRow(rows[0]!);
  }

  async readSecret(key: AiSecretKey): Promise<SecretEnvelope | null> {
    const rows = await this.q(
      `SELECT enc_version, key_version, algorithm, iv, auth_tag, secret_ciphertext
         FROM ai_platform_secrets WHERE secret_key = $1`,
      [key],
    );
    if (rows.length === 0) return null;
    const r = rows[0]!;
    // pg returns BYTEA as Buffer. The lengths are already CHECKed by 0028; they
    // are re-checked here because decryptCredential refuses a malformed envelope
    // with a uniform error, and a clear "the row is malformed" beats a mystery.
    const iv = toBuffer(r["iv"]);
    const authTag = toBuffer(r["auth_tag"]);
    const ciphertext = toBuffer(r["secret_ciphertext"]);
    if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length === 0) return null;
    return {
      version: Number(r["enc_version"]),
      keyVersion: Number(r["key_version"]),
      algorithm: String(r["algorithm"]) as SecretEnvelope["algorithm"],
      iv,
      ciphertext,
      authTag,
    };
  }

  async writeSecret(key: AiSecretKey, envelope: SecretEnvelope, actorId: string | null): Promise<void> {
    await this.q(
      `INSERT INTO ai_platform_secrets
         (secret_key, enc_version, key_version, algorithm, iv, auth_tag, secret_ciphertext, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (secret_key) DO UPDATE
          SET enc_version = EXCLUDED.enc_version, key_version = EXCLUDED.key_version,
              algorithm = EXCLUDED.algorithm, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag,
              secret_ciphertext = EXCLUDED.secret_ciphertext, updated_by = EXCLUDED.updated_by,
              updated_at = now()`,
      [key, envelope.version, envelope.keyVersion, envelope.algorithm,
       envelope.iv, envelope.authTag, envelope.ciphertext, actorId],
    );
  }

  async deleteSecret(key: AiSecretKey): Promise<boolean> {
    const rows = await this.q(`DELETE FROM ai_platform_secrets WHERE secret_key = $1 RETURNING secret_key`, [key]);
    return rows.length > 0;
  }

  async secretKeysPresent(): Promise<AiSecretKey[]> {
    const rows = await this.q(`SELECT secret_key FROM ai_platform_secrets ORDER BY secret_key ASC`);
    return rows.map((r) => String(r["secret_key"]) as AiSecretKey);
  }

  async setting(key: string): Promise<string | null> {
    const rows = await this.q(`SELECT setting_value FROM ai_settings WHERE setting_key = $1`, [key]);
    return rows.length === 0 ? null : str(rows[0]!["setting_value"]);
  }

  async setSetting(key: string, value: string | null, actorId: string | null): Promise<void> {
    await this.q(
      `INSERT INTO ai_settings (setting_key, setting_value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (setting_key) DO UPDATE
          SET setting_value = EXCLUDED.setting_value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, value, actorId],
    );
  }

  async deleteSetting(key: string): Promise<boolean> {
    const rows = await this.q(`DELETE FROM ai_settings WHERE setting_key = $1 RETURNING setting_key`, [key]);
    return rows.length > 0;
  }

  async createFeedback(input: {
    userId: string; attemptId: string | null; feature: string;
    original: Record<string, unknown>; corrected: Record<string, unknown>;
    changedFields: readonly string[];
  }): Promise<AiFeedbackRow> {
    const rows = await this.q(
      `INSERT INTO ai_feedback (user_id, attempt_id, feature, original, corrected, changed_fields)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
       RETURNING id, user_id, attempt_id, feature, original, corrected, changed_fields, created_at`,
      [input.userId, input.attemptId, input.feature, JSON.stringify(input.original),
       JSON.stringify(input.corrected), JSON.stringify([...input.changedFields])],
    );
    return feedbackRow(rows[0]!);
  }

  async feedbackFor(userId: string, limit: number): Promise<AiFeedbackRow[]> {
    const rows = await this.q(
      `SELECT id, user_id, attempt_id, feature, original, corrected, changed_fields, created_at
         FROM ai_feedback WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map(feedbackRow);
  }
}
