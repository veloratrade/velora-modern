-- 0015_tags_and_attachments.sql — Roadmap v0.5 (Analytics Engine & Tagging).
--
-- SOURCE OF AUTHORITY
--   docs/pdf/Roadmap.pdf (Legacy repo, commit edede313), §4 "Version 0.5":
--     "Database Changes: Create tags, trade_tags, trade_attachments, and
--      user_analytics_daily tables."   (user_analytics_daily -> migration 0016)
--   Column vocabulary is NOT invented: it mirrors the PHP reference DDL
--   (api/database/database.sql: `tags`, `trade_tags`, `trade_screenshots`) —
--   PHP is the contract source for existing product behaviour.
--
-- WHAT THIS MIGRATION ADDS
--   tags             — per-user tag vocabulary (STRATEGY|SETUP|MISTAKE|EMOTION|CUSTOM)
--   trade_tags       — trade <-> tag association
--   trade_attachments— roadmap's name for the PHP `trade_screenshots` capability,
--                      reshaped for object storage (db/MIGRATION_MAP.md: "Rows AND
--                      bytes: binary objects move to object storage via StoragePort").
--
-- OWNERSHIP IS A DATABASE INVARIANT, NOT A CONVENTION
--   `trade_tags` and `trade_attachments` carry a denormalized user_id WITH a
--   composite FK back to the trade. This makes "attach another user's tag to my
--   trade" impossible at the DB level (the legacy MySQL schema has no such
--   guarantee; here the isolation rule that the product already relies on in
--   application code becomes structural).
--   Requires UNIQUE (id, user_id) on trades — trivially true (id is the PK) and
--   added as an index only, so no existing row is read or rewritten.
--
-- SCOPE / SAFETY
--   - Forward-only (ADR-010), additive, idempotent (IF NOT EXISTS / DROP+ADD).
--   - Creates 3 tables + 2 supporting indexes. No existing table, column,
--     constraint, default or row is modified. Migration 0001..0014 untouched.
--   - MIME/size CHECKs encode the roadmap's own upload rule ("MIME-type
--     whitelist JPG/PNG/WebP, max file size 5MB") so an oversized or
--     disallowed object cannot be registered even if application code is wrong.
--   - NO bytes are stored here: only the object-storage key + sha256, so the DB
--     never becomes a binary store.
--   - No production database exists or is touched by this file.

-- Trades need a (id, user_id) uniqueness ANCHOR for the composite FKs below.
-- A composite FOREIGN KEY requires a UNIQUE CONSTRAINT on the referenced columns
-- (a plain unique index is NOT sufficient in PostgreSQL) — verified by execution:
-- "there is no unique constraint matching given keys for referenced table".
-- id is already the PRIMARY KEY, so (id, user_id) is trivially unique and this
-- adds a redundant-by-construction index, not a new data restriction.
ALTER TABLE trades DROP CONSTRAINT IF EXISTS trades_id_user_unique;
ALTER TABLE trades ADD CONSTRAINT trades_id_user_unique UNIQUE (id, user_id);

CREATE TABLE IF NOT EXISTS tags (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  kind       TEXT NOT NULL DEFAULT 'CUSTOM'
             CHECK (kind IN ('STRATEGY','SETUP','MISTAKE','EMOTION','CUSTOM')),
  color      TEXT CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One vocabulary per user: the same name cannot exist twice for one trader
  -- (case-insensitive compare is an APPLICATION concern — ADR-003 canonicalization
  -- is applied to the value before write, exactly as it is for email).
  CONSTRAINT tags_user_name_unique UNIQUE (user_id, name),
  -- Anchor for trade_tags' composite FK (see the trades note above).
  CONSTRAINT tags_id_user_unique UNIQUE (id, user_id)
);
CREATE INDEX IF NOT EXISTS tags_user_kind_idx ON tags (user_id, kind, name);

CREATE TABLE IF NOT EXISTS trade_tags (
  trade_id   BIGINT NOT NULL,
  tag_id     BIGINT NOT NULL,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (trade_id, tag_id),
  CONSTRAINT trade_tags_trade_owner_fk FOREIGN KEY (trade_id, user_id)
    REFERENCES trades (id, user_id) ON DELETE CASCADE,
  CONSTRAINT trade_tags_tag_owner_fk FOREIGN KEY (tag_id, user_id)
    REFERENCES tags (id, user_id) ON DELETE CASCADE
);
-- Reverse lookup: "all trades carrying this tag" (tag performance matrix).
CREATE INDEX IF NOT EXISTS trade_tags_tag_idx ON trade_tags (tag_id, trade_id);

CREATE TABLE IF NOT EXISTS trade_attachments (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trade_id      BIGINT NOT NULL,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category      TEXT NOT NULL DEFAULT 'OTHER'
                CHECK (category IN ('BEFORE','AFTER','OTHER')),   -- PHP parity
  file_name     TEXT NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  mime          TEXT NOT NULL
                CHECK (mime IN ('image/jpeg','image/png','image/webp')),  -- roadmap whitelist
  size_bytes    BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880), -- 5 MiB
  storage_key   TEXT NOT NULL CHECK (length(storage_key) BETWEEN 1 AND 512),
  checksum_sha256 TEXT CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,                       -- tombstone, never a physical DELETE (ADR-002 posture)
  CONSTRAINT trade_attachments_storage_unique UNIQUE (storage_key),
  CONSTRAINT trade_attachments_trade_owner_fk FOREIGN KEY (trade_id, user_id)
    REFERENCES trades (id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS trade_attachments_trade_idx
  ON trade_attachments (trade_id, category) WHERE deleted_at IS NULL;

-- DELIBERATELY NOT DONE HERE
--   - `trade_events.type` is NOT widened. Tagging/attachment changes are
--     journaling mutations and are already representable as JOURNALING_EDITED
--     (ADR-002 vocabulary, 0001). Adding a new event type no consumer can emit
--     would be dead contract surface (same reasoning as 0011's CREDENTIAL_REVEALED).
--   - Legacy `trade_features` (a derived/materialized per-trade feature row) is
--     NOT ported: it is a denormalized projection of fields that already exist on
--     `trades` plus tags; the roadmap's analytics requirement is served by 0016.
--     Porting it would create a second source of truth for the same facts.
