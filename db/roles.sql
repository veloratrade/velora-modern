-- Database role separation — ADR-010 (Accepted, D-15); verified in Phase D D5.
--
-- ============================================================================
-- EXECUTION ORDER (D5 fix for defect D-1 — this file is NOT pre-migration)
-- ============================================================================
-- Run this file **AFTER** the migration chain has been applied, as a role that
-- can administer privileges (the bootstrap/owner role for the environment):
--
--     1. bootstrap roles      : db/roles-bootstrap.sql   (superuser, once)
--     2. migrations           : npx tsx db/migrate.ts    (as velora_migrator)
--     3. this file            : db/roles.sql             (after migrations)
--
-- Rationale: the append-only REVOKEs below name `trade_events` and
-- `webhook_events`, which are created by `0001_core.sql`. Executing this file
-- before the migrations fails with `relation "trade_events" does not exist`
-- (VERIFIED by execution, D5). The previous header instruction ("BEFORE app
-- deployment") was incoherent for that reason and has been corrected.
--
-- This file is idempotent and may be re-run after every migration deployment;
-- doing so is the supported way to (re)assert the privilege grid.
--
-- ============================================================================
-- OWNERSHIP MODEL — SUPERSEDED (Railway staging preparation)
-- ============================================================================
-- ⚠ The model described in this block ("velora_migrator OWNS the application
-- schema") was proven UNSATISFIABLE against D5 requirement P13 and has been
-- replaced by the separated-owner model implemented in `db/provision.ts`:
--
--     velora_owner    owns every application object (NOLOGIN)
--     velora_migrator NOINHERIT member of velora_owner; must SET ROLE to do
--                     DDL, therefore holds NO implicit runtime DML
--
-- Reason: PostgreSQL grants an object's owner all privileges implicitly and
-- that cannot be revoked. While the migrator owned the tables, P13
-- ("velora_migrator holds NO runtime DML") could never pass on a non-superuser
-- connection. VERIFIED: P13 fails with migrator-as-owner, passes once
-- ownership moves to velora_owner (full battery 18/18).
--
-- The D5 CI evidence (run 34768881278) passes 18/18 because the workflow
-- connects as a SUPERUSER and applies this file AFTER migrations, so every
-- table ends up owned by that superuser and a superuser's SET ROLE masks the
-- owner-privilege problem. That run remains valid as PRIVILEGE-GRID evidence;
-- it is NOT evidence for the ownership model.
--
-- Historical description retained below for traceability:
-- `velora_migrator` OWNS the application schema. Migrations run as that role,
-- so every table it creates is owned by it. This is required because the right
-- to ALTER/DROP an object is inherent in the owner and is NOT grantable
-- (PostgreSQL 16/17 GRANT docs); migrations 0002/0004/0005 issue ALTER TABLE
-- statements, so a migrator holding only `CREATE ON SCHEMA` cannot maintain the
-- schema (VERIFIED: `ERROR: must be owner of table users`).
--
-- Note: ownership CANNOT be retrofitted from a bootstrap superuser with
-- `REASSIGN OWNED BY` (VERIFIED: "cannot reassign ownership of objects owned by
-- role velora_test because they are required by the database system"). The
-- migrator must own the schema from the first migration onward.
--
-- ============================================================================
-- LEAST PRIVILEGE BY CONSTRUCTION
-- ============================================================================
--   velora_migrator : owns + evolves the schema (DDL). Not an app runtime role.
--   app_readwrite   : API — row DML; ledger/event tables are append-only
--                     (INSERT allowed; UPDATE/DELETE revoked)
--   velora_worker   : jobs/sync — row DML; same append-only restriction
--   velora_readonly : analytics/reporting — SELECT only
--
-- CREDENTIALS: this file deliberately sets NO passwords. Login credentials are
-- provisioned out-of-band per environment (secret store / platform variables)
-- and never live in the repository (D5 defect D-3; AGENTS.md rule 1).
--
-- SCOPE: no pg-boss/queue grants are defined here. The previous header claimed
-- `pgboss.*` grants "included with IF EXISTS guards" — no such statements ever
-- existed (defect D-4). Queue privileges belong with the pg-boss work
-- (ADR-007), which is NOT in Phase D scope; the false claim is removed rather
-- than silently implemented.

-- ---------------------------------------------------------------------------
-- 1. Roles (idempotent; NOLOGIN→LOGIN capability without credentials).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_readwrite') THEN
    CREATE ROLE app_readwrite LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'velora_worker') THEN
    CREATE ROLE velora_worker LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'velora_migrator') THEN
    CREATE ROLE velora_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'velora_readonly') THEN
    CREATE ROLE velora_readonly LOGIN;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Schema access. Only the migrator may CREATE.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO app_readwrite, velora_worker, velora_migrator, velora_readonly;
GRANT CREATE ON SCHEMA public TO velora_migrator;

-- Deny-by-default hygiene: PostgreSQL grants CREATE on `public` to PUBLIC in
-- versions < 15. Harmless on 15+ (already revoked); required on older servers.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 3. Runtime DML on the tables that exist right now.
--    (`ALL TABLES` is a point-in-time snapshot — future tables are handled in
--    section 5. This is defect D-2.)
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_readwrite;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO velora_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO velora_readonly;

-- ---------------------------------------------------------------------------
-- 4. APPEND-ONLY LEDGER ENFORCEMENT (ADR-002 / ADR-008; D1 risk R9).
--    Events may be appended and read, never rewritten or erased.
--    NOTE: this is the DATABASE privilege layer only. Business-semantic /
--    staged ledger enforcement is OD-9 → Phase E and is NOT implemented here.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE trade_events   FROM app_readwrite, velora_worker;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE webhook_events FROM app_readwrite, velora_worker;

-- `schema_migrations` is migrator-owned bookkeeping: runtime roles never write it.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE schema_migrations FROM app_readwrite, velora_worker;

-- ---------------------------------------------------------------------------
-- 5. FUTURE TABLES (defect D-2 fix) — ALTER DEFAULT PRIVILEGES.
--    Keyed to velora_migrator for the historical/CI path. Under the
--    separated-owner model velora_owner is the creator, so `db/provision.ts`
--    applies an EQUIVALENT block keyed to velora_owner after this file.
--    Without that block a future migration would create tables with NO grants
--    (VERIFIED: probe table gave app_readwrite SELECT = false).
--
--    ⚠ DELIBERATE RESIDUAL RISK (documented, not silently accepted):
--    default privileges are table-type-wide — a FUTURE ledger/event table would
--    receive UPDATE/DELETE for app_readwrite/velora_worker unless this file is
--    extended with an explicit REVOKE for it (as section 4 does). Any migration
--    introducing a new append-only table MUST add its REVOKE here. VERIFIED by
--    execution in D5 (`future_events` received UPDATE=true).
-- ---------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE velora_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_readwrite;
ALTER DEFAULT PRIVILEGES FOR ROLE velora_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO velora_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE velora_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO velora_readonly;

-- Sequences: every PK here is `BIGINT GENERATED ALWAYS AS IDENTITY`, whose
-- implicit sequence is permission-linked to its parent table, so no sequence
-- USAGE grant is required today. Declared for future explicit sequences.
ALTER DEFAULT PRIVILEGES FOR ROLE velora_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_readwrite, velora_worker;
