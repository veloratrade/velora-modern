-- 0037_telegram_post_templates.sql — user-defined post templates and prepared channel posts.
--
-- WHAT THIS ADDS
--   telegram_post_templates  — a user's own named, versioned template body (the placeholder
--                              grammar lives in `packages/domain/src/telegramTemplates.ts`).
--   telegram_outbox_posts    — a prepared post: the exact text (and optional banner artwork +
--                              chart reference) that was previewed, the approval that covers THAT
--                              content, and the result of sending it to a registered channel.
--
-- WHY NEW TABLES AND NOT EXISTING ONES (each alternative was read, not assumed)
--   * `telegram_channel_posts` (0023) cannot hold a prepared post: its `trade_id` is NOT NULL with
--     `FOREIGN KEY (trade_id, user_id) REFERENCES trades`, so every row must mirror one trade. A
--     bias card or a checklist card has no trade, and relaxing that NOT NULL would turn the table's
--     whole purpose — "this trade was mirrored once" — into a nullable idea. The two tables are
--     therefore separate concerns, not a fork: trade mirroring stays where it is.
--   * `integration_settings` / `ai_settings` are per-feature blobs for server-owned configuration,
--     and `tags` is a shared vocabulary table; none can express "one row per user template with a
--     version that may not be silently rewritten". There is no generic user-settings table to reuse.
--   * `trade_attachments` (0015) cannot store the banner artwork: `trade_id` is NOT NULL (a draft
--     post may have no trade) and `mime` is whitelisted to jpeg/png/webp, which excludes the SVG
--     source this build composes. The chart's ORIGINAL bytes stay where they already belong — the
--     attachment row recorded when the photo was received — and this table keeps only the Telegram
--     `file_id`, which is a reference to the source artifact rather than a copy of it.
--
-- WHY THE SHAPE IS RESTRICTIVE
--   * UNIQUE (user_id, name) WHERE current — a name addresses exactly one live template. The
--     uniqueness is PARTIAL on purpose: versioning is append-only (below), so the constraint that
--     must hold is "one CURRENT row per name", not "one row per name".
--   * Append-only versioning: an update inserts `version + 1` and stamps `superseded_at` on the row
--     it replaces, so the row a user approved is still readable after the edit. `UNIQUE (user_id,
--     name, version)` makes a repeated bump impossible, and the partial unique index on
--     (user_id, name) WHERE superseded_at IS NULL makes "two current versions of one template"
--     unrepresentable. A lost update therefore surfaces as a constraint violation the caller can
--     report, instead of silently overwriting a trader's wording — the one thing a template editor
--     must never do.
--   * `body` is capped at 8000 characters, the domain's own TEMPLATE_BODY_LIMIT. A body that long
--     is refused at save time and explained, not truncated on its way in: a template whose text was
--     quietly cut is a template that no longer means what its author typed.
--   * `telegram_outbox_posts.dedupe_key` with UNIQUE (user_id, dedupe_key) is the duplicate-post
--     guard. Telegram retries, the confirm button gets double-tapped, and a re-delivered update must
--     not put the same card on a channel twice — the second INSERT is a no-op the caller can detect,
--     not a second publication.
--   * `content_hash` (sha256 over the final text) is what makes approval mean something:
--     `approved_hash` records the hash the user actually approved, and the CHECK
--     `approved_hash IS NULL OR approved_hash = content_hash` means an edit AFTER approval cannot
--     leave the row looking approved. Editing a preview does not inherit consent; it has to be
--     approved again. That constraint lives in the database precisely because a service-level
--     "we check before sending" is a check someone can forget.
--   * `published_at`/`telegram_message_id` coherence mirrors `telegram_channel_posts` (0023): a row
--     claims publication if and only if it can name the message. There is no state in which the
--     table says PUBLISHED and the user has nothing to point at.
--   * `channel_id` is not a bare reference: it is the composite FK `(channel_id, user_id) →
--     telegram_channels (id, user_id)`, the anchor 0023 established for `trade_attachments`, so a
--     post aimed at another user's binding is refused by the database rather than by a filter someone
--     may forget. It is ON DELETE RESTRICT, so unbinding a channel cannot strand a post without a
--     destination. `chat_id` is denormalised next to it because `telegram_channels` rows are
--     re-verified in place (0023's reopen-on-conflict): a post must remember the chat it was actually
--     addressed to, not whatever the binding looks like today. Its CHECK is `<> 0` and NOT `> 0`,
--     because a real channel id is negative — a positivity rule would reject every destination.
--
-- SECURITY POSTURE, AND WHAT THIS FILE DOES NOT DO
--   Nothing here authorises anything. Ownership is `user_id`, resolved by the caller from the linked
--   Telegram identity before any of these rows is touched; a template or a post body is UNTRUSTED
--   text (the domain layer escapes and bounds it at render time). `telegram_message_id`,
--   `chat_id` and `error_code` are metadata for the user's own history: no bot token, no
--   `Authorization` material, and no raw Telegram response body is stored anywhere in this schema —
--   `error_code` is a name from a closed set, not a server's message.
--   `audit_log` is deliberately NOT widened. Nothing that reaches these tables runs inside a
--   transaction with an AuditWrite handle: the journal bot has no audit sink at all (audit for
--   linking is written by the HTTP route in `telegramRoutes.ts`). Adding actions no code can emit
--   would be dead contract surface — the same reasoning 0015 used for `trade_events.type`.
--
-- FORWARD-ONLY AND ADDITIVE
--   No existing table is read, rewritten or relaxed; no existing constraint changes. Nothing in the
--   deployed database depends on these names, and no production database is touched by this file.

CREATE TABLE IF NOT EXISTS telegram_post_templates (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The name a user types to address this template. Case is preserved for display, and the
  -- UNIQUE below is on the raw value: two names differing only in case would be a UX trap, not a
  -- feature, but folding them here would also make `MyCard` and `mycard` unaddressable apart — so
  -- the domain layer matches case-insensitively and this index keeps exact names distinct.
  name          TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 64),
  body          TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  version       INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- NULL while the row is the current one; set when a later version superseded it. Never deleted:
  -- a trader asking "what did the post say yesterday?" is a question this column answers.
  superseded_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT telegram_post_templates_version_unique UNIQUE (user_id, name, version)
  -- Currency has ONE marker: `superseded_at`. There is no `is_current` column that could drift
  -- against it, and a table-level CHECK here would only restate the column's own `version > 0`.
);

-- One CURRENT row per (user, name) — the same partial-unique-index idiom `subscriptions` uses for
-- "at most one live row". Partial so the history rows can coexist; an extension-based EXCLUDE is
-- deliberately not used because no `btree_gist` is installed anywhere in this schema.
CREATE UNIQUE INDEX IF NOT EXISTS telegram_post_templates_current_unique
  ON telegram_post_templates (user_id, name) WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS telegram_post_templates_recent_idx
  ON telegram_post_templates (user_id, name, version DESC);

-- 0023's ownership-anchor idiom, one index: a composite FK to (id, user_id) makes "prepared a post
-- against somebody else's channel binding" unrepresentable in the data, rather than a WHERE clause
-- every reader has to remember. `id` is already the primary key, so this index is redundant by
-- content and additive by effect — no existing row changes.
CREATE UNIQUE INDEX IF NOT EXISTS telegram_channels_id_owner_unique
  ON telegram_channels (id, user_id);

CREATE TABLE IF NOT EXISTS telegram_outbox_posts (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id        BIGINT NOT NULL REFERENCES telegram_channels(id) ON DELETE RESTRICT,
  -- Which chat was addressed. Kept alongside channel_id because `telegram_channels` rows are
  -- re-verified in place (0023's reopen-on-conflict), and a post must remember the destination it
  -- actually went to, not whatever the binding looks like today.
  -- NOT `> 0`, unlike a Telegram *user* id: channel and supergroup ids are negative (the -100…
  -- range), so a positivity check would refuse every real destination this table can ever hold.
  -- 0023 leaves `telegram_channels.chat_id` unconstrained for the same reason; non-zero is the
  -- only claim worth making here, and it keeps an unset id from looking like a destination.
  chat_id           BIGINT NOT NULL CHECK (chat_id <> 0),
  body              TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4096),
  content_hash      TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  approved_hash     TEXT CHECK (approved_hash IS NULL OR approved_hash ~ '^[0-9a-f]{64}$'),
  approved_at       TIMESTAMPTZ,
  -- The artwork this post was composed with. TEXT, not a file: this build composes SVG and has no
  -- rasterizer in either runtime, so the honest record is the source document (bounded), and the
  -- preview the user approved is derived from the SAME string the post references.
  banner_svg        TEXT CHECK (banner_svg IS NULL OR length(banner_svg) BETWEEN 1 AND 65536),
  -- A Telegram file_id for the chart photo, i.e. a reference to the original capture on Telegram's
  -- own storage. Never a URL with a token in it, and never the bytes.
  image_file_id     TEXT CHECK (image_file_id IS NULL OR length(image_file_id) BETWEEN 1 AND 512),
  -- Provenance of the rendering, so a post can be explained later: built-in id or user template
  -- name, plus the version that produced it.
  template_key      TEXT CHECK (template_key IS NULL OR length(template_key) BETWEEN 1 AND 64),
  template_version  INTEGER CHECK (template_version IS NULL OR template_version > 0),
  -- `PUBLISHING` is the send-in-flight state and it exists for one reason: a double-tapped
  -- Publish button must be a CLAIM, not two sends. A row may be stuck here if the process dies
  -- mid-request; that is reported to the user as "this may already be posted", never auto-retried,
  -- because a duplicate on a public channel is worse than a post that needs one more tap.
  status            TEXT NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT', 'APPROVED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED')),
  dedupe_key        TEXT NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 128),
  telegram_message_id TEXT CHECK (telegram_message_id IS NULL OR length(telegram_message_id) BETWEEN 1 AND 128),
  published_at      TIMESTAMPTZ,
  -- A name from the caller's closed set (`TELEGRAM_NOT_CONFIGURED`, `CHANNEL_UNVERIFIED`,
  -- `SEND_FAILED`, …) — never a provider's free-text error, which is where tokens leak.
  error_code        TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  attempts          SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT telegram_outbox_posts_dedupe_unique UNIQUE (user_id, dedupe_key),
  -- The anchor above, used: the channel a post is destined for must be THIS user's binding.
  CONSTRAINT telegram_outbox_posts_channel_owner_fk
    FOREIGN KEY (channel_id, user_id) REFERENCES telegram_channels (id, user_id) ON DELETE RESTRICT,
  -- Approval cannot survive an edit: the hash that was approved must be the hash that is stored.
  CONSTRAINT telegram_outbox_posts_approval_matches_content
    CHECK (approved_hash IS NULL OR approved_hash = content_hash),
  -- `APPROVED` is the only state that may be published from, and it is defined by the pair.
  CONSTRAINT telegram_outbox_posts_approved_coherent
    CHECK ((approved_at IS NOT NULL) = (approved_hash IS NOT NULL)),
  -- Publication is earned by a message id, exactly like 0023's `status_coherent`.
  CONSTRAINT telegram_outbox_posts_published_coherent
    CHECK ((status = 'PUBLISHED') = (telegram_message_id IS NOT NULL AND published_at IS NOT NULL)),
  -- A failure is recorded as a failure, and never as a publication.
  CONSTRAINT telegram_outbox_posts_failed_has_code
    CHECK (status <> 'FAILED' OR error_code IS NOT NULL),
  -- An artwork claim without an approval trail is how a bot ends up posting something its owner
  -- never saw: a post that reached a channel must have had its final content approved.
  CONSTRAINT telegram_outbox_posts_publish_requires_approval
    CHECK (status NOT IN ('PUBLISHING', 'PUBLISHED', 'FAILED') OR (approved_at IS NOT NULL AND approved_hash = content_hash))
);

-- The user's own post history, newest first, and the reconciliation worklist for a send that died
-- between claim and finish.
CREATE INDEX IF NOT EXISTS telegram_outbox_posts_recent_idx
  ON telegram_outbox_posts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS telegram_outbox_posts_unfinished_idx
  ON telegram_outbox_posts (channel_id, created_at)
  WHERE status IN ('APPROVED', 'PUBLISHING', 'FAILED');
