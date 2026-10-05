-- 0029 — METAAPI POSITION ASSEMBLY (MG-METAAPI-ASSEMBLY, audit §9.2).
--
-- Legacy (the authoritative capability, VERIFIED from
-- api/src/Accounts/MetaApiService.php + MetaApiFillRepository.php @ edede31)
-- reconciles CLOSED POSITIONS out of the durable fill ledger:
-- pendingPositionIds() → fillsForPosition() → MetaApiDealAssembler::assemble()
-- → insertExternalTrade (idempotent on `pos-<positionId>`) → markAggregated /
-- markSkipped(terminal). The per-position state machine is
-- received → aggregated | skipped(close_before_open|unknown_direction — the
-- only two reasons a later fill can never repair), and a NEW fill for a
-- position re-opens it as received.
--
-- Modern's `sync_fills` is APPEND-ONLY by a deliberate security control
-- (db/roles.sql §4, B11/D-6: provider evidence is never rewritten). This
-- migration does NOT relax that control. Instead the per-position WORKFLOW
-- state — which Legacy stored on the fill rows because it had no separate
-- place — moves to a dedicated mutable companion table, exactly like
-- `sync_reservations` (a lease/workflow table, not a ledger):
--
--   sync_fills          → immutable provider evidence (unchanged, append-only)
--   sync_position_state → the reconciliation state machine (mutable by design)
--
-- This preserves the Legacy capability (state machine, terminal-vs-repairable
-- skips, re-open on later fills, durable skip evidence for operators) while
-- keeping a control Legacy lacked: fill evidence rows are byte-immutable.
--
-- DESIGN NOTE — why state is not derived from trades: a trade row existing for
-- `pos-<id>` does imply aggregation, but terminal-skip evidence and the
-- received/aggregated/skipped distinction would then live nowhere, and every
-- sync run would re-assemble every never-closing position forever. Legacy
-- persists the assessment; so does Modern.
CREATE TABLE IF NOT EXISTS sync_position_state (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   BIGINT NOT NULL REFERENCES trading_accounts(id) ON DELETE CASCADE,
  -- Raw provider positionId (the `pos-` group key is derived, never stored).
  position_id  TEXT NOT NULL
    CHECK (position_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  -- Legacy MetaApiFillRepository state machine, verbatim vocabulary.
  state        TEXT NOT NULL DEFAULT 'received'
    CHECK (state IN ('received', 'aggregated', 'skipped')),
  -- Assembler skip reasons are Legacy's lowercase vocabulary (distinct from
  -- sync_fills.skip_reason's uppercase INGESTION codes by design).
  skip_reason  TEXT
    CHECK (skip_reason IS NULL OR skip_reason ~ '^[a-z0-9_]{1,64}$'),
  -- The assembled trade for an aggregated position. No ON DELETE CASCADE:
  -- the assessment record must outlive a tombstoned trade.
  trade_id     BIGINT REFERENCES trades(id) ON DELETE SET NULL,
  -- When reconciliation last assessed this position (any outcome).
  assessed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sync_position_state_unique UNIQUE (account_id, position_id),
  -- Shape invariants: skipped ⇒ reason; aggregated ⇒ trade; received ⇒ clean.
  CONSTRAINT sync_position_state_shape CHECK (
    (state = 'skipped'   AND skip_reason IS NOT NULL)
    OR (state = 'aggregated' AND trade_id IS NOT NULL)
    OR (state = 'received'   AND skip_reason IS NULL AND trade_id IS NULL)
  )
);

-- The reconciliation hot path: pending positions per account.
CREATE INDEX IF NOT EXISTS sync_position_state_pending_idx
  ON sync_position_state (account_id) WHERE state = 'received';
