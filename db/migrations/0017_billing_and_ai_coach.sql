-- 0017_billing_and_ai_coach.sql — Roadmap v1.0 (Commercial Launch & AI Coach v1).
--
-- SOURCE OF AUTHORITY (docs/pdf/Roadmap.pdf, §4 "Version 1.0")
--   "Database Changes: Create subscriptions, ai_coaching_logs, and
--    admin_audit_logs tables. Add role column to users."
--
-- WHY ONLY TWO TABLES ARE CREATED HERE
--   * `admin_audit_logs` — ALREADY EXISTS as `audit_log` (migration 0009, widened
--     by 0011/0014). The PHP repo and the roadmap use the older name; the Modern
--     table is the same capability with a stricter contract (append-only enforced
--     by db/roles.sql REVOKEs, server-derived actor, CHECK vocabulary). Creating a
--     second table under the roadmap's historical name would create two audit
--     trails for one system, which is precisely what 0009's header forbids.
--     MAPPING: roadmap `admin_audit_logs` == Modern `audit_log`.
--   * `users.role` — ALREADY EXISTS (0001 `user|admin`, widened by 0006 to
--     `user|admin|super_admin`, exactly the roadmap's RBAC intention).
--
-- PLAN VOCABULARY (users.plan) — sourced, not invented
--   `users.plan` was added by 0002 with DEFAULT 'free' and NO constraint.
--   Modern's own roadmap (velora-modern docs/migration/ROADMAP.md, Phase 6.5)
--   names the plan set as (free, pro, enterprise) and requires Plan to stay
--   strictly separate from Role. This migration adds the missing CHECK only.
--   It does NOT grant any privilege: a plan value can never widen a role.
--
-- STRIPE IDENTIFIERS ARE NOT SECRETS but are not free text either:
--   they are provider-issued identifiers, stored verbatim, with a UNIQUE
--   constraint so a webhook replay cannot create a second subscription row for
--   the same provider object. Webhook SIGNATURE verification is application
--   behaviour (roadmap: "Stripe webhook cryptographic signature verification")
--   and no secret, key or signature material is stored in this schema.
--
-- SCOPE / SAFETY
--   - Forward-only (ADR-010), additive, idempotent (DROP+ADD for constraints).
--   - Creates 2 tables, adds 1 CHECK, adds 2 indexes. No row is read or rewritten.
--   - Existing rows are valid by construction: `plan` has defaulted to 'free'
--     since 0002, so every pre-existing row already satisfies the new CHECK.
--   - No production database exists or is touched by this file.

-- Plan vocabulary (Phase 6.5 of Modern's roadmap; Roadmap.pdf v1.0 "Tiered Access Rules").
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check;
ALTER TABLE users ADD CONSTRAINT users_plan_check
  CHECK (plan IN ('free', 'pro', 'enterprise'));

CREATE TABLE IF NOT EXISTS subscriptions (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id                  BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan                     TEXT NOT NULL CHECK (plan IN ('pro', 'enterprise')),
  status                   TEXT NOT NULL CHECK (status IN
                             ('incomplete','trialing','active','past_due','canceled','unpaid')),
  provider                 TEXT NOT NULL DEFAULT 'stripe' CHECK (provider = 'stripe'),
  provider_customer_id     TEXT,
  provider_subscription_id TEXT,
  current_period_start     TIMESTAMPTZ,
  current_period_end       TIMESTAMPTZ,
  cancel_at_period_end     BOOLEAN NOT NULL DEFAULT false,
  canceled_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A provider object maps to exactly one local row (webhook idempotency).
  CONSTRAINT subscriptions_provider_unique UNIQUE (provider, provider_subscription_id)
);
-- At most ONE live subscription per user: "failed payment downgrades access"
-- cannot leave two active rows competing for the same account state.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_live_per_user
  ON subscriptions (user_id) WHERE status IN ('active', 'trialing', 'past_due');
CREATE INDEX IF NOT EXISTS subscriptions_user_recent_idx
  ON subscriptions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_coaching_logs (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider        TEXT NOT NULL CHECK (provider IN ('openai','gemini')),
  model           TEXT NOT NULL CHECK (length(btrim(model)) BETWEEN 1 AND 120),
  prompt_version  TEXT NOT NULL CHECK (length(btrim(prompt_version)) BETWEEN 1 AND 40),
  window_from     TIMESTAMPTZ,
  window_to       TIMESTAMPTZ,
  trades_analyzed INTEGER CHECK (trades_analyzed IS NULL OR trades_analyzed >= 0),
  insight         JSONB NOT NULL CHECK (jsonb_typeof(insight) = 'object'),
  tokens_in       INTEGER CHECK (tokens_in  IS NULL OR tokens_in  >= 0),
  tokens_out      INTEGER CHECK (tokens_out IS NULL OR tokens_out >= 0),
  cost_micro_usd  BIGINT  CHECK (cost_micro_usd IS NULL OR cost_micro_usd >= 0),
  outcome         TEXT NOT NULL CHECK (outcome IN ('success','refused','error')),
  error_code      TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,48}$'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_coaching_logs_window_sane
    CHECK (window_from IS NULL OR window_to IS NULL OR window_from <= window_to)
);
CREATE INDEX IF NOT EXISTS ai_coaching_logs_user_idx
  ON ai_coaching_logs (user_id, created_at DESC);

-- DELIBERATELY ABSENT
--   No column stores the raw prompt or the raw model response. The prompt is
--   assembled from a user's trades — including free-text `notes` — so keeping it
--   would silently duplicate user content (and any PII inside it) into a third
--   store. Only the STRUCTURED insight, the window, the model identity, the
--   version of the prompt template, and the cost are retained; that is exactly
--   what the roadmap's feature needs ("outputs structured JSON recommendations")
--   and nothing more.
