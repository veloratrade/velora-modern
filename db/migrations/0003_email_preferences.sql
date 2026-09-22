-- 0003_email_preferences.sql — Phase C increment 2 (identity completion).
-- PHP email-preference categories (BUG-A9): 6 keys, all default ON, one row
-- per user (upsert semantics). PHP is the contract source here — Remote's
-- marketing_emails shape is an older divergence and is NOT ported.
-- Forward-only (ADR-010); no production database exists or is touched.

CREATE TABLE IF NOT EXISTS email_preferences (
  user_id                   BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  welcome_email             BOOLEAN NOT NULL DEFAULT TRUE,
  security_alerts           BOOLEAN NOT NULL DEFAULT TRUE,
  trade_notifications       BOOLEAN NOT NULL DEFAULT TRUE,
  weekly_report             BOOLEAN NOT NULL DEFAULT TRUE,
  monthly_report            BOOLEAN NOT NULL DEFAULT TRUE,
  achievement_notifications BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
