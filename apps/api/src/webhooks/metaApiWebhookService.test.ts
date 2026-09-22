// v0.2 webhook ingestion — the external contract, case by case.
//
// Every assertion here is a behaviour a Legacy caller could observe:
//   the exact HTTP status, the exact error code, and the exact effect.
// The signature/freshness primitives get their own file; this one drives the
// service with real HMACs so the ORDER of checks is exercised too (size before
// secret, signature before parse, freshness before identifiers).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { MemoryWebhookEventStore } from "./memoryWebhookStore.js";
import { MetaApiWebhookService, type WebhookOutcome } from "./metaApiWebhookService.js";
import type { SyncRequest } from "./syncTrigger.js";

const SECRET = "webhook-test-secret-0123456789abcdef";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function build(options: {
  secret?: string | null;
  triggerResult?: boolean;
  account?: { accountId: string; userId: string; metaapiAccountId: string; syncCursor: string | null } | null;
  now?: () => Date;
} = {}) {
  const store = new MemoryWebhookEventStore(options.now);
  const requests: SyncRequest[] = [];
  const pending: string[] = [];
  const service = new MetaApiWebhookService({
    store,
    secret: () => (options.secret === undefined ? SECRET : options.secret),
    resolveAccount: async () => options.account ?? null,
    markSyncPending: async (accountId) => {
      pending.push(accountId);
    },
    trigger: {
      name: "test",
      requestSync: async (request) => {
        requests.push(request);
        return options.triggerResult ?? true;
      },
      close: async () => undefined,
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { service, store, requests, pending };
}

/** Envelope-shaped helper: the service returns a verdict, not an HTTP object. */
function payloadBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    accountId: "acct-1",
    type: "deal",
    eventId: "evt-1",
    webhookTimestamp: new Date().toISOString(),
    ...overrides,
  });
}

async function handle(
  body: string,
  headers: Record<string, string> = {},
  opts: Parameters<typeof build>[0] = {},
): Promise<WebhookOutcome & { pending: string[]; requests: SyncRequest[] }> {
  const ctx = build(opts);
  const outcome = await ctx.service.handle({
    rawBody: Buffer.from(body, "utf8"),
    headers: { "x-metaapi-signature": sign(body), ...headers },
  });
  return { ...outcome, pending: ctx.pending, requests: ctx.requests };
}

// ---------------------------------------------------------------------------
// Size and configuration
// ---------------------------------------------------------------------------

test("empty body is 413 PAYLOAD_TOO_LARGE", async () => {
  const ctx = build();
  const outcome = await ctx.service.handle({ rawBody: Buffer.alloc(0), headers: {} });
  assert.equal(outcome.status, 413);
  assert.equal(outcome.result, "rejected");
  if (outcome.result === "rejected") assert.equal(outcome.code, "PAYLOAD_TOO_LARGE");
});

test("a body over 1 MiB is 413 even with a VALID signature", async () => {
  const body = JSON.stringify({ accountId: "a", type: "deal", pad: "x".repeat(1_048_600) });
  const outcome = await handle(body);
  assert.equal(outcome.status, 413);
});

test("an unconfigured secret is 503 WEBHOOK_SECRET_MISSING, never an accept", async () => {
  const body = payloadBody();
  const ctx = build({ secret: null });
  const outcome = await ctx.service.handle({
    rawBody: Buffer.from(body, "utf8"),
    headers: { "x-metaapi-signature": sign(body) },
  });
  assert.equal(outcome.status, 503);
  assert.equal(outcome.result, "rejected");
  if (outcome.result === "rejected") assert.equal(outcome.code, "WEBHOOK_SECRET_MISSING");
  assert.equal(ctx.pending.length, 0);
});

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

test("a missing signature is 401 HMAC_FAILED", async () => {
  const ctx = build();
  const body = payloadBody();
  const outcome = await ctx.service.handle({ rawBody: Buffer.from(body, "utf8"), headers: {} });
  assert.equal(outcome.status, 401);
  if (outcome.result === "rejected") assert.equal(outcome.code, "HMAC_FAILED");
});

test("a signature computed with the WRONG secret is 401", async () => {
  const outcome = await handle(payloadBody(), { "x-metaapi-signature": sign(payloadBody(), "other-secret") });
  assert.equal(outcome.status, 401);
});

test("the signature covers the RAW BYTES: an equivalent re-serialized body fails", async () => {
  // Same JSON values, different bytes (key order). A verifier that parsed and
  // re-encoded would accept this; the contract must reject it.
  const original = '{"accountId":"acct-1","type":"deal","eventId":"e1"}';
  const reordered = '{"type":"deal","accountId":"acct-1","eventId":"e1"}';
  const ctx = build();
  const outcome = await ctx.service.handle({
    rawBody: Buffer.from(reordered, "utf8"),
    headers: { "x-metaapi-signature": sign(original) },
  });
  assert.equal(outcome.status, 401);
});

test("an `sha256=`-prefixed signature is accepted (provider formatting)", async () => {
  const body = payloadBody();
  const outcome = await handle(body, { "x-metaapi-signature": `sha256=${sign(body)}` });
  assert.equal(outcome.result, "accepted");
});

test("the fallback header `x-webhook-signature` is honored", async () => {
  const body = payloadBody();
  const ctx = build();
  const outcome = await ctx.service.handle({
    rawBody: Buffer.from(body, "utf8"),
    headers: { "x-webhook-signature": sign(body) },
  });
  assert.equal(outcome.result, "accepted");
});

// ---------------------------------------------------------------------------
// Body and freshness
// ---------------------------------------------------------------------------

test("a non-object JSON body is 422 INVALID_WEBHOOK_PAYLOAD", async () => {
  const outcome = await handle("[1,2,3]");
  assert.equal(outcome.status, 422);
  if (outcome.result === "quarantined") assert.equal(outcome.code, "INVALID_WEBHOOK_PAYLOAD");
});

test("a stale delivery timestamp is 401 WEBHOOK_TIMESTAMP_INVALID", async () => {
  const stale = new Date(Date.now() - 3600_000).toISOString();
  const outcome = await handle(payloadBody({ webhookTimestamp: stale }));
  assert.equal(outcome.status, 401);
  if (outcome.result === "rejected") assert.equal(outcome.code, "WEBHOOK_TIMESTAMP_INVALID");
});

test("a timestamp far in the FUTURE is rejected too", async () => {
  const future = new Date(Date.now() + 600_000).toISOString();
  const outcome = await handle(payloadBody({ webhookTimestamp: future }));
  assert.equal(outcome.status, 401);
});

test("a missing timestamp is rejected (a deal timestamp is not a delivery time)", async () => {
  const outcome = await handle(payloadBody({ webhookTimestamp: undefined }));
  assert.equal(outcome.status, 401);
});

test("a signed timestamp HEADER must carry its own valid signature", async () => {
  const body = payloadBody({ webhookTimestamp: undefined });
  const ts = String(Math.floor(Date.now() / 1000));
  const bad = await handle(body, { "x-metaapi-timestamp": ts, "x-metaapi-timestamp-signature": sign("nope") });
  assert.equal(bad.status, 401);
  if (bad.result === "rejected") assert.equal(bad.code, "WEBHOOK_TIMESTAMP_HMAC_FAILED");

  const good = await handle(body, {
    "x-metaapi-timestamp": ts,
    "x-metaapi-timestamp-signature": sign(`${ts}.${body}`),
  });
  assert.equal(good.result, "accepted");
});

// ---------------------------------------------------------------------------
// Identifiers, dedupe and effect
// ---------------------------------------------------------------------------

test("a malformed event type is 422 INVALID_WEBHOOK_IDENTIFIERS", async () => {
  const outcome = await handle(payloadBody({ type: "deal closed!" }));
  assert.equal(outcome.status, 422);
  if (outcome.result === "quarantined") assert.equal(outcome.code, "INVALID_WEBHOOK_IDENTIFIERS");
});

test("an event type longer than 50 characters is refused", async () => {
  const outcome = await handle(payloadBody({ type: "a".repeat(51) }));
  assert.equal(outcome.status, 422);
});

test("an unknown account is ACCEPTED and recorded (Legacy parity, account_id null)", async () => {
  const outcome = await handle(payloadBody());
  assert.equal(outcome.result, "accepted");
  assert.equal(outcome.status, 200);
  if (outcome.result === "accepted") {
    assert.equal(outcome.body["account_id"], null);
    assert.equal(outcome.body["sync"], "unknown-account");
  }
  assert.equal(outcome.pending.length, 0);
  assert.equal(outcome.requests.length, 0);
});

test("a known account is marked pending and a sync is requested", async () => {
  const outcome = await handle(payloadBody(), {}, {
    account: { accountId: "7", userId: "1", metaapiAccountId: "acct-1", syncCursor: "2026-01-01T00:00:00.000Z" },
  });
  assert.equal(outcome.result, "accepted");
  assert.deepEqual(outcome.pending, ["7"]);
  assert.equal(outcome.requests.length, 1);
  assert.equal(outcome.requests[0]?.accountId, "7");
  assert.equal(outcome.requests[0]?.from, "2026-01-01T00:00:00.000Z", "the window starts at the durable cursor");
  if (outcome.result === "accepted") assert.equal(outcome.body["sync"], "requested");
});

test("when dispatch is unavailable the event is still recorded and reported deferred", async () => {
  const outcome = await handle(payloadBody(), {}, {
    account: { accountId: "7", userId: "1", metaapiAccountId: "acct-1", syncCursor: null },
    triggerResult: false,
  });
  // Recorded (accepted) — a lost queue delays convergence, it does not lose it.
  assert.equal(outcome.result, "accepted");
  if (outcome.result === "accepted") assert.equal(outcome.body["sync"], "deferred");
  assert.deepEqual(outcome.pending, ["7"]);
});

test("a replayed event is 200 deduplicated with NO second effect", async () => {
  const body = payloadBody();
  const ctx = build({ account: { accountId: "7", userId: "1", metaapiAccountId: "acct-1", syncCursor: null } });
  const headers = { "x-metaapi-signature": sign(body) };
  const first = await ctx.service.handle({ rawBody: Buffer.from(body, "utf8"), headers });
  const second = await ctx.service.handle({ rawBody: Buffer.from(body, "utf8"), headers });
  assert.equal(first.result, "accepted");
  assert.equal(second.result, "deduplicated");
  assert.equal(second.status, 200);
  assert.equal(ctx.store.size, 1);
  assert.equal(ctx.requests.length, 1, "the replay must not trigger a second sync");
  assert.equal(ctx.pending.length, 1);
});

test("two events with distinct ids are both recorded", async () => {
  const ctx = build();
  for (const id of ["evt-a", "evt-b"]) {
    const body = payloadBody({ eventId: id });
    await ctx.service.handle({ rawBody: Buffer.from(body, "utf8"), headers: { "x-metaapi-signature": sign(body) } });
  }
  assert.equal(ctx.store.size, 2);
});

test("an event WITHOUT an id is deduplicated by content, so a retry is not replayable", async () => {
  const body = payloadBody({ eventId: undefined });
  const ctx = build();
  const headers = { "x-metaapi-signature": sign(body) };
  const first = await ctx.service.handle({ rawBody: Buffer.from(body, "utf8"), headers });
  const second = await ctx.service.handle({ rawBody: Buffer.from(body, "utf8"), headers });
  assert.equal(first.result, "accepted");
  assert.equal(second.result, "deduplicated");
});

test("the recorded event is marked processed", async () => {
  const ctx = build();
  const body = payloadBody();
  const outcome = await ctx.service.handle({
    rawBody: Buffer.from(body, "utf8"),
    headers: { "x-metaapi-signature": sign(body) },
  });
  assert.equal(outcome.result, "accepted");
  if (outcome.result === "accepted") {
    const id = String(outcome.body["event_id"]);
    const record = await ctx.store.findById("1");
    assert.equal(record?.eventId, id);
    assert.notEqual(record?.processedAt, null);
  }
});

test("the response keeps the Legacy field names so an existing caller still parses", async () => {
  const outcome = await handle(payloadBody());
  if (outcome.result !== "accepted") throw new Error("expected accepted");
  for (const key of ["account_id", "inserted", "skipped", "fills"]) {
    assert.ok(key in outcome.body, `missing Legacy field ${key}`);
  }
});
