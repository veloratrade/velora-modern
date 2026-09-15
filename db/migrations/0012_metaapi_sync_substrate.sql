-- 0012_metaapi_sync_substrate.sql — D-6 (owner-authorized 2026-09-15).
--
-- The minimum DURABLE SUBSTRATE for MetaAPI historical/incremental sync.
-- No MetaAPI client, no worker deployment, no webhook, no provider call is
-- authorized by D-6 — this migration only makes the state such a worker will
-- need representable and SAFE.
--
-- Forward-only and additive (ADR-010). No column is renamed or dropped, no row
-- is transformed, and every new object is nullable or defaulted, so existing
-- data is preserved untouched.
--
-- WHAT ALREADY EXISTS AND IS THEREFORE *NOT* RE-CREATED HERE
--   - `trades.external_deal_id` + `trades_extdeal_unique (account_id,
--     external_deal_id)` — trade-level import idempotency (0001).
--   - `trade_events.event_uid` + `trade_events_uid_unique` — event-level
--     idempotency (0001).
--   - `trade_events.type` CHECK already contains `TRADE_IMPORTED`; the actor
--     CHECK already contains `sync`. ADR-002 Amendment A-1 needs NO migration.
--   - `trading_accounts.sync_status` + `external_account_id` (0001/0004).
--   - `trades.occurred_open_at_utc` / `source_timezone*` (0005).
-- Re-adding any of these would be redundant, so this migration does not.
--
-- OWNERSHIP: every new object carries BOTH `account_id` and `user_id` with FKs.
-- `user_id` is denormalized deliberately — it lets ownership be enforced and
-- indexed without a join, and matches the existing `trades` shape. Imported
-- rows therefore stay attributable to exactly one user and one account.
--
-- SECURITY (D-2 Boundary-Scoped Option B): nothing here stores or references a
-- broker credential, credential ciphertext, or any token. Sync is
-- credential-free; it authenticates with the platform token and the non-secret
-- provider account id. No column may ever hold a secret.

-- ---------------------------------------------------------------------------
-- 1. Per-account sync cursor / state  (D-6 item 1)
-- ---------------------------------------------------------------------------
-- Extends the existing table rather than adding a parallel one: an account has
-- exactly one sync state, so a separate table would only add a join and the
-- risk of an orphan row. Follows the 0004 precedent of extending
-- `trading_accounts` in place.
ALTER TABLE trading_accounts
  -- Durable high-water mark: the instant up to which this account is known to
  -- be synced. NULL = never synced (distinct from "synced and found nothing",
  -- which a zero timestamp would wrongly conflate).
  ADD COLUMN IF NOT EXISTS last_synced_at        TIMESTAMPTZ,
  -- Opaque provider-side resumption cursor, stored verbatim. Deliberately
  -- untyped TEXT: its format is the provider's, and parsing it would be an
  -- unverified provider-fact assumption (D-7 boundary).
  ADD COLUMN IF NOT EXISTS sync_cursor           TEXT,
  -- Fixed, non-secret failure CODE from the last sync attempt (never a message,
  -- never provider text — G-3 rule: codes are safe, free text is not).
  ADD COLUMN IF NOT EXISTS last_sync_error_code  TEXT
    CHECK (last_sync_error_code IS NULL OR last_sync_error_code ~ '^[A-Z0-9_]{1,48}$');

-- ---------------------------------------------------------------------------
-- 2. Operation reservation / concurrency control  (D-6 item 2)
-- ---------------------------------------------------------------------------
-- Prevents two overlapping sync operations on the SAME account. The invariant
-- is enforced by the DATABASE, not by application checks: a partial unique
-- index means a second concurrent INSERT fails with SQLSTATE 23505 even across
-- processes, which an application-level "check then insert" cannot guarantee.
CREATE TABLE IF NOT EXISTS sync_reservations (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id     BIGINT NOT NULL REFERENCES trading_accounts(id) ON DELETE CASCADE,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Which kind of sync holds the account. WEBHOOK is listed because the
  -- vocabulary is cheap to fix now; webhook IMPLEMENTATION remains unauthorized.
  operation      TEXT NOT NULL DEFAULT 'HISTORICAL'
    CHECK (operation IN ('HISTORICAL', 'INCREMENTAL', 'WEBHOOK')),
  -- Opaque holder identity (e.g. worker instance). Never a credential.
  holder         TEXT NOT NULL,
  -- Lease expiry drives STALE RECOVERY. Policy, stated explicitly:
  --   A reservation is RECLAIMABLE once `lease_expires_at < now()`.
  --   Reclaiming is an explicit UPDATE that sets `released_at` and
  --   `stale_reclaimed = true`; the row is NEVER deleted, so an abandoned
  --   operation stays visible as evidence instead of vanishing.
  lease_expires_at TIMESTAMPTZ NOT NULL,
  acquired_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL = currently held. Non-NULL = finished or reclaimed.
  released_at    TIMESTAMPTZ,
  stale_reclaimed BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT sync_reservations_lease_after_acquire
    CHECK (lease_expires_at > acquired_at),
  CONSTRAINT sync_reservations_release_order
    CHECK (released_at IS NULL OR released_at >= acquired_at)
);

-- THE load-bearing invariant: at most ONE unreleased reservation per account.
-- Partial (WHERE released_at IS NULL) so historical rows accumulate freely.
CREATE UNIQUE INDEX IF NOT EXISTS sync_reservations_one_active_per_account
  ON sync_reservations (account_id) WHERE released_at IS NULL;

-- Finding reclaimable leases without scanning released history.
CREATE INDEX IF NOT EXISTS sync_reservations_expiry_idx
  ON sync_reservations (lease_expires_at) WHERE released_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Fill / import ledger substrate  (D-6 item 3)
-- ---------------------------------------------------------------------------
-- One durable row per provider deal, so a replayed or duplicated provider
-- response cannot create a second domain record. Shape follows the VERIFIED
-- legacy `metaapi_fills` ledger (evidence, not invention) minus everything the
-- modern system does not yet need.
--
-- APPEND-ONLY, per the ADR-002 immutable-ledger principle: rows are inserted
-- and their processing outcome recorded; provider-reported facts are never
-- rewritten. UPDATE/DELETE are revoked from runtime roles in db/roles.sql.
CREATE TABLE IF NOT EXISTS sync_fills (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id         BIGINT NOT NULL REFERENCES trading_accounts(id) ON DELETE CASCADE,
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Provider deal identity. The idempotency anchor.
  external_deal_id   TEXT NOT NULL,
  -- Pairing key for open/close legs (provider-supplied, opaque).
  position_id        TEXT,
  entry_type         TEXT CHECK (entry_type IS NULL OR entry_type IN ('in', 'out')),
  direction          TEXT CHECK (direction IS NULL OR direction IN ('buy', 'sell')),
  symbol             TEXT,
  -- Provider-reported financials. NUMERIC per ADR-001 (never float for money).
  -- Stored as reported; interpretation/authority is D-4 and NOT decided here.
  volume             NUMERIC(20,8),
  price              NUMERIC(20,8),
  profit             NUMERIC(20,2),
  commission         NUMERIC(20,2),
  swap               NUMERIC(20,2),
  -- TIMESTAMPS — TZ-M1, deliberately conservative:
  --   `occurred_at_utc` is NULLABLE and set ONLY from an offset-explicit
  --   provider `time`, parsed deterministically to UTC.
  --   `raw_time_text` keeps that value verbatim as evidence.
  --   `time_status` records which happened; 'unresolved' is the honest default.
  -- NO naive `brokerTime` column is added here: TZ-M1 item 6 assigns its
  -- durable storage to D-5, which is NOT authorized by D-6. No IANA timezone is
  -- inferred anywhere, and nothing guesses an offset.
  occurred_at_utc    TIMESTAMPTZ,
  raw_time_text      TEXT,
  time_status        TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (time_status IN ('resolved_utc', 'unresolved')),
  -- Provenance of the row. 'webhook' is vocabulary only; not implemented.
  ingestion_source   TEXT NOT NULL DEFAULT 'historical'
    CHECK (ingestion_source IN ('historical', 'incremental', 'webhook')),
  -- Reconciliation outcome. 'received' → terminal state once processed.
  processing_state   TEXT NOT NULL DEFAULT 'received'
    CHECK (processing_state IN ('received', 'aggregated', 'skipped', 'rejected')),
  -- Set when this fill has been folded into a trade. No FK ON DELETE CASCADE:
  -- ledger evidence must outlive a tombstoned trade.
  processed_trade_id BIGINT REFERENCES trades(id) ON DELETE SET NULL,
  -- Fixed code, never provider text (G-3).
  skip_reason        TEXT
    CHECK (skip_reason IS NULL OR skip_reason ~ '^[A-Z0-9_]{1,48}$'),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- IDEMPOTENCY: the same provider deal can exist at most once per account.
  -- Enforced by the database, so a duplicate import raises 23505 rather than
  -- silently double-counting. Account-scoped, so two users' accounts may
  -- legitimately carry the same provider-side id.
  CONSTRAINT sync_fills_deal_unique UNIQUE (account_id, external_deal_id),
  CONSTRAINT sync_fills_time_consistency CHECK (
    (time_status = 'resolved_utc' AND occurred_at_utc IS NOT NULL)
    OR (time_status = 'unresolved' AND occurred_at_utc IS NULL)
  )
);

-- Position pairing (open/close legs) during reconciliation.
CREATE INDEX IF NOT EXISTS sync_fills_position_idx
  ON sync_fills (account_id, position_id, processing_state);
-- Ownership-scoped reads.
CREATE INDEX IF NOT EXISTS sync_fills_user_idx
  ON sync_fills (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Quarantine state  (D-6 item 4)
-- ---------------------------------------------------------------------------
-- The domain ALREADY models this: `TradeState.quarantined` exists and
-- `QUARANTINE_RAISED` sets it (packages/domain/src/tradeLedger.ts), and the
-- event type is already in the 0005 CHECK — but no column persisted it, so the
-- flag was lost on every write. This closes that gap and nothing more: no new
-- quarantine workflow, no review queue, no additional states are invented.
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS quarantined BOOLEAN NOT NULL DEFAULT false;

-- Quarantined trades are rare; a partial index keeps review lookups cheap
-- without burdening the common path.
CREATE INDEX IF NOT EXISTS trades_quarantined_idx
  ON trades (user_id, id) WHERE quarantined;
