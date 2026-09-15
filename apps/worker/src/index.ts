// Worker entrypoint — binds the runner to the pg-boss queue when a real
// PostgreSQL is configured.
//
// DEPLOYMENT STATUS (B10-a/B10-d): this process is STILL NOT deployed anywhere.
// `railway.json` defines a single API service and does not start the worker,
// and Railway's config-as-code has no `services` key, so a second service
// cannot be declared in-repo. That remains an OWNER DEPLOYMENT DECISION and is
// deliberately NOT made here. This file supports local execution only:
//
//     DATABASE_URL=postgresql://... METAAPI_PLATFORM_TOKEN=... npm run start:worker
//
// CREDENTIAL BOUNDARY (D-2, Boundary-Scoped Option B). This process reads
// exactly two environment secrets, both listed below and nothing else:
//     DATABASE_URL            — its own least-privilege role (velora_worker)
//     METAAPI_PLATFORM_TOKEN  — installation-level platform token
// It must NEVER receive CREDENTIAL_MASTER_KEY, a broker login, an investor
// password, or credential ciphertext, and it never imports the credential
// store. Per-account authority comes from the NON-SECRET `metaapi_account_id`.
import { Pool } from "pg";
import { WorkerRunner } from "./runner.js";
import { createPgBossQueue } from "./queue/pgBossAdapter.js";
import { safeLogFields } from "./observability/safeLog.js";
import { createHandlerRegistry } from "./handlers/registry.js";
import { createMetaApiSyncHandler } from "./handlers/metaApiSyncHandler.js";
import { METAAPI_SYNC_JOB_CLASS } from "@velora/contracts";
import type { MetaApiSyncPayload } from "@velora/contracts";
import { runSyncTick, SYNC_TICK_JOB_CLASS, DEFAULT_SYNC_CRON } from "./scheduler/syncScheduler.js";

// Explicit registration (B10-c). MetaAPI historical sync is the first — and
// currently only — authorized production job class.
const registry = createHandlerRegistry();

const log = (e: Record<string, unknown>) => console.log(JSON.stringify(safeLogFields(e)));

const databaseUrl = process.env["DATABASE_URL"];
const platformToken = process.env["METAAPI_PLATFORM_TOKEN"] ?? "";

if (databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });

  // The handler is registered only when the platform token is actually
  // present. A worker that cannot authenticate to MetaAPI must not claim jobs
  // it is guaranteed to fail — with no token the registry stays empty and the
  // fail-loud branch below stops the process with a clear reason.
  if (platformToken.trim() !== "") {
    registry.register<MetaApiSyncPayload>(
      METAAPI_SYNC_JOB_CLASS,
      createMetaApiSyncHandler({
        pool,
        platformToken,
        // Instance identity for the reservation row. Non-secret by
        // construction: a hostname/pid, never a credential.
        holder: `worker:${process.env["HOSTNAME"] ?? "local"}:${process.pid}`,
      }),
    );
  } else {
    log({ level: "warn", event: "worker.token_absent", count: 0 });
  }

  if (registry.size === 0) {
    // Fail loudly rather than idling forever looking healthy. pg-boss v10 needs
    // concrete queue names to poll, so a worker with no registered class has
    // nothing to create, nothing to claim, and no reason to run.
    log({ level: "error", event: "worker.no_handlers", count: 0 });
    console.error(
      "worker: no job classes registered — refusing to start an idle worker. " +
        "Register a handler in apps/worker/src/handlers/registry.ts.",
    );
    process.exit(1);
  }

  // Both the work queue and the scheduler-tick queue must exist. Under the
  // least-privilege model the worker has NO CREATE, so these are pre-created
  // by the owner bootstrap path (db/provision.ts); naming them here only
  // tells the adapter which queues to poll.
  const queue = await createPgBossQueue(databaseUrl, {
    jobClasses: [...registry.jobClasses(), SYNC_TICK_JOB_CLASS],
  });

  // --- Scheduled producer (pg-boss NATIVE cron) ---------------------------
  // `schedule()` upserts a row in `pgboss.schedule` (pure DML — the worker
  // role is granted exactly that, and no CREATE). pg-boss's timekeeper fires
  // the cron through its internal `__pgboss__send-it` queue with
  // singletonSeconds=60, so a duplicated tick is debounced by the library.
  const tickHandler = async (): Promise<void> => {
    const n = await runSyncTick(pool, queue);
    log({ level: "info", event: "scheduler.tick", count: n });
  };
  registry.register(SYNC_TICK_JOB_CLASS, tickHandler);

  try {
    await queue.schedule(SYNC_TICK_JOB_CLASS, DEFAULT_SYNC_CRON);
    log({ level: "info", event: "scheduler.registered", jobClass: SYNC_TICK_JOB_CLASS });
  } catch (err) {
    // A missing schedule must not take the worker down: it still serves jobs
    // enqueued by any other authorized producer. Code only, never the error.
    log({ level: "warn", event: "scheduler.unavailable", errorCode: "UNKNOWN" });
    void err;
  }

  // G-3: the sink emits only allow-listed fields. The runner already restricts
  // itself to safe values; this is defence in depth, so an unexpected field
  // from a future call site is dropped rather than serialized.
  const runner = new WorkerRunner(queue, registry.toHandlerMap(), log);
  const timer = setInterval(() => void runner.processOnce(), 500);

  // Graceful shutdown: release the lease loop and pg-boss's connections so a
  // restart does not wait for leases to expire.
  const shutdown = async (signal: string) => {
    log({ level: "info", event: "worker.shutdown", service: signal });
    clearInterval(timer);
    await queue.stop();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  log({ level: "info", event: "worker.started", count: registry.size });
} else {
  console.error("worker: DATABASE_URL not set — nothing to do (no PostgreSQL configured)");
}
