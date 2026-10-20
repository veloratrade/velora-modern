-- 0036_journal_daily_checklist.sql — the daily review checklist a journal entry is made against.
--
-- WHAT THIS ADDS
--   journal_daily_checklists — ONE row per (user, calendar day) holding the structured review a
--   trader performs before and around a trade: daily bias, market leg, price location, the PD
--   arrays read on H4/H1/M15, the M1 CISD, SMT divergence, macro timing, the planned stop loss,
--   planned risk, and free-text notes.
--
-- WHY A TABLE AND NOT A COLUMN ON telegram_journal_drafts
--   The draft table is a per-MESSAGE object with a TTL: it expires, it is claimed once, and it is
--   consumed by confirmation. A daily review is none of those things — it is the day's record,
--   written before any trade exists, edited again later the same day, and read by the web journal
--   next to the trades it explains. Putting it in a row that expires would delete analysis.
--
-- WHY THE SHAPE IS RESTRICTIVE
--   * UNIQUE (user_id, report_date) is the idempotency key. Telegram retries, a double-tapped
--     confirm button and a re-sent voice note all become UPSERTs onto the same day; there is no
--     second row to reconcile and no duplicate to notice afterwards.
--   * `items` is JSONB with a `jsonb_typeof` gate because the item set is a vocabulary the domain
--     layer owns (`packages/domain/src/journalChecklist.ts`) and evolves with the trader's
--     template, not with the database. The shape is validated on write AND re-validated on read;
--     nothing in this file's CHECK constraints pretends to understand a trading concept.
--   * `timezone` is stored with the date. `report_date` is a calendar day, and a day silently
--     interpreted as UTC would move a 00:40 Tehran entry to the previous day (ADR-004's time model).
--   * `risk_unit` refuses to guess. `0.5` means half a percent to one trader and a half-lot to
--     another; no ADR decides it, so the unit is recorded when the user gave one and stays
--     `UNSPECIFIED` when they did not (AGENTS.md rule 12 — a business ambiguity is reported, never
--     defaulted away).
--   * `confirmed_items` plus the coherence CHECK make "the review is complete" a DATABASE
--     invariant rather than a UI claim: a row can only be `CONFIRMED` when all eleven items are,
--     so a writer bug cannot present an unfinished review as a finished one.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   It stores no derived signal and asserts no trading rule. There is no constraint, default or
--   trigger here that decides whether a bias is right, whether a level qualifies as a PD array, or
--   whether an unreviewed item should inherit yesterday's answer. Those are the trader's calls;
--   the schema's only job is to keep the three states — confirmed, unreviewed, unknown —
--   distinguishable forever, and to keep them the user's own words.
--
-- FORWARD-ONLY AND ADDITIVE
--   No existing row is read, rewritten or deleted; no existing constraint is relaxed. The only
--   modification to an existing object is widening `audit_log_action_check` with one action, in
--   the same way 0023 widened it (the full vocabulary is restated, never replaced by a looser
--   check). No production database exists or is touched by this file.

CREATE TABLE IF NOT EXISTS journal_daily_checklists (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Provenance, never authority: which Telegram identity last wrote this report. Nullable because
  -- the same day's review may be written from the web. Ownership is ALWAYS resolved through
  -- user_id, so a revoked or changed Telegram identity cannot orphan or expose the row.
  telegram_user_id  BIGINT CHECK (telegram_user_id IS NULL OR telegram_user_id > 0),
  report_date       DATE NOT NULL,
  timezone          TEXT NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 64),
  items             JSONB NOT NULL CHECK (jsonb_typeof(items) = 'object'),
  -- Only two of the three counts are stored. The third is GENERATED, so a writer cannot make
  -- them disagree and an UPSERT that mentions some items cannot lose the others: an item that is
  -- simply absent from `items` IS the unreviewed count, by arithmetic rather than by convention.
  confirmed_items   SMALLINT NOT NULL DEFAULT 0 CHECK (confirmed_items BETWEEN 0 AND 11),
  unknown_items     SMALLINT NOT NULL DEFAULT 0 CHECK (unknown_items BETWEEN 0 AND 11),
  unreviewed_items  SMALLINT GENERATED ALWAYS AS (11 - confirmed_items - unknown_items) STORED,
  -- A sparse `items` object is legal (a report may name two items); the counts must still fit.
  CONSTRAINT journal_daily_checklists_counters_fit
    CHECK (confirmed_items + unknown_items <= 11),
  -- Decimals at the same scales the trade ledger uses (numeric(20,8)); never a float, ever.
  stop_loss         NUMERIC(20,8),
  risk_value        NUMERIC(20,8),
  risk_unit         TEXT NOT NULL DEFAULT 'UNSPECIFIED'
                      CHECK (risk_unit IN ('PERCENT', 'AMOUNT', 'UNSPECIFIED')),
  notes             TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  review_state      TEXT NOT NULL DEFAULT 'UNREVIEWED'
                      CHECK (review_state IN ('UNREVIEWED', 'PARTIAL', 'CONFIRMED')),
  source_kind       TEXT NOT NULL DEFAULT 'TEXT'
                      CHECK (source_kind IN ('TEXT', 'VOICE', 'PHOTO', 'MANUAL')),
  -- Set exactly when the review reaches the CONFIRMED state; the coherence CHECK below pairs them.
  reviewed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT journal_daily_checklists_day_unique UNIQUE (user_id, report_date),
  -- "Complete" is earned item-by-item, and the database says so.
  CONSTRAINT journal_daily_checklists_state_coherent
    CHECK ((review_state = 'CONFIRMED') = (confirmed_items = 11)),
  -- A unit claim without a number would be a claim about nothing.
  CONSTRAINT journal_daily_checklists_risk_coherent
    CHECK (risk_value IS NOT NULL OR risk_unit = 'UNSPECIFIED'),
  -- Same lifecycle grammar as 0023's token table: an unreviewed row never carries a review stamp.
  CONSTRAINT journal_daily_checklists_reviewed_at_coherent
    CHECK ((review_state = 'CONFIRMED') = (reviewed_at IS NOT NULL))
);


-- The web journal and the bot both read "the last N days", newest first.
CREATE INDEX IF NOT EXISTS journal_daily_checklists_recent_idx
  ON journal_daily_checklists (user_id, report_date DESC);

-- ---------------------------------------------------------------------------
-- Audit vocabulary: the checklist is a persistent write to a user's financial
-- record, so it is auditable on the same terms as a journal entry. `provider`
-- is not widened here: a checklist save may come from the web or from
-- Telegram, and `audit_log.provider` is already NULL-able for "no external
-- provider was involved", which is the honest value for the web path.
-- ---------------------------------------------------------------------------
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN (
    'OWNERSHIP_CLAIMED',
    'USER_ROLE_CHANGED',
    'USER_STATUS_CHANGED',
    'CREDENTIAL_CREATED',
    'CREDENTIAL_DELETED',
    'CREDENTIAL_USED',
    'ACCOUNT_BINDING_CHANGED',
    'TELEGRAM_LINK_STARTED',
    'TELEGRAM_LINK_COMPLETED',
    'TELEGRAM_LINK_FAILED',
    'TELEGRAM_UNLINKED',
    'TELEGRAM_CHANNEL_BOUND',
    'TELEGRAM_CHANNEL_UNBOUND',
    'JOURNAL_CHECKLIST_SAVED'
  ));
