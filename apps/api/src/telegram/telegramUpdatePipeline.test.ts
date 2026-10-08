// The update-stream seam — webhook/polling parity AND the MG-TG-3 queue handoff.
//
// WHY A DEDICATED FILE. The queue handoff is the one place where the API can
// silently lose an update: hand the work to pg-boss and no worker consumes the
// job, and the update is claimed but never processed. These tests pin the two
// properties that make the handoff safe —
//   1. the CLAIM precedes the enqueue, so a retry is a duplicate, not a second job;
//   2. a queue that refuses or throws falls back to the in-process path, so the
//      update is still processed exactly once, just later.
//
// The consumer is a deterministic double, which is exactly why the pipeline's
// dependency is the structural `TelegramUpdateConsumer` and not the `TelegramBot`
// class: the seam under test is the handoff, not the bot.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TelegramUpdate } from "@velora/contracts";
import {
  TelegramUpdatePipeline,
  type AcceptResult,
  type TelegramUpdateConsumer,
} from "./telegramUpdatePipeline.js";

const UPDATE: TelegramUpdate = {
  update_id: 909,
  message: {
    message_id: 3,
    chat: { id: 11, type: "private" },
    date: 1_700_000_000,
    text: "journal this",
  },
};

interface Harness {
  readonly pipeline: TelegramUpdatePipeline;
  readonly enqueued: TelegramUpdate[];
  readonly deferred: (() => Promise<void>)[];
  readonly events: { level: string; event: string; [k: string]: unknown }[];
  readonly processed: string[];
  runDeferred(): Promise<void>;
}

function harness(opts: { claim?: boolean; enqueue?: (u: TelegramUpdate) => Promise<boolean> } = {}): Harness {
  const enqueued: TelegramUpdate[] = [];
  const deferred: (() => Promise<void>)[] = [];
  const events: { level: string; event: string; [k: string]: unknown }[] = [];
  const processed: string[] = [];
  let claimResult = opts.claim ?? true;
  const enqueueFn: ((u: TelegramUpdate) => Promise<boolean>) | undefined = opts.enqueue;

  const bot: TelegramUpdateConsumer = {
    async claim(update) {
      return claimResult;
    },
    async handleUpdate() {
      return "handled";
    },
    async processClaimed(update) {
      processed.push(String(update.update_id));
      return "handled";
    },
  };

  const pipeline = new TelegramUpdatePipeline({
    bot,
    mode: () => "webhook",
    defer: (task) => {
      deferred.push(task);
    },
    get enqueue() {
      return enqueueFn;
    },
    log: (event) => {
      events.push(event as { level: string; event: string });
    },
  });

  return {
    pipeline,
    enqueued,
    deferred,
    events,
    processed,
    async runDeferred() {
      while (deferred.length > 0) {
        const task = deferred.shift();
        if (task !== undefined) await task();
      }
    },
  };
}

test("with a queue configured, acceptDeferred enqueues and does NOT run the work in-process", async () => {
  const h = harness({
    enqueue: async (u) => {
      h.enqueued.push(u);
      return true;
    },
  });
  const result = await h.pipeline.acceptDeferred(JSON.stringify(UPDATE), "webhook");
  assert.equal(result.status, "accepted");
  assert.equal(h.enqueued.length, 1, "the job row — not this process — now owns the update");
  assert.equal(h.deferred.length, 0, "no in-process work when the handoff succeeded");
  assert.equal(h.processed.length, 0);
  const accepted = result as Extract<AcceptResult, { status: "accepted" }>;
  assert.equal(accepted.outcome, "deferred");
  assert.equal(accepted.updateId, "909");
  assert.ok(h.events.some((e) => e.event === "telegram.update_queued"));
});

test("the claim precedes the enqueue: a duplicate is answered before a job is created", async () => {
  const h = harness({
    claim: false,
    enqueue: async (u) => {
      h.enqueued.push(u);
      return true;
    },
  });
  const result = await h.pipeline.acceptDeferred(JSON.stringify(UPDATE), "webhook");
  assert.equal(result.status, "duplicate");
  assert.equal(h.enqueued.length, 0, "a Telegram retry must never become a second job");
  assert.equal(h.processed.length, 0);
});

test("a malformed body is refused before anything is claimed or enqueued", async () => {
  const h = harness({
    enqueue: async (u) => {
      h.enqueued.push(u);
      return true;
    },
  });
  const result = await h.pipeline.acceptDeferred("{not json", "webhook");
  assert.equal(result.status, "malformed");
  assert.equal(h.enqueued.length, 0);
  assert.equal(h.deferred.length, 0);
  assert.ok(h.events.some((e) => e.event === "telegram.update_malformed"));
});

test("a queue that refuses the job falls back to the in-process path — the update is not lost", async () => {
  const h = harness({ enqueue: async () => false });
  const result = await h.pipeline.acceptDeferred(JSON.stringify(UPDATE), "webhook");
  assert.equal(result.status, "accepted");
  assert.equal(h.deferred.length, 1, "degraded, not dropped");
  await h.runDeferred();
  assert.deepEqual(h.processed, ["909"], "the update is still processed exactly once");
  assert.ok(h.events.some((e) => e.event === "telegram.update_queue_rejected"));
});

test("a queue that throws falls back to the in-process path and logs a code, not a stack", async () => {
  const h = harness({
    enqueue: async () => {
      throw new Error("connection refused");
    },
  });
  const result = await h.pipeline.acceptDeferred(JSON.stringify(UPDATE), "webhook");
  assert.equal(result.status, "accepted");
  await h.runDeferred();
  assert.deepEqual(h.processed, ["909"]);
  const failure = h.events.find((e) => e.event === "telegram.update_queue_failed");
  assert.ok(failure !== undefined);
  assert.equal(failure["error"], "Error");
  assert.ok(!JSON.stringify(failure).includes("connection refused"), "log events carry codes, never provider text");
});

test("without a queue, behaviour is the pre-MG-TG-3 in-process defer (unchanged)", async () => {
  const h = harness();
  const result = await h.pipeline.acceptDeferred(JSON.stringify(UPDATE), "webhook");
  assert.equal(result.status, "accepted");
  assert.equal(h.deferred.length, 1);
  assert.ok(!h.events.some((e) => e.event === "telegram.update_queued"));
  await h.runDeferred();
  assert.deepEqual(h.processed, ["909"]);
});

test("the mode gate still wins: a delivery this process may not consume is refused", async () => {
  const h = harness({
    enqueue: async (u) => {
      h.enqueued.push(u);
      return true;
    },
  });
  const result = await h.pipeline.acceptDeferred(JSON.stringify(UPDATE), "polling");
  assert.equal(result.status, "wrong_consumer");
  assert.equal(h.enqueued.length, 0);
  assert.equal(h.deferred.length, 0);
});

test("the polling path stays synchronous — it never touches the queue", async () => {
  const h = harness({
    enqueue: async (u) => {
      h.enqueued.push(u);
      return true;
    },
  });
  const result = await h.pipeline.accept(JSON.stringify(UPDATE), "webhook");
  assert.equal(result.status, "accepted");
  assert.equal(h.enqueued.length, 0, "polling must advance the offset only after the work completes");
  assert.equal(h.deferred.length, 0);
});
