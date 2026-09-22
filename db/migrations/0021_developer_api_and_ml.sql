-- 0021_developer_api_and_ml.sql — Roadmap v3.0 (Sovereign Trading OS).
--
-- SOURCE OF AUTHORITY (docs/pdf/Roadmap.pdf, §4 "Version 3.0")
--   "Database Changes: Create developer_api_keys, ml_model_predictions,
--    voice_session_logs tables."
--   "Security Changes: OAuth2 Scoped Tokens for Developer API Marketplace;
--    Granular rate limiting (100 req/min per API key)."
--   "Features: Real-Time Voice AI Co-Pilot (WebSockets audio stream ...),
--    Machine Learning Win-Probability model."
--   "Backend: Machine Learning Inference Engine Integration (Python microservice)."
--
-- PRIVACY IS THE DESIGN CONSTRAINT HERE, NOT AN AFTERTHOUGHT
--   * Voice: a co-pilot session captures a live audio stream. Audio and full
--     transcripts are the most sensitive artefacts this product will ever touch.
--     The schema therefore stores METADATA by default and requires an explicit
--     opt-in flag for any retained transcript; there is no column that silently
--     accumulates raw audio. Retention of `alerts` is limited to structured,
--     low-cardinality rule violations.
--   * ML: `features` is the model input. It is stored as a compact JSONB of
--     engineered values — deliberately NOT a copy of the trade rows it was built
--     from, so a prediction row cannot become a shadow trade archive.
--
-- KEYS FOLLOW THE EXISTING INVARIANT
--   A developer API key is a bearer credential: only its SHA-256 hash and a
--   short non-secret PREFIX (for display/identification in the portal) are
--   stored. No plaintext column exists and none may be added.
--
-- SCOPE / SAFETY
--   - Forward-only (ADR-010), additive, idempotent.
--   - Creates 3 tables + indexes. No existing object is modified.
--   - No audio, no transcript-without-consent, no secret material.
--   - No production database exists or is touched by this file.

-- ---------------------------------------------------------------------------
-- 1. Developer API keys (Open API marketplace)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS developer_api_keys (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name           TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  -- Non-secret display prefix; the credential itself is only ever a hash.
  key_prefix     TEXT NOT NULL CHECK (key_prefix ~ '^[A-Za-z0-9]{6,12}$'),
  key_hash       TEXT NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  -- OAuth2-style scope vocabulary. CHECK-constrained so an unknown scope cannot
  -- be granted by a future caller without a deliberate migration.
  scopes         TEXT[] NOT NULL DEFAULT ARRAY['trades:read']::TEXT[]
                 CHECK (scopes <@ ARRAY['trades:read','trades:write','analytics:read','accounts:read']::TEXT[]),
  rate_limit_per_min INTEGER NOT NULL DEFAULT 100 CHECK (rate_limit_per_min BETWEEN 1 AND 10000), -- roadmap: 100 req/min
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT developer_api_keys_hash_unique UNIQUE (key_hash)
);
CREATE INDEX IF NOT EXISTS developer_api_keys_user_live_idx
  ON developer_api_keys (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. ML model predictions (Python inference microservice output)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ml_model_predictions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_id      BIGINT,        -- historical id, no FK: a prediction must outlive its trade
  model_name    TEXT NOT NULL CHECK (length(btrim(model_name)) BETWEEN 1 AND 120),
  model_version TEXT NOT NULL CHECK (length(btrim(model_version)) BETWEEN 1 AND 60),
  features      JSONB NOT NULL CHECK (jsonb_typeof(features) = 'object'),
  prediction    JSONB NOT NULL CHECK (jsonb_typeof(prediction) = 'object'),
  -- Win probability the roadmap's acceptance criterion talks about (> 65%).
  probability   NUMERIC(6,5) CHECK (probability IS NULL OR (probability >= 0 AND probability <= 1)),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ml_model_predictions_user_idx
  ON ml_model_predictions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ml_model_predictions_trade_idx
  ON ml_model_predictions (trade_id) WHERE trade_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Voice co-pilot sessions (metadata only by default)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice_session_logs (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_uid         TEXT NOT NULL CHECK (session_uid ~ '^[A-Za-z0-9_-]{8,64}$'),
  started_at          TIMESTAMPTZ NOT NULL,
  ended_at            TIMESTAMPTZ,
  duration_seconds    INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  -- Structured rule violations raised during the session (low cardinality only).
  alerts              JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(alerts) = 'array'),
  -- NO raw audio column exists. A transcript is retained ONLY with explicit consent.
  transcript_retained BOOLEAN NOT NULL DEFAULT false,
  transcript          TEXT CHECK (transcript IS NULL OR transcript_retained),
  outcome             TEXT NOT NULL DEFAULT 'completed'
                      CHECK (outcome IN ('completed','aborted','error')),
  error_code          TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,48}$'),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT voice_session_logs_uid_unique UNIQUE (session_uid),
  CONSTRAINT voice_session_logs_time_sane CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX IF NOT EXISTS voice_session_logs_user_idx
  ON voice_session_logs (user_id, started_at DESC);
