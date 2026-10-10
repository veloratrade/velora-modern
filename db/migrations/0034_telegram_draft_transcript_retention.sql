-- Voice transcripts are transient confirmation aids, not durable journal content.
-- Preserve confirmed trade fields/notes; discard only the separate transcript
-- once a draft can no longer be reviewed or acted on.
UPDATE telegram_journal_drafts
   SET transcript = NULL
 WHERE state IN ('CONFIRMED', 'CANCELLED', 'EXPIRED')
   AND transcript IS NOT NULL;

ALTER TABLE telegram_journal_drafts
  ADD CONSTRAINT telegram_journal_drafts_terminal_transcript_cleared
  CHECK (state NOT IN ('CONFIRMED', 'CANCELLED', 'EXPIRED') OR transcript IS NULL);
