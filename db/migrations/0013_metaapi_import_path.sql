-- 0013_metaapi_import_path.sql — first MetaAPI historical-sync implementation.
--
-- Owner-authorized (this change): (1) a dedicated `metaapi_account_id` on
-- `trading_accounts`; (2) the `broker_time_text` evidence column required by
-- D-5. Nothing else. Forward-only and ADDITIVE (ADR-010): no column is renamed,
-- dropped or re-typed, no row is transformed, every new object is nullable, so
-- existing data is preserved byte-for-byte.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   - It does NOT widen `trades.source`: the 0005 CHECK already permits
--     ('manual','metaapi','import'), so the import path needs no constraint
--     change. Re-stating it would be redundant DDL.
--   - It does NOT touch `trade_events.type`/`actor` CHECKs: 0001 already
--     permits TRADE_IMPORTED and actor 'sync' (ADR-002 A-1 needs no migration).
--   - It does NOT add a second PnL column. D-4 is explicit: provider profit
--     populates the existing canonical `trades.net_pnl`. No `provider_profit`,
--     no `calculated_profit`, no `broker_profit`.
--   - It does NOT create the pgboss schema. Queue bootstrap is an owner/
--     bootstrap-path concern (db/provision.ts), never a migration run by the
--     migrator identity, and never the worker.

-- ---------------------------------------------------------------------------
-- 1. MetaAPI provider account identifier  (owner decision, this change)
-- ---------------------------------------------------------------------------
-- WHY A DEDICATED COLUMN, NOT `external_account_id`.
-- `external_account_id` already exists (0001) and carries a DIFFERENT meaning:
-- it participates in `trading_accounts_unique (user_id, external_account_id)`
-- and is the user-facing external account reference. The MetaAPI provisioning
-- identifier is a distinct provider-side identity with a distinct lifecycle (it
-- is issued by MetaAPI when an account is provisioned, and is absent for every
-- MANUAL account). Overloading one column with two identities would make
-- "which identity is this?" unanswerable from the schema — the owner decision
-- is therefore a separate column, and `external_account_id` keeps its exact
-- current semantics, unchanged and un-renamed.
--
-- NON-SECRET BY CONSTRUCTION. This is an opaque provider identifier, not a
-- credential: it authenticates nothing on its own. Under D-2 (Boundary-Scoped
-- Option B) it is precisely the value the credential-free worker is allowed to
-- consume, alongside the installation-level METAAPI_PLATFORM_TOKEN. A broker
-- login, investor password or credential ciphertext MUST NEVER be stored here.
--
-- NULLABLE. Most accounts are MANUAL and have no MetaAPI identity at all. NULL
-- means "this account is not MetaAPI-provisioned" — the scheduled producer
-- therefore SKIPS such accounts rather than guessing an identifier.
ALTER TABLE trading_accounts
  ADD COLUMN IF NOT EXISTS metaapi_account_id TEXT
    -- Shape guard only (charset/length), never a uniqueness or identity claim.
    -- Mirrors the VERIFIED legacy column width (varchar(64)) and the
    -- conservative identifier charset already used by `sync_fills.skip_reason`
    -- style guards. Rejects whitespace/control characters, so a malformed value
    -- cannot silently become part of a provider URL path.
    CHECK (metaapi_account_id IS NULL OR metaapi_account_id ~ '^[A-Za-z0-9._:-]{1,64}$');

-- UNIQUENESS — justified by the provider lifecycle, not added reflexively.
-- One MetaAPI account maps to exactly one Velora trading account: MetaAPI
-- issues one provisioned account per (broker account, platform) pair, and the
-- legacy system verified the same invariant (v0.2 bridge migration explicitly
-- checks for duplicate `metaapi_account_id` values before applying). Allowing
-- two Velora accounts to claim one provider account would let the same provider
-- deals be imported into two ledgers — double-counting the user's PnL.
--
-- GLOBAL (not per-user) and PARTIAL (NULLs excluded, so the many MANUAL
-- accounts are unaffected). Global because a provider account id is issued in
-- MetaAPI's own namespace: the same id appearing under two different users is
-- a cross-user ownership violation, which is exactly what must be impossible.
CREATE UNIQUE INDEX IF NOT EXISTS trading_accounts_metaapi_unique
  ON trading_accounts (metaapi_account_id) WHERE metaapi_account_id IS NOT NULL;

-- Producer lookup: "accounts eligible for scheduled sync", oldest-synced first.
-- Partial, so the index spans only MetaAPI-provisioned accounts.
CREATE INDEX IF NOT EXISTS trading_accounts_sync_due_idx
  ON trading_accounts (last_synced_at NULLS FIRST)
  WHERE metaapi_account_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Naive `brokerTime` evidence  (D-5, ratified 2026-09-15 in commit 9504d4f)
-- ---------------------------------------------------------------------------
-- D-5 term 7, verbatim: `raw_time_text` keeps its existing meaning — the
-- verbatim copy of the ABSOLUTE, offset-explicit `time` — and a DEDICATED
-- `broker_time_text` carries the naive `brokerTime`. The provider returns both
-- as two distinct fields of the same deal, so one column cannot hold both, and
-- `raw_time_text` is NOT overloaded, redefined or altered here.
--
-- EVIDENCE, NEVER AN INSTANT. This value is stored verbatim and is never
-- parsed, never converted, and never permitted to influence any UTC value. No
-- timezone is assigned and no IANA zone is inferred from it — not from the
-- broker country, the server location, the account location, the host
-- timezone, or any other heuristic (D-5 term 3, exhaustive and binding).
--
-- NO CONSTRAINT REFERENCES IT, DELIBERATELY. The existing
-- `sync_fills_time_consistency` CHECK ties `time_status` to `occurred_at_utc`
-- only. Adding `broker_time_text` to that CHECK would couple EVIDENCE to
-- RESOLUTION and imply that a naive broker time carries instant information —
-- the precise inference D-5 forbids. A fill may therefore legitimately have
-- broker_time_text NOT NULL while occurred_at_utc IS NULL and
-- time_status='unresolved'.
ALTER TABLE sync_fills
  ADD COLUMN IF NOT EXISTS broker_time_text TEXT;
