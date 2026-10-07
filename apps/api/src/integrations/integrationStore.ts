// Integration persistence — admin-managed external integrations (MetaAPI, Email).
//
// ONE STORE, TWO ADAPTERS: PgIntegrationStore over `pg` Pool and
// MemoryIntegrationStore as contract-identical double for unit tests.
// The envelope shape reuses credentialCrypto (0010) — same as ai_platform_secrets,
// so no second convention exists for the same job.
//
// This file covers the substrate for the 12 admin/integrations routes:
//   - GET /admin/integrations (inventory)
//   - GET/PUT/DELETE/POST test for metaapi (4) and email (4)
//   - GET/PUT/DELETE for relay/config (3) — relay itself is delegated to AiSecretService,
//     so this store does not duplicate GEMINI_RELAY_*; it only proves the metaapi/email
//     half.

import type { Pool } from "pg";
import { poolQuery } from "../persistence/pg.js";
import type { CredentialEnvelope } from "../credentials/credentialCrypto.js";

export const INTEGRATION_SECRET_KEYS = [
  "METAAPI_TOKEN",
  "METAAPI_WEBHOOK_SECRET",
  "SMTP_PASSWORD",
  "RESEND_API_KEY",
] as const;
export type IntegrationSecretKey = (typeof INTEGRATION_SECRET_KEYS)[number];

export const INTEGRATION_SETTING_KEYS = [
  "METAAPI_BASE_URL",
  "MAIL_DRIVER",
  "MAIL_FROM",
  "MAIL_FROM_NAME",
  "MAIL_HOST",
  "MAIL_PORT",
  "MAIL_USER",
] as const;
export type IntegrationSettingKey = (typeof INTEGRATION_SETTING_KEYS)[number];

export type SecretEnvelope = CredentialEnvelope;

export interface IntegrationStore {
  // secrets (encrypted at rest, never returned as plaintext over HTTP)
  readSecret(key: IntegrationSecretKey): Promise<SecretEnvelope | null>;
  writeSecret(key: IntegrationSecretKey, envelope: SecretEnvelope, actorId: string | null): Promise<void>;
  deleteSecret(key: IntegrationSecretKey): Promise<boolean>;
  secretKeysPresent(): Promise<IntegrationSecretKey[]>;
  hasSecret(key: IntegrationSecretKey): Promise<boolean>;

  // settings (plain, bounded 2048)
  setting(key: string): Promise<string | null>;
  setSetting(key: string, value: string | null, actorId: string | null): Promise<void>;
  deleteSetting(key: string): Promise<boolean>;
  allSettings(): Promise<Record<string, string | null>>;
}

type Row = Record<string, unknown>;

function toBuffer(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : "");
}
function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export class PgIntegrationStore implements IntegrationStore {
  private readonly q: ReturnType<typeof poolQuery>;
  constructor(private readonly pool: Pool) {
    this.q = poolQuery(pool);
  }

  async readSecret(key: IntegrationSecretKey): Promise<SecretEnvelope | null> {
    const rows = await this.q(
      `SELECT enc_version, key_version, algorithm, iv, auth_tag, secret_ciphertext
         FROM integration_platform_secrets WHERE secret_key = $1`,
      [key],
    );
    if (rows.length === 0) return null;
    const r = rows[0] as Row;
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

  async writeSecret(key: IntegrationSecretKey, envelope: SecretEnvelope, actorId: string | null): Promise<void> {
    await this.q(
      `INSERT INTO integration_platform_secrets
         (secret_key, enc_version, key_version, algorithm, iv, auth_tag, secret_ciphertext, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (secret_key) DO UPDATE
          SET enc_version = EXCLUDED.enc_version, key_version = EXCLUDED.key_version,
              algorithm = EXCLUDED.algorithm, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag,
              secret_ciphertext = EXCLUDED.secret_ciphertext, updated_by = EXCLUDED.updated_by,
              updated_at = now()`,
      [key, envelope.version, envelope.keyVersion, envelope.algorithm, envelope.iv, envelope.authTag, envelope.ciphertext, actorId],
    );
  }

  async deleteSecret(key: IntegrationSecretKey): Promise<boolean> {
    const rows = await this.q(`DELETE FROM integration_platform_secrets WHERE secret_key = $1 RETURNING secret_key`, [key]);
    return rows.length > 0;
  }

  async secretKeysPresent(): Promise<IntegrationSecretKey[]> {
    const rows = await this.q(`SELECT secret_key FROM integration_platform_secrets ORDER BY secret_key ASC`);
    return rows.map((r) => String((r as Row)["secret_key"]) as IntegrationSecretKey);
  }

  async hasSecret(key: IntegrationSecretKey): Promise<boolean> {
    const rows = await this.q(`SELECT 1 FROM integration_platform_secrets WHERE secret_key = $1`, [key]);
    return rows.length > 0;
  }

  async setting(key: string): Promise<string | null> {
    const rows = await this.q(`SELECT setting_value FROM integration_settings WHERE setting_key = $1`, [key]);
    return rows.length === 0 ? null : str((rows[0] as Row)["setting_value"]);
  }

  async setSetting(key: string, value: string | null, actorId: string | null): Promise<void> {
    await this.q(
      `INSERT INTO integration_settings (setting_key, setting_value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (setting_key) DO UPDATE
          SET setting_value = EXCLUDED.setting_value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
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
}
