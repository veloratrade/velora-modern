-- 0006_rbac_roles.sql — Phase 3B-3 (application RBAC, OD-9).
--
-- 0001_core.sql created users.role as:
--     role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin'))
-- OD-9 freezes the application role set as user | admin | super_admin, so the
-- CHECK must admit the third value. This migration widens that ONE constraint
-- and changes nothing else.
--
-- SCOPE / SAFETY:
--   - Forward-only (ADR-010), additive, idempotent on re-run.
--   - Constraint WIDENING only: every value accepted before is still accepted,
--     so every existing row ('user' / 'admin') remains valid. No row is read,
--     rewritten, deleted or re-interpreted; the DEFAULT is unchanged ('user').
--   - No column is added, dropped or retyped. No other table is touched.
--   - APPLICATION roles only. These are NOT the ADR-010 PostgreSQL identities
--     (velora_owner, velora_migrator, app_readwrite, velora_worker,
--     velora_readonly), which live in db/roles.sql and are NOT modified here.
--     A super_admin application user gains NO database privilege whatsoever.
--   - No production database exists or is touched by this file.
--
-- The DROP/ADD pair follows the convention established by 0005 for forward-only
-- constraint widening (trade_events_type_check).

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('user', 'admin', 'super_admin'));
