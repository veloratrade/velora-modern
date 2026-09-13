-- Role bootstrap — Phase D D5. Run ONCE per environment, BEFORE migrations,
-- as a superuser / the platform's provisioning role.
--
-- Why this is a separate file from db/roles.sql:
--   `db/roles.sql` grants privileges on tables and therefore must run AFTER the
--   migration chain (defect D-1). But the migration role must EXIST and be able
--   to create objects BEFORE the first migration runs (defect D-5).
--
--   ⚠ OWNERSHIP (ADR-010 amendment, 2026-09-13): application objects are owned
--   by `velora_owner` (NOLOGIN), NOT by `velora_migrator`. A PostgreSQL owner
--   implicitly holds all privileges on its objects and they cannot be revoked,
--   so a migrator that owned the tables would inherently hold runtime DML —
--   contradicting D5 P13. `db/provision.ts` creates `velora_owner`, makes
--   `velora_migrator` a NOINHERIT member (WITH SET TRUE), and revokes the
--   migrator's direct CREATE. This file keeps that CREATE grant so the
--   bootstrap remains self-sufficient for the CI evidence path, which does not
--   run `db/provision.ts`.
--   Those two requirements sit on opposite sides of `db/migrate.ts`, so they
--   are two files with an explicit order:
--
--     1. db/roles-bootstrap.sql   (superuser, once per environment)  <- this file
--     2. npx tsx db/migrate.ts    (connected AS velora_migrator)
--     3. db/roles.sql             (after migrations; re-runnable)
--
-- CREDENTIALS: no passwords are set here. Each environment provisions login
-- credentials out-of-band (secret store / platform variables) — never in the
-- repository (AGENTS.md rule 1; D5 defect D-3). A role created LOGIN without a
-- password cannot authenticate over TCP under password auth; that is intended.
-- Assign one out-of-band, e.g. (NEVER committed, values from the secret store):
--     ALTER ROLE velora_migrator PASSWORD :'migrator_pw';
--
-- PORTABILITY: standard PostgreSQL only — no platform-specific assumptions.
-- On managed platforms (e.g. Railway) the provisioning role is typically the
-- database owner rather than a true superuser; every statement below works for
-- a role with CREATEROLE + database ownership.

-- 1. Roles (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'velora_migrator') THEN
    CREATE ROLE velora_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_readwrite') THEN
    CREATE ROLE app_readwrite LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'velora_worker') THEN
    CREATE ROLE velora_worker LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'velora_readonly') THEN
    CREATE ROLE velora_readonly LOGIN;
  END IF;
END $$;

-- 2. The migrator may create the initial schema; nobody else may CREATE.
--    (Under db/provision.ts this grant is revoked once velora_owner exists —
--     objects are then created via `SET ROLE velora_owner`.)
GRANT USAGE, CREATE ON SCHEMA public TO velora_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- 3. Runtime roles may enter the schema (object privileges come from roles.sql).
GRANT USAGE ON SCHEMA public TO app_readwrite, velora_worker, velora_readonly;

-- After this file: connect as velora_migrator and run db/migrate.ts, then run
-- db/roles.sql. Under the deploy path (db/provision.ts) the migrator assumes
-- `velora_owner` for DDL, so every migrated table is owned by velora_owner.
