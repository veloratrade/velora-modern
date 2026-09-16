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
-- 2. Schema access. Only the object owner may CREATE.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO app_readwrite, velora_worker, velora_migrator, velora_readonly;

-- NOTE — deliberately NO `GRANT CREATE ON SCHEMA public TO velora_migrator`.
-- Under the separated-owner model (ADR-010 amendment 2026-09-13) objects are
-- created by and owned by `velora_owner`; `velora_migrator` reaches CREATE only
-- by an explicit `SET ROLE velora_owner`. A direct CREATE grant here let the
-- migrator create objects it would then OWN, and a PostgreSQL owner implicitly
-- holds all privileges on its objects — reintroducing exactly the runtime DML
-- authority that D5 P13 forbids (VERIFIED: with the grant present, a bare
-- migrator `CREATE TABLE` produced a migrator-owned table).
--
-- The pre-migration bootstrap (`db/roles-bootstrap.sql`) still grants the
-- migrator `CREATE` so the very first migration can run in environments that do
-- not use `db/provision.ts` (the CI evidence path); `db/provision.ts` revokes it
-- again once `velora_owner` exists. This file must not re-grant it afterwards.

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
-- `audit_log` (C-34, migration 0009) is the security audit trail: the API
-- appends and reads it, and must never be able to rewrite or erase history.
-- This is the DATABASE layer of the append-only guarantee; the application
-- layer enforces the same rule independently by exposing no update/delete
-- method on the AuditStore port. velora_worker gets no access at all: no
-- background job records or reads privileged-action history.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_log      FROM app_readwrite, velora_worker;
REVOKE ALL                      ON TABLE audit_log      FROM velora_worker;
GRANT  INSERT, SELECT           ON TABLE audit_log      TO   app_readwrite;

-- `sync_fills` (D-6, migration 0012) is the MetaAPI import ledger: one durable
-- row per provider deal, which is what makes a replayed provider response
-- converge instead of double-counting. Provider-reported facts are evidence and
-- must never be rewritten, so the same append-only rule as `trade_events`
-- applies. Discharges the standing obligation in section 6: ALTER DEFAULT
-- PRIVILEGES would otherwise have auto-granted UPDATE/DELETE on this new table
-- to both runtime roles (B11).
-- The worker KEEPS INSERT/SELECT here: under D-2 sync is credential-free, and
-- writing fills is precisely the work it is authorized to do. This is NOT a
-- credential grant — `user_credentials` stays fully revoked below.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE sync_fills     FROM app_readwrite, velora_worker;

-- `sync_reservations` (D-6, migration 0012) is a mutable lease table, NOT a
-- ledger: releasing and reclaiming a stale lease are UPDATEs by design, so the
-- append-only rule deliberately does NOT apply. TRUNCATE is still revoked —
-- wiping live reservations would silently permit concurrent sync of one
-- account, defeating the invariant the table exists to enforce.
REVOKE TRUNCATE                 ON TABLE sync_reservations FROM app_readwrite, velora_worker;

-- `user_credentials` (C-22, migration 0010) holds AES-256-GCM ciphertext for
-- third-party integration secrets. The API owns the full lifecycle (create,
-- read, revoke), so app_readwrite keeps ordinary DML. velora_worker gets NO
-- access: no background job in this phase reads or writes integration secrets,
-- and the narrowest grant that satisfies the implementation is the correct one.
-- When a future worker genuinely needs them (C-29 sync), that phase must grant
-- exactly what it requires and justify it.
REVOKE ALL ON TABLE user_credentials FROM velora_worker;
-- Reporting/analytics must never read credential ciphertext or its envelope.
REVOKE ALL ON TABLE user_credentials FROM velora_readonly;

-- `provisioning_operations` (OD-MP-1, migration 0014) is the durable record of
-- MetaAPI provisioning attempts. It is written ONLY by the API-side
-- provisioning service, which is the single authorized consumer of a decrypted
-- user credential. Discharges the standing obligation recorded in section 5:
-- ALTER DEFAULT PRIVILEGES would otherwise have auto-granted full DML on this
-- new table to velora_worker (B11).
--
-- THE WORKER GETS NO ACCESS AT ALL. Under OD-MP-1 the sync worker is
-- credential-free: it receives a flat scalar payload carrying an already-bound
-- metaapi_account_id and never participates in provisioning. Reading this table
-- would tell a background job which users hold provider credentials and let it
-- observe provisioning state it has no business seeing; writing it could forge
-- the evidence that makes provisioning idempotent. Neither is work the worker
-- is authorized to do, so the narrowest correct grant is none.
REVOKE ALL ON TABLE provisioning_operations FROM velora_worker;
-- Reporting must not mine provisioning activity either: the row set reveals
-- which users connected which broker accounts and when. Analytics has no
-- legitimate need for provider-operation state.
REVOKE ALL ON TABLE provisioning_operations FROM velora_readonly;
-- The API may create and advance an operation, but never erase the evidence:
-- TRUNCATE would wipe exactly the durable record that prevents a lost provider
-- account after a local failure. UPDATE and DELETE are retained deliberately —
-- unlike a ledger, an operation is a state machine (PENDING → ACCEPTED →
-- COMPLETED/AMBIGUOUS/FAILED) whose progress is recorded in place, and
-- reconciliation must be able to close out a resolved row.
REVOKE TRUNCATE ON TABLE provisioning_operations FROM app_readwrite;

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

-- ---------------------------------------------------------------------------
-- 6. PG-BOSS QUEUE SCHEMA — least privilege for velora_worker.
--
--    EMPIRICALLY DERIVED, NOT ASSUMED. pg-boss's own documentation implies the
--    job-running role needs CREATE on the database (it self-migrates and
--    self-creates queue partitions). That is a large privilege for a process
--    whose whole purpose is to be the least-trusted identity in the system, so
--    the actual requirement was measured against pg-boss 10.4.2 on PostgreSQL
--    17.10 rather than accepted. Findings that shape this section:
--
--      - `start()` short-circuits when `pgboss.version` already exists, so the
--        worker never needs the install/upgrade DDL path.
--      - `createQueue()` short-circuits when the queue row already exists, so
--        with queues PRE-CREATED the worker never executes the partition DDL
--        (CREATE TABLE ... ATTACH PARTITION).
--      - runtime DML (send/fetch/complete/fail) targets the PARENT tables, so
--        no per-partition grant is needed.
--      - maintenance (expire/archive/drop) under `supervise: true` is DML on
--        `pgboss.job`/`pgboss.archive` only — VERIFIED over repeated ticks with
--        zero permission errors.
--
--    CONSEQUENCE: velora_worker runs pg-boss with **no CREATE on the database
--    and no CREATE on the pgboss schema** (both VERIFIED false at runtime).
--    Creating a NEW queue fails 42501 — deliberately: introducing a job class
--    is a deployment decision, not something a worker may do to itself.
--
--    PREREQUISITE (owner/bootstrap path — `db/provision.ts`, NOT a migration):
--    the pgboss schema, its objects, and every queue (including pg-boss's
--    internal `__pgboss__send-it`, used by the cron timekeeper) are created by
--    velora_owner before this file runs. This section only GRANTS.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') THEN
    -- Enter the schema, but never create in it.
    EXECUTE 'GRANT USAGE ON SCHEMA pgboss TO velora_worker';
    EXECUTE 'REVOKE CREATE ON SCHEMA pgboss FROM velora_worker';

    -- Job lifecycle: send, fetch, complete, fail, archive, maintain.
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO velora_worker';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO velora_worker';
    -- pg-boss calls its own helper functions (e.g. create_queue's guard path).
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO velora_worker';

    -- Future queue partitions created by the owner must be usable without
    -- re-running this file. Keyed to velora_owner because the owner is the
    -- creator under the separated-owner model.
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE velora_owner IN SCHEMA pgboss '
         || 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO velora_worker';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE velora_owner IN SCHEMA pgboss '
         || 'GRANT USAGE, SELECT ON SEQUENCES TO velora_worker';

    -- The API process does not run jobs; it must not reach into the queue.
    -- Read-only/reporting has no business in queue internals either.
    EXECUTE 'REVOKE ALL ON SCHEMA pgboss FROM velora_readonly';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA pgboss FROM velora_readonly';
  END IF;
END
$$;

-- NOTE on `sync_fills` (0012/0013): the append-only REVOKE in section 4 above
-- is deliberately left INTACT for the MetaAPI importer. The first draft of the
-- import path wanted UPDATE (to stamp `processing_state`/`processed_trade_id`
-- after folding a fill into a trade) and was refused by this grant at runtime
-- (VERIFIED 42501). The importer was restructured to compute the final state
-- BEFORE the insert and write each fill exactly once, rather than relaxing the
-- grant — provider evidence stays immutable, as B11/D-6 require.
