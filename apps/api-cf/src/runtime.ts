// The second composition root: the same API kernel, wired for Cloudflare Workers.
//
// WHAT THIS IS NOT. It is not a second API. Routing, authentication, RBAC, the JSON envelope, the
// security headers and every handler decision live in `apps/api` and are reached through ONE call —
// `createRequestListener(config)` — exactly as the Node server reaches them. This file only answers the
// question the Node entry point answers inline: which services exist in THIS deployment.
//
// FAIL-CLOSED BY CONSTRUCTION. `ApiConfig`'s capabilities are optional and the kernel already answers
// 503 on a route whose capability is absent (that is the documented posture, tested in
// `apps/api/src/kernel/server.test.ts`). So the admin panel's needs are wired here — auth, sessions,
// the admin user surface, the admin console — and everything else says "not configured in this
// deployment" instead of pretending. A route that silently 200s with empty data would be worse than a
// 503, because the panel would render a checked-and-clean lie.
//
// WHY THE DATABASE IS HYPERDRIVE. `velora-pg-nonprod` already fronts the staging Neon database for the
// Telegram Worker; a Worker has no TCP stack for `pg` to open a socket on, and reusing the proven
// config means one place to rotate a password instead of two.
import { assertBootable, BootError } from "../../api/src/kernel/boot.js";
import { createRequestListener, type ApiConfig } from "../../api/src/kernel/server.js";
import { adaptListener } from "./nodeHttpBridge.js";
import { poolFor, POOL_MAX, type PoolLike } from "../../worker-cf/src/pgHyperdrive.js";
import { poolQuery } from "../../api/src/persistence/pg.js";
import { PgUserStore } from "../../api/src/auth/pgUserStore.js";
import { PgAuthEventStore } from "../../api/src/auth/pgAuthEventStore.js";
import { PgOwnershipStore } from "../../api/src/auth/pgOwnershipStore.js";
import { PgAuditStore } from "../../api/src/auth/pgAuditStore.js";
import { PgAdminConsoleStore } from "../../api/src/admin/adminConsoleStore.js";
import { AuthService } from "../../api/src/auth/authService.js";
import { WorkersHasher } from "./workersHasher.js";
import { JwtService } from "../../api/src/auth/jwt.js";
import { AdminUserService } from "../../api/src/auth/adminUserService.js";
import { OwnershipService } from "../../api/src/auth/ownershipService.js";
import { AdminConsoleService } from "../../api/src/admin/adminConsoleService.js";
import { FixedWindowRateLimiter } from "../../api/src/ratelimits/rateLimiter.js";
import { PgRateLimitStore } from "../../api/src/ratelimits/pgRateLimitStore.js";
import { LogMailProvider } from "../../api/src/mail/logMailProvider.js";
import { ResendMailProvider } from "../../api/src/mail/resendMailProvider.js";
import type { MailPort } from "../../api/src/mail/mailPort.js";
import { NotificationService } from "../../api/src/notifications/notificationService.js";
import { PgAchievementStore, PgDeviceRegistry, PgEmailNotificationLog } from "../../api/src/notifications/pgNotificationStores.js";

/** The bindings this Worker needs. Everything here is a NAME; no value is ever read from a request. */
export interface Env {
  readonly HYPERDRIVE: { readonly connectionString: string };
  readonly APP_ENV?: string;
  readonly APP_ORIGIN?: string;
  readonly CANONICAL_STAGING_ORIGINS?: string;
  readonly CANONICAL_PRODUCTION_ORIGINS?: string;
  readonly JWT_SECRET?: string;
  readonly RESEND_API_KEY?: string;
  readonly SUPPORT_NOTIFY_EMAIL?: string;
  /** The browser origins the API will answer for CORS/CSRF purposes. Named as the kernel names it. */
  readonly API_ALLOWED_ORIGINS?: string;
  readonly PERSISTENCE?: string;
}

/**
 * The env record `assertBootable` validates.
 *
 * Two values are DERIVED rather than configured, and both for the same reason — the Worker reaches
 * Postgres through a binding, not a URL:
 *
 *   - `DATABASE_URL` is the Hyperdrive connection string. The boot gate (SC-006) refuses
 *     `PERSISTENCE=postgres` without one, and it is right to: a staging process that cannot name its
 *     database must not start. Deriving it from the binding means the connection string lives in ONE
 *     place (the Hyperdrive config, where the password is rotated) instead of being duplicated as a
 *     Worker secret that drifts.
 *   - `PERSISTENCE` defaults to `postgres` here, because a Worker host with a Hyperdrive binding IS
 *     postgres-backed — there is no memory mode to fall back to. An explicit value still wins, so the
 *     gate can still refuse a contradiction.
 */
const asRecord = (env: Env): Record<string, string | undefined> => {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  const connectionString = env.HYPERDRIVE?.connectionString ?? "";
  if ((out.DATABASE_URL ?? "") === "" && connectionString !== "") out.DATABASE_URL = connectionString;
  if ((out.PERSISTENCE ?? "") === "") out.PERSISTENCE = "postgres";
  return out;
};

/**
 * Build the kernel's configuration for this deployment.
 *
 * `assertBootable` is the SAME gate the Node process runs: it refuses an environment/origin mismatch
 * (ADR-013) and returns the canonical origin plus the trusted-proxy list. Reusing it means the Worker
 * cannot be configured into a state the Node server would reject.
 */
export function buildApiConfig(env: Env, pool: PoolLike): { config: ApiConfig; boot: ReturnType<typeof assertBootable> } {
  const boot = assertBootable(asRecord(env));

  // The `as never` hops are the same ones `apps/worker-cf/src/runtime.ts` makes and for the same
  // reason: these stores are typed against `pg`'s `Pool`, while Hyperdrive speaks `postgres.js`
  // through `PoolLike`. The surface they use (`query(text, values) → { rows }`, `connect`, `end`) is
  // satisfied by both drivers, and `poolQuery` is the single seam that translates one to the other.
  const q = poolQuery(pool as never);
  // ONE hasher for this host, and it is NOT the Node one: `VeloraHasher` hashes with `hash-wasm`, which a
  // deployed Worker refuses ("Wasm code generation disallowed by embedder" — measured on staging
  // 2026-10-20, where registration 500'd and login could not have rehashed). `WorkersHasher` produces the
  // identical `$argon2id$v=19$m=19456,t=2,p=1$…` encoding in pure TypeScript, and
  // `workersHasher.test.ts` proves the two verify each other's output in both directions.
  const userStore = new PgUserStore(pool as never);
  const authEventStore = new PgAuthEventStore(pool as never);
  const ownershipStore = new PgOwnershipStore(pool as never);
  const auditStore = new PgAuditStore(pool as never);
  const achievements = new PgAchievementStore(pool as never);
  const devices = new PgDeviceRegistry(pool as never);

  // ONE mail provider for the whole deployment. The log provider never claims delivery and never
  // prints a body — a reset link is a bearer credential — so a staging deployment with no mail
  // configured sends nothing and says so, rather than silently dropping the reset it just "sent".
  const resendKey = (env.RESEND_API_KEY ?? "").trim();
  const mail: MailPort = resendKey === "" ? new LogMailProvider() : new ResendMailProvider({ apiKey: resendKey });

  const notifications = new NotificationService({
    mail,
    log: new PgEmailNotificationLog(pool as never),
    appOrigin: boot.appOrigin,
    ...((env.SUPPORT_NOTIFY_EMAIL ?? "").trim() === ""
      ? {}
      : { supportDeskEmail: (env.SUPPORT_NOTIFY_EMAIL as string).trim() }),
  });

  const config: ApiConfig = {
    allowedOrigins: boot.allowedOrigins,
    checks: {
      // A real round trip, not a liveness flag: the panel's health tab is only useful if "ok" means
      // the database answered a query on this request.
      database: async () => {
        try {
          await pool.query("SELECT 1");
          return "ok";
        } catch {
          return "fail";
        }
      },
    },
    rateLimiter: new FixedWindowRateLimiter(new PgRateLimitStore(pool as never)),
    trustedProxyCidrs: boot.trustedProxyCidrs,
  };

  // No JWT secret ⇒ no auth surface at all, and the kernel's login route answers 503 instead of
  // authenticating against a secret that does not exist. That is the Node server's rule too; this
  // host inherits it rather than re-deciding it.
  if (boot.jwtSecret !== undefined) {
    const adminUsers = new AdminUserService({
      store: userStore,
      getSystemOwnerUserId: async () => (await ownershipStore.getOwnership())?.ownerUserId ?? null,
      audit: auditStore,
    });
    const auth = new AuthService({
      store: userStore,
      hasher: new WorkersHasher(),
      jwt: JwtService.create(boot.jwtSecret),
      mail,
      authEvents: authEventStore,
      appOrigin: boot.appOrigin,
      notifications,
      devices,
      achievements,
    });
    Object.assign(config, {
      auth,
      authEvents: authEventStore,
      ownership: new OwnershipService({
        ownership: ownershipStore,
        users: userStore,
        hasher: new WorkersHasher(),
        audit: auditStore,
      }),
      adminUsers,
      achievements,
      // The admin console's migration expectation: `null` in a Worker (no filesystem to count the
      // manifest from), which the console reports as UNKNOWN rather than inventing a number. The SAME
      // value the Node server produces when its migration directory is unreadable — the console has
      // always had to handle it, so this is a supported state, not a degraded one.
      adminConsole: {
        console: new AdminConsoleService({ store: new PgAdminConsoleStore(q, null), users: adminUsers }),
        users: adminUsers,
      },
    });
  }

  return { config, boot };
}

/**
 * The fetch entry point for one request.
 *
 * A pool is created per request and released through `ctx.waitUntil` once the response is written. That
 * is deliberate for Hyperdrive: the pooler owns the real connections, a client per request is the
 * documented shape, and holding sockets in an isolate that may never serve another request only leaks
 * them. `waitUntil` (not a bare promise) is required — the socket belongs to this request's context,
 * and a close that lands after the response is refused by workerd.
 */
export function createFetch(
  env: Env,
  ctx?: { waitUntil(promise: Promise<unknown>): void },
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const pool = poolFor(env.HYPERDRIVE.connectionString, { HYPERDRIVE: env.HYPERDRIVE }, POOL_MAX, (promise) => {
      if (ctx !== undefined) ctx.waitUntil(promise);
      else void promise;
    });
    let config: ApiConfig;
    try {
      config = buildApiConfig(env, pool).config;
    } catch (error) {
      // A boot refusal is a CONFIGURATION answer, not a crash. The finding CODES are public
      // information (they are documented in `@velora/contracts`); the environment VALUES that
      // produced them are not and never appear here.
      if (error instanceof BootError) {
        const codes = error.findings.filter((f) => f.severity === "BLOCK").map((f) => f.code);
        const response = Response.json(
          {
            status: "error",
            data: null,
            error: { code: "BOOT_BLOCKED", message: `boot blocked: ${codes.join(", ")}`, requestId: "boot" },
            timestamp: new Date().toISOString(),
          },
          { status: 503 },
        );
        const close = pool.end().catch(() => undefined);
        if (ctx !== undefined) ctx.waitUntil(close);
        return response;
      }
      throw error;
    }
    const handler = adaptListener(createRequestListener(config));
    try {
      return await handler(request);
    } finally {
      const close = pool.end().catch(() => undefined);
      if (ctx !== undefined) ctx.waitUntil(close);
      else void close;
    }
  };
}
