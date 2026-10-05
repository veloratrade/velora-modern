-- 0023_telegram_journal.sql — Telegram journal client (ADR-018).
--
-- WHAT THIS ADDS, AND WHY EACH OBJECT EXISTS
--   telegram_identities    — an EXPLICIT link between one Telegram user id and one
--                            Velora user. Telegram is an external identity
--                            provider, NOT the account system: there is no
--                            password here, no email, no session. The stable
--                            numeric telegram_user_id is the identity; @username
--                            is display-only metadata and is never used to resolve
--                            a user.
--   telegram_link_tokens   — the one-time linking transaction. Short-lived,
--                            single-use, stored as SHA-256 (the same convention
--                            as user_sessions.refresh_token_hash and
--                            email_verifications.token_hash). The raw token is
--                            NEVER stored or logged.
--   telegram_updates       — the Telegram update-id dedupe claim (retry safety).
--                            The MECHANISM of ADR-008 is reused (a UNIQUE dedupe
--                            key + a durable record before any effect); the
--                            `webhook_events` TABLE is deliberately NOT reused,
--                            because its contract is "immutable raw payload"
--                            (0001). A Telegram update carries private message
--                            text, file references and identifiers, and archiving
--                            it would create a second uncontrolled copy of user
--                            content — the same reasoning 0017 uses to refuse
--                            raw prompts/responses. Only delivery METADATA is
--                            stored here; body content is never persisted in this
--                            table.
--   telegram_journal_drafts— the "confirm before you write" staging area for a
--                            journal entry that came from a text/voice/photo
--                            message. A draft is NOT a trade: it becomes an
--                            ADR-002 `trades` row + `trade_events` only after the
--                            user confirms, through the normal TradeService path.
--   telegram_channels      — an optional Telegram channel/group used as a journal
--                            mirror, with the bot's verified permissions.
--   telegram_channel_posts — publish idempotency for that mirror.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   * No second journal table. The journal capability is reconciled ON the
--     ADR-002 trades ledger (docs/reconciliation/PHASE-C-INC4-JOURNAL-INVENTORY.md);
--     creating `journal_entries` here would create a second source of truth for
--     one fact.
--   * No second audit trail. `audit_log` (0009) is widened instead — 0009's
--     header explicitly forbids a parallel security log.
--   * No raw media column. Screenshots reuse `trade_attachments` (0015: MIME
--     whitelist, ≤5 MiB, storage_key + sha256, bytes NEVER in the database).
--     Voice audio is not retained at all (0021's posture: no raw-audio column);
--     only a transcript the user confirmed becomes journal content.
--   * No credential, no session token, no password material anywhere.
--
-- SCOPE / SAFETY
--   - Forward-only (ADR-010), additive, idempotent (IF NOT EXISTS / DROP+ADD).
--   - Creates 6 tables + indexes; widens 2 audit_log CHECK vocabularies; adds 1
--     column + 1 CHECK to ai_coaching_logs. No row is read, rewritten or deleted.
--   - Existing rows stay valid by construction: the audit widening is a superset
--     of the previous vocabulary, and `ai_coaching_logs.feature` defaults to
--     'coach' (the only value any existing row can mean).
--   - No new append-only table is introduced, so section 4 of db/roles.sql needs
--     no additional REVOKE (see its §5 warning, which applies to append-only
--     tables only).
--   - No production database exists or is touched by this file.

-- ---------------------------------------------------------------------------
-- 1. Telegram identities (explicit account link)
-- ---------------------------------------------------------------------------
-- LINK EPISODES, NOT A MUTABLE "current link" ROW.
--   A revoked link is history: it is never rewritten and never physically
--   deleted, so revocation survives and the trail can always be reconstructed
--   from the table as well as from audit_log. Re-linking therefore inserts a NEW
--   row rather than flipping an old one back to LINKED, which also means
--   `linked_at` always means exactly what it says.
--   The two PARTIAL unique indexes are the actual security invariant:
--     * one LIVE link per Telegram identity  → a second Velora account cannot
--       capture an identity that is already connected;
--     * one LIVE link per Velora user        → an account cannot accumulate
--       several unintended Telegram identities.
--   Revoked rows are exempt from both, so the constrain-then-release lifecycle
--   (link → unlink → re-link) works without any row ever being mutated back.
CREATE TABLE IF NOT EXISTS telegram_identities (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Telegram's stable numeric identity. NEVER a username, display name or bio:
  -- those are user-mutable and would be an account-takeover vector.
  telegram_user_id BIGINT NOT NULL CHECK (telegram_user_id > 0),
  -- DISPLAY ONLY. Optional (a Telegram user may have none). Mirrors Telegram's
  -- own rule for the field; it is never read to resolve an account.
  username         TEXT CHECK (username IS NULL OR username ~ '^[A-Za-z0-9_]{4,32}$'),
  status           TEXT NOT NULL DEFAULT 'LINKED' CHECK (status IN ('LINKED', 'REVOKED')),
  linked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at       TIMESTAMPTZ,
  -- Observability only (last inbound activity). Not a session, not a credential.
  last_seen_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Lifecycle coherence is a database invariant, not a convention.
  CONSTRAINT telegram_identities_lifecycle
    CHECK ((status = 'LINKED') = (revoked_at IS NULL))
);
-- One LIVE identity per Telegram user id (the collision invariant).
CREATE UNIQUE INDEX IF NOT EXISTS telegram_identities_live_tg_unique
  ON telegram_identities (telegram_user_id) WHERE status = 'LINKED';
-- One LIVE Telegram identity per Velora user.
CREATE UNIQUE INDEX IF NOT EXISTS telegram_identities_live_user_unique
  ON telegram_identities (user_id) WHERE status = 'LINKED';
CREATE INDEX IF NOT EXISTS telegram_identities_user_idx
  ON telegram_identities (user_id, linked_at DESC);

-- ---------------------------------------------------------------------------
-- 2. One-time linking transactions
-- ---------------------------------------------------------------------------
-- ATOMICITY IS THE WHOLE POINT.
--   Consumption is a single conditional statement
--     UPDATE ... SET status='CONSUMED' WHERE token_hash=$1 AND status='PENDING'
--       AND expires_at > now() RETURNING ...
--   so two simultaneous deliveries of the same deep link cannot both win: the
--   row lock serialises them and the loser matches zero rows. A
--   SELECT-then-UPDATE design would have a window between the two statements.
--   The token is opaque (32 random bytes, base64url) and only its sha256 is
--   stored, so a database reader cannot replay it.
CREATE TABLE IF NOT EXISTS telegram_link_tokens (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- A token that could be silently repurposed is a token that could be
  -- mis-consumed. The purpose is pinned (single-valued by design).
  purpose        TEXT NOT NULL DEFAULT 'TELEGRAM_LINK' CHECK (purpose IN ('TELEGRAM_LINK')),
  token_hash     TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status         TEXT NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING', 'CONSUMED', 'EXPIRED', 'REVOKED')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  -- Attribution of the consumption: which Telegram identity presented it. Null
  -- until consumed. Non-secret, and it is what makes "who linked when"
  -- answerable without reading request logs.
  consumed_by_telegram_user_id BIGINT CHECK (consumed_by_telegram_user_id IS NULL OR consumed_by_telegram_user_id > 0),
  consumed_identity_id         BIGINT REFERENCES telegram_identities(id) ON DELETE SET NULL,
  CONSTRAINT telegram_link_tokens_hash_unique UNIQUE (token_hash),
  CONSTRAINT telegram_link_tokens_expiry_sane CHECK (expires_at > created_at),
  -- Terminal-state coherence: a consumed row must carry consumed_at, a revoked
  -- row must carry revoked_at, and a pending row must carry neither.
  CONSTRAINT telegram_link_tokens_state_coherent CHECK (
    (status = 'PENDING'  AND consumed_at IS NULL AND revoked_at IS NULL) OR
    (status = 'CONSUMED' AND consumed_at IS NOT NULL AND revoked_at IS NULL) OR
    (status = 'REVOKED'  AND revoked_at IS NOT NULL AND consumed_at IS NULL) OR
    (status = 'EXPIRED'  AND consumed_at IS NULL)
  )
);
-- At most ONE pending transaction per user. Starting a new linking flow
-- supersedes the previous one (the service revokes it in the same transaction),
-- so a stale deep link can never win a race against a fresh one.
CREATE UNIQUE INDEX IF NOT EXISTS telegram_link_tokens_one_pending_per_user
  ON telegram_link_tokens (user_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS telegram_link_tokens_user_idx
  ON telegram_link_tokens (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Update-idempotency claims
-- ---------------------------------------------------------------------------
-- Telegram re-delivers an update (same `update_id`) whenever a webhook does not
-- answer successfully. The PRIMARY KEY is the claim: INSERT ... ON CONFLICT DO
-- NOTHING RETURNING tells the caller whether THIS delivery owns the update, so a
-- retried /start or a retried journal confirmation cannot create a second effect.
-- NO message content is stored (see the file header).
CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id        BIGINT PRIMARY KEY,
  telegram_user_id BIGINT CHECK (telegram_user_id IS NULL OR telegram_user_id > 0),
  chat_id          BIGINT,
  update_kind      TEXT NOT NULL
                   CHECK (update_kind IN ('message', 'callback_query', 'edited_message', 'other')),
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ,
  outcome          TEXT CHECK (outcome IS NULL OR outcome IN ('handled', 'ignored', 'rejected', 'failed')),
  -- Non-secret classification only (fixed vocabulary written by the caller).
  error_code       TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,48}$')
);
-- Operational visibility: "is anything stuck unprocessed?"
CREATE INDEX IF NOT EXISTS telegram_updates_unprocessed_idx
  ON telegram_updates (received_at) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Journal drafts awaiting confirmation
-- ---------------------------------------------------------------------------
-- A DRAFT IS NOT A TRADE. It holds CANDIDATE fields extracted from a message,
-- with unknown values explicitly absent (never invented). Only confirmation
-- turns it into a ledger record — through TradeService, so every ADR-002
-- invariant applies unchanged.
CREATE TABLE IF NOT EXISTS telegram_journal_drafts (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  telegram_user_id  BIGINT NOT NULL CHECK (telegram_user_id > 0),
  chat_id           BIGINT NOT NULL,
  -- The Telegram message this draft came from: the second half of the dedupe
  -- key, so re-processing one message can never open two drafts.
  source_message_id BIGINT NOT NULL,
  source_kind       TEXT NOT NULL CHECK (source_kind IN ('TEXT', 'VOICE', 'PHOTO')),
  -- CONFIRMING is a CLAIM, not a user-visible state: confirmation updates it
  -- atomically before the trade is created, so two simultaneous confirmations
  -- cannot both pass a pre-check and write two trades. It is the same
  -- conditional-transition discipline the linking token uses.
  state             TEXT NOT NULL DEFAULT 'AWAITING_CONFIRMATION'
                    CHECK (state IN ('AWAITING_CONFIRMATION', 'NEEDS_DETAIL', 'CONFIRMING', 'CONFIRMED', 'CANCELLED', 'EXPIRED')),
  -- Extracted candidate fields. Shape-constrained to an object so a malformed
  -- write cannot put a bare string in a field the service expects to be a map.
  draft             JSONB NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  -- Progressive enrichment: which REQUIRED fields are still unknown.
  missing_fields    JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(missing_fields) = 'array'),
  -- Voice transcripts only — and only what the user is about to confirm. Audio
  -- itself is never retained by this system (0021 posture).
  transcript        TEXT CHECK (transcript IS NULL OR length(transcript) <= 5000),
  -- Non-secret media metadata (Telegram file_id/size/duration, or the
  -- trade_attachments id once stored). Never bytes, never a temporary URL.
  media             JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(media) = 'object'),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Confirmation windows are bounded: an abandoned draft stops being actionable.
  expires_at        TIMESTAMPTZ NOT NULL,
  -- Set exactly once, on confirmation, to the trade the domain actually created.
  confirmed_trade_id BIGINT REFERENCES trades(id) ON DELETE SET NULL,
  CONSTRAINT telegram_journal_drafts_message_unique UNIQUE (telegram_user_id, source_message_id),
  CONSTRAINT telegram_journal_drafts_expiry_sane CHECK (expires_at > created_at),
  -- A confirmed draft must name its trade; an unconfirmed one must not.
  CONSTRAINT telegram_journal_drafts_confirmed_coherent
    CHECK ((state = 'CONFIRMED') = (confirmed_trade_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS telegram_journal_drafts_open_idx
  ON telegram_journal_drafts (telegram_user_id, created_at DESC)
  WHERE state IN ('AWAITING_CONFIRMATION', 'NEEDS_DETAIL');

-- ---------------------------------------------------------------------------
-- 5. Journal channel (optional mirror — NEVER the source of truth)
-- ---------------------------------------------------------------------------
-- The chat id is supplied by the user, so it is UNTRUSTED until the server has
-- called the Telegram API and confirmed both (a) that the bot is a member and
-- (b) that it holds the permissions a publish requires. `status` records that
-- verification outcome; only ACTIVE channels are published to.
CREATE TABLE IF NOT EXISTS telegram_channels (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id     BIGINT NOT NULL,
  title       TEXT CHECK (title IS NULL OR length(btrim(title)) BETWEEN 1 AND 255),
  chat_type   TEXT NOT NULL CHECK (chat_type IN ('channel', 'supergroup', 'group')),
  status      TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION'
              CHECK (status IN ('PENDING_VERIFICATION', 'ACTIVE', 'REVOKED', 'INSUFFICIENT_PERMISSIONS')),
  -- Server-observed capability, re-checked on every (re)verification.
  can_post    BOOLEAN NOT NULL DEFAULT false,
  verified_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT telegram_channels_owner_chat_unique UNIQUE (user_id, chat_id),
  CONSTRAINT telegram_channels_lifecycle
    CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);
-- One ACTIVE mirror per user keeps "where does my journal go?" unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS telegram_channels_one_active_per_user
  ON telegram_channels (user_id) WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- 6. Channel publish ledger (idempotency)
-- ---------------------------------------------------------------------------
-- A Telegram send that is retried must not produce a second post. The UNIQUE key
-- is the guarantee; the row is also the durable record of what was mirrored, so
-- a failed publish is visible rather than silent. The composite FK to
-- (trades.id, trades.user_id) reuses 0015's ownership anchor, making "publish
-- another user's trade" impossible at the database level.
CREATE TABLE IF NOT EXISTS telegram_channel_posts (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id   BIGINT NOT NULL REFERENCES telegram_channels(id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_id     BIGINT NOT NULL,
  message_id   BIGINT,
  status       TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),
  error_code   TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,48}$'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  CONSTRAINT telegram_channel_posts_once_unique UNIQUE (channel_id, trade_id),
  CONSTRAINT telegram_channel_posts_status_coherent
    CHECK ((status = 'PUBLISHED') = (message_id IS NOT NULL)),
  CONSTRAINT telegram_channel_posts_trade_owner_fk FOREIGN KEY (trade_id, user_id)
    REFERENCES trades (id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS telegram_channel_posts_trade_idx
  ON telegram_channel_posts (trade_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 7. audit_log vocabulary widening (0009 widened by 0011/0014)
-- ---------------------------------------------------------------------------
-- WHY THE EXISTING TABLE. 0009's header is explicit: a second security log would
-- mean two audit trails for one system. Telegram linking is a privileged,
-- account-affecting action and belongs in the SAME trail.
--
-- WHY THESE SIX ACTIONS, AND NOT MORE.
--   The lifecycle events that a reviewer must be able to answer questions about
--   are: who asked to link, who completed a link, a failed linking attempt that
--   had an authenticated actor, an unlink, and channel bind/unbind. Purely
--   unauthenticated noise (a token that simply does not exist) has NO actor and
--   therefore cannot be written here at all — `actor_user_id` is NOT NULL by
--   0009's design, and that constraint is preserved rather than relaxed.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN (
    'OWNERSHIP_CLAIMED',
    'USER_ROLE_CHANGED',
    'USER_STATUS_CHANGED',
    'CREDENTIAL_CREATED',
    'CREDENTIAL_DELETED',
    'CREDENTIAL_USED',
    'ACCOUNT_BINDING_CHANGED',
    'TELEGRAM_LINK_STARTED',
    'TELEGRAM_LINK_COMPLETED',
    'TELEGRAM_LINK_FAILED',
    'TELEGRAM_UNLINKED',
    'TELEGRAM_CHANNEL_BOUND',
    'TELEGRAM_CHANNEL_UNBOUND'
  ));

-- `provider` becomes the same kind of vocabulary value it already is, with the
-- second provider this platform actually talks to. Still never a secret.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_provider_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_provider_check
  CHECK (provider IS NULL OR provider IN ('METAAPI', 'TELEGRAM'));

-- ---------------------------------------------------------------------------
-- 8. AI attempt ledger: a FEATURE discriminator
-- ---------------------------------------------------------------------------
-- `ai_coaching_logs` (0017) is the durable record of EVERY AI attempt: provider,
-- model, prompt version, outcome, error code, cost. Journal extraction,
-- transcription and image interpretation are the same KIND of thing and must be
-- recorded with the same discipline (0017's own comment: every attempt is
-- recorded, so "not consented" and "provider down" stay distinguishable). They
-- are NOT the same FEATURE though, and 0017's column set cannot tell them apart.
--
-- Adding a discriminator is the smallest change that keeps ONE AI ledger:
--   * default 'coach' — every pre-existing row already means exactly that, so no
--     historical row changes meaning and no backfill is needed;
--   * the coach read path filters on it, so an extraction attempt can never be
--     shown to the user as a coaching insight (see PgAiCoachStore.latest).
-- The raw prompt/response prohibition from 0017 is untouched: `insight` stays a
-- STRUCTURED object, and neither raw message text nor raw media is stored here.
ALTER TABLE ai_coaching_logs
  ADD COLUMN IF NOT EXISTS feature TEXT NOT NULL DEFAULT 'coach';
ALTER TABLE ai_coaching_logs DROP CONSTRAINT IF EXISTS ai_coaching_logs_feature_check;
ALTER TABLE ai_coaching_logs ADD CONSTRAINT ai_coaching_logs_feature_check
  CHECK (feature IN ('coach', 'journal_extract', 'transcribe', 'vision_extract'));
CREATE INDEX IF NOT EXISTS ai_coaching_logs_user_feature_idx
  ON ai_coaching_logs (user_id, feature, created_at DESC);
