-- 0004_trading_accounts.sql — Phase C increment 2 (wave 3: accounts capability).
--
-- 0001_core.sql already created `trading_accounts` as the MetaApi link table
-- (id, user_id, external_account_id, broker_server, created_at) that
-- trades.account_id references (ADR-002). A CREATE TABLE here would silently
-- no-op against it (caught by the PGlite persistence test) — so this
-- migration EXTENDS the existing table with the account-detail columns.
--
-- Evidence: Remote Prisma schema supplies the DB-level defaults
-- (provider/platform MANUAL, timezone_source 'unknown', sync_status
-- DISCONNECTED, balances 0.00, sync-status enum); the Remote repository
-- persists the API status enum (connected|error|disconnected, default
-- disconnected) — the Prisma TradingAccountStatus (active|archived) is a
-- legacy MySQL shape unused by the capability and is NOT ported (documented
-- divergence). PHP AccountController owns the API contract (provider
-- required, label max 120).
--
-- Money is NUMERIC(20,2) per the Local ADR-001 matrix (Remote's 18,2 is NOT
-- copied — no precision change for schema similarity; 0001 house standard).
-- MetaApi sync/credential columns and routes stay Phase H; the link columns
-- (external_account_id, broker_server) already exist from 0001.
-- Forward-only (ADR-010), additive-only; no production database is touched.

ALTER TABLE trading_accounts
  ADD COLUMN IF NOT EXISTS provider              TEXT NOT NULL DEFAULT 'MANUAL'
    CHECK (provider IN ('MT4', 'MT5', 'MANUAL')),
  ADD COLUMN IF NOT EXISTS platform              TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS label                 TEXT NOT NULL DEFAULT 'Trading Account',
  ADD COLUMN IF NOT EXISTS account_number_masked TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS currency              TEXT NOT NULL DEFAULT 'USD'
    CHECK (currency ~ '^[A-Z]{3}$'),
  ADD COLUMN IF NOT EXISTS leverage              TEXT NOT NULL DEFAULT '100'
    CHECK (leverage ~ '^(1:)?[1-9][0-9]{0,7}$'),
  ADD COLUMN IF NOT EXISTS timezone              TEXT,
  ADD COLUMN IF NOT EXISTS timezone_source       TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS status                TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('connected', 'error', 'disconnected')),
  ADD COLUMN IF NOT EXISTS sync_status           TEXT NOT NULL DEFAULT 'DISCONNECTED'
    CHECK (sync_status IN ('DISCONNECTED', 'CONNECTING', 'SYNCING', 'CONNECTED', 'ERROR')),
  ADD COLUMN IF NOT EXISTS balance               NUMERIC(20,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS equity                NUMERIC(20,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ NOT NULL DEFAULT now();

-- Ownership-scoped newest-first listing (Remote: orderBy createdAt desc).
CREATE INDEX IF NOT EXISTS trading_accounts_user_recent_idx
  ON trading_accounts (user_id, created_at DESC);
