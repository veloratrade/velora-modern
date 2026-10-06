-- 0030_email_notifications.sql — MG-EMAIL-TYPES (audit §12.3): the
-- transactional-email delivery log, the login-device registry behind
-- new-device alerts, and the user_achievements ledger the achievement emails
-- key off. All three are capability ports of Legacy tables, not new models:
--
--   email_notifications  ← Legacy `_database/database_corrected.sql:164`
--                          (EmailNotificationRepository::log — every send
--                          attempt recorded with its honest outcome)
--   user_devices         ← EXTENDS 0001's existing table (Legacy `:533`:
--                          UserDeviceRepository::recordAndCheckNewDevice —
--                          sha256(ip|ua) fingerprint per user; first sighting ⇒
--                          new-device email). 0001 created the table for the
--                          admin console but nothing wrote to it (the recorded
--                          MG-DEVICE-TRACKING gap); this migration adds
--                          Legacy's ip/user-agent columns and the login path
--                          becomes its first writer.)
--   user_achievements    ← Legacy `:513` (UserAchievementRepository::unlock —
--                          idempotent via UNIQUE(user_id, achievement_key);
--                          email fires only on the FIRST unlock)
--
-- Column-level deltas are deliberate and mechanical: MySQL DATETIME →
-- TIMESTAMPTZ (ADR-004), UNSIGNED BIGINT ids → BIGINT IDENTITY (0001), utf8mb4
-- length caps → TEXT with length CHECKs (the caps themselves are preserved —
-- Legacy truncated, Modern rejects, so an over-long value fails loudly
-- instead of silently corrupting the log).
--
-- WHAT IS *NOT* PORTED: payload_json stays JSONB (Legacy longtext) — same
-- field, stronger typing. The event-type CHECK list is Legacy's exact ten
-- email types (plus the three statuses Legacy recorded).

CREATE TABLE IF NOT EXISTS email_notifications (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- WHO the email was about (the account, not the SMTP envelope — the desk
  -- inbox receives support tickets about users). NOT NULL like Legacy: every
  -- Legacy call site passes an owner id.
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Legacy's ten event types, verbatim (NotificationService call graph).
  event_type      TEXT NOT NULL CHECK (event_type IN (
                    'VERIFICATION_EMAIL', 'WELCOME_EMAIL', 'PASSWORD_RESET_LINK',
                    'ADMIN_INVITE', 'PASSWORD_CHANGED', 'NEW_DEVICE_DETECTED',
                    'FIRST_TRADE_RECORDED', 'ACHIEVEMENT_UNLOCKED',
                    'SUPPORT_NEW_TICKET', 'SUPPORT_FIRST_REPLY')),
  recipient_email TEXT NOT NULL CHECK (length(recipient_email) <= 255),
  subject         TEXT NOT NULL CHECK (length(subject) <= 255),
  payload_json    JSONB,
  -- Legacy statuses: queued (default) / sent / failed.
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  sent_at         TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  error_message   TEXT CHECK (error_message IS NULL OR length(error_message) <= 500),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_notifications_user_recent_idx
  ON email_notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS email_notifications_status_idx
  ON email_notifications (status);

-- The login-device registry: REUSE, not a second table (house rule). 0001
-- already created user_devices with UNIQUE(user_id, fingerprint) — the exact
-- constraint that closes Legacy's SELECT-then-INSERT race (two concurrent
-- logins can no longer produce two "new device" rows). What Legacy tracked
-- that 0001 did not: the ip/ua behind each fingerprint.
ALTER TABLE user_devices ADD COLUMN IF NOT EXISTS ip_address
  TEXT CHECK (ip_address IS NULL OR length(ip_address) <= 45);
ALTER TABLE user_devices ADD COLUMN IF NOT EXISTS user_agent
  TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 250);

-- The achievements ledger (port of Legacy user_achievements). UNIQUE makes
-- unlock idempotent at the storage boundary — the "first time only" that
-- gates the achievement email. Title/description live in metadata_json as
-- Legacy stored them (catalog KEYS, not translated text: the locale is
-- resolved at email time, so a user switching language still gets the
-- achievement named in their current locale).
CREATE TABLE IF NOT EXISTS user_achievements (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_key TEXT NOT NULL CHECK (length(achievement_key) <= 80),
  achieved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata_json   JSONB,
  CONSTRAINT user_achievements_unique_unlock UNIQUE (user_id, achievement_key)
);

CREATE INDEX IF NOT EXISTS user_achievements_user_idx
  ON user_achievements (user_id, achieved_at DESC);
