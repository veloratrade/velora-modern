-- 0022_legacy_contract_parity.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS MIGRATION EXISTS
--
-- The Phase 5 three-world gap analysis (staging 36 tables / production 31 /
-- this schema) found fields that carry REAL DATA in the Legacy MySQL databases
-- but have no destination column here. Two different problems were mixed
-- together in that list, and they are answered differently:
--
--   (a) FIELDS THAT ARE SCHEMA PARITY — the Legacy contract already has them and
--       the data must land somewhere lossless. They are added here, 1:1 with the
--       Legacy semantics, widened only where ADR-001 requires it. This does NOT
--       decide any product question: an unused column is inert, and a later
--       release can deprecate one without touching data.
--
--   (b) FIELDS THAT ARE A PRODUCT DECISION — e.g. "should `strategy_tag` become
--       a tag row instead of a column?" (roadmap v0.5 introduces tags/trade_tags
--       for exactly that). That decision stays OPEN; parity (a) only guarantees
--       nothing is lost while the decision is pending.
--
-- Gaps closed by this file: GAP-01, GAP-02, GAP-07, GAP-08, GAP-09, GAP-10,
-- GAP-11, GAP-13. Gaps that remain OPEN and why:
--   GAP-03/04/05/06  value-vocabulary collisions — closing them means choosing a
--                    mapping for real values that have not been censused yet
--                    (OD-15 and the owner-side censuses). A guessed CHECK would
--                    either break the import or silently rewrite history.
--   GAP-12           broker credential ciphertext is not re-encryptable here (OD-17).
--   GAP-15/16/17     data-quality gates and an application-layer default (ETL / later phase).
--   GAP-18/19/20     source-of-record, the 401 backup token, and the Legacy repo's
--                    own pending migrations (OD-10, OD-18) — all owner decisions.
--   GAP-21/22/23     evidence still to be collected (production rows, staging columns,
--                    the lot_size/volume equality question).
--
-- CONVENTIONS (identical to 0015..0021): forward-only, additive, idempotent by
-- execution, TIMESTAMPTZ only (ADR-004), money NUMERIC(20,2) / quantities
-- NUMERIC(20,8) (ADR-001), CHECK vocabularies only where the Legacy vocabulary
-- is VERIFIED — never guessed. No existing column is altered, nothing is dropped,
-- no row is read or rewritten.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═══ trades — Legacy journal + measurement columns (GAP-07 / GAP-08 / GAP-09) ═══
-- Legacy shapes: strategy_tag varchar(64), emotional_score tinyint unsigned,
-- confidence tinyint unsigned, mistake varchar(100), market_context varchar(300),
-- lot_size decimal(10,2). Bounds mirror the Legacy STORAGE type (unsigned byte),
-- NOT an assumed 1..10 rating scale — the scale is a product question (OD-14).
ALTER TABLE trades ADD COLUMN IF NOT EXISTS strategy_tag     TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS emotional_score  SMALLINT
  CHECK (emotional_score IS NULL OR emotional_score BETWEEN 0 AND 255);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS confidence       SMALLINT
  CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 255);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS mistake          TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS market_context   TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS lot_size         NUMERIC(20,8)
  CHECK (lot_size IS NULL OR lot_size >= 0);

-- ═══ trading_accounts — balance baseline + connection diagnostics (GAP-01 / GAP-10 / GAP-11) ═══
-- starting_balance is what the roadmap's equity-curve and portfolio endpoints must
-- divide by to express a return ("+12% on the account"), and both Legacy databases
-- already store it per account. Parity column, not a new concept.
ALTER TABLE trading_accounts ADD COLUMN IF NOT EXISTS starting_balance NUMERIC(20,2) NOT NULL DEFAULT 0.00
  CHECK (starting_balance >= 0);
ALTER TABLE trading_accounts ADD COLUMN IF NOT EXISTS account_type       TEXT NOT NULL DEFAULT 'STANDARD';
ALTER TABLE trading_accounts ADD COLUMN IF NOT EXISTS auto_sync_enabled  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE trading_accounts ADD COLUMN IF NOT EXISTS consecutive_errors INTEGER NOT NULL DEFAULT 0
  CHECK (consecutive_errors >= 0);
ALTER TABLE trading_accounts ADD COLUMN IF NOT EXISTS last_error          TEXT;
ALTER TABLE trading_accounts ADD COLUMN IF NOT EXISTS connected_at       TIMESTAMPTZ;
ALTER TABLE trading_accounts ADD COLUMN IF NOT EXISTS disconnected_at    TIMESTAMPTZ;
ALTER TABLE trading_accounts ADD COLUMN IF NOT EXISTS connection_checked_at TIMESTAMPTZ;
ALTER TABLE trading_accounts ADD COLUMN IF NOT EXISTS last_incremental_at   TIMESTAMPTZ;

-- ═══ users — name parts + locale provenance (GAP-13) ═══
-- Legacy stores first_name/last_name separately AND a pre-joined full_name. Both
-- are kept: `full_name` stays the display contract, the parts preserve the ability
-- to render or sort per locale instead of freezing one concatenation forever.
-- locale_source vocabulary is deliberately NOT constrained: Legacy is varchar(16)
-- with default 'default' and the real value set has not been censused (GAP-04 area).
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name  TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale_source TEXT NOT NULL DEFAULT 'default';
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale_updated_at TIMESTAMPTZ;

-- ═══ webhook_events — HMAC verification evidence (GAP-02) ═══
-- Roadmap v0.2 security line: "HMAC verification on incoming MetaApi webhook
-- payloads". The Legacy table records the OUTCOME (hmac_verified flag); the
-- signature MATERIAL itself is never stored (it is derivable from the payload and
-- the shared secret, and storing it would add a secret-bearing column).
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS signature_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS signature_algorithm TEXT;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS signature_verified_at TIMESTAMPTZ;
ALTER TABLE webhook_events DROP CONSTRAINT IF EXISTS webhook_events_signature_evidence;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_signature_evidence
  CHECK (signature_verified = false OR signature_verified_at IS NOT NULL);

-- ═══ indexes ═══
-- Journal analytics ask "how do this trader's setups perform" — strategy_tag is the
-- Legacy equivalent of the roadmap's tag filter, so it gets the same treatment the
-- symbol filter got in 0016. Partial: rows without a tag are not indexed.
CREATE INDEX IF NOT EXISTS trades_user_strategy_tag_idx
  ON trades (user_id, strategy_tag) WHERE strategy_tag IS NOT NULL AND deleted_at IS NULL;

-- A failed sync streak is the trigger for backoff/reconnect; partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS trading_accounts_sync_errors_idx
  ON trading_accounts (user_id) WHERE consecutive_errors > 0;
