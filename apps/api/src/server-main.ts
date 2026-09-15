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
import { AdminUserService } from "./auth/adminUserService.js";
import { OwnershipService } from "./auth/ownershipService.js";
import { MemoryOwnershipStore } from "./auth/memoryOwnershipStore.js";
import { PgOwnershipStore } from "./auth/pgOwnershipStore.js";
import { MemoryAuditStore } from "./auth/memoryAuditStore.js";
import { PgAuditStore } from "./auth/pgAuditStore.js";
import { resolveCredentialKey } from "./credentials/credentialConfig.js";
import { MemoryCredentialStore } from "./credentials/memoryCredentialStore.js";
import { PgCredentialStore } from "./credentials/pgCredentialStore.js";
import type { CredentialStore } from "./credentials/credentialStore.js";
import { CredentialService } from "./credentials/credentialService.js";
import { makeDbProbe } from "./kernel/dbProbe.js";
import type { MailPort } from "./mail/mailPort.js";
import { ResendMailProvider } from "./mail/resendMailProvider.js";
import { LogMailProvider } from "./mail/logMailProvider.js";


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

  // C-41 — outbound transactional email.
  //
  // Provider selection is explicit and has no silent third state: with
  // RESEND_API_KEY set the real HTTPS adapter is used; without it the offline
  // LogMailProvider keeps an in-memory outbox. The log adapter does NOT claim
  // delivery to any external system and never prints message bodies (reset and
  // verification links are bearer-equivalent secrets), so nothing here can be
  // mistaken for a real send. The key itself is read from the environment,
  // passed straight to the adapter, and never logged, echoed or stored.
  const resendApiKey = process.env.RESEND_API_KEY;
  const mail: MailPort =
    resendApiKey !== undefined && resendApiKey.trim() !== ""
      ? new ResendMailProvider({ apiKey: resendApiKey })
      : new LogMailProvider();
  // Provider NAME only — never the key, and never the message contents.
  console.log(JSON.stringify({ level: "info", event: "mail.provider", provider: mail.name }));

  // Without a boot JWT secret every capability route stays fail-closed (503).
  // C-22 store; B-1 wraps it in a CredentialService and exposes authenticated
  // self-service routes. The store itself is still never handed to createApp —
  // only the service is — so the route layer cannot reach reveal()/findById()
  // and no secret-disclosure path exists over HTTP.
  let credentialStore: CredentialStore | undefined;
  const capabilities: {
    auth?: AuthService;
    accounts?: AccountService;
    trades?: TradeService;
    adminUsers?: AdminUserService;
    ownership?: OwnershipService;
    credentials?: CredentialService;
  } = {};
  if (boot.jwtSecret !== undefined) {
    capabilities.auth = new AuthService({
      store: userStore,
      hasher: new VeloraHasher(),
      jwt: JwtService.create(boot.jwtSecret),
      mail,
      // Verification/reset links must point at this environment's validated
      // origin (ADR-013); boot already guarantees it is present and canonical.
      appOrigin: boot.appOrigin,
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
    // Installation ownership (System Owner) and the admin user surface. The
    // admin service resolves the owner from AUTHORITATIVE STORAGE so the owner
    // can never be suspended or demoted through user management.
    const ownershipStore =
      pool !== undefined ? new PgOwnershipStore(pool) : new MemoryOwnershipStore();
    // C-34: one append-only audit trail shared by every privileged mutation.
    const auditStore = pool !== undefined ? new PgAuditStore(pool) : new MemoryAuditStore();
    capabilities.ownership = new OwnershipService({
      ownership: ownershipStore,
      users: userStore,
      hasher: new VeloraHasher(),
      audit: auditStore,
    });
    capabilities.adminUsers = new AdminUserService({
      store: userStore,
      getSystemOwnerUserId: async () => (await ownershipStore.getOwnership())?.ownerUserId ?? null,
      audit: auditStore,
    });

    // C-22 encrypted credential store. FAIL-CLOSED: without a valid
    // CREDENTIAL_MASTER_KEY the capability is simply ABSENT — it is never
    // constructed with a generated key and never degrades to plaintext, so a
    // misconfigured deployment cannot silently store unencrypted secrets.
    // B-1 exposes authenticated self-service routes over this store; B-3 makes
    // create/delete emit audit events in the same transaction. There is still
    // no reveal route, so no secret-disclosure path exists over HTTP.
    const credentialKey = resolveCredentialKey(process.env);
    if (credentialKey.key !== null) {
      credentialStore =
        pool !== undefined
          ? new PgCredentialStore(pool, credentialKey.key)
          : new MemoryCredentialStore(credentialKey.key);
      // B-1: the authenticated access layer. Only constructed when a valid key
      // produced a store, so a misconfigured deployment leaves the routes
      // fail-closed (503) instead of exposing an unusable capability.
      capabilities.credentials = new CredentialService({
        store: credentialStore,
        // B-3: the same append-only trail used by every other privileged
        // mutation. Credential create/delete and their audit rows commit in
        // ONE transaction.
        audit: auditStore,
      });
      // Key VERSION only — never the key, never a credential.
      console.log(
        JSON.stringify({
          level: "info",
          event: "credentials.enabled",
          keyVersion: credentialKey.key.version,
        }),
      );
    } else {
      // CODES and fixed messages only; the configured value is never logged.
      for (const f of credentialKey.findings) {
        console.log(
          JSON.stringify({
            level: "warn",
            event: "credentials.disabled",
            code: f.code,
            message: f.message,
          }),
        );
      }
    }
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
