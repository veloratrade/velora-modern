// Worker entrypoint — binds the runner to the pg-boss queue when a real
// PostgreSQL is configured.
//
// DEPLOYMENT STATUS (B10-a/B10-d): this process is NOT deployed anywhere.
// `railway.json` defines a single API service and does not start the worker.
// Adding a second service is an OWNER DEPLOYMENT DECISION and is deliberately
// NOT made here. This file supports local execution only:
//
//     DATABASE_URL=postgresql://... npm run start:worker
//
// The worker requires NO user credential of any kind (D-2, Boundary-Scoped
// Option B): it must never receive CREDENTIAL_MASTER_KEY, a broker password,
// or credential ciphertext. MetaAPI sync, when built, authenticates with the
// platform-level METAAPI_PLATFORM_TOKEN plus non-secret account identifiers.
import { WorkerRunner } from "./runner.js";
import { createPgBossQueue } from "./queue/pgBossAdapter.js";
import { safeLogFields } from "./observability/safeLog.js";
import { createHandlerRegistry } from "./handlers/registry.js";

// Explicit registration (B10-c). Currently EMPTY: no production job class is
// authorized yet — the first legitimate producer is MetaAPI sync, still gated
// on A-1 and D-3…D-7. A placeholder here would fake progress, not make it.
const registry = createHandlerRegistry();

const log = (e: Record<string, unknown>) => console.log(JSON.stringify(safeLogFields(e)));

if (process.env["DATABASE_URL"]) {
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

  const queue = await createPgBossQueue(process.env["DATABASE_URL"], {
    jobClasses: registry.jobClasses(),
  });

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
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  log({ level: "info", event: "worker.started", count: registry.size });
} else {
  console.error("worker: DATABASE_URL not set — nothing to do (no PostgreSQL configured)");
}
