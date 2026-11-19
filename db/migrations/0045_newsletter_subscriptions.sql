-- 0045_newsletter_subscriptions.sql — Phase 3 feature (GAP-NL): newsletter backend.
--
-- Forward-only, additive (ADR-010). Creates the newsletter subscriptions table
-- behind POST /api/v1/newsletter/subscribe. Idempotent (IF NOT EXISTS).
--
-- Ownership of the new object moves to velora_owner via the Phase D provisioning
-- runner (db/provision.ts); this migration only creates it. No existing table,
-- column or row is modified.
--
CREATE TABLE IF NOT EXISTS newsletter_subscriptions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'subscribed'
                CHECK (status IN ('subscribed', 'unsubscribed', 'pending')),
  source        TEXT NOT NULL DEFAULT 'web',
  subscribed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT newsletter_subscriptions_email_unique UNIQUE (email)
);
