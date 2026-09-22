-- VELORA-MODERN core schema — Phase 1 foundation.
-- Conforms to: ADR-001 (scales), ADR-002 (Option B ledger), ADR-003 (canonical
-- email), ADR-004 (timestamptz/UTC + dual trading timestamps), ADR-005 (auth),
-- ADR-008 (webhook raw archive + dedupe), ADR-007 (shared rate-limit store).
-- All timestamps: timestamptz, stored UTC (ADR-004). Money: numeric, ADR-001 matrix.

CREATE TABLE IF NOT EXISTS users (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email           TEXT NOT NULL,                      -- canonical lowercase (ADR-003/D-02)
  password_hash   TEXT NOT NULL,                      -- bcrypt $2y$ import or argon2id (ADR-005/D-04)
  role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  locale          TEXT NOT NULL DEFAULT 'fa' CHECK (locale IN ('fa','en')),
  email_verified_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,                   -- sha256 of token (verified PHP behavior)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ,
  CONSTRAINT user_sessions_token_unique UNIQUE (refresh_token_hash)
);
CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions(user_id);

CREATE TABLE IF NOT EXISTS user_devices (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_devices_unique UNIQUE (user_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS email_verifications (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT email_verifications_token_unique UNIQUE (token_hash)
);

CREATE TABLE IF NOT EXISTS password_resets (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT password_resets_token_unique UNIQUE (token_hash)
);

CREATE TABLE IF NOT EXISTS trading_accounts (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_account_id TEXT,
  broker_server TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trading_accounts_unique UNIQUE (user_id, external_account_id)
);

-- Trade ledger (ADR-002 / Option B): the row is a projection; mutations are
-- events (trade_events); deletion is a tombstone (deleted_at) — never a DELETE.
CREATE TABLE IF NOT EXISTS trades (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(id),
  account_id        BIGINT REFERENCES trading_accounts(id),
  external_deal_id  TEXT,                              -- MetaApi identity; idempotent upserts
  ticket_id         TEXT,
  symbol            TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('buy','sell')),
  status            TEXT NOT NULL DEFAULT 'CLOSED' CHECK (status IN ('OPEN','CLOSED')),
  entry_price       NUMERIC(20,8) NOT NULL,
  exit_price        NUMERIC(20,8),
  volume            NUMERIC(20,8) NOT NULL,
  contract_size     NUMERIC(20,8) NOT NULL DEFAULT 1.00000000,
  commission        NUMERIC(20,2) NOT NULL DEFAULT 0.00,
  swap              NUMERIC(20,2) NOT NULL DEFAULT 0.00,
  net_pnl           NUMERIC(20,2),
  r_multiple        NUMERIC(20,8),
  stop_loss         NUMERIC(20,8),
  take_profit       NUMERIC(20,8),
  strategy          TEXT,
  setup             TEXT,
  emotion           TEXT,
  notes             TEXT,
  allocated_volume  NUMERIC(20,8) NOT NULL DEFAULT 0.00000000,
  version           BIGINT NOT NULL DEFAULT 0,        -- optimistic concurrency
  deleted_at        TIMESTAMPTZ,                       -- tombstone
  -- ADR-004 dual trading timestamps (sync-sourced):
  occurred_at       TIMESTAMPTZ NOT NULL,
  source_time_naive TEXT,
  source_tz_offset  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trades_extdeal_unique UNIQUE (account_id, external_deal_id),
  CONSTRAINT trades_allocation_guard CHECK (allocated_volume <= volume),
  CONSTRAINT trades_volume_positive CHECK (volume > 0)
);
CREATE INDEX IF NOT EXISTS trades_user_idx ON trades(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS trades_account_idx ON trades(account_id);

-- Append-only event log (ADR-002). No UPDATE/DELETE grants for app roles (roles.sql).
CREATE TABLE IF NOT EXISTS trade_events (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_uid        TEXT NOT NULL,                      -- idempotency: duplicate delivery converges
  trade_id         BIGINT NOT NULL REFERENCES trades(id),
  type             TEXT NOT NULL CHECK (type IN
    ('TRADE_IMPORTED','TRADE_CREATED','FINANCIAL_CORRECTED','JOURNALING_EDITED',
     'EXIT_RECORDED','TOMBSTONE_SET','ADMIN_CORRECTION','QUARANTINE_RAISED')),
  actor            TEXT NOT NULL CHECK (actor IN ('user','sync','webhook','admin','system')),
  expected_version BIGINT NOT NULL,
  payload          JSONB NOT NULL,
  at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trade_events_uid_unique UNIQUE (event_uid)
);
CREATE INDEX IF NOT EXISTS trade_events_trade_idx ON trade_events(trade_id, id);

CREATE TABLE IF NOT EXISTS trade_exits (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trade_id    BIGINT NOT NULL REFERENCES trades(id),
  volume      NUMERIC(20,8) NOT NULL CHECK (volume > 0),
  price       NUMERIC(20,8) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- allocated_volume maintenance + over-allocation enforcement at the DB level
CREATE OR REPLACE FUNCTION velora_apply_exit() RETURNS TRIGGER AS $$
DECLARE trade_volume NUMERIC(20,8); allocated NUMERIC(20,8);
BEGIN
  SELECT volume, allocated_volume INTO trade_volume, allocated FROM trades WHERE id = NEW.trade_id FOR UPDATE;
  IF allocated + NEW.volume > trade_volume THEN
    RAISE EXCEPTION 'over-allocation: % + % > %', allocated, NEW.volume, trade_volume;
  END IF;
  UPDATE trades SET allocated_volume = allocated + NEW.volume, updated_at = now() WHERE id = NEW.trade_id;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trade_exits_guard ON trade_exits;
CREATE TRIGGER trade_exits_guard BEFORE INSERT ON trade_exits
  FOR EACH ROW EXECUTE FUNCTION velora_apply_exit();

-- Webhook raw archive + event-id dedupe (ADR-008)
CREATE TABLE IF NOT EXISTS webhook_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source      TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  payload     JSONB NOT NULL,                          -- immutable raw payload
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT webhook_events_dedupe UNIQUE (source, event_id)
);

-- Shared-store rate limiting (ADR-007 trigger #1 keeps this store swappable)
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT PRIMARY KEY,
  hits         BIGINT NOT NULL DEFAULT 1,
  window_start TIMESTAMPTZ NOT NULL
);
