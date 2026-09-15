// Worker runner — enforces the ADR-007 job contract around ANY QueuePort:
// hard timeout, bounded retries (backoff handled by the queue), DLQ, and
// idempotent completion. Handlers receive the descriptor and must be
// idempotent under the idempotencyKey contract.
import type { QueuePort, QueuedJob } from "./queue/QueuePort.js";
import {
  classifyError,
  safeDlqReason,
  safeFailureEvent,
  type WorkerErrorCode,
} from "./observability/safeError.js";

export type JobHandler = (job: QueuedJob) => Promise<void>;
export type Logger = (event: Record<string, unknown>) => void;

export class WorkerRunner {
  constructor(
    private readonly queue: QueuePort,
    private readonly handlers: Map<string, JobHandler>,
    private readonly log: Logger = () => {},
  ) {}

  /** Claim and run one job. Returns the outcome (for tests and loop ticks). */
  async processOnce(): Promise<"idle" | "done" | "failed" | "timeout" | "no-handler"> {
    const job = await this.queue.claim();
    if (!job) return "idle";
    const handler = this.handlers.get(job.descriptor.jobClass);
    if (!handler) {
      await this.queue.deadLetter(job.id, safeDlqReason("NO_HANDLER", job.descriptor.jobClass));
      this.log({ level: "error", event: "job.no_handler", jobClass: job.descriptor.jobClass });
      return "no-handler";
    }
    const started = Date.now();
    try {
      await this.withTimeout(handler(job), job.descriptor.timeoutMs, job.id);
      await this.queue.complete(job.id);
      this.log({ level: "info", event: "job.done", jobClass: job.descriptor.jobClass, id: job.id, idempotencyKey: job.descriptor.idempotencyKey, durationMs: Date.now() - started });
      return "done";
    } catch (err) {
      const timedOut = err instanceof JobTimeoutError;
      await this.queue.fail(job.id); // queue applies retry/DLQ policy (ADR-007)
      // G-3: the raw error is NEVER logged. An integration failure can embed
      // the request that produced it — including a credential forwarded to a
      // provider — so only a code from the closed vocabulary is emitted.
      const code: WorkerErrorCode = timedOut ? "TIMEOUT" : classifyError(err);
      this.log(
        safeFailureEvent({
          event: timedOut ? "job.timeout" : "job.failed",
          jobClass: job.descriptor.jobClass,
          jobId: job.id,
          attempts: job.attempts + 1,
          code,
          durationMs: Date.now() - started,
        }),
      );
      return timedOut ? "timeout" : "failed";
    }
  }

  private withTimeout(p: Promise<void>, timeoutMs: number, jobId: string): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      const t = setTimeout(() => reject(new JobTimeoutError(jobId, timeoutMs)), timeoutMs);
      p.then(
        () => { clearTimeout(t); resolvePromise(); },
        (err) => { clearTimeout(t); reject(err); },
      );
    });
  }
}

export class JobTimeoutError extends Error {
  constructor(jobId: string, timeoutMs: number) {
    super(`job ${jobId} exceeded hard timeout ${timeoutMs}ms`);
  }
}
