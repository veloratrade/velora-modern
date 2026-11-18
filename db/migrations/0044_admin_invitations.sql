-- 0044_admin_invitations.sql — Phase 2 W1: admin user creation + invitations (ADR-023 = A).
--
-- WHY THIS MIGRATION EXISTS
--
-- W1 adds two admin-surface operations that create or pre-authorize an account:
--
--   * `POST /api/v1/admin/users` — an administrator creates a user directly
--     (password set by the admin, account active and e-mail considered verified
--     because the admin vouches for it). Requires `users.create`.
--   * `POST /api/v1/admin/users/invite` — an administrator mints a single-use,
--     7-day invite token. The token is delivered out of band (invite *delivery*
--     is deploy-gated, MG-WORKER-DEPLOY evidence class); this migration only
--     creates the record and stores the token hash. Requires `users.invite`.
--
-- Both are privileged mutations acting on ANOTHER user's account and therefore
-- belong in the same append-only trail as USER_ROLE_CHANGED / USER_STATUS_CHANGED
-- (C-34). The trail widens deliberately: `USER_CREATED` joins the closed
-- vocabulary, every existing action stays valid, and no column, index or row is
-- touched or removed.
--
-- ROLLBACK (documented, not executed): restoring the pre-0044 constraint
-- requires that no `USER_CREATED` row exists, and dropping `invitation_tokens`
-- destroys pending invites. Neither is automatic.

-- 1) Widen the audit action vocabulary (replace, never stack — exactly one live
--    audit_log_action_check, see 0040/0041).
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
    -- 0027 (restored by 0040 after 0036 dropped them): the admin console
    'USER_SESSIONS_REVOKED',
    'USER_EMAIL_VERIFIED',
    -- 0036: the daily checklist's saved state
    'JOURNAL_CHECKLIST_SAVED',
    -- 0040: publishing reaches past the user
    'TELEGRAM_POST_PUBLISHED',
    -- 0041: an operator's tool validation
    'AI_TOOL_VALIDATED',
    -- 0044 (W1): an administrator created an account directly
    'USER_CREATED',
    -- 0044 (W1): an administrator minted a single-use invite token
    'USER_INVITED'
  ));

-- 2) Invitation tokens: single-use, 7-day, admin-minted.
CREATE TABLE IF NOT EXISTS invitation_tokens (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email             TEXT NOT NULL,            -- canonical, lowercase (ADR-003)
  role              TEXT NOT NULL DEFAULT 'user'
                    CHECK (role IN ('user', 'admin', 'super_admin')),
  token_hash        TEXT NOT NULL UNIQUE,     -- sha256 of the single-use token
  expires_at        TIMESTAMPTZ NOT NULL,     -- created_at + 7 days
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at           TIMESTAMPTZ,              -- null while pending
  used_by_user_id   BIGINT REFERENCES users(id),
  invited_by_user_id BIGINT NOT NULL REFERENCES users(id)
);

-- One pending (unused) invitation per e-mail; a re-invite replaces the old one
-- only after it has been consumed or expired (application-layer: expire first).
CREATE UNIQUE INDEX IF NOT EXISTS invitation_tokens_email_pending_unique
  ON invitation_tokens(email) WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS invitation_tokens_token_hash_idx
  ON invitation_tokens(token_hash);
