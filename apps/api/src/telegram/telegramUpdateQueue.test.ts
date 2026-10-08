// Telegram update queue — the API-side producer for MG-TG-3.
//
// WHAT THESE TESTS ARE EVIDENCE FOR. The handoff from the webhook boundary to
// pg-boss must be a durable, identifier-only payload whose idempotency key is
// the SAME value the `telegram_updates` claim uses. Anything else would let a
// Telegram retry create a second journal entry through the back door the
// claim exists to close.
//
// NO BOT TOKEN, NO NETWORK, NO DATABASE. Every assertion here is deterministic
// and runs on the memory double; the pg-boss producer is exercised by
// `db/tests/pgBossAdapter.pg.test.ts` against a real instance and is not
// re-litigated here.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TelegramUpdate } from "@velora/contracts";
import { TELEGRAM_UPDATE_JOB_CLASS } from "@velora/contracts";
import {
  MemoryTelegramUpdateQueue,
  buildTelegramUpdateDescriptor,
} from "./telegramUpdateQueue.js";

const UPDATE: TelegramUpdate = {
  update_id: 4242,
  message: {
    message_id: 7,
    chat: { id: 555, type: "private" },
    date: 1_700_000_000,
    text: "bought EURUSD at 1.0850",
    from: { id: 555, is_bot: false, username: "alice" },
  },
};

const OTHER: TelegramUpdate = {
  update_id: 4243,
  message: {
    message_id: 8,
    chat: { id: 555, type: "private" },
    date: 1_700_000_060,
    text: "sold at 1.0900",
  },
};

test("the descriptor targets the one documented job class", () => {
  const d = buildTelegramUpdateDescriptor(UPDATE);
  assert.equal(d.jobClass, TELEGRAM_UPDATE_JOB_CLASS);
  assert.equal(d.jobClass, "telegram.update");
  // Media download + a model call: the `ai` class budget, not `sync`.
  assert.equal(d.priorityClass, "ai");
});

test("the idempotency key is the Telegram update id — the same identity the claim uses", () => {
  const d = buildTelegramUpdateDescriptor(UPDATE);
  assert.equal(d.idempotencyKey, "telegram.update:4242");
  // pg-boss dedupes on `singletonKey` under the `stately` policy, so this key is
  // what turns a redelivered webhook into ONE job instead of two.
  assert.notEqual(buildTelegramUpdateDescriptor(UPDATE).idempotencyKey, buildTelegramUpdateDescriptor(OTHER).idempotencyKey);
});

test("the payload is a flat SafeJobPayload — identifiers and scalars only, never a secret", () => {
  const d = buildTelegramUpdateDescriptor(UPDATE);
  assert.equal(d.payload.updateId, "4242");
  assert.equal(d.payload.kind, "message");
  for (const [key, value] of Object.entries(d.payload)) {
    assert.ok(
      typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null,
      `payload field ${key} must be a flat scalar (queue payloads survive into retries and the DLQ)`,
    );
  }
  assert.ok(!("botToken" in d.payload));
  assert.ok(!("webhookSecret" in d.payload));
});

test("updateJson round-trips the full update, so the worker re-validates the same bytes", () => {
  const d = buildTelegramUpdateDescriptor(UPDATE);
  assert.deepEqual(JSON.parse(d.payload.updateJson), UPDATE);
});

test("`kind` mirrors the contract classifier for every inbound shape", () => {
  assert.equal(buildTelegramUpdateDescriptor(UPDATE).payload.kind, "message");
  assert.equal(
    buildTelegramUpdateDescriptor({
      update_id: 1,
      callback_query: { id: "cb1", from: { id: 5 }, data: "confirm:12" },
    }).payload.kind,
    "callback_query",
  );
  assert.equal(
    buildTelegramUpdateDescriptor({
      update_id: 2,
      edited_message: { message_id: 9, chat: { id: 5, type: "private" }, date: 1 },
    }).payload.kind,
    "edited_message",
  );
  assert.equal(buildTelegramUpdateDescriptor({ update_id: 3 }).payload.kind, "other");
});

test("the memory queue enqueues an update once and dedupes a repeat — like pg-boss `stately`", async () => {
  const queue = new MemoryTelegramUpdateQueue();
  const first = await queue.enqueue(UPDATE);
  assert.equal(first, "mem:4242");
  assert.equal(queue.enqueued.length, 1);

  const second = await queue.enqueue(UPDATE);
  assert.equal(second, "dup:telegram.update:4242");
  assert.equal(queue.enqueued.length, 1, "a duplicate must not become a second job");

  const third = await queue.enqueue(OTHER);
  assert.equal(third, "mem:4243");
  assert.equal(queue.enqueued.length, 2);
});

test("the retry policy travels with the job (pg-boss owns the backoff, not the runner)", () => {
  const d = buildTelegramUpdateDescriptor(UPDATE);
  assert.equal(d.maxAttempts, 3);
  assert.equal(d.backoffBaseMs, 2_000);
  assert.ok(d.leaseMs > d.timeoutMs, "the lease must exceed the worst-case runtime");
});
