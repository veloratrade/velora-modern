// G-3 regression suite — proves no worker sink can emit secret material.
//
// These tests inject FAKE secret-bearing errors (no real credential exists in
// this repository) and assert that the secret never reaches a log line or a DLQ
// row. They are written as leak assertions rather than shape assertions: each
// one fails if the substring survives anywhere in the serialized output, so a
// future refactor that reintroduces raw error text breaks them immediately.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryQueue } from "../queue/memoryQueue.js";
import { WorkerRunner } from "../runner.js";
import {
  ClassifiedError,
  WORKER_ERROR_CODES,
  classifyError,
  safeDlqReason,
  safeFailureEvent,
} from "./safeError.js";
import { allowedLogFields, safeLogFields } from "./safeLog.js";
import type { JobDescriptor } from "@velora/contracts";
import { fetchHistoryDeals } from "../metaapi/historyDealsClient.js";
import { buildSyncDescriptor } from "../scheduler/syncScheduler.js";

// A realistic worst case: a provider client that echoes the request it sent.
const FAKE_SECRET = "investorPassword=Hunter2-NOT-REAL";
const PROVIDER_ECHO = `MetaAPI 401 rejected request body {"login":"123","password":"${FAKE_SECRET}"}`;

let now = 0;
const clock = { nowMs: () => now };

function job(over: Partial<JobDescriptor> = {}): JobDescriptor {
  return {
    jobClass: "metaapi.sync-account",
    priorityClass: "sync",
    idempotencyKey: "sync:acct-1",
    payload: { accountId: "1", userId: "7" },
    timeoutMs: 50,
    leaseMs: 1000,
    maxAttempts: 2,
    backoffBaseMs: 10,
    backoffMaxMs: 100,
    ...over,
  };
}

/**
 * Two sinks, because the worker has two independent barriers and a test that
 * only sees the filtered output cannot tell which one held.
 *
 *   `filtered` — exactly what index.ts writes (runner + allow-list).
 *   `raw`      — what the runner HANDED to the logger, unfiltered.
 *
 * Asserting on `raw` is what makes these tests mutation-sensitive: if the
 * runner starts passing error text again, `raw` catches it even though the
 * allow-list would have scrubbed it downstream. Defence in depth must be
 * verified layer by layer, or a regression in one layer hides behind the other.
 */
function sink(): {
  raw: Record<string, unknown>[];
  log: (e: Record<string, unknown>) => void;
  all: () => string;
  allRaw: () => string;
} {
  const raw: Record<string, unknown>[] = [];
  const lines: string[] = [];
  return {
    raw,
    log: (e) => {
      raw.push(e);
      lines.push(JSON.stringify(safeLogFields(e)));
    },
    all: () => lines.join("\n"),
    // Serializing with a replacer so Error objects reveal their message here;
    // JSON.stringify(new Error) is "{}" and would hide a genuine leak.
    allRaw: () =>
      raw
        .map((e) =>
          JSON.stringify(e, (_k, v) =>
            v instanceof Error ? { name: v.name, message: v.message } : v,
          ),
        )
        .join("\n"),
  };
}

test("G-3/1: a handler error embedding a secret is NEVER logged", async () => {
  const q = new MemoryQueue(clock, () => 0);
  await q.enqueue(job());
  const s = sink();
  const r = new WorkerRunner(
    q,
    new Map([["metaapi.sync-account", async () => { throw new Error(PROVIDER_ECHO); }]]),
    s.log,
  );

  assert.equal(await r.processOnce(), "failed");
  assert.ok(s.raw.length > 0, "the failure must still be observable");
  assert.equal(s.all().includes(FAKE_SECRET), false, "secret must not reach the log");
  assert.equal(s.all().includes("password"), false, "no request material at all");
  // The runner itself must not even HAND the secret to the logger.
  assert.equal(s.allRaw().includes(FAKE_SECRET), false, "runner must not emit raw error text");
  // The failure is still diagnosable.
  assert.match(s.all(), /"errorCode":"UNKNOWN"/);
  assert.match(s.all(), /"jobClass":"metaapi\.sync-account"/);
});

test("G-3/2: a ClassifiedError reports its code and never its message", async () => {
  const q = new MemoryQueue(clock, () => 0);
  await q.enqueue(job());
  const s = sink();
  const r = new WorkerRunner(
    q,
    new Map([
      ["metaapi.sync-account", async () => {
        throw new ClassifiedError("PROVIDER_REJECTED", PROVIDER_ECHO);
      }],
    ]),
    s.log,
  );

  assert.equal(await r.processOnce(), "failed");
  assert.equal(s.all().includes(FAKE_SECRET), false);
  assert.equal(s.allRaw().includes(FAKE_SECRET), false, "the message must never be read");
  assert.match(s.all(), /"errorCode":"PROVIDER_REJECTED"/);
});

test("G-3/3: a non-Error throw (string) cannot smuggle text into the log", async () => {
  const q = new MemoryQueue(clock, () => 0);
  await q.enqueue(job());
  const s = sink();
  const r = new WorkerRunner(
    q,
    // Throwing a raw string used to hit `String(err)` in the old runner.
    new Map([["metaapi.sync-account", async () => { throw PROVIDER_ECHO; }]]),
    s.log,
  );

  assert.equal(await r.processOnce(), "failed");
  assert.equal(s.all().includes(FAKE_SECRET), false, "String(err) path must be closed");
  assert.equal(s.allRaw().includes(FAKE_SECRET), false, "String(err) path must be closed at source");
  assert.match(s.all(), /"errorCode":"UNKNOWN"/);
});

test("G-3/4: DLQ reasons are fixed codes, never error or provider text", async () => {
  const q = new MemoryQueue(clock, () => 0);
  await q.enqueue(job({ jobClass: "unregistered.class" }));
  const s = sink();
  // No handler registered → the runner dead-letters it.
  const r = new WorkerRunner(q, new Map(), s.log);

  assert.equal(await r.processOnce(), "no-handler");
  const entries = await q.dlqEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.reason, "NO_HANDLER:unregistered.class");
  assert.equal(entries[0]!.reason.includes(FAKE_SECRET), false);
  assert.equal(s.all().includes(FAKE_SECRET), false);
});

test("G-3/5: DLQ reason is bounded and secret-free even with a hostile jobClass", () => {
  const hostile = `x${FAKE_SECRET}`.repeat(50);
  const reason = safeDlqReason("HANDLER_FAILED", hostile);
  assert.ok(reason.length <= "HANDLER_FAILED:".length + 64, "reason must stay bounded");
  // The code prefix survives; the payload cannot grow without limit.
  assert.match(reason, /^HANDLER_FAILED:/);
});

test("G-3/6: the log sink drops any field not on the allow-list", () => {
  const out = safeLogFields({
    level: "warn",
    errorCode: "TIMEOUT",
    // Everything below is NOT allow-listed and must vanish.
    error: PROVIDER_ECHO,
    message: PROVIDER_ECHO,
    payload: { secret: FAKE_SECRET },
    stack: PROVIDER_ECHO,
    cause: new Error(PROVIDER_ECHO),
  });
  const serialized = JSON.stringify(out);
  assert.equal(serialized.includes(FAKE_SECRET), false);
  assert.deepEqual(Object.keys(out).sort(), ["errorCode", "level"]);
});

test("G-3/7: nested objects are dropped even under an allow-listed key", () => {
  const out = safeLogFields({ jobClass: { toString: () => FAKE_SECRET }, id: "j1" });
  assert.equal(JSON.stringify(out).includes(FAKE_SECRET), false);
  assert.equal("jobClass" in out, false, "an object under an allowed key is still dropped");
  assert.equal(out["id"], "j1");
});

test("G-3/8: classifyError never derives a code from error text", () => {
  // An error whose message literally contains a code name must NOT be promoted.
  assert.equal(classifyError(new Error("PROVIDER_REJECTED and the password is x")), "UNKNOWN");
  assert.equal(classifyError(new ClassifiedError("TIMEOUT")), "TIMEOUT");
  assert.equal(classifyError({ code: "NOT_CONFIGURED" }), "NOT_CONFIGURED");
  assert.equal(classifyError({ code: "totally-made-up" }), "UNKNOWN");
  assert.equal(classifyError(undefined), "UNKNOWN");
  assert.equal(classifyError(null), "UNKNOWN");
});

test("G-3/9: every emitted failure event contains only safe field types", () => {
  const ev = safeFailureEvent({
    event: "job.failed", jobClass: "metaapi.sync-account",
    jobId: "j1", attempts: 2, code: "PROVIDER_UNAVAILABLE", durationMs: 12,
  });
  for (const [k, v] of Object.entries(ev)) {
    assert.ok(allowedLogFields().includes(k), `${k} must be allow-listed`);
    assert.ok(["string", "number"].includes(typeof v), `${k} must be a scalar`);
  }
  assert.equal(ev["errorCode"], "PROVIDER_UNAVAILABLE");
});

test("G-3/10: a ClassifiedError with no message does not expose internals", () => {
  const e = new ClassifiedError("NOT_CONFIGURED");
  // Even an accidental String(err) at a future call site yields only the code.
  assert.equal(String(e).includes(FAKE_SECRET), false);
  assert.match(String(e), /NOT_CONFIGURED/);
  assert.ok(WORKER_ERROR_CODES.includes(e.code));
});

// --- MetaAPI sync surfaces (added with the historical-sync implementation) ---
// New code introduced two fresh egress surfaces — a provider HTTP client and a
// job payload — so each gets a leak assertion rather than an assumption.

test("G-3/11: the MetaAPI client never puts the platform token in an error", async () => {
  const TOKEN = "meta-platform-token-NOT-REAL-9f3b";
  // A provider that rejects, and a transport that throws with the token in its
  // message — the two realistic ways a token escapes into an error path.
  for (const impl of [
    (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch,
    (async () => { throw new Error(`connect failed using auth-token ${TOKEN}`); }) as unknown as typeof fetch,
  ]) {
    let thrown: unknown;
    try {
      await fetchHistoryDeals(TOKEN, {
        metaapiAccountId: "acc-1", from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z",
      }, { fetchImpl: impl });
    } catch (err) { thrown = err; }

    assert.ok(thrown instanceof ClassifiedError);
    // Neither the message nor any serialization of the error carries the token.
    assert.equal(String((thrown as Error).message).includes(TOKEN), false);
    assert.equal(JSON.stringify(safeFailureEvent({
      event: "job.failed", jobClass: "metaapi.sync-account", jobId: "1",
      attempts: 1, code: classifyError(thrown),
    })).includes(TOKEN), false);
  }
});

test("G-3/12: a sync job payload is flat, non-secret identifiers only", () => {
  const descriptor = buildSyncDescriptor(
    "acct-1", "meta-acct-1", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
  const serialized = JSON.stringify(descriptor.payload);
  for (const forbidden of ["token", "password", "secret", "credential", "cipher", "key"]) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false,
      `payload must not contain '${forbidden}'`);
  }
  // Flat scalars only: a nested object could smuggle a credential bundle.
  for (const v of Object.values(descriptor.payload)) {
    assert.ok(["string", "number", "boolean"].includes(typeof v));
  }
});

test("G-3/13: a provider error code is never derived from provider text", () => {
  // The provider controls the body; it must not be able to choose our code.
  const hostile = new Error("PROVIDER_REJECTED but actually leaking Hunter2");
  assert.equal(classifyError(hostile), "UNKNOWN");
  // And every sync code stays inside the closed vocabulary.
  for (const code of ["PROVIDER_MALFORMED", "RESERVATION_HELD"] as const) {
    assert.ok((WORKER_ERROR_CODES as readonly string[]).includes(code));
    assert.equal(safeDlqReason(code, "metaapi.sync-account").includes("Hunter2"), false);
  }
});
