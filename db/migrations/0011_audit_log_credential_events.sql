-- 0011_audit_log_credential_events.sql — Gate B-2: extend the audit contract
-- so credential lifecycle events can be represented.
--
-- PURPOSE
--   Migration 0009 created an append-only security audit trail whose `action`
--   CHECK admits exactly three account-lifecycle values and whose `outcome`
--   CHECK admits only 'success'. Credential events (C-22 / ADR-016) cannot be
--   recorded under that contract. This migration widens the contract. It wires
--   nothing: no application code emits these events yet (that is B-3).
--
-- WHAT THIS CHANGES
--   1. `action`   — adds CREDENTIAL_CREATED and CREDENTIAL_DELETED.
--   2. `outcome`  — adds 'denied' alongside 'success'.
--   3. new nullable columns `credential_id` and `provider`.
--
-- WHY 'denied' MATTERS
--   For credential access the REFUSED attempt carries more security signal
--   than the successful one: "user X tried to delete a credential they do not
--   own" is precisely what a trail exists to capture. 0009 could not express
--   it. Note `actor_user_id` remains NOT NULL, so only AUTHENTICATED denials
--   are recordable — an unauthenticated request never reaches the service and
--   therefore has no actor to attribute.
--
-- WHY credential_id IS NOT A FOREIGN KEY  (deliberate, owner decision 5)
--   Credential revocation is a HARD DELETE (pgCredentialStore.delete issues
--   DELETE ... RETURNING id). A foreign key would make the audit trail and the
--   deletion mutually exclusive:
--     • ON DELETE RESTRICT → the audit row would BLOCK the very deletion it
--       records, breaking revocation;
--     • ON DELETE CASCADE  → deleting the credential would ERASE its audit
--       history, destroying append-only semantics.
--   A plain BIGINT is therefore the correct type: a HISTORICAL IDENTIFIER of a
--   row that may no longer exist, not a live reference. The trail must outlive
--   the credential.
--
-- NO SECRET MATERIAL — THE CENTRAL INVARIANT (ADR-016)
--   The columns added here are METADATA ONLY: which credential, which
--   provider. There is deliberately NO column for the secret, the ciphertext,
--   the master key, the IV or the auth tag, and none may ever be added. A
--   reader with full SELECT on audit_log learns only WHAT happened, WHO did it
--   and WHEN — never the secret itself. `before_state`/`after_state` keep
--   their 0009 meaning (low-cardinality lifecycle values) and must never carry
--   secret-derived data.
--
-- PRESERVATION
--   Existing rows stay valid: the three original actions remain in the CHECK,
--   'success' remains the DEFAULT and a legal outcome, and both new columns
--   are NULLABLE with no default, so every historical row satisfies the new
--   constraints unchanged. No index, privilege or trigger is altered, so the
--   append-only posture from db/roles.sql (REVOKE UPDATE, DELETE, TRUNCATE)
--   is untouched. Migration 0009 itself is NOT modified.
--
-- IDEMPOTENCY
--   DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT follows the established pattern
--   in 0006_rbac_roles.sql and 0007_user_status.sql. Columns use IF NOT EXISTS.

-- 1. Action vocabulary: the three original values plus two credential events.
--    CREDENTIAL_REVEALED is deliberately ABSENT — reveal has no production
--    consumer, and an action nothing can emit is dead contract surface.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN (
    'OWNERSHIP_CLAIMED',
    'USER_ROLE_CHANGED',
    'USER_STATUS_CHANGED',
    'CREDENTIAL_CREATED',
    'CREDENTIAL_DELETED'
  ));

-- 2. Outcome vocabulary: success (unchanged default) plus denied.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_outcome_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_outcome_check
  CHECK (outcome IN ('success', 'denied'));

-- 3. Credential metadata. Both NULLABLE: non-credential actions carry neither,
--    and every pre-existing row is left untouched.
--    NO FOREIGN KEY on credential_id — see the rationale above.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS credential_id BIGINT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS provider      TEXT;

-- Provider vocabulary mirrors the 0010 user_credentials CHECK. NULL is allowed
-- so account-lifecycle events remain valid; a non-NULL value must be a
-- provider this installation actually supports.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_provider_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_provider_check
  CHECK (provider IS NULL OR provider IN ('METAAPI'));
