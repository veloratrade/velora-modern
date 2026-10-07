-- 0033_analytics_platform.sql — Phase 9: analytics operational substrate (integration health).
--
-- WHY THIS MIGRATION EXISTS
--
-- Legacy's AnalyticsService (Phase H) exposes six admin analytics endpoints:
--   overview | users | trading | ai | operations | revenue
-- Modern already delivered users + trading (Phase 6, PG-06) and the mixed-domain
-- overview snapshot (Phase 6 overview, without a time window). The remaining
-- four are:
--   * overview (range-aware, mixed-domain) — needs only existing tables;
--   * ai        — needs an AI request ledger (Modern already has it as
--                 ai_coaching_logs, see 0017 + 0023 + 0028 — no new AI table);
--   * operations— needs system_logs (0032, now exists) + integration_health +
--                 admin audit (audit_log, already exists);
--   * revenue   — ALWAYS unavailable (no billing source exists in the repo,
--                 classification C, reconfirmed in Legacy's own comment).
--
-- WHAT THIS MIGRATION CREATES — ONE TABLE, NOT FOUR
--
-- `integration_health` is the only substrate Modern was missing. Legacy's
-- schema defines it as a single row per integration (PK = integration) with
-- status, latency, error_code, message and checked_at. Modern's integration
-- surface (0031) stores configuration but never attested health; this table
-- closes that gap with the same vocabulary Legacy uses (HEALTHY|DEGRADED|
-- UNHEALTHY|NOT_CONFIGURED|UNKNOWN) and the same failure semantics (a missing
-- row means NOT_CONFIGURED, not healthy).
--
-- ai_requests IS DELIBERATELY NOT CREATED. Legacy writes four journals for one
-- attempt (ai_requests + ai_provider_logs + ai_audit_logs + ai_extractions).
-- Modern's 0028 header is explicit: \"ONE LEDGER, NOT FOUR\" — every AI attempt
-- is recorded once in ai_coaching_logs with provider, feature, outcome, model,
-- latency and cost. Creating a second ledger for the same fact would create two
-- sources of truth for \"how many AI calls did we make\". Analytics therefore
-- counts ai_coaching_logs, not a new ai_requests table — the behaviour (counts,
-- group-by, tokens, cost, trend) is preserved while the storage stays honest to
-- Modern's rule that PostgreSQL is authoritative and there is no second store.
--
-- FAIL-CLOSED RULES
--   * `integration_health.integration` is a CLOSED vocabulary (metaapi, email,
--     ai, n8n_relay, telegram) so a bug cannot persist an integration the UI
--     does not know how to render;
--   * `status` is a CLOSED vocabulary with a CHECK — a row cannot claim an
--     unknown health state;
--   * checked_at is required — health without a timestamp is not health.
--   * Revenue stays unavailable by contract (no table, no derivation, never zero).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Integration health (Legacy v1.5 integration_health).
--    One row per integration, the last probe outcome.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS integration_health (
  integration   TEXT PRIMARY KEY CHECK (integration IN ('metaapi', 'email', 'ai', 'n8n_relay', 'telegram')),
  status        TEXT NOT NULL CHECK (status IN ('HEALTHY', 'DEGRADED', 'UNHEALTHY', 'NOT_CONFIGURED', 'UNKNOWN')),
  latency_ms    INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code    TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,64}$'),
  message       TEXT CHECK (message IS NULL OR length(message) <= 500),
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
