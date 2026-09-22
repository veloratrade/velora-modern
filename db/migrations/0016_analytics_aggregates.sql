-- 0016_analytics_aggregates.sql — Roadmap v0.5 + §3 "Decoupled Analytics Engine".
--
-- SOURCE OF AUTHORITY (docs/pdf/Roadmap.pdf, §3 and §4 v0.5)
--   §3: "Never compute complex financial stats (Sharpe Ratio, Expectancy, Max
--        Drawdown) on the fly during API request execution. Pivot: Implement
--        asynchronous event-driven calculations ... and updates pre-aggregated
--        summary tables (user_analytics_daily, account_performance_summary).
--        The UI fetches pre-calculated snapshots instantaneously."
--   §4 v0.5: "Create tags, trade_tags, trade_attachments, and
--        user_analytics_daily tables." (tags/attachments -> 0015)
--   §3: "Enforce composite indexing on (account_id, open_time) and
--        (account_id, symbol)".
--
-- THE DAY BUCKET IS NOT ABSOLUTE — THIS IS THE ADR-004 BLOCKER, ENCODED
--   A "daily" aggregate is only defined once a timezone is chosen, and the
--   Legacy source timezone is BLOCKED_ON_SAMPLING (ADR-004; db/MIGRATION_MAP.md).
--   Rather than silently assuming UTC, a daily row carries its basis:
--       day            — the calendar day
--       tz_basis       — the IANA zone the day was computed in
--       tz_basis_source— where that zone came from
--   and the PRIMARY KEY includes tz_basis. A row therefore never claims to be
--   "the" day for a user; it claims to be that day *in that zone*. If the owner
--   later ratifies a different basis, new rows are added alongside instead of
--   overwriting history, and the old ones remain auditable.
--
-- MONEY AND RATIO SCALES follow the frozen ADR-001 matrix, not convenience:
--   money  -> NUMERIC(20,2)   ratios -> NUMERIC(18,8)   counts -> INTEGER
--   The schema stores WHAT was computed; it does not decide HOW money is
--   rounded (OD-1/OD-5 remain OPEN — no rounding rule is asserted here).
--
-- SCOPE / SAFETY
--   - Forward-only (ADR-010), additive, idempotent.
--   - Creates 2 tables + 2 indexes. No existing object is modified.
--   - These are DERIVED tables: every column is recomputable from `trades`.
--     Nothing authoritative lives only here, so a rebuild is always possible.
--   - No production database exists or is touched by this file.

CREATE TABLE IF NOT EXISTS user_analytics_daily (
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day             DATE NOT NULL,
  tz_basis        TEXT NOT NULL CHECK (length(tz_basis) BETWEEN 1 AND 64),
  tz_basis_source TEXT NOT NULL DEFAULT 'unknown'
                  CHECK (tz_basis_source IN ('user_profile','account','broker','assumed_utc','unknown')),
  trades_count    INTEGER NOT NULL DEFAULT 0 CHECK (trades_count >= 0),
  wins            INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses          INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
  breakeven       INTEGER NOT NULL DEFAULT 0 CHECK (breakeven >= 0),
  gross_profit    NUMERIC(20,2) NOT NULL DEFAULT 0.00 CHECK (gross_profit >= 0),
  gross_loss      NUMERIC(20,2) NOT NULL DEFAULT 0.00 CHECK (gross_loss <= 0),
  net_pnl         NUMERIC(20,2) NOT NULL DEFAULT 0.00,
  win_rate        NUMERIC(18,8),
  profit_factor   NUMERIC(18,8),
  expectancy      NUMERIC(20,2),
  max_drawdown    NUMERIC(20,2) CHECK (max_drawdown IS NULL OR max_drawdown >= 0),
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The basis is part of the identity of a daily figure (see header).
  PRIMARY KEY (user_id, day, tz_basis),
  CONSTRAINT user_analytics_daily_partition_consistent
    CHECK (wins + losses + breakeven <= trades_count)
);
CREATE INDEX IF NOT EXISTS user_analytics_daily_user_day_idx
  ON user_analytics_daily (user_id, day DESC);

CREATE TABLE IF NOT EXISTS account_performance_summary (
  account_id     BIGINT PRIMARY KEY REFERENCES trading_accounts(id) ON DELETE CASCADE,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency       TEXT CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  as_of          TIMESTAMPTZ NOT NULL DEFAULT now(),
  trades_count   INTEGER NOT NULL DEFAULT 0 CHECK (trades_count >= 0),
  wins           INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses         INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
  breakeven      INTEGER NOT NULL DEFAULT 0 CHECK (breakeven >= 0),
  gross_profit   NUMERIC(20,2) NOT NULL DEFAULT 0.00 CHECK (gross_profit >= 0),
  gross_loss     NUMERIC(20,2) NOT NULL DEFAULT 0.00 CHECK (gross_loss <= 0),
  net_pnl        NUMERIC(20,2) NOT NULL DEFAULT 0.00,
  win_rate       NUMERIC(18,8),
  profit_factor  NUMERIC(18,8),
  expectancy     NUMERIC(20,2),
  max_drawdown   NUMERIC(20,2) CHECK (max_drawdown IS NULL OR max_drawdown >= 0),
  equity_peak    NUMERIC(20,2),
  equity_trough  NUMERIC(20,2)
);
CREATE INDEX IF NOT EXISTS account_performance_summary_user_idx
  ON account_performance_summary (user_id, as_of DESC);

-- §3 composite indexes. `trades(account_id, occurred_open_at_utc)` is the
-- roadmap's (account_id, open_time) expressed against the CANONICAL time column
-- (ADR-004: instants are UTC-only; the naive legacy open_time is evidence, never
-- a sort key). Partial on live rows so tombstones do not bloat the index.
CREATE INDEX IF NOT EXISTS trades_account_open_canonical_idx
  ON trades (account_id, occurred_open_at_utc DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS trades_account_symbol_idx
  ON trades (account_id, symbol) WHERE deleted_at IS NULL;
