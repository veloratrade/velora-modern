// B10-c — handler registry semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DuplicateJobClassError,
  HandlerRegistry,
  createHandlerRegistry,
} from "./registry.js";
import { MemoryQueue } from "../queue/memoryQueue.js";
import { WorkerRunner } from "../runner.js";
import type { JobDescriptor } from "@velora/contracts";

const noop = async () => {};

test("registration is explicit and queryable", () => {
  const r = new HandlerRegistry();
  assert.equal(r.size, 0);
  r.register("a.one", noop).register("a.two", noop);
  assert.equal(r.size, 2);
  assert.ok(r.has("a.one"));
  assert.equal(r.has("never.registered"), false);
  // jobClasses() is the queue-name list the pg-boss adapter creates and polls.
  assert.deepEqual(r.jobClasses(), ["a.one", "a.two"]);
});

test("duplicate registration throws instead of silently replacing", () => {
  const r = new HandlerRegistry();
  r.register("dup.class", noop);
  assert.throws(() => r.register("dup.class", noop), DuplicateJobClassError);
  // Last-import-wins would be an invisible, order-dependent bug.
  assert.equal(r.size, 1);
});

test("an empty job class is rejected", () => {
  const r = new HandlerRegistry();
  assert.throws(() => r.register("", noop), /must not be empty/);
  assert.throws(() => r.register("   ", noop), /must not be empty/);
});

test("unknown classes resolve to undefined (the NO_HANDLER path)", () => {
  const r = new HandlerRegistry();
  r.register("known.class", noop);
  assert.equal(r.resolve("unknown.class"), undefined);
  assert.ok(r.resolve("known.class"));
});

test("NO_HANDLER:<jobClass> behaviour is preserved end to end", async () => {
  const clock = { nowMs: () => 0 };
  const q = new MemoryQueue(clock, () => 0);
  const descriptor: JobDescriptor = {
    jobClass: "unregistered.class",
    priorityClass: "sync",
    idempotencyKey: "k:1",
    payload: {},
    timeoutMs: 50,
    leaseMs: 1000,
    maxAttempts: 1,
    backoffBaseMs: 10,
    backoffMaxMs: 100,
  };
  await q.enqueue(descriptor);

  const registry = createHandlerRegistry(); // deliberately empty
  const runner = new WorkerRunner(q, registry.toHandlerMap());
  assert.equal(await runner.processOnce(), "no-handler");

  const entries = await q.dlqEntries();
  assert.equal(entries[0]?.reason, "NO_HANDLER:unregistered.class");
});

test("toHandlerMap returns a copy — the registry stays the source of truth", () => {
  const r = new HandlerRegistry();
  r.register("real.class", noop);
  const map = r.toHandlerMap();
  map.set("smuggled.class", noop);
  assert.equal(r.has("smuggled.class"), false, "mutating the copy must not register");
  assert.equal(r.size, 1);
});

test("the production registry is empty until a job class is authorized", () => {
  // Guards against a placeholder job class being added to fake B10 closure.
  // When MetaAPI sync is authorized this test is updated in the same change.
  const r = createHandlerRegistry();
  assert.equal(r.size, 0);
  assert.deepEqual(r.jobClasses(), []);
});
