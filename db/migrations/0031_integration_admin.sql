-- 0031_integration_admin.sql — Phase 8: admin-managed external integrations (MetaAPI, Email).
--
-- WHY THIS MIGRATION EXISTS
--
-- Legacy's Phase C IntegrationsController stores two kinds of configuration:
--   * SECRETS (AES-256-GCM via SecureCredentialStore, 0600 file)
--       - METAAPI_TOKEN, METAAPI_WEBHOOK_SECRET
--       - SMTP_PASSWORD, RESEND_API_KEY
--       - GEMINI_RELAY_URL / TOKEN (already migrated in 0028 as ai_platform_secrets)
--   * NON-SECRET settings (IntegrationSettingsRepository, generic settings table)
--       - METAAPI_BASE_URL
--       - MAIL_DRIVER, MAIL_FROM, MAIL_FROM_NAME, MAIL_HOST, MAIL_PORT, MAIL_USER
--
-- Modern already migrated the GEMINI relay secrets to `ai_platform_secrets`
-- (0028, AiSecretService). The remaining secrets and settings had no modern
-- counterpart — the runtime read them only from ENV (METAAPI_PLATFORM_TOKEN,
-- RESEND_API_KEY) and the admin surface was absent, which is why the audit
-- counts 12 missing admin/integrations routes (MG-ADMIN, §4.2).
--
-- THIS MIGRATION DOES NOT COPY LEGACY'S FILE STORE. Modern's rule is
-- PostgreSQL-authoritative, single envelope (credentialCrypto, same as 0010 and
-- 0028). The envelope shape is therefore identical to `ai_platform_secrets`:
-- version, algorithm, iv (12), tag (16), ciphertext (BYTEA), nonce uniqueness.
-- There is no second convention for the same job.
--
-- FAIL-CLOSED RULES
--   * Secret keys are a CLOSED vocabulary — an unknown key cannot be stored even
--     by a bug (CHECK).
--   * Settings keys are bounded length, values bounded 2048, and known keys have
--     value vocabularies where applicable (driver, base_url https).
--   * Both tables are append-only in spirit: an admin write audits, but the
--     tables themselves are upserted (one row per key, the effective value).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Encrypted platform secrets for integrations (MetaAPI, Email).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS integration_platform_secrets (
  secret_key        TEXT PRIMARY KEY CHECK (secret_key IN
                      ('METAAPI_TOKEN', 'METAAPI_WEBHOOK_SECRET', 'SMTP_PASSWORD', 'RESEND_API_KEY')),
  enc_version       SMALLINT NOT NULL DEFAULT 1 CHECK (enc_version = 1),
  key_version       SMALLINT NOT NULL CHECK (key_version >= 1),
  algorithm         TEXT     NOT NULL DEFAULT 'aes-256-gcm' CHECK (algorithm = 'aes-256-gcm'),
  iv                BYTEA    NOT NULL CHECK (octet_length(iv) = 12),
  auth_tag          BYTEA    NOT NULL CHECK (octet_length(auth_tag) = 16),
  secret_ciphertext BYTEA    NOT NULL CHECK (octet_length(secret_ciphertext) > 0),
  updated_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_platform_secrets_nonce_unique UNIQUE (key_version, iv)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Non-secret integration settings.
--    Kept separate from `ai_settings` so the two capabilities do not share a
--    namespace and an integration bug cannot corrupt an AI chain.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS integration_settings (
  setting_key   TEXT PRIMARY KEY CHECK (length(btrim(setting_key)) BETWEEN 1 AND 64),
  setting_value TEXT CHECK (setting_value IS NULL OR length(setting_value) <= 2048),
  updated_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Known settings are a closed vocabulary where the value matters, but the table
-- stays extensible for future integrations (a new key is a code change, not a
-- schema error). The CHECKs below are therefore per-key, not table-wide.
ALTER TABLE integration_settings DROP CONSTRAINT IF EXISTS integration_settings_metaapi_base_url_vocabulary;
ALTER TABLE integration_settings ADD CONSTRAINT integration_settings_metaapi_base_url_vocabulary
  CHECK (setting_key <> 'METAAPI_BASE_URL' OR setting_value IS NULL OR setting_value ~ '^https://');

ALTER TABLE integration_settings DROP CONSTRAINT IF EXISTS integration_settings_mail_driver_vocabulary;
ALTER TABLE integration_settings ADD CONSTRAINT integration_settings_mail_driver_vocabulary
  CHECK (setting_key <> 'MAIL_DRIVER' OR setting_value IN ('smtp', 'resend', 'log'));

ALTER TABLE integration_settings DROP CONSTRAINT IF EXISTS integration_settings_smtp_port_vocabulary;
ALTER TABLE integration_settings ADD CONSTRAINT integration_settings_smtp_port_vocabulary
  CHECK (setting_key <> 'MAIL_PORT' OR setting_value IS NULL OR setting_value ~ '^[0-9]{1,5}$');
