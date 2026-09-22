-- 0018_portfolio_and_prop.sql — Roadmap v1.5 (Multi-Account Portfolio & Prop Firm Suite).
--
-- SOURCE OF AUTHORITY (docs/pdf/Roadmap.pdf, §4 "Version 1.5")
--   "Features: Multi-Account Portfolio Grouping, Auto Currency Normalization
--    (EUR/GBP/JPY trades auto-converted to USD base currency using daily FX
--    rates), Prop Firm Rule Monitor (Tracks Max Daily Drawdown, Max Total Loss,
--    and Target Profit limits in real-time), Risk Exposure Dashboard."
--   "Database Changes: Create currency_rates, account_groups, prop_firm_rules
--    tables."
--   "Testing Requirements: Currency conversion precision tests; Prop Firm
--    drawdown edge-case calculations (high equity peak vs balance tracking)."
--   Acceptance criterion 2: "Reaching 80% of daily drawdown limit triggers
--    immediate In-App, Email, and Webhook alerts."
--
-- TWO DESIGN POINTS ARE ENCODED FROM THE ROADMAP'S OWN TEXT
--   1. FX precision: a rate is not money and not a price — it is a conversion
--      factor. It gets its own scale NUMERIC(24,10) with CHECK (rate > 0), and
--      the ledger keeps money at ADR-001 NUMERIC(20,2). Conversion results are
--      written as money at 2 dp; the RATE is never rounded into money.
--   2. Drawdown basis: the roadmap's own test requirement distinguishes
--      "equity peak vs balance tracking", so `drawdown_basis` is an explicit
--      column ('balance' | 'equity') rather than an assumption. A Prop Firm that
--      defines limits on balance and one that defines them on equity are
--      different products; the schema now says which one applies.
--
-- `account_group_members` is not named in the roadmap, but grouping accounts is
-- a many-to-many relation; a join table is the minimal correct shape (the
-- alternative — an array column on account_groups — cannot carry per-membership
-- metadata and cannot enforce ownership with a foreign key).
--
-- SCOPE / SAFETY
--   - Forward-only (ADR-010), additive, idempotent.
--   - Creates 4 tables (+1 supporting unique index on trading_accounts).
--     No existing row is read or rewritten.
--   - No production database exists or is touched by this file.

-- Ownership anchor for the composite FKs below. Must be a UNIQUE CONSTRAINT,
-- not a unique index: PostgreSQL composite FOREIGN KEYs require a matching
-- unique constraint (verified by execution on 0015). id is the PRIMARY KEY, so
-- (id, user_id) is unique by construction.
ALTER TABLE trading_accounts DROP CONSTRAINT IF EXISTS trading_accounts_id_user_unique;
ALTER TABLE trading_accounts ADD CONSTRAINT trading_accounts_id_user_unique UNIQUE (id, user_id);

-- ---------------------------------------------------------------------------
-- 1. Currency rates (daily background job, roadmap: "pulling ECB rate data")
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS currency_rates (
  base      TEXT NOT NULL CHECK (base  ~ '^[A-Z]{3}$'),
  quote     TEXT NOT NULL CHECK (quote ~ '^[A-Z]{3}$'),
  rate_date DATE NOT NULL,
  rate      NUMERIC(24,10) NOT NULL CHECK (rate > 0),
  source    TEXT NOT NULL DEFAULT 'ECB' CHECK (length(btrim(source)) BETWEEN 1 AND 40),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (base, quote, rate_date),
  CONSTRAINT currency_rates_distinct_pair CHECK (base <> quote)
);
CREATE INDEX IF NOT EXISTS currency_rates_lookup_idx
  ON currency_rates (base, quote, rate_date DESC);

-- ---------------------------------------------------------------------------
-- 2. Account groups (portfolio grouping)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_groups (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description TEXT CHECK (description IS NULL OR length(description) <= 500),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_groups_user_name_unique UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS account_group_members (
  group_id   BIGINT NOT NULL REFERENCES account_groups(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, account_id),
  -- A group can only contain accounts of ITS OWN owner ("users can only group
  -- accounts they explicitly own" is the roadmap's own security requirement).
  CONSTRAINT account_group_members_account_owner_fk FOREIGN KEY (account_id, user_id)
    REFERENCES trading_accounts (id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS account_group_members_account_idx
  ON account_group_members (account_id);

-- ---------------------------------------------------------------------------
-- 3. Prop firm rules (per account)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prop_firm_rules (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id           BIGINT NOT NULL,
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_set_name        TEXT NOT NULL DEFAULT 'default'
                       CHECK (length(btrim(rule_set_name)) BETWEEN 1 AND 120),
  max_daily_drawdown   NUMERIC(20,2) CHECK (max_daily_drawdown IS NULL OR max_daily_drawdown > 0),
  max_total_drawdown   NUMERIC(20,2) CHECK (max_total_drawdown IS NULL OR max_total_drawdown > 0),
  profit_target        NUMERIC(20,2) CHECK (profit_target       IS NULL OR profit_target       > 0),
  -- 'balance' | 'equity' — see header point 2.
  drawdown_basis       TEXT NOT NULL DEFAULT 'balance'
                       CHECK (drawdown_basis IN ('balance','equity')),
  -- The daily window is timezone-dependent; the basis is carried, never assumed.
  daily_reset_time     TIME,
  daily_reset_tz       TEXT CHECK (daily_reset_tz IS NULL OR length(daily_reset_tz) BETWEEN 1 AND 64),
  alert_threshold_pct  NUMERIC(5,2) NOT NULL DEFAULT 80.00
                       CHECK (alert_threshold_pct > 0 AND alert_threshold_pct <= 100), -- roadmap acceptance criterion 2
  enabled              BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prop_firm_rules_account_owner_fk FOREIGN KEY (account_id, user_id)
    REFERENCES trading_accounts (id, user_id) ON DELETE CASCADE
);
-- One active rule set per account keeps the monitor's decision unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS prop_firm_rules_one_per_account
  ON prop_firm_rules (account_id) WHERE enabled;
