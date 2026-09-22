// Privilege provisioning runner — Phase D / Railway staging preparation.
//
// WHY THIS FILE EXISTS
// ====================
// `railway.json` previously ran only `db/migrate.ts`, so neither
// `db/roles-bootstrap.sql` nor `db/roles.sql` was ever applied outside CI: a
// deployed environment would run with a single all-powerful database user and
// none of the D5 least-privilege grid. Those two files are plain `.sql`, and a
// RAILPACK Node image has **no `psql` binary** (VERIFIED: the repo declares no
// postgres-client dependency and `infra/Dockerfile.api` installs none), so the
// SQL cannot be applied by the platform. This runner applies them over the
// `pg` driver that `apps/api` already depends on — no new dependency, no new
// infrastructure.
//
// OWNERSHIP MODEL (supersedes the "migrator owns every table" note in
// db/roles.sql, which was proven unsatisfiable — see below)
// ==========================================================================
//   velora_owner    — owns every application object. NOLOGIN: it is never a
//                     connection identity, only an ownership identity.
//   velora_migrator — LOGIN, runs migrations. NOINHERIT member of velora_owner,
//                     so it must explicitly `SET ROLE velora_owner` to perform
//                     DDL and holds **no implicit runtime DML**.
//   app_readwrite   — API runtime.
//   velora_worker   — worker runtime.
//   velora_readonly — analytics/reporting, SELECT only.
//
// Why velora_owner is required: PostgreSQL grants an object's owner all
// privileges on it implicitly, and that cannot be revoked
// (https://www.postgresql.org/docs/16/sql-grant.html). While `velora_migrator`
// owned the tables, D5 requirement P13 ("migrator holds NO runtime DML") was
// unsatisfiable by construction — VERIFIED locally: P13 failed with the
// migrator as owner and passes once ownership moves to `velora_owner`.
//
// Membership grants MUST use `WITH SET TRUE`. In PostgreSQL 16+ a membership
// created `WITH ADMIN OPTION` has `set_option = false` and `SET ROLE` is still
// refused (VERIFIED: this single detail moved the D5 battery from 6/18 to
// 17/18 during the staging rehearsal).
//
// CREDENTIALS: this file contains none and creates none. It reads connection
// strings from the environment only, and never logs them. Login passwords are
// assigned out-of-band from the platform secret store (AGENTS.md rule 1;
// D5 defect D-3).
//
// IDEMPOTENT: safe to run on every deploy (VERIFIED by re-running the whole
// sequence against an already-provisioned database).
//
// WHEN THIS RUNS (deployment contract — 2026-09-14)
// =================================================
// This runner is a PRIVILEGED, OUT-OF-BAND operation: it requires
// `ADMIN_DATABASE_URL`, a bootstrap/superuser connection. It is therefore
// **NOT** part of the application start command. `railway.json` starts the
// service with `db/migrate.ts && apps/api/src/server-main.ts` only, so the
// application runtime never needs — and must never hold — the privileged
// credential. (Chaining this runner into `startCommand` would force
// `ADMIN_DATABASE_URL` into the runtime environment of every app instance,
// defeating the separation this file exists to create.)
//
// Provisioning is an operator step run once per environment, and again after
// any restore (`infra/backup/` strips owners/privileges — VERIFIED in
// docs/evidence/PHASE-D-D5-ROLES.md §"Privileges survive restore?"):
//
//   ADMIN_DATABASE_URL=... ADMIN_DATABASE_ROLE=<bootstrap-role> \
//     npx tsx db/provision.ts --phase pre-migration
//   MIGRATION_DATABASE_URL=... npx tsx db/migrate.ts
//   ADMIN_DATABASE_URL=... ADMIN_DATABASE_ROLE=<bootstrap-role> \
//     npx tsx db/provision.ts --phase post-migration
//
// See docs/deployment-contract.md.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DB_DIR = import.meta.dirname;

/** Roles that receive runtime privileges from db/roles.sql. */
const RUNTIME_ROLES = ["app_readwrite", "velora_worker", "velora_readonly"] as const;

/**
 * Establishes the separated-owner model and the memberships the privilege
 * layer depends on. Runs as the platform/bootstrap superuser.
 *
 * Every statement is idempotent so redeploys are no-ops.
 */
function ownershipSql(bootstrapRole: string): string {
  const q = quoteIdent(bootstrapRole);
  return `
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'velora_owner') THEN
    CREATE ROLE velora_owner NOLOGIN;
  END IF;
END $$;

-- The owner is the only role permitted to create objects in the schema.
GRANT USAGE, CREATE ON SCHEMA public TO velora_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- The migrator may ASSUME the owner for DDL but does NOT inherit its rights,
-- so an unqualified migrator session has no implicit DML (D5 P13).
GRANT velora_owner TO velora_migrator WITH INHERIT FALSE, SET TRUE;
REVOKE CREATE ON SCHEMA public FROM velora_migrator;

-- The bootstrap role administers the schema and applies db/roles.sql. It needs
-- INHERIT on velora_migrator, otherwise "ALTER DEFAULT PRIVILEGES FOR ROLE
-- velora_migrator" in db/roles.sql fails with 42501 (VERIFIED).
GRANT velora_owner    TO ${q} WITH INHERIT TRUE,  SET TRUE;
GRANT velora_migrator TO ${q} WITH INHERIT TRUE,  SET TRUE;
GRANT app_readwrite   TO ${q} WITH INHERIT FALSE, SET TRUE;
GRANT velora_worker   TO ${q} WITH INHERIT FALSE, SET TRUE;
GRANT velora_readonly TO ${q} WITH INHERIT FALSE, SET TRUE;
`;
}

/**
 * Default privileges for objects created by velora_owner.
 *
 * db/roles.sql keys ALTER DEFAULT PRIVILEGES to velora_migrator, which was
 * correct only while the migrator owned the tables. Under the separated-owner
 * model velora_owner is the creator, so without this block a future migration
 * would produce tables with NO grants at all and the application could not read
 * them (VERIFIED: a probe table gave app_readwrite SELECT = false before this
 * block, true after).
 *
 * ⚠ RESIDUAL RISK (D5 P15b, unchanged): default privileges are table-type-wide,
 * so a FUTURE ledger/event table receives UPDATE/DELETE unless db/roles.sql
 * section 4 is extended with an explicit REVOKE for it.
 */
const DEFAULT_PRIVILEGES_SQL = `
ALTER DEFAULT PRIVILEGES FOR ROLE velora_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_readwrite;
ALTER DEFAULT PRIVILEGES FOR ROLE velora_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO velora_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE velora_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO velora_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE velora_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_readwrite, velora_worker;
`;

/**
 * Re-asserts the migrator's CREATE revocation.
 *
 * `db/roles-bootstrap.sql` deliberately grants `velora_migrator` CREATE on the
 * schema so it stays self-sufficient for environments that never run this file
 * (the CI evidence path). In the deploy path that grant must not survive: once
 * `velora_owner` exists, the migrator reaches DDL only via `SET ROLE`. Anything
 * that re-applies the bootstrap afterwards (a redeploy, or the D5 battery
 * fixture, which re-runs it per test) would otherwise silently restore CREATE
 * and let the migrator create objects it would then OWN — reintroducing the
 * implicit-owner DML that D5 P13 forbids. Re-asserting it here makes the end
 * state independent of execution order.
 */
const REVOKE_MIGRATOR_CREATE_SQL = `
REVOKE CREATE ON SCHEMA public FROM velora_migrator;
`;

/** Re-asserts ownership of objects an earlier deploy may have created. */
const REASSIGN_SQL = `
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p','v','m','S')
      AND pg_get_userbyid(c.relowner) <> 'velora_owner'
  LOOP
    EXECUTE format(
      CASE r.relkind
        WHEN 'S' THEN 'ALTER SEQUENCE public.%I OWNER TO velora_owner'
        WHEN 'v' THEN 'ALTER VIEW public.%I OWNER TO velora_owner'
        WHEN 'm' THEN 'ALTER MATERIALIZED VIEW public.%I OWNER TO velora_owner'
        ELSE 'ALTER TABLE public.%I OWNER TO velora_owner'
      END, r.relname);
  END LOOP;
END $$;
`;

/** Minimal identifier quoting — role names come from config, never user input. */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error("provision: refusing to interpolate an unsafe role identifier");
  }
  return `"${name}"`;
}

export interface ProvisionOptions {
  /** Superuser/bootstrap connection string. Never logged. */
  readonly adminUrl: string;
  /** Role name of the bootstrap connection (Railway: POSTGRES_USER). */
  readonly bootstrapRole: string;
  /** Apply post-migration grants (db/roles.sql). */
  readonly phase: "pre-migration" | "post-migration";
}

/**
 * Queue classes this installation runs. Pre-creating them is what lets
 * velora_worker operate with NO CREATE privilege at all (see db/roles.sql §6).
 *
 * `__pgboss__send-it` is pg-boss's INTERNAL cron queue: its timekeeper
 * createQueue()s it on start and SWALLOWS the failure, so without pre-creation
 * the scheduler would silently never fire. It is listed explicitly for that
 * reason — omitting it is a silent-failure trap, not a harmless detail.
 */
export const PGBOSS_QUEUES = [
  // MetaAPI sync (v0.2/v2.0)
  "metaapi.sync-account",
  "metaapi.sync-tick",
  // FX reference rates (v1.5) — scheduled since pass 2, but never pre-created:
  // the worker role holds no CREATE privilege, so a scheduled job whose queue
  // does not exist cannot run. (Pass-3 finding: the omission was silent.)
  "fx.ecb-rates",
  "fx.ecb-tick",
  // Async analytics pre-aggregation (roadmap §3)
  "analytics.recompute-daily",
  "analytics.recompute-tick",
  // Copy-trading dispatch (v2.5). The tick and the handler are only SCHEDULED
  // when a transport is configured, but the queues are created here for the same
  // reason as the FX pair above.
  "copy.signal-dispatch",
  "copy.signals-tick",
  "velora.dlq",
  "__pgboss__send-it",
] as const;

/**
 * Create the pg-boss schema and queues as velora_owner.
 *
 * WHY HERE AND NOT IN A MIGRATION: the queue schema is operational
 * infrastructure, not application schema. Migrations run as velora_migrator
 * (which holds no CREATE on the database after provisioning) and are versioned
 * application state; pg-boss owns its own schema version and upgrades it
 * itself. Running its DDL from a migration would fork that ownership.
 *
 * The admin connection creates the schema (velora_owner is NOLOGIN and cannot
 * CREATE SCHEMA itself — VERIFIED: "permission denied for database"), then
 * hands authorship to velora_owner so every object inside is owner-owned.
 */
async function provisionPgBoss(client: {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}): Promise<void> {
  const PgBoss = (await import("pg-boss")).default;
  await client.query("CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION velora_owner");

  // getConstructionPlans emits the full install DDL without connecting.
  // Guarded by to_regclass so a re-run is a no-op rather than an error —
  // provisioning must be idempotent.
  const installed = (await client.query(
    "SELECT to_regclass('pgboss.version') IS NOT NULL AS ok",
  )) as { rows: Array<{ ok: boolean }> };
  if (installed.rows[0]?.ok !== true) {
    // The plans open with `CREATE SCHEMA IF NOT EXISTS pgboss`. PostgreSQL
    // checks CREATE on the DATABASE for that statement even when the schema
    // already exists, and velora_owner deliberately does not hold it
    // (VERIFIED: "permission denied for database"). The schema was just
    // created above by the admin connection WITH AUTHORIZATION velora_owner,
    // so the statement is redundant — it is removed rather than papered over
    // by granting the owner a database-wide CREATE it never otherwise needs.
    const plans = PgBoss.getConstructionPlans("pgboss")
      .replace(/CREATE SCHEMA IF NOT EXISTS pgboss\s*;/i, "");
    // Everything that remains is executed AS velora_owner, so every pgboss
    // object ends up owner-owned — the precondition for the grant model in
    // db/roles.sql §6.
    await client.query(`SET LOCAL ROLE velora_owner; ${plans}`);
  }

  // Queues are a row plus a partition; create_queue short-circuits when the
  // row exists, so re-running is a no-op. SET ROLE is issued separately: a
  // parameterized statement cannot carry multiple commands, and the partition
  // must be created BY the owner for the roles.sql grants to apply.
  await client.query("SET ROLE velora_owner");
  try {
    for (const name of PGBOSS_QUEUES) {
      await client.query("SELECT pgboss.create_queue($1, $2::json)", [
        name,
        JSON.stringify({ name }),
      ]);
    }
  } finally {
    await client.query("RESET ROLE");
  }
}

/**
 * pre-migration  : roles-bootstrap.sql + separated-owner model + memberships
 * post-migration : ownership re-assert + pgboss bootstrap + roles.sql + default privileges
 */
export async function provision(opts: ProvisionOptions): Promise<string[]> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: opts.adminUrl });
  await client.connect();
  const steps: string[] = [];
  try {
    if (opts.phase === "pre-migration") {
      await client.query(readFileSync(join(DB_DIR, "roles-bootstrap.sql"), "utf8"));
      steps.push("roles-bootstrap.sql");
      await client.query(ownershipSql(opts.bootstrapRole));
      steps.push("ownership-model");
    } else {
      await client.query(REASSIGN_SQL);
      steps.push("reassign-ownership");
      // The pgboss schema + queues must exist BEFORE roles.sql, because
      // roles.sql only GRANTS on them (its DO block is a no-op when the schema
      // is absent). This is the owner/bootstrap path — the only place
      // authorized to create queue infrastructure.
      await provisionPgBoss(client);
      steps.push("pgboss-bootstrap");
      await client.query(readFileSync(join(DB_DIR, "roles.sql"), "utf8"));
      steps.push("roles.sql");
      await client.query(DEFAULT_PRIVILEGES_SQL);
      steps.push("default-privileges");
      await client.query(REVOKE_MIGRATOR_CREATE_SQL);
      steps.push("revoke-migrator-create");
    }
  } finally {
    await client.end();
  }
  return steps;
}

/** Reports whether the runtime roles can actually be used. Never prints URLs. */
export async function verifyGrid(adminUrl: string): Promise<Record<string, boolean>> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const res = await client.query<{ k: string; v: boolean }>(`
      SELECT 'app_rw_select_trades'      AS k, has_table_privilege('app_readwrite','trades','SELECT')        AS v
      UNION ALL SELECT 'app_rw_insert_trade_events', has_table_privilege('app_readwrite','trade_events','INSERT')
      UNION ALL SELECT 'app_rw_update_trade_events', has_table_privilege('app_readwrite','trade_events','UPDATE')
      UNION ALL SELECT 'worker_delete_webhook_events', has_table_privilege('velora_worker','webhook_events','DELETE')
      UNION ALL SELECT 'readonly_insert_trades',      has_table_privilege('velora_readonly','trades','INSERT')
      UNION ALL SELECT 'migrator_select_users',       has_table_privilege('velora_migrator','users','SELECT')
      UNION ALL SELECT 'migrator_create_on_schema',    has_schema_privilege('velora_migrator','public','CREATE')
      UNION ALL SELECT 'all_objects_owned_by_owner',
        NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S')
                      AND pg_get_userbyid(c.relowner) <> 'velora_owner')
    `);
    return Object.fromEntries(res.rows.map((r) => [r.k, r.v]));
  } finally {
    await client.end();
  }
}

// CLI: npx tsx db/provision.ts --phase pre-migration|post-migration
if (process.argv[1] && process.argv[1].endsWith("provision.ts")) {
  const phaseArg = process.argv.includes("--phase")
    ? process.argv[process.argv.indexOf("--phase") + 1]
    : undefined;
  if (phaseArg !== "pre-migration" && phaseArg !== "post-migration") {
    console.error("provision: --phase must be 'pre-migration' or 'post-migration'");
    process.exit(2);
  }
  // ADMIN_DATABASE_URL is the bootstrap/superuser connection. It is deliberately
  // a DIFFERENT variable from DATABASE_URL so the application runtime never
  // holds the privileged credential (the API reads only DATABASE_URL).
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) {
    console.error("provision: ADMIN_DATABASE_URL not set — refusing to guess a privileged connection");
    process.exit(2);
  }
  const bootstrapRole = process.env.ADMIN_DATABASE_ROLE ?? "postgres";
  const steps = await provision({ adminUrl, bootstrapRole, phase: phaseArg });
  console.log(JSON.stringify({ event: "provision", phase: phaseArg, applied: steps }));
  if (phaseArg === "post-migration") {
    const grid = await verifyGrid(adminUrl);
    console.log(JSON.stringify({ event: "privilege_grid", grid }));
    const expected: Record<string, boolean> = {
      app_rw_select_trades: true,
      app_rw_insert_trade_events: true,
      app_rw_update_trade_events: false,
      worker_delete_webhook_events: false,
      readonly_insert_trades: false,
      migrator_select_users: false,
      // The migrator must NOT hold a direct CREATE grant: an object it created
      // would be migrator-OWNED, and an owner implicitly holds all privileges
      // on its objects (not revocable) — reintroducing the runtime DML that
      // D5 P13 forbids. DDL is reached only via `SET ROLE velora_owner`.
      migrator_create_on_schema: false,
      // Every table/view/sequence in `public` must be owned by velora_owner.
      // This is the ownership assertion the original D5 battery never made.
      all_objects_owned_by_owner: true,
    };
    const bad = Object.entries(expected).filter(([k, v]) => grid[k] !== v);
    if (bad.length > 0) {
      console.error(`provision: privilege grid FAILED for ${bad.map(([k]) => k).join(", ")}`);
      process.exit(1);
    }
    console.log(JSON.stringify({ event: "privilege_grid_ok", checks: Object.keys(expected).length }));
  }
}
