-- 0019_ea_ingestion_and_push.sql — Roadmap v2.0 (Native EAs & Mobile Apps).
--
-- SOURCE OF AUTHORITY (docs/pdf/Roadmap.pdf, §4 "Version 2.0")
--   "Database Changes: Add ea_api_key_hash to trading_accounts. Create
--    device_tokens table for mobile push notifications."
--   "Security Changes: EA Authentication via single-use rotated API secret keys;
--    HMAC signature validation on EA transmission headers."
--
-- THE ROADMAP ITSELF ALREADY NAMES THE COLUMN `ea_api_key_hash`
--   So only a HASH may be stored — there is deliberately no plaintext key column,
--   no prefix/suffix of the key, and no column from which the key can be derived.
--   A reader with full SELECT on this table learns WHICH account has an EA
--   configured and WHEN it was rotated — never the key. (Same central invariant as
--   migration 0010's credential envelope.)
--   SHA-256 hex is pinned by CHECK: the key is a random 256-bit secret, so a
--   plain digest is the correct verifier and no salt/KDF parameters are needed.
--
-- device_tokens — WHY AN ENVELOPE AND NOT THE TOKEN VERBATIM
--   A push registration token is a BEARER CAPABILITY: whoever holds it can send
--   notifications to that device. It is not a user password, but it is not public
--   either. The installation already has a reviewed envelope format (0010:
--   AES-256-GCM + key_version + 12-byte IV + 16-byte tag, with a UNIQUE
--   (key_version, iv) nonce guard). This migration REUSES that exact envelope
--   rather than inventing a second one or storing the token in the clear.
--   A non-secret `token_fingerprint` (sha256) carries uniqueness/dedupe, so the
--   database can still answer "is this device already registered?" without
--   decrypting anything.
--
-- SCOPE / SAFETY
--   - Forward-only (ADR-010), additive, idempotent.
--   - Adds 5 nullable columns + 2 indexes to trading_accounts; creates 1 table.
--     Every MANUAL account has NULL EA fields, so no existing row changes meaning.
--   - No secret, key or key material appears anywhere in this file.
--   - No production database exists or is touched by this file.

-- ---------------------------------------------------------------------------
-- 1. EA credentials on trading_accounts
-- ---------------------------------------------------------------------------
ALTER TABLE trading_accounts
  ADD COLUMN IF NOT EXISTS ea_api_key_hash TEXT
    CHECK (ea_api_key_hash IS NULL OR ea_api_key_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS ea_key_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ea_key_rotated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ea_key_revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ea_last_seen_at   TIMESTAMPTZ;

-- A key hash identifies exactly one account: two accounts sharing a key would
-- make every EA-submitted deal ambiguous about which ledger it belongs to.
CREATE UNIQUE INDEX IF NOT EXISTS trading_accounts_ea_key_unique
  ON trading_accounts (ea_api_key_hash) WHERE ea_api_key_hash IS NOT NULL;

-- Revocation must be immediate; the ingestion path looks accounts up by hash.
CREATE INDEX IF NOT EXISTS trading_accounts_ea_active_idx
  ON trading_accounts (ea_api_key_hash)
  WHERE ea_api_key_hash IS NOT NULL AND ea_key_revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Mobile push device tokens
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_tokens (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform     TEXT NOT NULL CHECK (platform IN ('ios','android','web')),
  -- Non-secret dedupe key (one row per physical installation token).
  token_fingerprint TEXT NOT NULL CHECK (token_fingerprint ~ '^[0-9a-f]{64}$'),
  -- Encrypted envelope (same shape as migration 0010 user_credentials).
  enc_version  SMALLINT NOT NULL DEFAULT 1 CHECK (enc_version = 1),
  key_version  SMALLINT NOT NULL CHECK (key_version >= 1),
  algorithm    TEXT NOT NULL DEFAULT 'aes-256-gcm' CHECK (algorithm = 'aes-256-gcm'),
  iv           BYTEA NOT NULL CHECK (octet_length(iv) = 12),
  auth_tag     BYTEA NOT NULL CHECK (octet_length(auth_tag) = 16),
  token_ciphertext BYTEA NOT NULL CHECK (octet_length(token_ciphertext) > 0),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  CONSTRAINT device_tokens_fingerprint_unique UNIQUE (token_fingerprint),
  CONSTRAINT device_tokens_nonce_unique UNIQUE (key_version, iv)
);
CREATE INDEX IF NOT EXISTS device_tokens_user_live_idx
  ON device_tokens (user_id) WHERE revoked_at IS NULL;
