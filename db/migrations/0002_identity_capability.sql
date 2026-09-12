-- 0002_identity_capability.sql — Phase C identity capability port (2026-09-12).
-- Adds the Remote-verified user-model fields (auth.service PublicUserDto) and
-- session metadata to the Local target schema. Forward-only (ADR-010); applied
-- by db/migrate.ts; exercised by the Phase C identity tests (PGlite, disposable).
-- No production database exists or is touched by this file.

ALTER TABLE users ADD COLUMN full_name    TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN timezone     TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE users ADD COLUMN plan         TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN status       TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN ai_consent_at TIMESTAMPTZ;

-- Session metadata recorded by the auth flows (Remote-verified behavior:
-- access-token hash binding + IP/user-agent capture, agent capped at 250 chars).
ALTER TABLE user_sessions ADD COLUMN access_token_hash TEXT;
ALTER TABLE user_sessions ADD COLUMN ip_address        TEXT;
ALTER TABLE user_sessions ADD COLUMN user_agent        TEXT;
