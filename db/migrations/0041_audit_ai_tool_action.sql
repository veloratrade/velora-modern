-- 0041 — one action for a tool validation an operator asked the platform to perform.
--
-- ============================================================================
-- WHY A VALIDATION DESERVES A ROW AT ALL
-- ============================================================================
-- `POST /api/v1/admin/ai/tools/{tool}/validate` does not change configuration. It does three things that
-- are not nothing, though:
--
--   1. it sends a live request to a third-party provider (Tavily, Brave, Serper, or an operator-hosted
--      Browserless endpoint) using a credential the platform holds;
--   2. its verdict is what the admin panel then renders as a fact to the rest of the team — "search is
--      verified" is a claim people make deployment decisions on;
--   3. it is the one place where a NEGATIVE result is informative: a failing probe is a security signal
--      (a key that stopped working, an endpoint that moved, a quota exhausted), and a signal nobody can
--      find later is a signal nobody acts on.
--
-- Without a row, "who last checked this, what did it say, and has anything been asserted since" is
-- unanswerable, and a stale green badge is indistinguishable from a fresh one. The `GET` listing that
-- reads `lastCheckedAt` is a separate concern: that column records the tool service's own bookkeeping,
-- not who caused the check.
--
-- ============================================================================
-- WHAT THE ROW CARRIES, AND WHAT IT MUST NEVER CARRY
-- ============================================================================
-- `action = 'AI_TOOL_VALIDATED'`, `actor_user_id` = the authenticated admin who pressed it (0009's
-- NOT NULL + FK to `users`, so an unattributable probe writes no row — and an unauthenticated caller is
-- refused before anything is sent, so there is nothing to attribute), `after_state` =
-- `tool:<name> verdict:<ok|CODE>`.
--
-- Deliberately absent, and this is not an oversight:
--   * no provider endpoint or URL — a Browserless origin is operator infrastructure and belongs in the
--     secret store, not in a table the console lists;
--   * no provider response body, not even truncated — an error page from a vendor can contain account
--     identifiers, and the verdict code already says what the operator needs;
--   * no secret, key fragment, ciphertext, IV or tag, and no `credential_id`: nothing here identifies
--     WHICH key was used, only that the tool it belongs to answered;
--   * `provider` stays NULL. `audit_log_provider_check` (0023) is the vocabulary of providers whose
--     credentials this platform *provisions for users* (METAAPI, TELEGRAM). A search vendor is not one of
--     them, and widening that constraint to admit "TAVILY" would put a third-party name in the same column
--     that carries broker credential lifecycle events — a search tool is not a broker account. The vendor
--     name remains in the tool row and in the log line.
--
-- `outcome` is 'success' for any COMPLETED probe, positive or negative: the vocabulary is about whether
-- the audited action was PERFORMED, not about whether the provider was healthy. A 424 from a failing
-- probe is still an operator who validated a tool; a request refused at the door (unknown tool, a runtime
-- that cannot probe) is not performed at all and writes nothing.
--
-- ============================================================================
-- THE MECHANICS, AND THE LESSON 0040 RECORDED
-- ============================================================================
-- A CHECK cannot be ALTERed, so growth means DROP + ADD with the full list — the style every previous
-- widening used, and the style that let 0036 narrow the list by omission. This file therefore carries the
-- UNION of all 18 names the platform has ever recognised, grouped by the migration that introduced each.
--
-- The durable protection is not this file's comment, it is `apps/api/src/auth/auditVocabulary.test.ts`,
-- which reads `AUDIT_ACTIONS` (now an array, so it is enumerable) and compares it with the LAST definition
-- of `audit_log_action_check` in this directory. If a future rewrite drops a name, or the TypeScript union
-- grows without a migration, that test fails in CI rather than at the first admin who presses a button.
--
-- No row is touched, no index changes (the console's existing (actor, target, action, time) access path
-- from 0027 already serves this), and the migration is a pure widening: every historical row remains
-- valid.
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
    -- 0027: the admin console (lost by 0036, restored by 0040)
    'USER_SESSIONS_REVOKED',
    'USER_EMAIL_VERIFIED',
    -- 0036: the daily checklist
    'JOURNAL_CHECKLIST_SAVED',
    -- 0040: a channel-affecting send
    'TELEGRAM_POST_PUBLISHED',
    -- 0041: an operator-run tool validation
    'AI_TOOL_VALIDATED'
  ));

-- ROLLBACK (documented, not executed): 0040's 17-name list, valid only once no row carries
-- 'AI_TOOL_VALIDATED'. Deleting such rows to make a rollback convenient would destroy the record of who
-- asserted a capability was healthy, which is the entire point of the row.
