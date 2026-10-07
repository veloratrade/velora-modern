-- 0032_admin_platform.sql — Phase 9: admin platform control plane (settings, feature flags, system logs, billing).
--
-- WHY THIS MIGRATION EXISTS
--
-- Legacy's admin panel stores four observability/configuration capabilities that
-- Modern's operator surface was missing, which is why the audit counts them as
-- part of MG-ADMIN's remaining 21 routes (§4.2, Phase 9 inventory):
--   * Platform settings (AdminSettingsService, IntegrationSettingsRepository):
--     a strict-allowlist store for operational knobs. Legacy's own comment on
--     AdminSettingsService says only ONE key is writable (platform.default_locale
--     ∈ {fa,en}, default 'fa', consumer = signup default locale) — everything
--     else is either a secret (SecureCredentialStore only), env-controlled infra,
--     or a supervisory read of another module's key.
--   * Feature flags (AIFeatureFlagRepository, ai_feature_flags):
--     the centralized flag control plane. Legacy's FeatureFlagController is
--     explicit: the feature name is validated against CANONICAL_FLAGS, enabled
--     is boolean, rollout is 0..100, and every mutation is audited. Modern
--     already migrated the table in 0028 (ai_feature_flags) and the flags
--     themselves (ai_screenshot_extraction on, the other three off). This
--     migration therefore adds NO new flag table — it only adds the log store
--     that the other two capabilities need.
--   * System logs (SystemLogRepository, system_logs):
--     the append-only structured application log store (v1.5, system_logs). The
--     store's contract is: severity allowlist, SecretRedactor on write AND on
--     read, no update/delete path for the UI, fail-open when the table is absent
--     so logging never breaks a request.
--   * Billing observability (BillingService):
--     read-only over the internal subscription layer (users.plan /
--     subscriptions). There is NO external provider in the repo (classification
--     C): the service reports plan/status distribution, per-user entitlements
--     and explicitly unavailable provider/history fields with reasons.
--
-- WHAT THIS MIGRATION CREATES — ONE TABLE, NOT FOUR
--
-- `system_logs` is the only substrate Modern was missing. Feature flags and
-- settings reuse tables Modern already owns (ai_feature_flags @ 0028,
-- integration_settings @ 0031); billing is a read over users/subscriptions.
-- Creating a second flag or settings table for the same job would be
-- speculative infrastructure. The precedence for platform.default_locale stays
-- the established one (DB row → ENV alias → default), and DELETE removes the row
-- so the value inherits again — never an ambiguous state.
--
-- FAIL-CLOSED RULES
--   * `system_logs.severity` is a CLOSED vocabulary (DEBUG|INFO|WARN|ERROR) so a
--     bug cannot persist a severity the UI does not know how to render.
--   * No update/delete path exists for the operator surface — the table is
--     WRITE-ONCE, READ-MANY.
--   * SecretRedactor is an application-level invariant (write AND read), so the
--     schema's job is only to bound lengths and enforce the vocabulary.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Structured application log store (Legacy v1.5 system_logs).
--    Append-only, operator-readable via GET /admin/logs/system.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS system_logs (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  severity       TEXT NOT NULL CHECK (severity IN ('DEBUG', 'INFO', 'WARN', 'ERROR')),
  source         TEXT NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 64),
  message        TEXT CHECK (message IS NULL OR length(message) <= 1000),
  request_id     TEXT CHECK (request_id IS NULL OR length(request_id) <= 64),
  correlation_id TEXT CHECK (correlation_id IS NULL OR length(correlation_id) <= 64),
  user_id        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  error_code     TEXT CHECK (error_code IS NULL OR length(error_code) <= 64),
  metadata_json  TEXT CHECK (metadata_json IS NULL OR length(metadata_json) <= 4000),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS system_logs_severity_idx ON system_logs (severity);
CREATE INDEX IF NOT EXISTS system_logs_source_idx ON system_logs (source);
CREATE INDEX IF NOT EXISTS system_logs_created_idx ON system_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS system_logs_request_idx ON system_logs (request_id);
