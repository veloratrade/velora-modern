// API process entrypoint. BOOT IS FAIL-CLOSED (Phase B, S2/S8): kernel/boot.ts
// validates environment identity + origin binding (ADR-013) and the security
// configuration (S1/S2/S8) BEFORE anything starts. Any BLOCK finding — e.g.
// APP_ENV=production with PERSISTENCE=memory, a missing JWT_SECRET, or missing
// production configuration — logs the finding codes/messages (never values)
// and exits 1. Deterministic startup failure; never a silent fallback.
//
// Dev invocation (everything explicit — no implicit defaults):
//   APP_ENV=development APP_ORIGIN=http://127.0.0.1:8080 \
//   PERSISTENCE=memory JWT_SECRET=<32+ chars> \
//   npx tsx apps/api/src/server-main.ts
//
// Persistence posture (S8): when a durable store is configured, the DB probe
// connects lazily and reconnects on loss — the process stays up with RED
// readiness while the database is unavailable, and there is NO code path that
// could ever substitute memory persistence in staging/production (the boot
// gate rejects that configuration outright). The pg runtime dependency lands
// with Phase D; until then a configured DATABASE_URL without pg installed
// yields permanently-red readiness (honest failure, never a fabricated "ok").
import { createApp, listen } from "./kernel/server.js";
import { assertBootable, BootError } from "./kernel/boot.js";
import { AuthService } from "./auth/authService.js";
import { JwtService } from "./auth/jwt.js";
import { VeloraHasher } from "./auth/hashing.js";
import { MemoryUserStore } from "./auth/memoryUserStore.js";

type PgClient = import("pg").Client;

/** Lazily-connecting, self-healing database probe. Never fabricates "ok". */
function makeDbProbe(databaseUrl: string | undefined): () => Promise<"ok" | "fail"> {
  if (databaseUrl === undefined) {
    return async () => "fail"; // memory (dev-only) — readiness honestly red
  }
  let client: PgClient | null = null;
  let connected = false;
  return async () => {
    if (client === null) {
      try {
        const { Client } = (await import("pg")) as typeof import("pg");
        client = new Client({ connectionString: databaseUrl });
      } catch {
        return "fail"; // pg not installed (Phase D dependency) — fail closed
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
      await client.query("SELECT 1");
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
  };
}

async function main(): Promise<void> {
  let boot;
  try {
    boot = assertBootable(process.env);
  } catch (err) {
    if (err instanceof BootError) {
      console.error(
        JSON.stringify({
          level: "error",
          service: "api",
          event: "boot_blocked",
          blocking: err.findings
            .filter((f) => f.severity === "BLOCK")
            .map((f) => f.code),
          findings: err.findings,
        }),
      );
      process.exit(1); // deterministic startup failure
    }
    throw err;
  }
  for (const w of boot.warnings) {
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "api",
        event: "boot_warning",
        code: w.code,
        message: w.message,
      }),
    );
  }

  const dbProbe = makeDbProbe(boot.persistence.databaseUrl);
  const app = createApp({ allowedOrigins: boot.allowedOrigins, checks: { database: dbProbe } });
  const bound = await listen(app, boot.port);
  console.log(
    JSON.stringify({
      level: "info",
      service: "api",
      event: "startup",
      port: bound,
      environment: boot.environment,
      persistence: boot.persistence.kind,
      db: boot.persistence.databaseUrl ? "configured" : "missing",
    }),
  );
}

void main();
