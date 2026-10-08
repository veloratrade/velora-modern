// Telegram update job handler — the worker half of MG-TG-3.
//
// DETERMINISTIC BY CONSTRUCTION. No bot token, no network, no database, no
// pg-boss: the handler is a pure function of (payload, processor). That is
// deliberate — MG-TG-3's live half (a real Telegram round trip, a deployed
// worker) is deployment-gated, and these tests must not pretend otherwise.
//
// CROSS-BOUNDARY EVIDENCE. The descriptors are built by the API's own
// `buildTelegramUpdateDescriptor`, not by a local copy. If the producer and the
// consumer ever disagree about the payload shape, this file fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TelegramUpdate } from "@velora/contracts";
import { buildTelegramUpdateDescriptor } from "@velora/api/src/telegram/telegramUpdateQueue.js";
import type { QueuedJob } from "../queue/QueuePort.js";
import type { TelegramUpdatePayload } from "@velora/contracts";
import {
  createTelegramUpdateHandler,
  type TelegramUpdateOutcome,
  type TelegramUpdateProcessor,
} from "./telegramUpdateHandler.js";
import { isWorkerErrorCode } from "../observability/safeError.js";

const UPDATE: TelegramUpdate = {
  update_id: 31337,
  message: {
    message_id: 4,
    chat: { id: 77, type: "private" },
    date: 1_700_000_000,
    text: "bought EURUSD 0.5 lot at 1.0850",
    from: { id: 77, is_bot: false, username: "alice" },
  },
};

function jobFor(update: TelegramUpdate, attempts = 0): QueuedJob<TelegramUpdatePayload> {
  const descriptor = buildTelegramUpdateDescriptor(update);
  return { id: "job-1", descriptor, attempts };
}

/** Run the handler and return either the thrown code or `null`. */
async function run(
  processor: TelegramUpdateProcessor | null,
  job: QueuedJob<TelegramUpdatePayload>,
  events: Record<string, unknown>[] = [],
): Promise<string | null> {
  const handler = createTelegramUpdateHandler({ processor, log: (e) => events.push(e) });
  try {
    await handler(job);
    return null;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "NOT_CLASSIFIED";
    assert.ok(isWorkerErrorCode(code), `the handler must throw a classified error, got ${code}`);
    return code;
  }
}

test("a well-formed job is handed to the processor and completes without throwing", async () => {
  const seen: TelegramUpdate[] = [];
  const events: Record<string, unknown>[] = [];
  const processor: TelegramUpdateProcessor = async (update) => {
    seen.push(update);
    return "handled";
  };
  const code = await run(processor, jobFor(UPDATE), events);
  assert.equal(code, null);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], UPDATE, "the worker re-parses the SAME update the API validated");
  assert.ok(events.some((e) => e["event"] === "telegram.job_processed" && e["outcome"] === "handled"));
});

test("the producer's descriptor and the consumer's parser agree on every inbound kind", async () => {
  const kinds: { update: TelegramUpdate; expected: string }[] = [
    { update: UPDATE, expected: "message" },
    {
      update: { update_id: 2, callback_query: { id: "cb", from: { id: 5 }, data: "confirm:12" } },
      expected: "callback_query",
    },
    {
      update: { update_id: 3, edited_message: { message_id: 9, chat: { id: 5, type: "private" }, date: 1 } },
      expected: "edited_message",
    },
  ];
  for (const k of kinds) {
    const seen: TelegramUpdate[] = [];
    const processor: TelegramUpdateProcessor = async (u) => {
      seen.push(u);
      return "handled";
    };
    const job = jobFor(k.update);
    assert.equal(job.descriptor.payload.kind, k.expected);
    assert.equal(await run(processor, job), null);
    assert.deepEqual(seen[0], k.update);
  }
});

test("a payload that is not JSON is terminal — classified and dead-lettered, not retried forever", async () => {
  const events: Record<string, unknown>[] = [];
  const job = jobFor(UPDATE);
  job.descriptor.payload = { ...job.descriptor.payload, updateJson: "{not json" };
  const processor: TelegramUpdateProcessor = async () => {
    throw new Error("the processor must never be reached");
  };
  const code = await run(processor, job, events);
  assert.equal(code, "PROVIDER_MALFORMED");
  assert.ok(events.some((e) => e["event"] === "telegram.job_malformed"));
});

test("a payload that parses but fails the frozen schema is treated the same way", async () => {
  const job = jobFor(UPDATE);
  job.descriptor.payload = { ...job.descriptor.payload, updateJson: JSON.stringify({ update_id: "not-a-number" }) };
  const code = await run(async () => "handled", job);
  assert.equal(code, "PROVIDER_MALFORMED");
});

test("no processor ⇒ fail closed with NOT_CONFIGURED, never a silent success", async () => {
  const events: Record<string, unknown>[] = [];
  const code = await run(null, jobFor(UPDATE), events);
  assert.equal(code, "NOT_CONFIGURED");
  assert.ok(events.some((e) => e["event"] === "telegram.processor_absent"));
});

test("an outcome of `failed` is retried within the class policy, not swallowed", async () => {
  const events: Record<string, unknown>[] = [];
  const processor: TelegramUpdateProcessor = async () => "failed";
  const code = await run(processor, jobFor(UPDATE), events);
  assert.equal(code, "PROVIDER_UNAVAILABLE");
  // The bot already recorded `failed` on the update row and answered the user;
  // the job is handed back so pg-boss retries and then dead-letters it, which is
  // what makes a stuck update visible instead of lost.
  assert.ok(events.some((e) => e["event"] === "telegram.job_processed" && e["outcome"] === "failed"));
});

test("`ignored` and `rejected` are completed, not retried", async () => {
  for (const outcome of ["ignored", "rejected"] as TelegramUpdateOutcome[]) {
    const code = await run(async () => outcome, jobFor(UPDATE));
    assert.equal(code, null, `${outcome} must complete the job`);
  }
});

test("a processor that throws is classified as retryable and logged by name, never by message", async () => {
  const events: Record<string, unknown>[] = [];
  const processor: TelegramUpdateProcessor = async () => {
    throw new Error("ECONNREFUSED 10.0.0.4:5432 password=hunter2");
  };
  const code = await run(processor, jobFor(UPDATE), events);
  assert.equal(code, "PROVIDER_UNAVAILABLE");
  const event = events.find((e) => e["event"] === "telegram.job_threw");
  assert.ok(event !== undefined);
  assert.equal(event["error"], "Error");
  assert.ok(!JSON.stringify(events).includes("hunter2"), "log events must never carry provider text");
});

test("the attempt count travels into the log so a stuck update is diagnosable", async () => {
  const events: Record<string, unknown>[] = [];
  await run(async () => "handled", jobFor(UPDATE, 2), events);
  assert.ok(events.some((e) => e["attempts"] === 2));
});
