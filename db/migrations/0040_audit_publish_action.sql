-- 0040 — the audit vocabulary: one action restored by necessity, one added because publishing needs it.
--
-- ============================================================================
-- PART 1 — A DEFECT THIS MIGRATION FIXES, NOT A FEATURE IT ADDS
-- ============================================================================
-- `audit_log_action_check` has been replaced (never extended) by every migration that needed a new
-- action: 0011, 0014, 0023, 0027 and 0036 each DROP the constraint and ADD a full list. That style
-- makes the last writer the sole authority, and 0036's list omitted two actions 0027 had added:
--
--   USER_SESSIONS_REVOKED
--   USER_EMAIL_VERIFIED
--
-- Both are still in `AuditAction` in `apps/api/src/auth/auditStore.ts`, both are still emitted by the
-- admin console, and both had been UNWRITABLE on any database migrated through 0036: the insert would
-- fail the CHECK, so revoking a user's sessions or verifying an email raised an error after the
-- mutation had already committed. Nothing in the test suite caught it because no test wrote those two
-- actions after 0036 landed.
--
-- The fix is a widening, which is the only legal direction here: restoring names the constraint had
-- three migrations ago invalidates nothing that was ever written, and no row is touched. This file
-- therefore lists the UNION of every action the platform has ever recognised, grouped by the migration
-- that introduced each one, so the next reader can see the whole lineage instead of reconstructing it.
--
-- The lesson is recorded in db/MIGRATION_MAP.md: a CHECK that must be rewritten to grow will eventually
-- be rewritten to shrink. New audit vocabulary belongs in one place from now on — if another action is
-- ever needed, this file is the one to edit, and the list below is the one to extend.
--
-- ============================================================================
-- PART 2 — TELEGRAM_POST_PUBLISHED
-- ============================================================================
-- Publishing is the one Telegram action that reaches BEYOND the user: it puts content in front of a
-- channel's subscribers, on the authority of a bot token the platform holds. Link and channel-binding
-- changes already have audit rows for exactly this reason (0023); a post that went out did not.
--
-- `after_state` carries `post:<id> message:<telegram message id>`, which is enough to answer "what did
-- this account send, and where is Telegram's copy" without storing the content: the body and its hash
-- already live on `telegram_outbox_posts` (0037), duplicated here they would only be able to disagree.
-- Direction needs no second action name — a publish that was refused never reaches this call, and a
-- FAILED publish is recorded on the outbox row with its code, which is where the retry machinery reads it.
--
-- NO SECRET AND NO AUDIENCE DATA: no bot token, no channel title, no chat id of anyone else.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN (
    -- 0009: the original three
    'OWNERSHIP_CLAIMED',
    'USER_ROLE_CHANGED',
    'USER_STATUS_CHANGED',
    -- 0011: credential lifecycle
    'CREDENTIAL_CREATED',
    'CREDENTIAL_DELETED',
    -- 0014 (OD-MP-2): MetaAPI provisioning
    'CREDENTIAL_USED',
    'ACCOUNT_BINDING_CHANGED',
    -- 0023: the Telegram journal client
    'TELEGRAM_LINK_STARTED',
    'TELEGRAM_LINK_COMPLETED',
    'TELEGRAM_LINK_FAILED',
    'TELEGRAM_UNLINKED',
    'TELEGRAM_CHANNEL_BOUND',
    'TELEGRAM_CHANNEL_UNBOUND',
    -- 0027: the admin console. RESTORED HERE — see part 1 above.
    'USER_SESSIONS_REVOKED',
    'USER_EMAIL_VERIFIED',
    -- 0036: the daily checklist
    'JOURNAL_CHECKLIST_SAVED',
    -- 0040: a channel-affecting send
    'TELEGRAM_POST_PUBLISHED'
  ));

-- No index change: the console reads by (actor, target, action, time window) and 0027 already built for
-- that shape. A publish is one row per post, so a new access path would be a guess about a query nobody
-- has written yet.
