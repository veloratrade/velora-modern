-- D1 (SQLite) schema for PRIVATE TEST MODE. Deliberately NOT the PostgreSQL schema.
--
-- Why a separate file instead of db/migrations: those 35 migrations use jsonb, `::` casts,
-- identity columns, triggers and CHECK vocabulary that SQLite does not have (measured on the
-- D1 engine: functions outside its allow-list are refused outright, e.g. `sqlite_version()` →
-- code 7500), and applying them here would mean "migrating" a database that is not the product
-- database — which the owner's rules forbid in both directions.
--
-- Scope, and nothing beyond it: record a delivered update, decide whether it is a redelivery,
-- mark its outcome, and read the test message back. No trades, no journal drafts, no audit
-- trail, no AI ledger — those tables do not exist here on purpose, so a mistake in code cannot
-- write trade data into D1 and cannot pretend D1 is Velora's ledger.
--
-- Applied by the operator, never by the Worker:
--   wrangler d1 migrations apply velora-telegram-test --remote
CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER NOT NULL PRIMARY KEY,
  sender_id INTEGER NOT NULL,
  chat_id INTEGER,
  update_kind TEXT NOT NULL,
  text_excerpt TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  outcome TEXT NOT NULL DEFAULT 'claimed' CHECK (outcome IN ('claimed', 'handled', 'failed')),
  error_code TEXT
) STRICT;

-- Retrieval is always "the last few things this sender sent", so cover exactly that.
CREATE INDEX IF NOT EXISTS telegram_updates_sender_recent
  ON telegram_updates (sender_id, update_id DESC);
