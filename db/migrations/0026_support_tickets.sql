-- 0026_support_tickets.sql — the support ticket capability (Phase 5).
--
-- LEGACY LINEAGE (source-read: `api/database/migrations/v1.8_support_tickets.sql`,
-- `api/src/Support/{SupportService,SupportRepository,SupportController}.php`;
-- capability reference only, no PHP structure copied):
--
--   Legacy modelled a ticket as a CONVERSATION with TWO INDEPENDENT AXES:
--
--     status       open | pending | closed | archived   (what the ticket IS)
--     waiting_for  admin | user | none                  (whose turn it is)
--
--   Both axes are SERVER-DERIVED. The client never sends them; the API derives
--   them from the event that happened (create / user reply / admin reply /
--   close / reopen), which is what stops a client from claiming "replied" or
--   "waiting for user" on its own. The unread counters are the same kind of
--   derived state: a user message raises the admin's count and clears the user's,
--   an admin message does the opposite.
--
--   `first_reply_at` is an IDEMPOTENCY SENTINEL, not a timestamp for display:
--   Legacy used it so the "your ticket has an answer" e-mail fires exactly once,
--   no matter how many replies follow or how often the event is retried.
--
-- WHAT IS DELIBERATELY DIFFERENT (and why)
-- ========================================
-- 1. The table is `support_tickets`, not Legacy's `support_conversations`. The
--    route contract is `/support/tickets` (the capability's own name in the
--    register, the audit and the shell), and the ROW is a ticket with messages.
--    Renaming the concept while keeping the behaviour is the migration rule;
--    keeping a legacy table name that nothing else uses would be the mechanical
--    copy the mission forbids.
-- 2. NO `support_message_translations` table in this migration. Legacy's
--    translation and copilot surfaces (`/admin/communications/tickets/{id}/translate`,
--    `/copilot`) call an AI provider; the phase order puts AI at phase 7, and a
--    table that only an unbuilt feature writes is speculative infrastructure.
--    The message body is stored as the author wrote it, and the translation
--    capability will own its own storage when it lands.
-- 3. ONE DEFECT IN LEGACY IS NOT REPRODUCED: an admin INTERNAL NOTE
--    (`message_type = 'system_note'`) must not move the ticket. Legacy's
--    repository ran the same UPDATE for every admin message (v1.8
--    `SupportRepository::addMessage`, admin branch), so a note flipped `status`
--    to `pending`, set `waiting_for = 'user'`, cleared the admin's unread count,
--    incremented `unread_user_count`, stamped `first_reply_at` AND moved
--    `last_message_at` — telling the user "we replied", raising a badge for a
--    message they cannot open, and REORDERING their ticket list, all from an
--    event the user is not allowed to see. Modern stores the note
--    (admin-visible only) and leaves status, waiting_for, both counters, the
--    sentinel and the ordering key untouched. Tests pin this.
--    `last_message_at` means "when the CONVERSATION last moved, as its
--    participants can see it" — a note is not a move.
--
-- IDEMPOTENT: `CREATE TABLE IF NOT EXISTS` + guarded DO blocks, so the file is
-- safe to re-run (the runner also records it in schema_migrations).

CREATE TABLE IF NOT EXISTS support_tickets (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject            TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','pending','closed','archived')),
  waiting_for        TEXT NOT NULL DEFAULT 'admin'
                       CHECK (waiting_for IN ('admin','user','none')),
  assigned_admin_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  priority           TEXT CHECK (priority IS NULL OR priority IN ('low','normal','high')),
  -- The sentinel: set ONCE, by the first admin text reply. NULL means "no answer
  -- has ever been visible to the user", which is exactly the e-mail condition.
  first_reply_at     TIMESTAMPTZ,
  last_message_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  unread_admin_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_admin_count >= 0),
  unread_user_count  INTEGER NOT NULL DEFAULT 0 CHECK (unread_user_count >= 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Legacy capped the subject at 200 characters in the service AND the column.
  CONSTRAINT support_tickets_subject_len CHECK (char_length(subject) BETWEEN 1 AND 200),
  -- A waiting side must be consistent with a live ticket; a closed/archived
  -- ticket waits for nobody. This is the invariant the two axes share.
  CONSTRAINT support_tickets_waiting_consistent CHECK (
    (status IN ('open','pending') AND waiting_for IN ('admin','user'))
    OR (status IN ('closed','archived') AND waiting_for = 'none')
  )
);
CREATE INDEX IF NOT EXISTS support_tickets_user_idx  ON support_tickets (user_id, last_message_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS support_tickets_queue_idx ON support_tickets (status, waiting_for, last_message_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS support_messages (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id       BIGINT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_type     TEXT NOT NULL CHECK (sender_type IN ('user','admin','system')),
  sender_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  body            TEXT NOT NULL,
  message_type    TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text','system_note')),
  -- Safe operational metadata only — never secrets, never a second copy of the body.
  metadata        JSONB,
  edited_at       TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT support_messages_body_len CHECK (char_length(body) BETWEEN 1 AND 5000)
);
CREATE INDEX IF NOT EXISTS support_messages_ticket_idx ON support_messages (ticket_id, created_at, id);
-- IDENTITY AND AUTHORSHIP. The invariant is: a SYSTEM note is never attributed
-- to a person, and a USER/ADMIN message is written by one. Both halves need the
-- FK's behaviour in mind, which is why they are decided together:
--
--   * `sender_user_id` is `ON DELETE SET NULL` (Legacy lineage:
--     `fk_sm_sender … ON DELETE SET NULL`, v1.8 line 44). That is deliberate —
--     the alternative, CASCADE, would DELETE an admin's replies out of other
--     people's tickets when the admin's account goes away, destroying the user's
--     support history. Losing the attribution is the lesser loss.
--   * The user's own tickets cascade away with the user (`support_tickets.user_id
--     ON DELETE CASCADE`), so a user-authored message cannot outlive its author
--     except during the instant the RI triggers run — and PostgreSQL does not
--     order those triggers, so `SET NULL` can fire BEFORE the cascade removes the
--     row. A strict "non-system messages always have an author" CHECK therefore
--     made account deletion FAIL (reproduced: 23514 on `DELETE FROM users`).
--
-- So the constraint enforces the half that carries meaning and cannot be broken
-- by a deletion — a system note has no author — and permits an authorless
-- user/admin row as the residue of a deleted author, which is exactly what the
-- SET NULL means. The application never writes one: every message the API stores
-- carries a sender id (pinned by the route and service batteries).
ALTER TABLE support_messages DROP CONSTRAINT IF EXISTS support_messages_sender_identity;
ALTER TABLE support_messages
  ADD CONSTRAINT support_messages_sender_identity CHECK (
    sender_type <> 'system' OR sender_user_id IS NULL
  );

-- ── derived-state maintenance ───────────────────────────────────────────────
-- The counters, `last_message_at`, `waiting_for`, `status` and the
-- `first_reply_at` sentinel are DERIVED FROM THE EVENT, and the two operations
-- that derive them are functions rather than application-side multi-statements.
--
-- WHY FUNCTIONS: a ticket reply is an INSERT plus an UPDATE. Doing that as two
-- round-trips lets a crash or a concurrent reply interleave them, which is how a
-- counter drifts or a user replies into a closed ticket. A single function call
-- runs in ONE transaction with one row lock, so "the message exists" and "the
-- ticket says so" can never disagree. The API calls these; nothing else writes
-- those columns.

-- Append a message and derive the ticket state from it. Returns the affected
-- ticket when the message was accepted, NO ROW when a guard rejected it (the
-- caller distinguishes "closed" from "not yours" by reading the ticket).
CREATE OR REPLACE FUNCTION velora_support_append_message(
  p_ticket_id   BIGINT,
  p_sender_type TEXT,
  p_sender_id   BIGINT,
  p_body        TEXT,
  p_message_type TEXT,
  p_require_live BOOLEAN DEFAULT false
) RETURNS TABLE (
  message_id      BIGINT,
  message_at      TIMESTAMPTZ,
  status          TEXT,
  waiting_for     TEXT,
  first_reply_now BOOLEAN,
  unread_admin    INTEGER,
  unread_user     INTEGER
) AS $$
DECLARE
  v_text BOOLEAN := p_message_type = 'text';
  v_new_status TEXT;
  v_new_waiting TEXT;
  -- (kept explicit: `v_text` is the visibility test used by every CASE below)
BEGIN
  -- The turn rule: a USER message hands the ticket back to the admin; an ADMIN
  -- text reply hands it to the user; an internal note moves nothing.
  IF p_sender_type = 'user' THEN
    v_new_status := 'open';   v_new_waiting := 'admin';
  ELSIF p_sender_type = 'admin' AND v_text THEN
    v_new_status := 'pending'; v_new_waiting := 'user';
  ELSE
    v_new_status := NULL; v_new_waiting := NULL;  -- system / internal note
  END IF;

  -- `v_visible` is the difference between "a message exists" and "the
  -- conversation moved": only a message the other side can read may reorder the
  -- ticket or change whose turn it is.
  RETURN QUERY
  WITH ins AS (
    INSERT INTO support_messages (ticket_id, sender_type, sender_user_id, body, message_type)
    SELECT p_ticket_id, p_sender_type, p_sender_id, p_body, p_message_type
     WHERE EXISTS (
       SELECT 1 FROM support_tickets t
        WHERE t.id = p_ticket_id
          AND (NOT p_require_live OR t.status IN ('open','pending'))
     )
    RETURNING id, created_at, ticket_id, message_type
  )
  UPDATE support_tickets t
     SET status          = COALESCE(v_new_status, t.status),
         waiting_for     = COALESCE(v_new_waiting, t.waiting_for),
         last_message_at = CASE WHEN ins.message_type = 'text' THEN ins.created_at ELSE t.last_message_at END,
         updated_at      = ins.created_at,
         unread_user_count  = CASE WHEN p_sender_type = 'admin' AND ins.message_type = 'text' THEN t.unread_user_count + 1
                                   WHEN p_sender_type = 'user' THEN 0
                                   ELSE t.unread_user_count END,
         unread_admin_count = CASE WHEN p_sender_type = 'user' THEN t.unread_admin_count + 1
                                   WHEN p_sender_type = 'admin' AND ins.message_type = 'text' THEN 0
                                   ELSE t.unread_admin_count END,
         first_reply_at  = CASE WHEN p_sender_type = 'admin' AND ins.message_type = 'text' AND t.first_reply_at IS NULL
                                THEN ins.created_at ELSE t.first_reply_at END
    FROM ins
   WHERE t.id = ins.ticket_id
  RETURNING ins.id, ins.created_at, t.status, t.waiting_for,
            t.first_reply_at IS NOT NULL AND t.first_reply_at = ins.created_at,
            t.unread_admin_count, t.unread_user_count;
END;
$$ LANGUAGE plpgsql;

-- Create a ticket and its opening message in one transaction. The opening
-- message is a USER message, so it raises the admin's unread count — the same
-- derivation the append function applies, expressed once here because the ticket
-- row does not exist yet.
CREATE OR REPLACE FUNCTION velora_support_create_ticket(
  p_user_id BIGINT,
  p_subject TEXT,
  p_body    TEXT
) RETURNS TABLE (ticket_id BIGINT, created_at TIMESTAMPTZ) AS $$
BEGIN
  RETURN QUERY
  WITH t AS (
    INSERT INTO support_tickets (user_id, subject, status, waiting_for, unread_admin_count)
    VALUES (p_user_id, p_subject, 'open', 'admin', 1)
    RETURNING id, support_tickets.created_at
  ), m AS (
    INSERT INTO support_messages (ticket_id, sender_type, sender_user_id, body, message_type)
    SELECT t.id, 'user', p_user_id, p_body, 'text' FROM t
    RETURNING id
  )
  SELECT t.id, t.created_at FROM t;
END;
$$ LANGUAGE plpgsql;

-- A status transition that must not race: the caller states the states it is
-- allowed to move FROM, and a concurrent change returns NO ROW (the API maps
-- that to 409, exactly as Legacy's `transition()` did).
CREATE OR REPLACE FUNCTION velora_support_transition(
  p_ticket_id BIGINT,
  p_from      TEXT[],
  p_to_status TEXT,
  p_to_waiting TEXT
) RETURNS TABLE (id BIGINT, status TEXT, waiting_for TEXT, updated_at TIMESTAMPTZ) AS $$
BEGIN
  RETURN QUERY
  UPDATE support_tickets t
     SET status = p_to_status, waiting_for = p_to_waiting, updated_at = now()
   WHERE t.id = p_ticket_id AND t.status = ANY(p_from)
  RETURNING t.id, t.status, t.waiting_for, t.updated_at;
END;
$$ LANGUAGE plpgsql;
