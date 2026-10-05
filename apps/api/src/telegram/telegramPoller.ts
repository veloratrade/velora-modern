// Long-polling adapter — the DEVELOPMENT consumer of the update stream (ADR-018).
//
// WHY A POLLER EXISTS AT ALL. Bringing Telegram up on a laptop must not require
// a public HTTPS endpoint and a tunnel. `getUpdates` needs only the bot token,
// which makes local and staging verification possible without exposing anything.
//
// WHY IT IS NOT THE PRODUCTION PATH. Two independent reasons, and either one is
// sufficient:
//   1. SCALE. A running poller is a stateful consumer holding an offset. Two
//      replicas polling the same bot make Telegram answer one of them with 409
//      Conflict, and whichever process wins the race is the one that answers the
//      user — so a rolling deploy silently changes who serves traffic.
//   2. LATENCY AND COST. Every idle poll is an outbound request held open for the
//      long-poll timeout; a webhook delivery costs nothing when nothing happens.
// The mode rules in `telegramConfig.ts` therefore refuse `polling` in production
// (finding TG-007) and `server-main.ts` never starts this adapter there.
//
// THE OFFSET DISCIPLINE IS THE IDEMPOTENCY DISCIPLINE. `getUpdates` is asked with
// `offset = last processed update_id + 1`, and the offset only advances AFTER an
// update has been fully handled. A crash mid-batch therefore re-delivers the
// batch on restart, and the `telegram_updates` claim turns each re-delivery into
// an `ignored` outcome instead of a second journal entry or a re-spent token.
import type { TelegramUpdate } from "@velora/contracts";
import type { TelegramBotApi } from "./telegramApi.js";
import type { TelegramUpdatePipeline } from "./telegramUpdatePipeline.js";

export interface TelegramPollerDeps {
  readonly api: Pick<TelegramBotApi, "getUpdates">;
  /**
   * The SAME seam the webhook ingress uses. Polling must not be a second, weaker
   * path into the bot: routing it through the pipeline is what gives a polled
   * update the identical parse, mode gate and claim discipline, and it is why a
   * payload the schema cannot represent is dropped (with a warning) instead of
   * being redelivered forever while the offset refuses to move.
   */
  readonly pipeline: TelegramUpdatePipeline;
  readonly log: (event: Record<string, unknown>) => void;
  /** Long-poll seconds requested from Telegram (1–50; 0 = short poll). */
  readonly timeoutSeconds?: number | undefined;
  /** Backoff floor/ceiling after a failed poll. */
  readonly minBackoffMs?: number | undefined;
  readonly maxBackoffMs?: number | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export class TelegramPoller {
  #offset: number | null = null;
  #running = false;
  #stopped = false;
  #backoffMs: number;

  constructor(private readonly deps: TelegramPollerDeps) {
    this.#backoffMs = deps.minBackoffMs ?? 1000;
  }

  /** The next update id to request. Exposed for tests and diagnostics. */
  get offset(): number | null {
    return this.#offset;
  }

  get running(): boolean {
    return this.#running;
  }

  /** Ask Telegram to forget nothing, but stop the current consumer's backlock. */
  async stop(): Promise<void> {
    this.#stopped = true;
  }

  /**
   * Run until `stop()`. Never throws: a polling loop that dies on a transient
   * network error would leave the bot silently deaf, which is worse than any
   * single failed batch.
   */
  async run(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.deps.log({ level: "info", event: "telegram.poller_started" });
    while (!this.#stopped) {
      try {
        const updates = await this.deps.api.getUpdates(this.#offset, this.deps.timeoutSeconds ?? 25);
        await this.handleBatch(updates);
        // Only an iteration that BOTH read and handled successfully clears the
        // backoff. Resetting it on the read alone would mean an update that
        // consistently fails to be handled — a stuck offset with a healthy
        // network — is retried once a second forever with no escalating pause.
        this.#backoffMs = this.deps.minBackoffMs ?? 1000;
      } catch (err) {
        const code = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "POLL_FAILED";
        this.deps.log({ level: "warn", event: "telegram.poll_failed", code, backoffMs: this.#backoffMs });
        // A conflict means ANOTHER consumer is polling the same bot. Retrying
        // hard would keep stealing the stream from it, so a conflict backs off
        // furthest and is reported as the configuration fault it is.
        const floor = code === "CONFLICT" ? Math.max(this.#backoffMs, 15_000) : this.#backoffMs;
        await this.sleep(floor);
        this.#backoffMs = Math.min(floor * 2, this.deps.maxBackoffMs ?? 60_000);
      }
    }
    this.#running = false;
    this.deps.log({ level: "info", event: "telegram.poller_stopped" });
  }

  /**
   * Handle one batch IN ORDER and advance the offset only past handled updates.
   *
   * An update whose handling throws is NOT skipped past: the offset stays AT the
   * failed update, so the next poll re-requests it and Telegram redelivers it.
   * That is safe rather than duplicative because the update row is claimed before
   * the work, so a redelivery is recognised as a duplicate instead of being
   * executed twice. An update the schema cannot represent is the one case that IS
   * skipped — it can never succeed, and holding the offset on it would stall the
   * whole stream behind a single bad payload.
   */
  private async handleBatch(updates: readonly TelegramUpdate[]): Promise<void> {
    for (const update of updates) {
      const result = await this.deps.pipeline.accept(update, "polling");
      switch (result.status) {
        case "accepted":
          this.deps.log({ level: "info", event: "telegram.update_consumed", updateId: result.updateId, kind: result.kind, outcome: result.outcome });
          break;
        case "duplicate":
          this.deps.log({ level: "info", event: "telegram.update_duplicate", updateId: result.updateId });
          break;
        case "malformed":
          this.deps.log({ level: "warn", event: "telegram.update_unprocessable", updateId: String(update.update_id), reason: result.reason });
          break;
        case "wrong_consumer":
          // This process is polling a stream the configuration says it does not
          // consume. Advancing the offset would silently drop every update, so
          // the loop stops and says why.
          this.deps.log({ level: "error", event: "telegram.poller_mode_mismatch", mode: result.mode });
          await this.stop();
          return;
      }
      this.#offset = update.update_id + 1;
    }
  }

  private async sleep(ms: number): Promise<void> {
    const sleep = this.deps.sleep ?? ((duration: number) => new Promise<void>((resolve) => setTimeout(resolve, duration)));
    await sleep(ms);
  }
}
