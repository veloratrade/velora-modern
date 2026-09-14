-- 0009_audit_log.sql — C-34: append-only security audit trail.
--
-- WHY A SEPARATE TABLE AND NOT trade_events:
--   trade_events is the TRADE LEDGER (ADR-002): it is folded/replayed to derive
--   trade state, is keyed to a trade_id, and carries a version for CAS. This
--   table answers a different question — "which privileged action did which
--   authenticated actor perform against which account" — is never folded, never
--   replayed, and is not part of any aggregate's state. Reusing trade_events
--   would conflate a domain event stream with a security log, so the two remain
--   separate. This is NOT a second general event model: nothing reads this table
--   to reconstruct state, and no event bus is introduced.
--
-- APPEND-ONLY:
--   Enforced in two independent layers, neither of which relies on the other:
--     1. APPLICATION — the AuditStore port exposes append() and a read used only
--        by tests. There is deliberately no update or delete method, so no
--        application path can mutate history.
--     2. DATABASE — db/roles.sql REVOKEs UPDATE, DELETE and TRUNCATE on this
--        table from app_readwrite and velora_worker, exactly as it already does
--        for trade_events and webhook_events.
--
-- ACTOR INTEGRITY (§K):
--   actor_user_id is ALWAYS the server-derived authenticated identity
--   (authority.sub, resolved from the verified JWT subject). It is never taken
--   from a request body, header or query parameter. The column is NOT NULL
--   because every action recorded here is performed by an authenticated user.
--
-- SENSITIVE MATERIAL:
--   This table NEVER stores passwords, password hashes, raw or hashed reset or
--   verification tokens, refresh tokens, API keys, Authorization headers or
--   email bodies. before_state/after_state hold only low-cardinality lifecycle
--   values (a role name or an account status), never credentials.
--
-- FK BEHAVIOUR:
--   ON DELETE RESTRICT, consistent with installation_ownership (0008). A user
--   row that is referenced by the audit trail cannot be deleted, so history
--   cannot be silently erased by removing an account. There is no application
--   user-delete path today, so this adds no new operational constraint.
--
-- SCOPE / SAFETY:
--   - Forward-only (ADR-010), additive, idempotent (IF NOT EXISTS).
--   - Creates ONE new table. No existing table, column, constraint, default or
--     row is modified. Migration 0008 is untouched.
--   - No production database exists or is touched by this file.

CREATE TABLE IF NOT EXISTS audit_log (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- When the action happened (ADR-004: every timestamp is timestamptz).
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- What happened. CHECK-constrained so an unknown action cannot be written by
  -- a future caller without a deliberate migration.
  action          TEXT NOT NULL CHECK (action IN (
                    'OWNERSHIP_CLAIMED',
                    'USER_ROLE_CHANGED',
                    'USER_STATUS_CHANGED'
                  )),
  -- Who performed it — server-derived authenticated identity, never client input.
  actor_user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Which account the action was performed against. For OWNERSHIP_CLAIMED this
  -- is the new owner (self-claim), so it equals actor_user_id by design.
  target_user_id  BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  -- Relevant before/after lifecycle state (role name or account status).
  -- NULL where the action has no meaningful prior state (a first-time claim).
  before_state    TEXT,
  after_state     TEXT,
  -- Only successful actions are recorded: a rejected mutation never reaches the
  -- write. The column is explicit so a later phase could add failure rows
  -- without changing the meaning of existing ones.
  outcome         TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success')),
  -- Correlation id from the existing per-request security context
  -- (kernel/security.ts randomUUID). NULL when a caller has no request context.
  request_id      TEXT
);

-- Newest-first retrieval for a given target account, and for the trail overall.
CREATE INDEX IF NOT EXISTS audit_log_occurred_idx ON audit_log(occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_log_target_idx   ON audit_log(target_user_id, occurred_at DESC);
