-- 0028_ai_capability.sql — Phase 7: the AI configuration substrate.
--
-- WHY THIS MIGRATION EXISTS
--
-- Modern already had an honest AI seam (aiProvider.ts: a port, a fail-closed
-- default, bounded payloads, validated output) and ONE attempt ledger
-- (`ai_coaching_logs`, 0017 + the 0023 `feature` discriminator). What it did not
-- have was the CONFIGURATION that decides which provider serves which feature,
-- whether a feature is switched on, how much of a provider's daily budget is
-- left, and how a platform-level secret is held. Legacy keeps those in
-- `ai_feature_providers`, `ai_feature_flags`, `ai_provider_quotas`,
-- `ai_provider_credentials` and `ai_global_settings` (v0.4/v0.5/v0.9/v1.2/v1.4).
--
-- THREE DELIBERATE DIFFERENCES FROM LEGACY, each recorded in
-- docs/audits/2026-10-05-PHASE7-AI-CAPABILITY-MAP.md §3:
--
--   1. ONE LEDGER, NOT FOUR. Legacy writes ai_requests + ai_provider_logs +
--      ai_audit_logs + ai_extractions for a single attempt. Modern extends the
--      ledger it already has (route, fallback_index, latency_ms, input_hash) so
--      "what did we spend, on what, through which route, and did it work" stays
--      answerable from one table. No second journal for the same fact.
--   2. SECRETS IN POSTGRES, ENCRYPTED. Legacy stores provider secrets in a
--      private 0600 file (SecureCredentialStore). Modern's rule is that
--      PostgreSQL is authoritative and there is no second store, so the secret
--      lives here as an AES-256-GCM envelope produced by the EXISTING
--      `credentialCrypto` (the same code path user MetaAPI credentials use).
--      The property that actually matters is kept verbatim: the value is never
--      returned over HTTP — only a fingerprint and a status are.
--   3. NO `ai_jobs`. Legacy's three user-facing AI routes are synchronous with a
--      deadline (20 s / 25 s); the async job table belongs with the worker,
--      which is phase 8. Recorded, not silently dropped.
--
-- FAIL-CLOSED RULES ENCODED HERE (not left to application code):
--   * a feature route names a provider from a CLOSED vocabulary, and a route
--     value from a CLOSED vocabulary — an unknown provider cannot be configured;
--   * a rollout percentage is 0..100, so "enabled" cannot mean "sometimes more
--     than everyone";
--   * a quota's daily_used can never be negative and reset_at is required, so a
--     reservation cannot be computed against a missing window;
--   * credential metadata carries a fingerprint and a status but NO secret
--     column at all — the table cannot leak what it does not have.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The ledger grows the chain semantics (route, fallback position, latency,
--    input hash) and admits the phase-7 features and the local OCR provider.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE ai_coaching_logs
  ADD COLUMN IF NOT EXISTS route          TEXT,
  ADD COLUMN IF NOT EXISTS fallback_index SMALLINT,
  ADD COLUMN IF NOT EXISTS latency_ms     INTEGER,
  ADD COLUMN IF NOT EXISTS input_hash     TEXT;

-- 'tesseract' joins the provider vocabulary: it is the LOCAL OCR fallback, so a
-- refused external call still has somewhere to go. This widens 0017's closed
-- list deliberately (the same way 0027 widened the audit actions) rather than
-- loosening it to any string.
ALTER TABLE ai_coaching_logs DROP CONSTRAINT IF EXISTS ai_coaching_logs_provider_check;
ALTER TABLE ai_coaching_logs ADD CONSTRAINT ai_coaching_logs_provider_check
  CHECK (provider IN ('openai', 'gemini', 'tesseract'));

-- Feature vocabulary: 0023's four + the five this phase delivers. `ocr` is the
-- local Tesseract path; `translate` and `copilot` are the support-console
-- features Legacy deferred to its AI module (SupportController::translate /
-- copilot), which phase 5 recorded as open with the AI phase as their owner.
ALTER TABLE ai_coaching_logs DROP CONSTRAINT IF EXISTS ai_coaching_logs_feature_check;
ALTER TABLE ai_coaching_logs ADD CONSTRAINT ai_coaching_logs_feature_check
  CHECK (feature IN ('coach', 'journal_extract', 'transcribe', 'vision_extract',
                     'analysis', 'report', 'assistant', 'ocr', 'translate', 'copilot'));

-- One constraint, three rules:
--   * route is a closed vocabulary (or absent, meaning "the provider decides");
--   * a fallback position is meaningless unless it is a real position, and a
--     latency cannot be negative;
--   * input_hash is a sha256 of the INPUT, never the input itself (Legacy's
--     ai_audit_logs rule: hashes only, so the ledger cannot become a copy of
--     whatever a user uploaded).
ALTER TABLE ai_coaching_logs DROP CONSTRAINT IF EXISTS ai_coaching_logs_chain_sane;
ALTER TABLE ai_coaching_logs ADD CONSTRAINT ai_coaching_logs_chain_sane CHECK (
  (route IS NULL OR route IN ('direct', 'n8n_relay'))
  AND (fallback_index IS NULL OR fallback_index >= 0)
  AND (latency_ms IS NULL OR latency_ms >= 0)
  AND (input_hash IS NULL OR input_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS ai_coaching_logs_feature_created_idx
  ON ai_coaching_logs (feature, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_coaching_logs_provider_created_idx
  ON ai_coaching_logs (provider, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Feature → provider chains (Legacy ai_feature_providers).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_feature_routes (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feature     TEXT NOT NULL CHECK (feature IN
                ('screenshot_extraction', 'trade_analysis', 'weekly_report', 'assistant',
                 'coach', 'transcribe', 'vision_extract', 'translate', 'copilot')),
  provider    TEXT NOT NULL CHECK (provider IN ('openai', 'gemini', 'tesseract')),
  -- NULL = the provider's own default model. A non-null value must be a real
  -- model name; the allowlist per provider lives in code (aiCatalog) because it
  -- changes with the provider, not with the schema.
  model       TEXT CHECK (model IS NULL OR length(btrim(model)) BETWEEN 1 AND 120),
  priority    SMALLINT NOT NULL DEFAULT 1 CHECK (priority >= 1),
  enabled     BOOLEAN NOT NULL DEFAULT true,
  route       TEXT CHECK (route IS NULL OR route IN ('direct', 'n8n_relay')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- one entry per provider per feature: a chain is an ORDER, not a multiset
  CONSTRAINT ai_feature_routes_unique UNIQUE (feature, provider)
);

-- The lookup the router actually runs: an enabled chain for one feature, ordered.
CREATE INDEX IF NOT EXISTS ai_feature_routes_chain_idx
  ON ai_feature_routes (feature, enabled, priority);

-- Legacy seeds screenshot_extraction → gemini (1) then tesseract (2): the local
-- OCR fallback is the reason a screenshot still yields text when Google is
-- unreachable or the quota is gone. Seeded idempotently; an operator's own
-- ordering is never overwritten by a re-run.
INSERT INTO ai_feature_routes (feature, provider, model, priority, enabled, route)
VALUES ('screenshot_extraction', 'gemini', NULL, 1, true, NULL),
       ('screenshot_extraction', 'tesseract', NULL, 2, true, NULL)
ON CONFLICT (feature, provider) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Feature flags with a deterministic rollout (Legacy ai_feature_flags).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_feature_flags (
  feature_name       TEXT PRIMARY KEY CHECK (feature_name ~ '^ai_[a-z0-9_]{1,63}$'),
  enabled            BOOLEAN NOT NULL DEFAULT false,
  rollout_percentage SMALLINT NOT NULL DEFAULT 0 CHECK (rollout_percentage BETWEEN 0 AND 100),
  updated_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Legacy's own default posture: extraction on, everything else off until an
-- operator switches it on. Seeded, idempotent, never overwriting a decision.
INSERT INTO ai_feature_flags (feature_name, enabled, rollout_percentage) VALUES
  ('ai_screenshot_extraction', true,  100),
  ('ai_trade_analysis',        false, 0),
  ('ai_weekly_report',         false, 0),
  ('ai_assistant',             false, 0)
ON CONFLICT (feature_name) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Provider budgets (Legacy ai_provider_quotas).
--    The reservation is ONE statement in code (`UPDATE … WHERE daily_used <
--    quota_limit`) — Legacy's file records that a check-then-increment was a
--    race, and re-introducing it here would re-open a bug that was already paid
--    for once.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_provider_quotas (
  provider     TEXT PRIMARY KEY CHECK (provider IN ('openai', 'gemini', 'tesseract')),
  daily_used   INTEGER NOT NULL DEFAULT 0 CHECK (daily_used >= 0),
  quota_limit  INTEGER NOT NULL DEFAULT 1500 CHECK (quota_limit >= 0),
  reset_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Gemini's free tier is 1500 requests/day (Legacy's own comment on the column);
-- the local OCR provider is effectively unbounded but still counted, so "how
-- many calls did we make" stays answerable for every provider.
INSERT INTO ai_provider_quotas (provider, quota_limit) VALUES
  ('gemini', 1500), ('openai', 1500), ('tesseract', 100000)
ON CONFLICT (provider) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Credential METADATA (Legacy ai_provider_credentials) — status, fingerprint
--    and verification history. There is deliberately NO secret column here.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_provider_credentials (
  provider        TEXT PRIMARY KEY CHECK (provider IN ('openai', 'gemini', 'tesseract', 'n8n_relay')),
  status          TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (status IN
                    ('VALID', 'INVALID_CREDENTIAL', 'EXPIRED', 'REVOKED', 'DISABLED',
                     'INSUFFICIENT_PERMISSION', 'QUOTA_EXCEEDED', 'RATE_LIMITED',
                     'PROVIDER_UNAVAILABLE', 'REGION_RESTRICTED', 'NETWORK_ERROR',
                     'UNKNOWN', 'UNVERIFIED')),
  -- `verified` is a consequence of the status, not an independent opinion.
  verified        BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT ai_provider_credentials_verified_coherent
    CHECK ((status = 'VALID') = verified),
  -- HMAC-SHA256 of the secret under the master key: non-reversible, and the only
  -- thing about the value that ever leaves the server.
  fingerprint     TEXT CHECK (fingerprint IS NULL OR fingerprint ~ '^[0-9a-f]{64}$'),
  verified_at     TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  error_code      TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,64}$'),
  latency_ms      INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Platform secrets, encrypted at rest (the Modern replacement for Legacy's
--    private 0600 file). The envelope is credentialCrypto's: version, algorithm,
--    iv, tag, ciphertext — all base64, all opaque to SQL.
-- ─────────────────────────────────────────────────────────────────────────────

-- The envelope shape is 0010's, column for column: `user_credentials` already
-- established how this repository stores an AES-256-GCM envelope, and a second
-- convention for the same job would mean two places to get wrong. Typed BYTEA
-- columns (never text/hex, so nothing can be concatenated into a log line), a
-- CHECK on every length, and nonce uniqueness per key version.
CREATE TABLE IF NOT EXISTS ai_platform_secrets (
  secret_key        TEXT PRIMARY KEY CHECK (secret_key IN
                      ('GEMINI_API_KEY', 'OPENAI_API_KEY', 'GEMINI_RELAY_URL', 'GEMINI_RELAY_TOKEN')),
  enc_version       SMALLINT NOT NULL DEFAULT 1 CHECK (enc_version = 1),
  key_version       SMALLINT NOT NULL CHECK (key_version >= 1),
  algorithm         TEXT     NOT NULL DEFAULT 'aes-256-gcm' CHECK (algorithm = 'aes-256-gcm'),
  iv                BYTEA    NOT NULL CHECK (octet_length(iv) = 12),
  auth_tag          BYTEA    NOT NULL CHECK (octet_length(auth_tag) = 16),
  secret_ciphertext BYTEA    NOT NULL CHECK (octet_length(secret_ciphertext) > 0),
  updated_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Defence in depth, same as 0010: one nonce per key version, ever.
  CONSTRAINT ai_platform_secrets_nonce_unique UNIQUE (key_version, iv)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Admin-managed AI settings (Legacy ai_global_settings). The global route is
--    the one Legacy names explicitly: `ai_route_default` ∈ direct | n8n_relay.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_settings (
  setting_key   TEXT PRIMARY KEY CHECK (length(btrim(setting_key)) BETWEEN 1 AND 64),
  setting_value TEXT CHECK (setting_value IS NULL OR length(setting_value) <= 64),
  updated_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The route setting is closed-vocabulary: an operator may choose direct or the
-- relay, and nothing else can be stored even by a bug.
ALTER TABLE ai_settings DROP CONSTRAINT IF EXISTS ai_settings_route_vocabulary;
ALTER TABLE ai_settings ADD CONSTRAINT ai_settings_route_vocabulary
  CHECK (setting_key <> 'ai_route_default' OR setting_value IN ('direct', 'n8n_relay'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Feedback on an AI answer (Legacy ai_feedback): what the model produced,
--    what the user says it should have been, and which fields differed.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_feedback (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The attempt the correction refers to. Nullable because Legacy accepted
  -- feedback for an extraction that may already have been pruned; the correction
  -- is still worth keeping when the attempt is not.
  attempt_id     BIGINT REFERENCES ai_coaching_logs(id) ON DELETE SET NULL,
  feature        TEXT NOT NULL CHECK (feature IN
                   ('screenshot_extraction', 'trade_analysis', 'weekly_report', 'assistant',
                    'coach', 'transcribe', 'vision_extract', 'ocr')),
  original       JSONB NOT NULL CHECK (jsonb_typeof(original) = 'object'),
  corrected      JSONB NOT NULL CHECK (jsonb_typeof(corrected) = 'object'),
  changed_fields JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(changed_fields) = 'array'),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- a correction that changes nothing is not feedback
  CONSTRAINT ai_feedback_changed_fields_present CHECK (jsonb_array_length(changed_fields) > 0)
);

CREATE INDEX IF NOT EXISTS ai_feedback_user_idx ON ai_feedback (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_feedback_feature_idx ON ai_feedback (feature, created_at DESC);
