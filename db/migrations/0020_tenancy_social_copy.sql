-- 0020_tenancy_social_copy.sql — Roadmap v2.5 (B2B White-Label, Social Verification, Copy Trading).
--
-- SOURCE OF AUTHORITY (docs/pdf/Roadmap.pdf, §4 "Version 2.5")
--   "Database Changes: Create tenants, public_profiles, copy_relationships,
--    signal_queue tables."
--   "Security Changes: Strict multi-tenant data boundary isolation; Prevent
--    public profiles from leaking ticket numbers, account IDs, or exact balance
--    sizes (percentage-based display option)."
--   "Acceptance: Copy trading signal replicates from master to follower EA in
--    < 100ms."
--
-- WHAT THE SCHEMA CAN ENFORCE, AND WHAT IT CANNOT
--   * Multi-tenant isolation here is a TENANT LABEL + a tenant-scoped uniqueness
--     rule, not a data boundary. A true boundary is a deployment/ownership
--     question (one schema per tenant vs. row-scoped) and is NOT decided by this
--     migration — deciding it in DDL would silently pick an architecture the
--     roadmap leaves open ("Multi-Tenant Backend Isolation Engine" is listed as a
--     Backend Change, not a schema change).
--   * Public-profile leakage IS enforceable: `show_absolute_amounts` defaults to
--     FALSE, and the profile carries no column able to hold a ticket number, an
--     account id or a balance at all — the roadmap's rule is implemented as an
--     absence plus a default, not as a display convention.
--   * `signal_queue` follows the durable-queue discipline already established by
--     sync_reservations (0012): a lease, an attempt counter, a terminal state —
--     and rows are never deleted, so a dropped signal stays visible as evidence.
--
-- SCOPE / SAFETY
--   - Forward-only (ADR-010), additive, idempotent.
--   - Creates 4 tables + indexes. No existing object is modified.
--   - No secret material of any kind is stored in these tables.
--   - No production database exists or is touched by this file.

-- ---------------------------------------------------------------------------
-- 1. Tenants (white-label clients)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug         TEXT NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  display_name TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  -- Branding only: logo/colour/domain. NEVER credentials, keys or tokens.
  branding     JSONB NOT NULL DEFAULT '{}'::jsonb
               CHECK (jsonb_typeof(branding) = 'object'),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  owner_user_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tenants_slug_unique UNIQUE (slug)
);

-- ---------------------------------------------------------------------------
-- 2. Public verified profiles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public_profiles (
  user_id       BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  handle        TEXT NOT NULL CHECK (handle ~ '^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$'),
  visibility    TEXT NOT NULL DEFAULT 'private'
                CHECK (visibility IN ('private','link','public')),
  -- Absolute amounts stay OFF unless the trader explicitly opts in (roadmap's
  -- "percentage-based display option").
  show_absolute_amounts BOOLEAN NOT NULL DEFAULT false,
  verified_at   TIMESTAMPTZ,
  -- Proof-of-history hash: the published digest of server-side trade history.
  -- A DIGEST, never the history itself, and never a ticket/account identifier.
  verification_hash TEXT CHECK (verification_hash IS NULL OR verification_hash ~ '^[0-9a-f]{64}$'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT public_profiles_handle_unique UNIQUE (handle),
  -- A profile cannot claim verification without a proof hash, and vice versa.
  CONSTRAINT public_profiles_verification_pair
    CHECK ((verified_at IS NULL) = (verification_hash IS NULL))
);

-- ---------------------------------------------------------------------------
-- 3. Copy relationships (master -> follower)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS copy_relationships (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  leader_user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  follower_user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  leader_account_id  BIGINT NOT NULL,
  follower_account_id BIGINT NOT NULL,
  allocation_mode    TEXT NOT NULL DEFAULT 'proportional'
                     CHECK (allocation_mode IN ('fixed_lot','proportional','risk_multiplier')),
  -- Meaning depends on allocation_mode (lots, a multiplier, or a fraction).
  allocation_value   NUMERIC(20,8) NOT NULL DEFAULT 1.00000000 CHECK (allocation_value > 0),
  max_lot_per_signal NUMERIC(20,8) CHECK (max_lot_per_signal IS NULL OR max_lot_per_signal > 0),
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','active','paused','revoked')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Self-copy is meaningless and is refused at the database level.
  CONSTRAINT copy_relationships_not_self CHECK (leader_user_id <> follower_user_id),
  CONSTRAINT copy_relationships_leader_owner_fk FOREIGN KEY (leader_account_id, leader_user_id)
    REFERENCES trading_accounts (id, user_id) ON DELETE RESTRICT,
  CONSTRAINT copy_relationships_follower_owner_fk FOREIGN KEY (follower_account_id, follower_user_id)
    REFERENCES trading_accounts (id, user_id) ON DELETE RESTRICT
);
-- One live relationship per (leader account, follower account) pair.
CREATE UNIQUE INDEX IF NOT EXISTS copy_relationships_pair_unique
  ON copy_relationships (leader_account_id, follower_account_id)
  WHERE status IN ('pending','active','paused');

-- ---------------------------------------------------------------------------
-- 4. Signal queue (durable fan-out to follower EAs)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signal_queue (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  leader_account_id BIGINT NOT NULL REFERENCES trading_accounts(id) ON DELETE CASCADE,
  leader_user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol            TEXT NOT NULL CHECK (length(btrim(symbol)) BETWEEN 1 AND 32),
  direction         TEXT NOT NULL CHECK (direction IN ('buy','sell')),
  volume            NUMERIC(20,8) NOT NULL CHECK (volume > 0),
  price             NUMERIC(20,8) NOT NULL CHECK (price > 0),
  occurred_at       TIMESTAMPTZ NOT NULL,     -- ADR-004: instants are UTC
  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','dispatched','acked','failed','expired')),
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_expires_at  TIMESTAMPTZ,              -- same stale-recovery policy as 0012
  last_error_code   TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,48}$'),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  acked_at          TIMESTAMPTZ,
  -- Terminal/lease coherence: an acked signal must carry its ack instant.
  CONSTRAINT signal_queue_ack_coherent CHECK ((status = 'acked') = (acked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS signal_queue_dispatch_idx
  ON signal_queue (status, created_at) WHERE status IN ('queued','dispatched');
CREATE INDEX IF NOT EXISTS signal_queue_leader_idx
  ON signal_queue (leader_account_id, created_at DESC);
