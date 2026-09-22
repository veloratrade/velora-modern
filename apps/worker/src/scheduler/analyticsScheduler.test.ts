// Analytics tick — the producer's decisions, without a database.
//
// The SQL of the due set is proven against real PostgreSQL
// (`db/tests/analyticsRecompute.pg.test.ts`, which drives `listRecomputeUsers`
// itself). What this battery pins down is the tick's own contract: which window
// it asks for, how many users it fans out to, that the batch bound is respected,
// that a tick with nothing due produces no work, and that the idempotency key
// collapses a doubled tick inside one hour while leaving the next hour free.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ANALYTICS_BATCH,
  runAnalyticsTick,
  buildAnalyticsDescriptor,
  recomputeWindow,
  ANALYTICS_TICK_JOB_CLASS,
  DEFAULT_ANALYTICS_CRON,
} from "./analyticsScheduler.js";
import { DEFAULT_WINDOW_DAYS } from "../analytics/dailyRecompute.js";
import type { AggregateQuery } from "../analytics/dailyRecompute.js";
import type { JobDescriptor } from "@velora/contracts";
import type { QueuePort } from "../queue/QueuePort.js";

function fakeQueue(): { queue: QueuePort; enqueued: JobDescriptor[] } {
  const enqueued: JobDescriptor[] = [];
  const queue = {
    enqueue: async (descriptor: JobDescriptor) => {
      enqueued.push(descriptor);
      return `job-${enqueued.length}`;
    },
  } as unknown as QueuePort;
  return { queue, enqueued };
}

/** A port that returns a fixed due set and records the parameters it was asked with. */
function fakeQuery(due: string[]): { q: AggregateQuery; calls: { from: string; to: string; limit: number }[] } {
  const calls: { from: string; to: string; limit: number }[] = [];
  const q: AggregateQuery = async (sql, params = []) => {
    assert.match(sql, /FROM trades t/);
    assert.match(sql, /AS due/, "the due set is the UNION the tick relies on");
    calls.push({ from: String(params[0]), to: String(params[1]), limit: Number(params[2]) });
    return due.map((user_id) => ({ user_id }));
  };
  return { q, calls };
}

const NOW = new Date("2026-09-22T12:34:56.000Z");

test("the tick asks for the documented window and fans out one job per due user", async () => {
  const { q, calls } = fakeQuery(["1", "2", "3"]);
  const { queue, enqueued } = fakeQueue();

  const count = await runAnalyticsTick(q, queue, NOW, 10);

  assert.equal(count, 3, "the returned count is the number of jobs enqueued, not a guess");
  assert.equal(enqueued.length, 3);
  assert.deepEqual(calls, [{ from: recomputeWindow(NOW).from, to: NOW.toISOString(), limit: 10 }]);
  assert.equal(recomputeWindow(NOW).from, new Date(NOW.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000).toISOString());

  for (const job of enqueued) {
    assert.equal(job.jobClass, "analytics.recompute-daily");
    assert.equal(job.priorityClass, "reports", "the ADR-007 policy for this class");
    assert.match(job.idempotencyKey, /^analytics:daily:\d+:2026-09-22T12$/, "user + UTC hour");
    assert.deepEqual(Object.keys(job.payload as Record<string, unknown>).sort(), ["from", "to", "userId"], "no user data beyond the window");
  }
});

test("a doubled tick inside one hour collapses onto the same keys; the next hour does not", async () => {
  const { q } = fakeQuery(["7"]);
  const first = fakeQueue();
  const second = fakeQueue();
  await runAnalyticsTick(q, first.queue, NOW, 10);
  await runAnalyticsTick(q, second.queue, new Date("2026-09-22T12:59:00.000Z"), 10);
  await runAnalyticsTick(q, fakeQueue().queue, new Date("2026-09-22T13:00:00.000Z"), 10);

  assert.deepEqual(first.enqueued[0]?.idempotencyKey, second.enqueued[0]?.idempotencyKey);
  assert.equal(
    buildAnalyticsDescriptor("7", recomputeWindow(NOW).from, NOW.toISOString(), "2026-09-22T13").idempotencyKey,
    "analytics:daily:7:2026-09-22T13",
    "a new hour is a new key — the tick is not silenced forever",
  );
});

test("nothing due is not work, and the batch bound is the caller's", async () => {
  const empty = fakeQuery([]);
  const queue = fakeQueue();
  assert.equal(await runAnalyticsTick(empty.q, queue.queue, NOW, 10), 0);
  assert.equal(queue.enqueued.length, 0, "an idle tick enqueues nothing (and logs an honest 0)");

  const { q, calls } = fakeQuery(["1", "2"]);
  await runAnalyticsTick(q, fakeQueue().queue, NOW);
  assert.equal(calls[0]?.limit, DEFAULT_ANALYTICS_BATCH, "the default fan-out bound");

  // The tick does not invent users when the port returns more than the bound —
  // bounding is the SQL's LIMIT, and this asserts the tick passes a bound at all.
  const { q: q2, calls: calls2 } = fakeQuery(["1", "2", "3", "4"]);
  const big = fakeQueue();
  await runAnalyticsTick(q2, big.queue, NOW, 2);
  assert.equal(calls2[0]?.limit, 2);
});

test("the scheduled cadence and class names are the ones the worker registers", () => {
  assert.equal(ANALYTICS_TICK_JOB_CLASS, "analytics.recompute-tick");
  assert.equal(DEFAULT_ANALYTICS_CRON, "20 * * * *");
});
