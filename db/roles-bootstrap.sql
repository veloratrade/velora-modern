-- Role bootstrap — Phase D D5. Run ONCE per environment, BEFORE migrations,
-- as a superuser / the platform's provisioning role.
--
-- Why this is a separate file from db/roles.sql:
--   `db/roles.sql` grants privileges on tables and therefore must run AFTER the
--   migration chain (defect D-1). But the migrator role must EXIST and OWN the
--   schema BEFORE the first migration runs (defect D-5, ownership model B-4).
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

-- 2. The migrator owns and evolves the schema; nobody else may CREATE.
GRANT USAGE, CREATE ON SCHEMA public TO velora_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- 3. Runtime roles may enter the schema (object privileges come from roles.sql).
GRANT USAGE ON SCHEMA public TO app_readwrite, velora_worker, velora_readonly;

-- After this file: connect as velora_migrator and run db/migrate.ts, so that
-- every migrated table is owned by velora_migrator. Then run db/roles.sql.
