-- 0010_user_credentials.sql — C-22: encrypted credential store.
--
-- PURPOSE
--   Storage infrastructure for third-party integration secrets (the future
--   C-27 MetaAPI chain). This migration creates ONE table. It implements no
--   provider client, no connection flow and no sync: those are later phases.
--
-- CIPHERTEXT ONLY — THE CENTRAL INVARIANT
--   `secret_ciphertext` holds the output of AES-256-GCM over the credential
--   payload. There is deliberately NO plaintext column, and no column derived
--   from the plaintext that could leak it: no prefix, no suffix, no length
--   hint, no searchable digest of the secret itself. A reader with full SELECT
--   on this table and no master key learns only WHICH provider a user has
--   configured and WHEN — never the secret.
--
--   The envelope is split across columns rather than stored as one opaque blob
--   so that the crypto parameters are inspectable and enforceable by the
--   database (NOT NULL, length CHECKs) without ever exposing key material:
--     enc_version  — envelope format version (currently 1)
--     key_version  — WHICH master key encrypted this row (rotation readiness)
--     algorithm    — pinned to 'aes-256-gcm'
--     iv           — 12-byte GCM nonce, UNIQUE PER ROW (see below)
--     auth_tag     — 16-byte GCM authentication tag (integrity)
--   iv and auth_tag are NOT secrets: GCM's security depends on the key and on
--   nonce uniqueness, not on hiding the nonce. Storing them is required to
--   decrypt, and is standard practice for an envelope format.
--
-- NONCE UNIQUENESS
--   A repeated (key, nonce) pair catastrophically breaks GCM. The application
--   generates a fresh 12-byte CSPRNG nonce per encryption. This migration adds
--   a defence-in-depth UNIQUE constraint on (key_version, iv) so that a
--   repeated nonce under the same key is rejected by the DATABASE rather than
--   silently accepted — a bug in the application cannot quietly weaken the
--   cryptography.
--
-- OWNERSHIP AND DELETION
--   user_id uses ON DELETE RESTRICT, matching the ownership-safe posture of
--   installation_ownership (0008) and audit_log (0009), NOT the ON DELETE
--   CASCADE used by trading_accounts (0001). Rationale: a credential is a
--   security object, and deleting a user must never silently destroy security
--   state as a side effect. There is no application user-delete path today, so
--   this adds no operational constraint.
--
--   Revocation is a HARD DELETE of the row, performed through an owner-scoped
--   application path. This is deliberate and is the safer option for secret
--   material: a soft-deleted row would keep recoverable ciphertext alive after
--   the user asked for it to be gone. This table is NOT an audit trail and is
--   deliberately not append-only — C-34's audit_log remains the immutable
--   history, and it never contains secrets.
--
-- ONE ACTIVE CREDENTIAL PER (USER, PROVIDER)
--   UNIQUE (user_id, provider) makes "replace my MetaAPI token" an explicit
--   delete-then-create, instead of silently accumulating duplicate secrets
--   whose precedence would be ambiguous for future integration routing.
--
-- SCOPE / SAFETY
--   - Forward-only (ADR-010), additive, idempotent (IF NOT EXISTS).
--   - Creates ONE new table. No existing table, column, constraint, default or
--     row is modified. Migrations 0001-0009 are untouched.
--   - No production database exists or is touched by this file.
--   - No secret, key or key material appears anywhere in this file.

CREATE TABLE IF NOT EXISTS user_credentials (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Owning user. Ownership is the ONLY authorization rule for secrets:
  -- administrative authority (including System Owner) does not grant access.
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Which third-party system this credential is for. CHECK-constrained so an
  -- unknown provider cannot be written without a deliberate migration.
  -- 'METAAPI' is listed because it is the known next consumer (C-27); no
  -- MetaAPI behaviour is implemented in this phase.
  provider         TEXT NOT NULL CHECK (provider IN ('METAAPI')),

  -- --- encrypted envelope -------------------------------------------------
  enc_version      SMALLINT NOT NULL DEFAULT 1 CHECK (enc_version = 1),
  key_version      SMALLINT NOT NULL CHECK (key_version >= 1),
  algorithm        TEXT     NOT NULL DEFAULT 'aes-256-gcm'
                     CHECK (algorithm = 'aes-256-gcm'),
  -- 12-byte GCM nonce and 16-byte tag, stored as bytea (never text/hex, so no
  -- accidental string concatenation into a log line).
  iv               BYTEA    NOT NULL CHECK (octet_length(iv) = 12),
  auth_tag         BYTEA    NOT NULL CHECK (octet_length(auth_tag) = 16),
  -- The encrypted credential payload. Never empty: an empty ciphertext would
  -- mean an empty secret was stored.
  secret_ciphertext BYTEA   NOT NULL CHECK (octet_length(secret_ciphertext) > 0),

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Exactly one credential per user per provider (see header).
  CONSTRAINT user_credentials_user_provider_unique UNIQUE (user_id, provider),
  -- Defence in depth: the same nonce must never be reused under one key.
  CONSTRAINT user_credentials_nonce_unique UNIQUE (key_version, iv)
);

-- Owner lookup: "all credentials belonging to this user", newest first.
CREATE INDEX IF NOT EXISTS user_credentials_user_idx
  ON user_credentials (user_id, created_at DESC);
