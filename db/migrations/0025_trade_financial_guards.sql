-- 0025_trade_financial_guards.sql — the financial invariants of a trade, enforced
-- by the DATABASE rather than only by the service that happens to write it.
--
-- WHY THIS MIGRATION EXISTS (Legacy lineage, not invention)
-- ========================================================
-- Legacy shipped `api/database/migrations/v0.3_trade_financial_consistency.sql`,
-- which refuses to deploy while an unresolved trade exists:
--
--   "Before deployment, the following count must be 0; review and correct such
--    journal records using their broker/source history. In particular, never
--    invent an exit price."
--
--   entry_price IS NULL OR entry_price <= 0
--   OR exit_price IS NULL OR exit_price <= 0
--   OR volume IS NULL OR volume <= 0
--   OR contract_size IS NULL OR contract_size <= 0
--   OR commission IS NULL OR swap IS NULL OR profit_loss IS NULL
--   OR open_time IS NULL OR close_time IS NULL OR close_time < open_time
--
-- That list is the product's definition of a financially-resolved journal row,
-- and Legacy then narrowed the columns to NOT NULL so the states it rejected
-- could not come back. Modern validated the same things in `TradeService` — and
-- nothing else. A row written by any other path (a migration load, a future
-- worker, an operator with psql) could hold a zero price, a negative contract
-- size, a close instant BEFORE its open instant, or a CLOSED trade with no exit
-- price and no PnL, and every downstream number would silently be wrong.
--
-- Modern's own model adds exactly ONE state Legacy could not express: an OPEN
-- trade, which legitimately has no exit price, no close instant and no PnL yet.
-- The guards below are therefore written as "when the value EXISTS it must be
-- valid" plus "a CLOSED trade is financially complete" — which is Legacy's list,
-- translated to the modern column set rather than weakened.
--
-- WHAT LEGACY ENFORCED THAT IS *NOT* REPEATED HERE, AND WHY
-- =========================================================
-- * `commission/swap/profit_loss NOT NULL`: Modern stores commission and swap as
--   NOT NULL DEFAULT 0.00 already (0001), and `net_pnl` is nullable ON PURPOSE —
--   an OPEN trade has none. The CLOSED guard below is the stronger statement.
-- * `r_multiple` is deliberately NOT constrained to Legacy's 4-dp scale: ADR-001
--   §3 stores it at scale 8 ("storing at higher precision than display never
--   loses parity"), and the comparison rule for migrated values lives in
--   `packages/domain/src/legacyParity.ts` (MG-RMULTIPLE-SCALE).
--
-- IDEMPOTENT: DROP … IF EXISTS + ADD, per the migration idiom in 0015, so this
-- file is safe to re-run (the runner also records it in schema_migrations).
--
-- FORWARD-ONLY, and the ADD is the whole point: any EXISTING row that violates
-- one of these invariants makes the migration fail loudly. That is the intended
-- behaviour and the same choice Legacy made — a journal that cannot prove its
-- own numbers is not repaired by a schema that looks away. Every production
-- writer (TradeService, the MetaAPI sync importer, the Telegram journal) already
-- satisfies every guard below; the load gates in `db/data-step/load_gates.sql`
-- assert the same properties on migrated data before it is read by anyone.

ALTER TABLE trades
  DROP CONSTRAINT IF EXISTS trades_entry_price_positive,
  DROP CONSTRAINT IF EXISTS trades_exit_price_positive,
  DROP CONSTRAINT IF EXISTS trades_contract_size_positive,
  DROP CONSTRAINT IF EXISTS trades_stop_loss_positive,
  DROP CONSTRAINT IF EXISTS trades_take_profit_positive,
  DROP CONSTRAINT IF EXISTS trades_close_after_open,
  DROP CONSTRAINT IF EXISTS trades_closed_has_financials;

ALTER TABLE trades
  -- Prices and sizes are magnitudes. Zero is not a small price: it is an
  -- unfinished record (Legacy's own words: "never invent an exit price").
  ADD CONSTRAINT trades_entry_price_positive CHECK (entry_price > 0),
  ADD CONSTRAINT trades_exit_price_positive CHECK (exit_price IS NULL OR exit_price > 0),
  ADD CONSTRAINT trades_contract_size_positive CHECK (contract_size > 0),
  ADD CONSTRAINT trades_stop_loss_positive CHECK (stop_loss IS NULL OR stop_loss > 0),
  ADD CONSTRAINT trades_take_profit_positive CHECK (take_profit IS NULL OR take_profit > 0),
  -- A close instant before the open instant is not a rounding artifact; it means
  -- one of the two was interpreted in the wrong direction (ADR-004 exists for
  -- exactly this class of error). Only comparable when both are present.
  ADD CONSTRAINT trades_close_after_open CHECK (
    occurred_close_at_utc IS NULL OR occurred_close_at_utc >= occurred_at
  ),
  -- The one state Modern adds over Legacy: OPEN rows carry no exit yet. CLOSED
  -- rows carry the complete financial record — exit price, realized PnL, and the
  -- instant the exit happened — because every consumer (analytics, R-multiple,
  -- equity curve, Telegram journal) reads those three as facts.
  ADD CONSTRAINT trades_closed_has_financials CHECK (
    status <> 'CLOSED'
    OR (exit_price IS NOT NULL AND net_pnl IS NOT NULL AND occurred_close_at_utc IS NOT NULL)
  );

-- Partial exits are the same magnitudes as the trade they belong to (0001 already
-- enforces volume > 0). A price of zero on an exit is an unfinished record too.
ALTER TABLE trade_exits
  DROP CONSTRAINT IF EXISTS trade_exits_price_positive;

ALTER TABLE trade_exits
  ADD CONSTRAINT trade_exits_price_positive CHECK (price > 0);
