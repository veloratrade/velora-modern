-- Database role separation — ADR-010 (Accepted, D-15).
-- Execute as a superuser/migrator once per environment BEFORE app deployment.
-- Least privilege by construction:
--   app_readwrite : API — owns row data; NO trade_events UPDATE/DELETE (append-only)
--   worker        : jobs/sync — row data + queue tables
--   migrator      : schema changes only (run migrations, then disconnect)
--   readonly      : analytics/reporting
-- NOTE: queue tables (pg-boss) are created by the migrator in a later migration;
-- grants for pgboss.* are included here with IF EXISTS guards.

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

GRANT USAGE ON SCHEMA public TO app_readwrite, velora_worker, velora_migrator, velora_readonly;

-- API role: full row DML; ledger events are append-only (no UPDATE/DELETE).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_readwrite;
REVOKE UPDATE, DELETE ON TABLE trade_events, webhook_events FROM app_readwrite;

-- Worker role: same row DML, also append-only on the ledger archive.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO velora_worker;
REVOKE UPDATE, DELETE ON TABLE trade_events, webhook_events FROM velora_worker;

-- Migrator: schema DDL.
GRANT CREATE ON SCHEMA public TO velora_migrator;

-- Readonly.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO velora_readonly;
