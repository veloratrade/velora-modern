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
// gate rejects that configuration outright). PERSISTENCE=postgres boots the
// real-PostgreSQL adapters (Phase D D2): `pg` is a declared apps/api
// dependency and the four Pg* stores in this tree are the durable adapters.
import { createApp, listen } from "./kernel/server.js";
import { assertBootable, BootError } from "./kernel/boot.js";
import { AuthService } from "./auth/authService.js";
import { JwtService } from "./auth/jwt.js";
import { VeloraHasher } from "./auth/hashing.js";
import { MemoryUserStore } from "./auth/memoryUserStore.js";
import { PgUserStore } from "./auth/pgUserStore.js";
import { AccountService } from "./accounts/accountService.js";
import { MemoryAccountStore } from "./accounts/memoryAccountStore.js";
import { PgAccountStore } from "./accounts/pgAccountStore.js";
import { TradeService } from "./trades/tradeService.js";
import { MemoryTradeStore } from "./trades/memoryTradeStore.js";
import { PgTradeStore } from "./trades/pgTradeStore.js";
import { FixedWindowRateLimiter } from "./ratelimits/rateLimiter.js";
import { MemoryRateLimitStore } from "./ratelimits/memoryRateLimitStore.js";
import { PgRateLimitStore } from "./ratelimits/pgRateLimitStore.js";
import { EntitlementService } from "./entitlements/entitlementService.js";

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

  // Persistence wiring (Phase D D2, direct pg — no ORM, owner decision
  // 2026-09-13): PERSISTENCE=postgres boots the real-PostgreSQL adapters over
  // ONE shared pool; memory adapters remain the dev-only posture. The S8 boot
  // gate already rejects memory persistence outside development, so no code
  // path can substitute memory persistence in staging/production.
  let pool: import("pg").Pool | undefined;
  if (boot.persistence.kind === "postgres" && boot.persistence.databaseUrl !== undefined) {
    const { Pool } = (await import("pg")) as typeof import("pg");
    pool = new Pool({ connectionString: boot.persistence.databaseUrl });
    // Idle-client socket errors must never crash the process (S2/S8 posture:
    // stay up, readiness red, reconnect on the next probe).
    pool.on("error", (err: Error) => {
      console.error(
        JSON.stringify({ level: "error", service: "api", event: "pg_pool_error", message: err.message }),
      );
    });
  }
  const userStore = pool !== undefined ? new PgUserStore(pool) : new MemoryUserStore();
  const accountStore = pool !== undefined ? new PgAccountStore(pool) : new MemoryAccountStore();
  const tradeStore = pool !== undefined ? new PgTradeStore(pool) : new MemoryTradeStore();
  const rateLimitStore = pool !== undefined ? new PgRateLimitStore(pool) : new MemoryRateLimitStore();

  // Without a boot JWT secret every capability route stays fail-closed (503).
  const capabilities: { auth?: AuthService; accounts?: AccountService; trades?: TradeService } = {};
  if (boot.jwtSecret !== undefined) {
    capabilities.auth = new AuthService({
      store: userStore,
      hasher: new VeloraHasher(),
      jwt: JwtService.create(boot.jwtSecret),
    });
    // Plan lookup through the entitlement module — fail-closed (503 on store
    // errors, never a silent 'free') per the Remote EntitlementService invariant.
    const entitlements = new EntitlementService({
      findUserById: (userId) => userStore.findUserById(userId),
    });
    capabilities.accounts = new AccountService({
      store: accountStore,
      getPlan: (userId) => entitlements.getUserPlan(userId),
    });
    capabilities.trades = new TradeService({
      store: tradeStore,
      getUserTimezone: async (userId) => (await userStore.findUserById(userId))?.timezone ?? "UTC",
      verifyAccountOwnership: async (accountId, userId) =>
        (await accountStore.findByIdForUser(accountId, userId)) !== null,
    });
  }
  const app = createApp({
    allowedOrigins: boot.allowedOrigins,
    checks: { database: dbProbe },
    // D2: the limiter rides the configured persistence (PG store when
    // PERSISTENCE=postgres; per-app memory store otherwise — identical to the
    // createApp default in the memory posture).
    rateLimiter: new FixedWindowRateLimiter(rateLimitStore),
    ...capabilities,
  });
  // HOST: bind address for deployed environments (container platforms need
  // 0.0.0.0; default 127.0.0.1 preserves local-dev behavior).
  const bound = await listen(app, boot.port, process.env.HOST ?? "127.0.0.1");
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
