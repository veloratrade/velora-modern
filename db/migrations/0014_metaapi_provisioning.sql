-- 0014_metaapi_provisioning.sql — OD-MP-1 / OD-MP-2 / OD-MP-3.
--
-- WHAT THIS MIGRATION IS FOR
--   The provisioning/account-binding path authorized by OD-MP-1 needs three
--   things the schema cannot express today:
--
--     1. An audit vocabulary that can record *authorized credential use* and
--        *binding changes*                                        (OD-MP-2).
--     2. A durable account reference on an audit row, so a binding transition
--        is traceable to the account it changed                   (OD-MP-2 §11).
--     3. A durable provisioning operation record, so a provider call that
--        succeeded can never be lost by a local failure           (OD-MP-1).
--
-- ADDITIVE ONLY. No column is dropped, no row is rewritten, no trade is
-- touched, and every pre-existing audit row stays valid. The append-only
-- posture of `audit_log` (db/roles.sql REVOKE UPDATE, DELETE, TRUNCATE) is
-- unchanged and is NOT weakened here.
--
-- ============================================================================
-- 1. AUDIT ACTION VOCABULARY  (OD-MP-2)
-- ============================================================================
-- Exactly two new values. The owner decision names them explicitly and forbids
-- redundant per-outcome action names: `outcome` already distinguishes success
-- from denial, so a failed/denied credential use is CREDENTIAL_USED +
-- outcome='denied', not a separate action.
--
-- CREDENTIAL_REVEALED IS DELIBERATELY STILL ABSENT.
--   Migration 0011 omitted it on the grounds that "reveal has no production
--   consumer, and an action nothing can emit is dead contract surface". That
--   reasoning is now superseded only in part: a consumer exists, but it does
--   not REVEAL anything — the plaintext is used server-side against MetaAPI on
--   the owner's behalf and is never disclosed to any caller. The action name
--   must not imply a disclosure capability the system does not have, so the
--   authorized name is CREDENTIAL_USED (OD-MP-2 rationale).
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN (
    'OWNERSHIP_CLAIMED',
    'USER_ROLE_CHANGED',
    'USER_STATUS_CHANGED',
    'CREDENTIAL_CREATED',
    'CREDENTIAL_DELETED',
    -- OD-MP-2: an authorized, owner-scoped consumption of a stored credential
    -- by the provisioning service. outcome='success' = the credential was
    -- used; outcome='denied' = the attempt was refused.
    'CREDENTIAL_USED',
    -- OD-MP-2: establishment or removal of the Velora <-> MetaAPI binding.
    -- Direction is carried by before_state/after_state, exactly as
    -- USER_ROLE_CHANGED carries a role transition.
    'ACCOUNT_BINDING_CHANGED'
  ));

-- ============================================================================
-- 2. ACCOUNT REFERENCE ON THE AUDIT ROW  (OD-MP-2, governance §11)
-- ============================================================================
-- WHY A DEDICATED COLUMN IS REQUIRED
--   The governance audit found audit_log has no account reference. The
--   existing columns are insufficient for ACCOUNT_BINDING_CHANGED:
--     • target_user_id  — identifies the USER, not which of their accounts.
--                         A user may hold several trading accounts, so a
--                         binding row would be ambiguous.
--     • before_state /  — low-cardinality lifecycle values by existing
--       after_state       contract (a role name, a status). Stuffing a
--                         database id into them would overload a column whose
--                         meaning is established, which the brief forbids.
--     • credential_id   — identifies the SECRET, not the account it provisioned.
--     • provider        — a vocabulary value ('METAAPI'), not an instance.
--   So the smallest explicit addition is one nullable account reference.
--
-- WHY NO FOREIGN KEY  (same rationale as credential_id in migration 0011)
--   Account deletion is a hard DELETE (pgAccountStore.deleteForUser).
--     • ON DELETE CASCADE  → deleting the account would ERASE its binding
--                            history, destroying append-only audit durability.
--     • ON DELETE RESTRICT → the audit trail would BLOCK account deletion,
--                            making the security log a functional obstacle.
--     • ON DELETE SET NULL → an UPDATE against a table whose UPDATE privilege
--                            is revoked from every runtime role; it would fail
--                            at runtime (42501) even if it were desirable.
--   The column is therefore a HISTORICAL identifier, not a live reference: the
--   trail must outlive the account it describes.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS trading_account_id BIGINT;

-- Retrieval of one account's binding history, newest-first.
CREATE INDEX IF NOT EXISTS audit_log_trading_account_idx
  ON audit_log (trading_account_id, occurred_at DESC)
  WHERE trading_account_id IS NOT NULL;

-- ============================================================================
-- 3. DURABLE PROVISIONING OPERATIONS  (OD-MP-1)
-- ============================================================================
-- WHY A NEW TABLE, AND WHY `sync_reservations` CANNOT BE REUSED
--   sync_reservations (0012) is a LEASE over an account that already exists:
--   account_id is NOT NULL REFERENCES trading_accounts(id). A provisioning
--   operation must be durable BEFORE the provider call, and its whole purpose
--   is to survive the window in which no binding exists yet. It also has to
--   outlive the operation as evidence, whereas a reservation is released.
--   Different lifetime, different key, different invariant — reusing it would
--   conflate a lease with an operation record.
--
-- SHAPE follows the VERIFIED legacy `metaapi_operations` anchor
-- (v0.2_metaapi_bridge.sql:214-233) minus everything Modern does not need.
-- The legacy DEFECT (an undocumented Idempotency-Key header) is NOT copied:
-- idempotency here is Velora-internal and database-enforced.
CREATE TABLE IF NOT EXISTS provisioning_operations (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The Velora account this operation provisions for. NOT NULL: OD-MP-1
  -- authorizes binding an EXISTING user-owned account, never silent creation.
  account_id     BIGINT NOT NULL REFERENCES trading_accounts(id) ON DELETE CASCADE,
  -- Deterministic per (user, account, broker identity). THE idempotency key:
  -- a double-clicked request computes the same value and converges onto the
  -- same row instead of provisioning twice. Hex sha-256, never a secret.
  operation_key  TEXT NOT NULL CHECK (operation_key ~ '^[a-f0-9]{64}$'),
  -- Deterministic provider-side account NAME, used to reconcile an ambiguous
  -- outcome by searching the provider instead of blindly re-creating.
  -- CONTAINS NO SECRET: derived from the operation key only.
  provider_marker TEXT NOT NULL CHECK (provider_marker ~ '^velora-[a-f0-9]{32}$'),
  -- MetaAPI's documented 202-polling identity (D-7 / §2E). Random 32 chars,
  -- reused verbatim when polling an accepted-but-incomplete creation.
  -- It is NOT assumed to provide provider-side deduplication.
  transaction_id TEXT CHECK (transaction_id IS NULL OR transaction_id ~ '^[A-Za-z0-9]{32}$'),
  status         TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN (
      'PENDING',    -- reserved locally; provider not yet called
      'ACCEPTED',   -- provider returned 202; outcome not yet known
      'COMPLETED',  -- provider account created AND locally bound
      'AMBIGUOUS',  -- provider outcome unknown — MUST be reconciled, never retried blindly
      'FAILED'      -- provider terminally rejected the request
    )),
  -- Populated once the provider account id is known. Same charset as the
  -- 0013 trading_accounts CHECK so the two cannot disagree.
  provider_account_id TEXT
    CHECK (provider_account_id IS NULL OR provider_account_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  -- Non-secret failure classification. Never a provider message or body.
  last_error_code TEXT
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z_]{1,40}$'),
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- THE convergence invariant: one operation per (user, operation_key).
  -- A concurrent duplicate INSERT fails with 23505 across processes, which an
  -- application-level check-then-insert cannot guarantee.
  CONSTRAINT provisioning_operations_key_unique UNIQUE (user_id, operation_key),
  -- The marker must be unique so reconciliation can never match two operations.
  CONSTRAINT provisioning_operations_marker_unique UNIQUE (provider_marker)
);

-- Finding operations that need reconciliation without scanning history.
CREATE INDEX IF NOT EXISTS provisioning_operations_unresolved_idx
  ON provisioning_operations (status, updated_at)
  WHERE status IN ('PENDING', 'ACCEPTED', 'AMBIGUOUS');

COMMENT ON TABLE provisioning_operations IS
  'OD-MP-1 durable MetaAPI provisioning operations. Contains NO credential, no ciphertext and no token: operation_key and provider_marker are derived identifiers, transaction_id is the provider''s documented 202-polling identity.';
