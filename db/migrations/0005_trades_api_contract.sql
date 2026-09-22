-- 0005_trades_api_contract.sql — Phase C increment 3 (trades capability).
--
-- 0001_core.sql already created the ADR-002 ledger (trades projection,
-- trade_events append-only log, trade_exits + velora_apply_exit allocation
-- trigger). This migration extends the pre-existing tables with the
-- Remote/PHP trades API contract columns — additive, forward-only, no 0001
-- modification, no data changes.
--
-- Evidence:
--   - canonical dual time columns (occurred_*_at_utc, time_status
--     resolved|unresolved, source_timezone*, source_calendar, raw_*_text)
--     — PHP v1.0_trade_time_canonical shape + ADR-004 (instants UTC-only).
--   - source enum ('manual' now; 'metaapi'/'import' vocabulary reserved for
--     Phase H — Remote TradeSource; no sync rows can exist yet).
--   - trade_events.type CHECK widened with EXIT_CANCELLED: ADR-002 requires
--     exit deletion to be a mutation event; the constraint swap drops and
--     re-adds the CHECK (no row data is touched — non-destructive widening).
--   - trade_exits: exit_type/pnl/notes/exited_at per the Remote/PHP exit
--     contract; deleted_at tombstone (ADR-002 — never a physical DELETE).

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS occurred_open_at_utc   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS occurred_close_at_utc  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS time_status            TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (time_status IN ('resolved', 'unresolved')),
  ADD COLUMN IF NOT EXISTS source_timezone        TEXT,
  ADD COLUMN IF NOT EXISTS source_timezone_source TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS source_calendar        TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS raw_open_text          TEXT,
  ADD COLUMN IF NOT EXISTS raw_close_text         TEXT,
  ADD COLUMN IF NOT EXISTS source                 TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'metaapi', 'import'));

-- Ownership-scoped newest-first listing on the canonical open instant,
-- tombstones excluded (partial index).
CREATE INDEX IF NOT EXISTS trades_user_open_idx
  ON trades (user_id, occurred_open_at_utc DESC) WHERE deleted_at IS NULL;

-- Forward-only constraint widening: EXIT_CANCELLED joins the event vocabulary.
ALTER TABLE trade_events DROP CONSTRAINT IF EXISTS trade_events_type_check;
ALTER TABLE trade_events ADD CONSTRAINT trade_events_type_check CHECK (type IN
  ('TRADE_IMPORTED', 'TRADE_CREATED', 'FINANCIAL_CORRECTED', 'JOURNALING_EDITED',
   'EXIT_RECORDED', 'EXIT_CANCELLED', 'TOMBSTONE_SET', 'ADMIN_CORRECTION',
   'QUARANTINE_RAISED'));

ALTER TABLE trade_exits
  ADD COLUMN IF NOT EXISTS exit_type  TEXT NOT NULL DEFAULT 'manual'
    CHECK (exit_type IN ('tp', 'sl', 'manual', 'partial')),
  ADD COLUMN IF NOT EXISTS pnl        NUMERIC(20,2),
  ADD COLUMN IF NOT EXISTS notes      TEXT,
  ADD COLUMN IF NOT EXISTS exited_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ; -- exit tombstone (ADR-002)

CREATE INDEX IF NOT EXISTS trade_exits_trade_idx
  ON trade_exits (trade_id, exited_at ASC) WHERE deleted_at IS NULL;
