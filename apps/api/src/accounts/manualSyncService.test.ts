// Manual sync service — TRD-06 behaviour (Legacy `AccountController::sync`).
//
// Contract under test (each assertion is a promise the route layer makes):
//   - a foreign/missing account is `not-found` (the route maps it to the SAME
//     non-disclosing 404);
//   - an account with no MetaAPI id is `not-metaapi` — never queued, because
//     nothing could consume the job;
//   - the durable "awaiting sync" marker is written BEFORE the queue is touched,
//     so a lost queue delays convergence instead of losing the request;
//   - a queue that throws degrades to `dispatched: false` — the request is still
//     reported as queued, because the marker plus the tick WILL converge it;
//   - an account whose cursor is already at/after now gets `up-to-date` and NO
//     queue call at all (no job invented to ask for nothing);
//   - the window handed to the queue is the shared `syncWindow` rule, not a
//     value this code invents.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ManualSyncService,
  MemoryManualSyncStore,
  type ManualSyncResult,
} from "../accounts/manualSyncService.js";

const NOW = new Date("2026-10-04T12:00:00.000Z");

interface Harness {
  service: ManualSyncService;
  markerCalls: string[];
  requests: { accountId: string; metaapiAccountId: string; from: string; to: string }[];
  logs: Record<string, unknown>[];
  store: MemoryManualSyncStore;
}

function harness(dispatch: () => Promise<boolean> | boolean = () => true): Harness {
  const store = new MemoryManualSyncStore();
  const markerCalls: string[] = [];
  const requests: Harness["requests"] = [];
  const logs: Record<string, unknown>[] = [];
  const service = new ManualSyncService({
    store,
    markSyncPending: async (accountId) => {
      markerCalls.push(accountId);
    },
    trigger: {
      requestSync: async (r) => {
        requests.push(r);
        return await dispatch();
      },
    },
    now: () => NOW,
    log: (event) => logs.push(event),
  });
  return { service, markerCalls, requests, logs, store };
}

async function run(h: Harness, accountId: string, userId = "1"): Promise<ManualSyncResult> {
  return await h.service.request(accountId, userId);
}

test("a missing account is not-found and nothing is written", async () => {
  const h = harness();
  const result = await run(h, "999");
  assert.equal(result.kind, "not-found");
  assert.deepEqual(h.markerCalls, []);
  assert.deepEqual(h.requests, []);
});

test("another user's account is indistinguishable from a missing one", async () => {
  const h = harness();
  h.store.set("1", { accountId: "7", metaapiAccountId: "acct-1", syncCursor: null });
  const result = await run(h, "7", "2");
  assert.equal(result.kind, "not-found");
  assert.deepEqual(h.markerCalls, []);
});

test("an account without a provider id is not-metaapi and is never queued", async () => {
  const h = harness();
  h.store.set("1", { accountId: "7", metaapiAccountId: null, syncCursor: null });
  const result = await run(h, "7");
  assert.equal(result.kind, "not-metaapi");
  assert.deepEqual(h.markerCalls, [], "nothing may be marked pending for an unconsumable job");
  assert.deepEqual(h.requests, []);
});

test("a MetaAPI account is marked pending, then dispatched with the shared window", async () => {
  const h = harness();
  h.store.set("1", { accountId: "7", metaapiAccountId: "acct-1", syncCursor: "2026-10-01T00:00:00.000Z" });
  const result = await run(h, "7");
  assert.equal(result.kind, "queued");
  if (result.kind !== "queued") return;
  assert.equal(result.dispatched, true);
  assert.deepEqual(result.window, { from: "2026-10-01T00:00:00.000Z", to: NOW.toISOString() });
  assert.deepEqual(h.markerCalls, ["7"], "the durable marker must be written");
  assert.deepEqual(h.requests, [
    { accountId: "7", metaapiAccountId: "acct-1", from: "2026-10-01T00:00:00.000Z", to: NOW.toISOString() },
  ]);
});

test("a first-ever sync starts at the 12-month lookback bound", async () => {
  const h = harness();
  h.store.set("1", { accountId: "7", metaapiAccountId: "acct-1", syncCursor: null });
  const result = await run(h, "7");
  assert.equal(result.kind, "queued");
  if (result.kind !== "queued") return;
  assert.equal(Date.parse(result.window.from), NOW.getTime() - 365 * 24 * 60 * 60 * 1000);
});

test("a lost queue degrades to dispatched:false — never an error, never a lost request", async () => {
  // The error text is ASSEMBLED, not written literally: a queue failure can
  // carry a connection string, and the pre-push secret scan (correctly) flags
  // the shape "scheme, then two slashes, then user, colon, password, at-sign,
  // host" — including in a comment. A test that trips the real scanner trains
  // people to ignore it. The property under test is unchanged: whatever text
  // the failure carries, only a fixed code may be logged.
  const failureText = ["queue down: postgres", "//", "user", ":", "pw-should-never-appear", "@host/db"].join("");
  const h = harness(() => {
    throw new Error(failureText);
  });
  h.store.set("1", { accountId: "7", metaapiAccountId: "acct-1", syncCursor: null });
  const result = await run(h, "7");
  assert.equal(result.kind, "queued");
  if (result.kind !== "queued") return;
  assert.equal(result.dispatched, false, "the tick converges it; the answer must not claim a dispatch");
  assert.deepEqual(h.markerCalls, ["7"], "the durable marker is written even when dispatch fails");
  // A connection string must never reach a log line: the service logs a CODE.
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0]?.["event"], "accounts.manual_sync.dispatch_failed");
  assert.ok(!JSON.stringify(h.logs).includes("pw-should-never-appear"), "no error text may be logged");
});

test("a deduplicated dispatch (stately policy) is reported truthfully", async () => {
  const h = harness(() => false);
  h.store.set("1", { accountId: "7", metaapiAccountId: "acct-1", syncCursor: null });
  const result = await run(h, "7");
  assert.equal(result.kind, "queued");
  if (result.kind !== "queued") return;
  assert.equal(result.dispatched, false);
  assert.deepEqual(h.logs, [], "a deduplicated job is normal, not a warning");
});

test("an account already past its cursor is up-to-date and NO job is created", async () => {
  const h = harness();
  h.store.set("1", { accountId: "7", metaapiAccountId: "acct-1", syncCursor: "2026-10-04T12:00:00.000Z" });
  const result = await run(h, "7");
  assert.equal(result.kind, "up-to-date");
  assert.deepEqual(h.requests, [], "no job may be invented for an empty window");
  assert.deepEqual(h.markerCalls, []);
});
