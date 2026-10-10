-- A claimed Telegram update may start side effects at most once. If a worker
-- crashes after this marker, the row remains visible for reconciliation and a
-- pg-boss replay becomes a no-op rather than repeating an external action.
ALTER TABLE telegram_updates
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

-- Preserve existing completed rows while bringing them under the new lifecycle
-- invariant. No message content is read or introduced by this backfill.
UPDATE telegram_updates
   SET processing_started_at = COALESCE(processed_at, received_at)
 WHERE processed_at IS NOT NULL
   AND processing_started_at IS NULL;

ALTER TABLE telegram_updates
  DROP CONSTRAINT IF EXISTS telegram_updates_processing_lifecycle;
ALTER TABLE telegram_updates
  ADD CONSTRAINT telegram_updates_processing_lifecycle
  CHECK (processed_at IS NULL OR processing_started_at IS NOT NULL);

-- This is the manual-reconciliation worklist: processing began but no terminal
-- outcome was recorded before the process stopped.
CREATE INDEX IF NOT EXISTS telegram_updates_started_unprocessed_idx
  ON telegram_updates (processing_started_at)
  WHERE processed_at IS NULL AND processing_started_at IS NOT NULL;
