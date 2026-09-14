// Readiness probe for the durable store (deploy safety).
//
// Extracted from server-main.ts so the REAL implementation can be tested:
// server-main.ts self-executes on import and exports nothing, so a probe
// defined there can only ever be re-implemented by a test, which proves
// nothing about the shipped code.
//
// WHY SCHEMA-AWARE: `/health` is liveness-only and is what the platform
// healthcheck hits. A database that is reachable but UNMIGRATED answers
// `SELECT 1` happily, so connectivity-only readiness let a schema-less deploy
// pass every automated check while every capability failed. Readiness
// therefore also requires that the migration tracking table exists and records
// at least one applied migration.
//
// SCOPE (honest): this proves "a schema has been applied", NOT "the schema is
// at the newest revision". Head-equality is deliberately NOT checked here —
// `apps/api` cannot import the migration module (it lives outside this
// project's rootDir), and re-deriving the expected head here would create a
// second source of truth for it.

type PgClient = import("pg").Client;

/** Minimal surface the probe needs — lets tests inject a client. */
export interface ProbeClient {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
}

export interface DbProbeOptions {
  /** Client factory. Defaults to a real `pg` client for the given URL. */
  readonly createClient?: () => Promise<ProbeClient>;
  /** Structured warning sink. Defaults to console.error. */
  readonly warn?: (event: Record<string, unknown>) => void;
}

/**
 * Readiness probe. Holds a lazily-created connection for self-healing, so
 * `close()` releases it — required for deterministic test teardown and clean
 * shutdown (an open pg client keeps the event loop alive).
 */
export interface DbProbe {
  (): Promise<"ok" | "fail">;
  close(): Promise<void>;
}

export const SCHEMA_MISSING_MESSAGE =
  "Database is reachable but no applied migration was found. Run the migration step before serving traffic.";

/**
 * Lazily-connecting, self-healing database probe. Never fabricates "ok".
 * Returns "fail" for: no durable store configured, driver missing, connection
 * failure, missing migration tracking table, or an empty tracking table.
 */
export function makeDbProbe(
  databaseUrl: string | undefined,
  options: DbProbeOptions = {},
): DbProbe {
  if (databaseUrl === undefined) {
    const dead: DbProbe = async () => "fail"; // memory (dev-only) — honestly red
    dead.close = async () => {};
    return dead;
  }
  const warn =
    options.warn ??
    ((event: Record<string, unknown>) => {
      console.error(JSON.stringify(event));
    });
  const createClient =
    options.createClient ??
    (async (): Promise<ProbeClient> => {
      const { Client } = (await import("pg")) as typeof import("pg");
      const client: PgClient = new Client({ connectionString: databaseUrl });
      return client as unknown as ProbeClient;
    });

  let client: ProbeClient | null = null;
  let connected = false;
  let schemaWarned = false;

  const schemaMissing = (): "fail" => {
    if (!schemaWarned) {
      schemaWarned = true;
      // Distinguish "unreachable" from "reachable but unmigrated" for operators
      // without widening the public /ready contract. Never logs the DSN.
      warn({ level: "error", event: "readiness.schema_missing", message: SCHEMA_MISSING_MESSAGE });
    }
    return "fail";
  };

  const probe: DbProbe = (async () => {
    if (client === null) {
      try {
        client = await createClient();
      } catch {
        return "fail"; // driver unavailable — fail closed
      }
    }
    if (!connected) {
      try {
        await client.connect();
        connected = true;
      } catch {
        return "fail";
      }
    }
    try {
      // Connectivity AND schema presence. to_regclass is null when the table
      // does not exist, so this is one round trip with no error-handling games.
      const res = await client.query(
        "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS has_table",
      );
      if (res.rows[0]?.has_table !== true) return schemaMissing();
      const applied = await client.query("SELECT 1 FROM schema_migrations LIMIT 1");
      if (applied.rowCount === 0) return schemaMissing();
      return "ok";
    } catch {
      // Connection lost: mark dead, retry on the next probe. Readiness stays
      // red until the durable store returns — NO memory fallback exists.
      connected = false;
      const dead = client;
      client = null;
      try {
        await dead.end();
      } catch {
        // already dead — nothing to clean up
      }
      return "fail";
    }
  }) as DbProbe;

  probe.close = async () => {
    const open = client;
    client = null;
    connected = false;
    if (open !== null) {
      try {
        await open.end();
      } catch {
        // already closed — nothing to clean up
      }
    }
  };
  return probe;
}
