// Telegram update job handler — the worker half of MG-TG-3.
//
// TARGET ARCHITECTURE
//   Telegram update → API/webhook boundary → pg-boss → Worker → Telegram journal processing
//
// WHAT THIS HANDLER OWNS (and only this):
//   1. RE-VALIDATING the payload. The queue persists the update as a JSON
//      string; a job row can outlive the code that wrote it, so the frozen
//      contract schema is re-applied here rather than trusting the producer.
//      A payload that cannot be parsed is TERMINAL — retrying cannot fix it —
//      so it is classified and dead-lettered instead of looping.
//   2. CALLING the injected processor, and nothing else. This handler knows
//      no Telegram business rule: it does not resolve a user, does not claim an
//      update and does not write a journal entry. `TelegramBot` does all of
//      that, and there is exactly one `TelegramBot` in this repository.
//   3. REPORTING the outcome as a structured, code-only event.
//
// WHY THE PROCESSOR IS INJECTED. The bot's composition (`TelegramBot` +
// journal + AI + notifications over one pool) lives in the API package. The
// worker is a separate process and cannot reach the API's object graph, so the
// factory is imported and its result injected. That is a second composition
// root, NOT a second architecture: every rule still lives in the one bot.
//
// IDEMPOTENCY IS NOT RE-DONE HERE. The API claims the `update_id` BEFORE it
// enqueues, which is what makes its early 200 safe. The processor therefore
// calls `processClaimed` on an already-claimed update; a redelivered webhook is
// answered as a duplicate at the HTTP layer and never becomes a second job.
import { telegramUpdateSchema, type TelegramUpdate, type TelegramUpdatePayload } from "@velora/contracts";
import type { QueuedJob } from "../queue/QueuePort.js";
import { ClassifiedError } from "../observability/safeError.js";

/** `TelegramBot`'s own outcome vocabulary, mirrored verbatim. */
export type TelegramUpdateOutcome = "handled" | "ignored" | "rejected" | "failed";

/**
 * The execution seam. Structurally identical to the API factory's
 * `TelegramUpdateProcessor`, so neither package imports the other's types.
 */
export type TelegramUpdateProcessor = (update: TelegramUpdate) => Promise<TelegramUpdateOutcome>;

export interface TelegramUpdateHandlerDeps {
  /**
   * `null` ⇒ this worker cannot execute Telegram work. The handler then fails
   * closed with `NOT_CONFIGURED` instead of pretending the update was handled.
   */
  readonly processor: TelegramUpdateProcessor | null;
  readonly log: (event: Record<string, unknown>) => void;
}

/** Parse the persisted JSON without letting a throw escape unclassified. */
function parseUpdate(json: string): TelegramUpdate | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = telegramUpdateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function createTelegramUpdateHandler(deps: TelegramUpdateHandlerDeps) {
  return async function handleTelegramUpdate(job: QueuedJob<TelegramUpdatePayload>): Promise<void> {
    const payload = job.descriptor.payload;
    const updateId = payload.updateId;
    const kind = payload.kind;

    const update = parseUpdate(payload.updateJson);
    if (update === null) {
      // A payload that failed the schema will fail it again on every retry —
      // this is a producer/version mismatch, not a transient fault. Classified
      // so the runner records a code and pg-boss dead-letters it after the
      // bounded retry policy rather than cycling forever.
      deps.log({ level: "warn", event: "telegram.job_malformed", updateId, kind, attempts: job.attempts });
      throw new ClassifiedError("PROVIDER_MALFORMED", "telegram update payload failed contract validation");
    }

    if (deps.processor === null) {
      deps.log({ level: "warn", event: "telegram.processor_absent", updateId, kind, attempts: job.attempts });
      throw new ClassifiedError("NOT_CONFIGURED", "telegram update processor is not configured on this worker");
    }

    let outcome: TelegramUpdateOutcome;
    try {
      outcome = await deps.processor(update);
    } catch (err) {
      // The bot never throws for a handler failure (it records the outcome and
      // answers the user), so reaching here means the execution path itself
      // broke — a transport or database fault, i.e. genuinely retryable.
      deps.log({
        level: "error",
        event: "telegram.job_threw",
        updateId,
        kind,
        attempts: job.attempts,
        error: err instanceof Error ? err.name : "UNKNOWN",
      });
      throw new ClassifiedError("PROVIDER_UNAVAILABLE", "telegram update processing threw");
    }

    deps.log({ level: "info", event: "telegram.job_processed", updateId, kind, outcome, attempts: job.attempts });

    if (outcome === "failed") {
      // The bot already recorded `failed` on the update row and answered the
      // user. Throwing hands the job back to pg-boss so it is retried within
      // the class policy and then dead-lettered, which is what makes a stuck
      // update VISIBLE instead of silently dropped.
      throw new ClassifiedError("PROVIDER_UNAVAILABLE", "telegram update processing reported failed");
    }
  };
}
