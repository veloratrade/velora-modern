-- 0027_admin_console.sql — Phase 6: two new audited administrative actions.
--
-- WHY THIS MIGRATION EXISTS
--
-- `audit_log.action` has been a CLOSED vocabulary since 0009 and was widened
-- once already, in 0011, for the credential events. The rule that made it closed
-- is the reason it must be widened deliberately rather than loosened: an audit
-- trail is only trustworthy if the set of things it can record is enumerated
-- somewhere a reviewer can read. Phase 6 adds two administrative operations that
-- act on ANOTHER user's account and therefore must be auditable:
--
--   * USER_SESSIONS_REVOKED — an administrator revoked one session, or every
--     session, of a user. This is the operation that ends someone else's access
--     without changing their stored role or status, so without a trail entry it
--     would be invisible: the user is logged out, and nothing anywhere says why.
--
--   * USER_EMAIL_VERIFIED — an administrator marked a user's e-mail as verified
--     (Legacy's users.verify_email). It grants a real capability (the account
--     becomes fully usable), so it belongs in the same trail as a role or status
--     change. Keeping it out would leave an authorization grant unrecorded.
--
-- Both are append-only additions. The five existing actions remain valid, every
-- historical row stays valid, and no column, index or row is touched.
--
-- ROLLBACK (documented, not executed): restoring the constraint as 0023 left it
-- requires that no row of the two new actions exists. The statement is 0023's
-- CHECK verbatim (thirteen actions):
--   ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
--   ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
--     CHECK (action IN ('OWNERSHIP_CLAIMED','USER_ROLE_CHANGED',
--       'USER_STATUS_CHANGED','CREDENTIAL_CREATED','CREDENTIAL_DELETED',
--       'CREDENTIAL_USED','ACCOUNT_BINDING_CHANGED','TELEGRAM_LINK_STARTED',
--       'TELEGRAM_LINK_COMPLETED','TELEGRAM_LINK_FAILED','TELEGRAM_UNLINKED',
--       'TELEGRAM_CHANNEL_BOUND','TELEGRAM_CHANNEL_UNBOUND'));
--
-- It is deliberately NOT written as an automatic down-migration: dropping rows
-- (the alternative) would destroy the very evidence this migration exists to
-- keep, and silently failing on a populated table would be worse than refusing.

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN (
    -- 0009 (the original three)
    'OWNERSHIP_CLAIMED',
    'USER_ROLE_CHANGED',
    'USER_STATUS_CHANGED',
    -- 0011 (credential lifecycle)
    'CREDENTIAL_CREATED',
    'CREDENTIAL_DELETED',
    -- 0014 (OD-MP-2: MetaAPI provisioning)
    'CREDENTIAL_USED',
    'ACCOUNT_BINDING_CHANGED',
    -- 0023 (Telegram journal client)
    'TELEGRAM_LINK_STARTED',
    'TELEGRAM_LINK_COMPLETED',
    'TELEGRAM_LINK_FAILED',
    'TELEGRAM_UNLINKED',
    'TELEGRAM_CHANNEL_BOUND',
    'TELEGRAM_CHANNEL_UNBOUND',
    -- 0027 (this migration)
    'USER_SESSIONS_REVOKED',
    'USER_EMAIL_VERIFIED'
  ));

-- Index support for the Phase 6 console reads. The audit trail is now read by
-- FILTER (actor, target, action, time window) rather than only by descending id,
-- and `audit_log` grows monotonically — a filtered scan without an index would
-- degrade as the trail does its job and grows.
--
-- (occurred_at, id) is the ordering key the console pages by; the two partial
-- entry points are the ones the console opens first (\"what happened to this
-- user\", \"what did this administrator do\").
CREATE INDEX IF NOT EXISTS audit_log_occurred_idx
  ON audit_log (occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_log_target_idx
  ON audit_log (target_user_id, occurred_at DESC, id DESC)
  WHERE target_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_log_actor_idx
  ON audit_log (actor_user_id, occurred_at DESC, id DESC);

-- The security feeds read `auth_events` the same way (event type + time window,
-- newest first). 0024 created the table and its outcome index only.
CREATE INDEX IF NOT EXISTS auth_events_type_occurred_idx
  ON auth_events (event_type, occurred_at DESC, id DESC);
