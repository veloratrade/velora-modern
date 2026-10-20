-- 0038_telegram_channel_standby.sql — one more state for a bound channel: verified, not selected.
--
-- WHY THIS EXISTS
--   0023 made `ACTIVE` mean "the active mirror" and enforced exactly one per user
--   (`telegram_channels_one_active_per_user`, a partial unique index on status='ACTIVE'). That is
--   the right invariant for "where does my journal go?" — an ambiguous answer is worse than no
--   answer. But a user with two verified channels who wants to choose which one THIS post goes to
--   has nowhere to put the other one: the vocabulary is
--   PENDING_VERIFICATION | ACTIVE | REVOKED | INSUFFICIENT_PERMISSIONS, and every one of those says
--   something about VERIFICATION, not about SELECTION. Demoting the previously selected channel to
--   REVOKED would be a lie — nothing was revoked, the user still owns the binding, the bot is still
--   an admin there, and `revoked_at` plus the `telegram_channels_lifecycle` CHECK would assert a
--   revocation that did not happen.
--
-- WHAT CHANGED
--   `STANDBY` — verified and usable, deliberately not the default target. A STANDBY channel keeps
--   its `can_post` and `verified_at` exactly as they were: the state is about routing, so the
--   verification facts must survive it. Selecting it again re-checks permissions like anything else
--   (a permission can be removed while a channel waits), which the application does rather than the
--   schema, since 0023's server-observed `can_post` is already the field that records the verdict.
--
-- WHY THIS IS A WIDENING AND NOT A RELAXATION
--   The CHECK gains one accepted value; no existing row is read, rewritten or deleted, and no other
--   constraint changes. Every reader that treats `status = 'ACTIVE'` as the only writable state —
--   which is all of them — keeps working unchanged, because STANDBY falls on the same side of that
--   test as PENDING_VERIFICATION and REVOKED do. Making selection a SEPARATE boolean instead would
--   have created a second source of truth about where posts go, which is precisely the drift this
--   table's one-active index exists to prevent.
--
-- FORWARD-ONLY. No production database is touched by this file.

ALTER TABLE telegram_channels DROP CONSTRAINT IF EXISTS telegram_channels_status_check;
ALTER TABLE telegram_channels ADD CONSTRAINT telegram_channels_status_check
  CHECK (status IN ('PENDING_VERIFICATION', 'ACTIVE', 'REVOKED', 'INSUFFICIENT_PERMISSIONS', 'STANDBY'));

-- The state is only meaningful while the binding itself is intact, so a STANDBY row can never be a
-- row that was revoked and quietly kept. `revoked_at` belongs to REVOKED alone (0023's lifecycle
-- check already forces the pair); restating it here for the new value keeps the invariant explicit
-- rather than inherited from a comment.
ALTER TABLE telegram_channels ADD CONSTRAINT telegram_channels_standby_not_revoked
  CHECK (status <> 'STANDBY' OR revoked_at IS NULL);
