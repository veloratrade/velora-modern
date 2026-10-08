// The update stream seam — one code path for webhook and polling (ADR-018).
//
// WHY THIS EXISTS AS A SEPARATE MODULE. Telegram offers two ways to receive
// updates and a deployment must choose exactly one of them. The CHOICE is
// configuration; everything after the choice is identical: validate the payload,
// claim its `update_id`, dispatch it, record how it ended. Putting that sequence
// in one place is what makes "polling and webhook behave the same" a fact rather
// than a hope, and it is the reason the two adapters cannot drift apart.
//
// WHAT THIS MODULE OWNS
//   * PARSING. The frozen contract schema is the boundary: a payload that does
//     not match it is refused BEFORE any Telegram-identifier is trusted. The
//     narrow schema is deliberate (see contracts/telegram.ts) — an unvalidated
//     `update_id` would silently break the claim that protects against Telegram
//     retries.
//   * THE MODE GATE. `acceptForMode(mode)` refuses a delivery whose stream this
//     process is not the consumer of, so a stray webhook into a polling
//     deployment (or the reverse) cannot cause a second consumption.
//   * THE DEFERRED PATH. Telegram requires a prompt HTTP answer; media
//     downloads and model calls do not fit in that budget. `acceptDeferred`
//     claims the update synchronously and finishes the work afterwards, so a
//     slow update is retried by NEITHER Telegram (it already got its 2xx) nor a
//     second delivery (the claim is held).
//
// WHAT IT DOES NOT OWN: any business decision. It never resolves a user, never
// writes a journal entry and never answers a user — that is `TelegramBot`'s job.
import { classifyUpdate, telegramUpdateSchema, type TelegramUpdate, type TelegramUpdateKind } from "@velora/contracts";
import type { TelegramUpdateMode } from "./telegramConfig.js";
import type { TelegramBot, UpdateOutcome } from "./telegramBot.js";

/**
 * `outcome` is the bot's own verdict and is reported verbatim — the pipeline
 * never reinterprets it. `"deferred"` is the only value the pipeline invents,
 * and it means one thing: the claim is held and the work is still ahead of us.
 */
/**
 * The three operations the pipeline performs on the bot — the whole surface it
 * is allowed to touch. See `TelegramUpdatePipelineDeps.bot`.
 */
export interface TelegramUpdateConsumer {
  claim(update: TelegramUpdate): Promise<boolean>;
  handleUpdate(update: TelegramUpdate): Promise<UpdateOutcome>;
  processClaimed(update: TelegramUpdate): Promise<UpdateOutcome>;
}

export type AcceptResult =
  | { readonly status: "accepted"; readonly updateId: string; readonly kind: TelegramUpdateKind; readonly outcome: UpdateOutcome | "deferred" }
  | { readonly status: "duplicate"; readonly updateId: string }
  | { readonly status: "malformed"; readonly reason: "INVALID_JSON" | "SCHEMA_MISMATCH" }
  | { readonly status: "wrong_consumer"; readonly mode: TelegramUpdateMode };

export interface TelegramUpdatePipelineDeps {
  /**
   * The consumer of a claimed update.
   *
   * A STRUCTURAL interface, not the `TelegramBot` class: the pipeline only ever
   * claims, dispatches and finishes, and naming exactly that is what lets the
   * handoff be tested with a deterministic double instead of a composed bot.
   * `TelegramBot` satisfies it unchanged.
   */
  readonly bot: TelegramUpdateConsumer;
  /** The mode THIS process is allowed to consume for. */
  readonly mode: () => TelegramUpdateMode;
  /** Schedules background work. Injectable so tests are deterministic. */
  readonly defer?: ((task: () => Promise<void>) => void) | undefined;
  /**
   * MG-TG-3 — hand the CLAIMED update to the durable job queue (pg-boss).
   *
   * Absent ⇒ `acceptDeferred` keeps the pre-MG-TG-3 behaviour and finishes the
   * work in this process. Present and returning `true` ⇒ the API's job is done
   * the moment the job row exists, and the worker owns the rest.
   *
   * Returns `false` when the queue could not durably accept (e.g. a duplicate
   * the queue already holds); the caller then falls back to the in-process path
   * so the update is still processed exactly once.
   */
  readonly enqueue?: ((update: TelegramUpdate) => Promise<boolean>) | undefined;
  readonly log: (event: Record<string, unknown>) => void;
}

export class TelegramUpdatePipeline {
  constructor(private readonly deps: TelegramUpdatePipelineDeps) {}

  /**
   * Validate a raw delivery.
   *
   * Accepts the raw body (webhook) or an already-decoded value (poller) because
   * both callers have different natural inputs and re-encoding one to feed the
   * other would be a silent place for the two paths to diverge.
   */
  parse(input: Buffer | string | unknown): { ok: true; update: TelegramUpdate } | { ok: false; reason: "INVALID_JSON" | "SCHEMA_MISMATCH" } {
    let value: unknown = input;
    if (Buffer.isBuffer(input) || typeof input === "string") {
      const text = Buffer.isBuffer(input) ? input.toString("utf8") : input;
      if (text.trim() === "") return { ok: false, reason: "INVALID_JSON" };
      try {
        value = JSON.parse(text);
      } catch {
        return { ok: false, reason: "INVALID_JSON" };
      }
    }
    const parsed = telegramUpdateSchema.safeParse(value);
    if (!parsed.success) return { ok: false, reason: "SCHEMA_MISMATCH" };
    return { ok: true, update: parsed.data };
  }

  /**
   * Claim and dispatch, awaited. This is the POLLING path (and the test path):
   * the offset must only advance after the update is fully handled, so the work
   * has to complete before the next batch is requested.
   */
  async accept(raw: Buffer | string | unknown, mode: TelegramUpdateMode): Promise<AcceptResult> {
    if (this.deps.mode() !== mode) return { status: "wrong_consumer", mode: this.deps.mode() };
    const parsed = this.parse(raw);
    if (!parsed.ok) {
      this.deps.log({ level: "warn", event: "telegram.update_malformed", reason: parsed.reason });
      return { status: "malformed", reason: parsed.reason };
    }
    const outcome = await this.deps.bot.handleUpdate(parsed.update);
    return outcome === "ignored"
      ? { status: "duplicate", updateId: String(parsed.update.update_id) }
      : { status: "accepted", updateId: String(parsed.update.update_id), kind: classifyUpdate(parsed.update), outcome };
  }

  /**
   * Claim now, finish later. This is the WEBHOOK path: the caller answers
   * Telegram as soon as the claim is held.
   *
   * The claim is what makes the early answer safe. Without it, answering before
   * the work is done would mean a crash mid-processing loses the update with no
   * trace; with it, the update row exists (claimed, unprocessed) and Telegram's
   * retry is recognised as a duplicate.
   */
  async acceptDeferred(raw: Buffer | string | unknown, mode: TelegramUpdateMode): Promise<AcceptResult> {
    if (this.deps.mode() !== mode) return { status: "wrong_consumer", mode: this.deps.mode() };
    const parsed = this.parse(raw);
    if (!parsed.ok) {
      this.deps.log({ level: "warn", event: "telegram.update_malformed", reason: parsed.reason });
      return { status: "malformed", reason: parsed.reason };
    }
    const update = parsed.update;
    const updateId = String(update.update_id);
    const claimed = await this.deps.bot.claim(update);
    if (!claimed) return { status: "duplicate", updateId };

    // MG-TG-3 — the queue handoff.
    //
    // THE CLAIM PRECEDES THE ENQUEUE, and that order is the safety property:
    // a Telegram retry that arrives before the job row exists is recognised as
    // a duplicate here rather than enqueued twice. Once the job row is durable
    // the API's obligation ends, and a crash costs nothing because the row —
    // not this process — now owns the update.
    const enqueue = this.deps.enqueue;
    if (enqueue !== undefined) {
      try {
        if (await enqueue(update)) {
          this.deps.log({ level: "info", event: "telegram.update_queued", updateId, kind: classifyUpdate(update) });
          return { status: "accepted", updateId, kind: classifyUpdate(update), outcome: "deferred" };
        }
        this.deps.log({ level: "warn", event: "telegram.update_queue_rejected", updateId });
      } catch (err) {
        // Degrade, do not lose: the update is already claimed, so finishing it
        // here is still exactly-once. Only the latency benefit is given up.
        this.deps.log({
          level: "error",
          event: "telegram.update_queue_failed",
          updateId,
          error: err instanceof Error ? err.name : "UNKNOWN",
        });
      }
    }

    const task = async (): Promise<void> => {
      await this.deps.bot.processClaimed(update).catch((err: unknown) => {
        // processClaimed already records the failure on the update row and
        // answers the user; reaching here means the bookkeeping itself failed.
        this.deps.log({ level: "error", event: "telegram.deferred_processing_failed", code: err instanceof Error ? err.name : "UNKNOWN" });
      });
    };
    const defer = this.deps.defer ?? ((fn: () => Promise<void>): void => void setTimeout(() => void fn(), 0));
    defer(task);
    return { status: "accepted", updateId: String(update.update_id), kind: classifyUpdate(update), outcome: "deferred" };
  }
}
