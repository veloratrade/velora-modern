// Worker entrypoint — binds the runner to the pg-boss queue when a real
// PostgreSQL is configured (dev/staging). In the sandbox no PG server exists,
// so this file is exercised only in a real environment.
import { WorkerRunner } from "./runner.js";
import { createPgBossQueue } from "./queue/pgBossAdapter.js";
import { safeLogFields } from "./observability/safeLog.js";

const handlers = new Map(); // job classes registered per Phase 2 capability waves

if (process.env.DATABASE_URL) {
  const queue = await createPgBossQueue(process.env.DATABASE_URL);
  // G-3: the sink emits only allow-listed fields. The runner already restricts
  // itself to safe values, and this is defence in depth: if a future call site
  // passes an unexpected field, it is dropped here rather than serialized.
  const runner = new WorkerRunner(queue, handlers, (e) => console.log(JSON.stringify(safeLogFields(e))));
  setInterval(() => void runner.processOnce(), 500);
} else {
  console.error("worker: DATABASE_URL not set — nothing to do (dev sandbox has no PostgreSQL)");
}
