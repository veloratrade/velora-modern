// The polling consumer and the update pipeline.
//
// WHAT IS PINNED HERE, AND WHY IT IS THE FAILURE BEHAVIOUR.
// The happy path is the least interesting part of a poller: it handles a batch and
// moves an integer. What decides whether a user loses data is what happens when a
// delivery is slow, failed, duplicated or foreign, so these tests are written
// against those cases:
//   * a failed update must stay INSIDE the request window (never skipped past),
//   * a conflict means a second consumer exists, so the loop backs off hard
//     instead of fighting for the stream,
//   * a payload the schema cannot represent must be dropped with a warning rather
//     than stall the stream forever behind one bad update,
//   * a webhook delivery must be refused by a polling deployment and vice versa,
//     because two consumers on one stream is the fault this whole seam exists to
//     prevent.
//
// ON THE INJECTED `sleep`: the loop under test is infinite by design, so every
// poller test stops it from inside the sleep stub. Resolving the stub WITHOUT
// stopping would leave a loop whose `await`s all resolve as already-settled
// promises — an endless microtask chain that starves timers and hangs the test
// runner with no output at all. Do not remove those `stop()` calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramPoller } from "./telegramPoller.js";
import { TelegramUpdatePipeline } from "./telegramUpdatePipeline.js";
import type { TelegramBot } from "./telegramBot.js";
import type { TelegramUpdate } from "@velora/contracts";

const message = (updateId: number, text = "/start"): TelegramUpdate => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    from: { id: 555, username: "trader" },
    chat: { id: 555, type: "private" },
    date: 1_770_000_000,
    text,
  },
});

/** How many updates of the script the double will hand out before failing. */
class ScriptedUpdates {
  readonly calls: (number | null)[] = [];
  #queue: (TelegramUpdate[] | Error)[];
  constructor(queue: (TelegramUpdate[] | Error)[]) {
    this.#queue = queue;
  }
  async getUpdates(offset: number | null): Promise<TelegramUpdate[]> {
    this.calls.push(offset);
    const next = this.#queue.shift();
    // Running out of script is a TRANSPORT failure, not a test assertion: it is
    // what a network fault looks like to the loop.
    if (next === undefined) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return next;
  }
}

interface PollerHarness {
  readonly poller: TelegramPoller;
  readonly api: ScriptedUpdates;
  readonly handled: TelegramUpdate[];
  readonly sleeps: number[];
  readonly logs: Record<string, unknown>[];
  run(): Promise<void>;
}

/**
 * A poller whose `sleep` records the delay and stops the loop on the Nth backoff,
 * so the run terminates without a timer race.
 */
function harness(options: {
  script: (TelegramUpdate[] | Error)[];
  failOn?: number | undefined;
  stopAfterSleeps: number;
  maxBackoffMs?: number | undefined;
}): PollerHarness {
  const handled: TelegramUpdate[] = [];
  const sleeps: number[] = [];
  const logs: Record<string, unknown>[] = [];
  const api = new ScriptedUpdates(options.script);
  const pipeline = new TelegramUpdatePipeline({
    bot: {
      handleUpdate: async (update: TelegramUpdate) => {
        handled.push(update);
        if (options.failOn !== undefined && update.update_id === options.failOn) throw new Error("handler exploded");
        return "handled" as const;
      },
    } as unknown as TelegramBot,
    mode: () => "polling",
    log: (event) => logs.push(event),
  });
  const poller = new TelegramPoller({
    api,
    pipeline,
    log: (event) => logs.push(event),
    ...(options.maxBackoffMs === undefined ? {} : { maxBackoffMs: options.maxBackoffMs }),
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length >= options.stopAfterSleeps) await poller.stop();
    },
  });
  return { poller, api, handled, sleeps, logs, run: () => poller.run() };
}

test("the poller handles a batch in order and advances the offset only past handled updates", async () => {
  const h = harness({ script: [[message(10), message(11)], [message(12)], new Error("timeout")], stopAfterSleeps: 1 });
  await h.run();

  assert.deepEqual(h.handled.map((u) => u.update_id), [10, 11, 12], "updates are handled in delivery order");
  // First call: no offset yet. Then last-handled + 1 — never the last id itself,
  // which would re-deliver the update the user just sent.
  assert.deepEqual(h.api.calls, [null, 12, 13]);
  assert.equal(h.poller.offset, 13);
  assert.equal(h.poller.running, false, "the loop reports itself stopped once it exits");
  assert.deepEqual(h.sleeps, [1000], "a failed poll backs off instead of spinning");
  assert.equal(h.logs.filter((e) => e.event === "telegram.update_consumed").length, 3);
});

test("a failed update stays inside the request window and is redelivered, never skipped", async () => {
  // The script ends where reality does: the second poll fails the same update
  // again, and the loop backs off without ever asking past it.
  const h = harness({ script: [[message(20), message(21)], [message(21)]], failOn: 21, stopAfterSleeps: 2 });
  await h.run();

  // 20 succeeded; 21 failed. The offset moved to 21 — the failed update's OWN id,
  // which means the next poll asks for it again.
  assert.deepEqual(h.handled.map((u) => u.update_id), [20, 21, 21], "the failed update is attempted again on the next poll");
  // `null` first (no offset yet), then 21 — never 22, which would have skipped the
  // failed update out of the window entirely.
  assert.deepEqual(h.api.calls, [null, 21], "the offset never moves PAST the failed update");
  assert.equal(h.poller.offset, 21);
  assert.deepEqual(h.sleeps, [1000, 2000], "each consecutive failure doubles the backoff");
});

test("a 409 CONFLICT is treated as a second consumer: backed off hard, and capped", async () => {
  const conflict = Object.assign(new Error("Conflict: terminated by other getUpdates request"), { code: "CONFLICT" });
  const h = harness({ script: [conflict, conflict, conflict, conflict], stopAfterSleeps: 4 });
  await h.run();

  assert.deepEqual(h.handled, [], "a conflict means no update was consumed by this process");
  // 15s floor on the first conflict (retrying fast would keep stealing the stream
  // from the other consumer), then doubling, then pinned at the 60s default cap.
  assert.deepEqual(h.sleeps, [15_000, 30_000, 60_000, 60_000]);
  const conflicts = h.logs.filter((e) => e.event === "telegram.poll_failed");
  assert.equal(conflicts.length, 4);
  assert.ok(conflicts.every((e) => e.code === "CONFLICT"), "the conflict is reported as the configuration fault it is");
});

test("a transient poll failure doubles from the floor and respects the configured ceiling", async () => {
  const h = harness({ script: [new Error("boom"), new Error("boom"), new Error("boom"), new Error("boom"), new Error("boom")], stopAfterSleeps: 5, maxBackoffMs: 4000 });
  await h.run();
  assert.deepEqual(h.sleeps, [1000, 2000, 4000, 4000, 4000]);
  assert.ok(h.logs.every((e) => e.event === "telegram.poll_failed" ? e.code === "POLL_FAILED" : true));
});

test("a poll into the wrong consumer stops the loop instead of dropping the stream", async () => {
  const handled: TelegramUpdate[] = [];
  const logs: Record<string, unknown>[] = [];
  const api = new ScriptedUpdates([[message(30)]]);
  const pipeline = new TelegramUpdatePipeline({
    bot: { handleUpdate: async (u: TelegramUpdate) => { handled.push(u); return "handled" as const; } } as unknown as TelegramBot,
    mode: () => "webhook", // this process consumes by webhook
    log: () => undefined,
  });
  const poller = new TelegramPoller({ api, pipeline, log: (event) => logs.push(event), sleep: async () => undefined });
  await poller.run();

  assert.deepEqual(handled, [], "the bot must not act on a stream this process does not consume");
  assert.equal(poller.running, false, "the loop stops rather than skipping every update forever");
  assert.equal(poller.offset, null, "the offset must not advance");
  assert.ok(logs.some((e) => e.event === "telegram.poller_mode_mismatch" && e.level === "error"));
});

test("the pipeline refuses junk before any identifier is trusted, and drops it rather than stalling", async () => {
  const seen: TelegramUpdate[] = [];
  const pipeline = new TelegramUpdatePipeline({
    bot: {
      handleUpdate: async (update: TelegramUpdate) => {
        seen.push(update);
        return "handled";
      },
    } as unknown as TelegramBot,
    mode: () => "webhook",
    log: () => undefined,
  });

  for (const junk of ["{not json", "{}", "", "   ", Buffer.from([0xff, 0xfe])]) {
    const result = await pipeline.accept(junk, "webhook");
    assert.equal(result.status, "malformed", `${JSON.stringify(String(junk))} must be refused`);
  }
  // A well-formed JSON body that is not an update: no `update_id` to claim, so
  // there is nothing to deduplicate against and it must never reach the bot.
  const shaped = await pipeline.accept(JSON.stringify({ message: { text: "hi" } }), "webhook");
  assert.equal(shaped.status, "malformed");
  assert.equal(shaped.status === "malformed" ? shaped.reason : "", "SCHEMA_MISMATCH");
  assert.deepEqual(seen, []);
});

test("the pipeline reports the update kind and the bot's own outcome, not the identifier", async () => {
  const pipeline = new TelegramUpdatePipeline({
    bot: { handleUpdate: async () => "rejected" } as unknown as TelegramBot,
    mode: () => "polling",
    log: () => undefined,
  });

  const accepted = await pipeline.accept(JSON.stringify(message(41)), "polling");
  assert.equal(accepted.status, "accepted");
  assert.deepEqual(accepted, { status: "accepted", updateId: "41", kind: "message", outcome: "rejected" });

  // `ignored` is the bot's duplicate verdict — surfaced as a duplicate, never as
  // an error, so a replayed update does not look like a failure in the logs.
  const ignored = new TelegramUpdatePipeline({
    bot: { handleUpdate: async () => "ignored" } as unknown as TelegramBot,
    mode: () => "polling",
    log: () => undefined,
  });
  assert.deepEqual(await ignored.accept(JSON.stringify(message(42)), "polling"), { status: "duplicate", updateId: "42" });

  const wrong = await pipeline.accept(JSON.stringify(message(43)), "webhook");
  assert.deepEqual(wrong, { status: "wrong_consumer", mode: "polling" });
});

test("a webhook delivery is claimed BEFORE the answer, so a slow update is retried by nobody", async () => {
  const claimed: TelegramUpdate[] = [];
  const finished: TelegramUpdate[] = [];
  const deferred: (() => Promise<void>)[] = [];
  const logs: Record<string, unknown>[] = [];
  let claimable = true;
  const pipeline = new TelegramUpdatePipeline({
    bot: {
      claim: async (update: TelegramUpdate) => {
        claimed.push(update);
        return claimable;
      },
      processClaimed: async (update: TelegramUpdate) => {
        finished.push(update);
        return "handled";
      },
      handleUpdate: async () => "handled",
    } as unknown as TelegramBot,
    mode: () => "webhook",
    defer: (task) => deferred.push(task),
    log: (event) => logs.push(event),
  });

  const accepted = await pipeline.acceptDeferred(JSON.stringify(message(50)), "webhook");
  assert.deepEqual(accepted, { status: "accepted", updateId: "50", kind: "message", outcome: "deferred" });
  assert.deepEqual(claimed.map((u) => u.update_id), [50], "the claim is held before the caller answers Telegram");
  assert.equal(finished.length, 0, "the work is not done inside the request — that is the point of the claim");
  assert.equal(deferred.length, 1);

  await deferred[0]!();
  assert.deepEqual(finished.map((u) => u.update_id), [50]);

  // A redelivery of the same update finds the claim taken and answers 200 without
  // doing the work twice.
  claimable = false;
  const duplicate = await pipeline.acceptDeferred(JSON.stringify(message(50)), "webhook");
  assert.deepEqual(duplicate, { status: "duplicate", updateId: "50" });
  assert.equal(deferred.length, 1, "a duplicate schedules no work");
});

test("a deferred task that explodes is logged, never an unhandled rejection", async () => {
  const deferred: (() => Promise<void>)[] = [];
  const logs: Record<string, unknown>[] = [];
  const pipeline = new TelegramUpdatePipeline({
    bot: {
      claim: async () => true,
      // The real bot records its own failure and answers the user; reaching the
      // pipeline with a rejection means the bookkeeping itself failed.
      processClaimed: async () => {
        throw new Error("bookkeeping exploded");
      },
      handleUpdate: async () => "handled",
    } as unknown as TelegramBot,
    mode: () => "webhook",
    defer: (task) => deferred.push(task),
    log: (event) => logs.push(event),
  });

  const result = await pipeline.acceptDeferred(JSON.stringify(message(60)), "webhook");
  assert.equal(result.status, "accepted");
  await assert.doesNotReject(async () => deferred[0]!());
  assert.ok(logs.some((e) => e.event === "telegram.deferred_processing_failed"));
});
