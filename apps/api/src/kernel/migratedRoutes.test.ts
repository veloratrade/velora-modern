// Migrated capability surface over real HTTP (directive t, pass 1).
//
// These tests drive the ACTUAL server returned by `createApp`, so they prove
// three things a service-level test cannot:
//   1. the route is reachable and the kernel really delegates to it;
//   2. the Phase C surface keeps precedence (no migrated route shadows one);
//   3. an absent capability fails closed with 503 instead of degrading.
// Every store here is the in-memory double of its PostgreSQL adapter, which is
// why this file proves ROUTE behaviour only — real-SQL behaviour lives in
// `*.pg.test.ts` batteries under `db/tests/`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createApp, listen, type ApiConfig } from "./server.js";
import { AuthService } from "../auth/authService.js";
import { JwtService } from "../auth/jwt.js";
import { VeloraHasher } from "../auth/hashing.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { LogMailProvider } from "../mail/logMailProvider.js";
import { MemoryWebhookEventStore } from "../webhooks/memoryWebhookStore.js";
import { MetaApiWebhookService } from "../webhooks/metaApiWebhookService.js";
import { MemorySyncStatusStore, type SyncStatusView } from "../accounts/syncStatusService.js";
import { MemoryAnalyticsStore, type AnalyticsTradeRow } from "../analytics/analyticsStore.js";
import { MemoryTagStore } from "../tags/tagService.js";
import {
  AttachmentService,
  MemoryAttachmentStore,
  MemoryAttachmentStorage,
  MAX_ATTACHMENT_BYTES,
} from "../attachments/attachmentService.js";
import { MemorySubscriptionStore } from "../billing/subscriptionService.js";
import { MemoryAiCoachStore } from "../aicoach/aiCoachRoutes.js";
import { MemoryAdminStore } from "../admin/adminRoutes.js";
import { MemoryPortfolioStore } from "../portfolio/portfolioRoutes.js";
import { MemoryEaStore } from "../ea/eaRoutes.js";
import { MemoryTenancyStore } from "../tenancy/tenancyRoutes.js";
import { MemoryDeveloperStore } from "../developer/developerRoutes.js";

const SECRET = "migrated-routes-test-secret-0123456789";
const WEBHOOK_SECRET = "webhook-secret-abcdef0123456789";

function tokenFor(sub: string, role = "user"): string {
  return JwtService.create(SECRET).sign({ sub, role }, 900);
}

interface Envelope<T = Record<string, unknown>> {
  status: string;
  data: T;
  error: { code: string; message: string } | null;
  timestamp: string;
}

interface Harness {
  base: string;
  config: ApiConfig;
  webhookStore: MemoryWebhookEventStore;
  attachments: MemoryAttachmentStore;
}

async function withServer(fn: (h: Harness) => Promise<void>, extend: Partial<ApiConfig> = {}): Promise<void> {
  const webhookStore = new MemoryWebhookEventStore();
  const attachmentStore = new MemoryAttachmentStore();
  const config: ApiConfig = {
    allowedOrigins: ["https://veloratrade.ir"],
    checks: { database: async () => "ok" as const },
    auth: new AuthService({
      store: new MemoryUserStore(),
      hasher: new VeloraHasher(),
      jwt: JwtService.create(SECRET),
      mail: new LogMailProvider(),
    }),
    webhooks: new MetaApiWebhookService({
      store: webhookStore,
      secret: () => WEBHOOK_SECRET,
      resolveAccount: async (id) =>
        id === "acct-1" ? { accountId: "7", userId: "1", metaapiAccountId: "acct-1", syncCursor: null } : null,
      markSyncPending: async () => undefined,
      trigger: { name: "test", requestSync: async () => true, close: async () => undefined },
    }),
    ...extend,
  };
  const app = createApp(config);
  const port = await listen(app);
  try {
    await fn({ base: `http://127.0.0.1:${port}`, config, webhookStore, attachments: attachmentStore });
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

/** Headers to SPREAD into an explicit headers object. */
const AUTH = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
/** A complete RequestInit for a bare authenticated GET. */
const H = (token?: string): RequestInit =>
  token === undefined ? {} : { headers: AUTH(token) };

async function json<T = Record<string, unknown>>(res: Response): Promise<Envelope<T>> {
  return (await res.json()) as Envelope<T>;
}

// ---------------------------------------------------------------------------
// The kernel delegation itself
// ---------------------------------------------------------------------------

test("the Phase C surface keeps precedence and unknown routes still 404", async () => {
  await withServer(async ({ base }) => {
    const missing = await fetch(`${base}/api/v1/definitely-not-a-route`, H(tokenFor("1")));
    assert.equal(missing.status, 404);
    const body = await json(missing);
    assert.equal(body.error?.code, "NOT_FOUND");
  });
});

test("a migrated capability that is NOT wired fails closed with 503", async () => {
  await withServer(async ({ base }) => {
    for (const path of [
      "/api/v1/analytics/summary",
      "/api/v1/tags",
      "/api/v1/subscriptions/me",
      "/api/v1/ai-coach/consent",
      "/api/v1/admin/metrics",
      "/api/v1/portfolio/summary",
      "/api/v1/developer/keys",
      "/api/v1/copy-trading/relationships",
      "/api/v1/accounts/7/sync-status",
    ]) {
      const res = await fetch(`${base}${path}`, H(tokenFor("1")));
      assert.equal(res.status, 503, `${path} must fail closed when absent`);
      const body = await json(res);
      assert.equal(body.error?.code, "SERVICE_UNAVAILABLE");
    }
  });
});

// ---------------------------------------------------------------------------
// v0.2 — webhook ingress + sync status
// ---------------------------------------------------------------------------

test("POST /webhooks/metaapi accepts a correctly signed event and reports 200 ok", async () => {
  await withServer(async ({ base, webhookStore }) => {
    const body = JSON.stringify({
      accountId: "acct-1",
      type: "deal",
      eventId: "evt-route-1",
      webhookTimestamp: new Date().toISOString(),
    });
    const res = await fetch(`${base}/api/v1/webhooks/metaapi`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-metaapi-signature": createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex"),
      },
      body,
    });
    assert.equal(res.status, 200);
    const envelope = await json(res);
    assert.equal(envelope.status, "success");
    assert.equal(envelope.data["account_id"], "7");
    assert.equal(webhookStore.size, 1);
  });
});

test("POST /webhooks/metaapi surfaces the Legacy error codes unchanged", async () => {
  await withServer(async ({ base }) => {
    const bad = await fetch(`${base}/api/v1/webhooks/metaapi`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-metaapi-signature": "0".repeat(64) },
      body: "{}",
    });
    assert.equal(bad.status, 401);
    assert.equal((await json(bad)).error?.code, "HMAC_FAILED");

    const wrongMethod = await fetch(`${base}/api/v1/webhooks/metaapi`, { method: "GET" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
  });
});

test("the webhook route does NOT require a bearer token (signature IS the auth)", async () => {
  await withServer(async ({ base }) => {
    const body = JSON.stringify({
      accountId: "acct-1",
      type: "deal",
      eventId: "evt-no-bearer",
      webhookTimestamp: new Date().toISOString(),
    });
    const res = await fetch(`${base}/api/v1/webhooks/metaapi`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-metaapi-signature": createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex"),
      },
      body,
    });
    assert.equal(res.status, 200);
  });
});

test("GET /accounts/{id}/sync-status is ownership scoped and non-disclosing", async () => {
  const store = new MemorySyncStatusStore();
  const view: SyncStatusView = {
    accountId: "7",
    provider: "METAAPI",
    platform: "MT5",
    state: "CONNECTED",
    lastSyncedAt: "2026-01-01T00:00:00.000Z",
    lastErrorCode: null,
    consecutiveErrors: 0,
    connectedAt: "2025-12-31T00:00:00.000Z",
    metaapiConnected: true,
  };
  store.set("1", view);
  await withServer(
    async ({ base }) => {
      const mine = await fetch(`${base}/api/v1/accounts/7/sync-status`, H(tokenFor("1")));
      assert.equal(mine.status, 200);
      const body = await json(mine);
      assert.equal(body.data["state"], "CONNECTED");
      assert.equal(body.data["metaapiConnected"], true);

      // Another user asking for the SAME account gets a 404, identical to a
      // nonexistent account — the endpoint is not an existence oracle.
      const foreign = await fetch(`${base}/api/v1/accounts/7/sync-status`, H(tokenFor("2")));
      assert.equal(foreign.status, 404);
      const missing = await fetch(`${base}/api/v1/accounts/999/sync-status`, H(tokenFor("1")));
      assert.equal(missing.status, 404);

      const anonymous = await fetch(`${base}/api/v1/accounts/7/sync-status`);
      assert.equal(anonymous.status, 401);
    },
    { syncStatus: store },
  );
});

// ---------------------------------------------------------------------------
// v0.5 — analytics, tags, attachments
// ---------------------------------------------------------------------------

const analyticsRows: AnalyticsTradeRow[] = [
  { tradeId: "1", accountId: "7", symbol: "EURUSD", occurredAt: "2026-01-01T09:00:00.000Z", netPnl: "100.00", rMultiple: "2.00000000", day: "2026-01-01", weekday: 2, hour: 9, strategy: "breakout" },
  { tradeId: "2", accountId: "7", symbol: "EURUSD", occurredAt: "2026-01-02T10:00:00.000Z", netPnl: "-40.00", rMultiple: "-1.00000000", day: "2026-01-02", weekday: 3, hour: 10, strategy: "breakout" },
  { tradeId: "3", accountId: "7", symbol: "XAUUSD", occurredAt: "2026-01-02T11:00:00.000Z", netPnl: "10.00", rMultiple: null, day: "2026-01-02", weekday: 3, hour: 11, strategy: null },
];

test("GET /analytics/summary returns the metric contract, scoped to the caller", async () => {
  await withServer(
    async ({ base }) => {
      const res = await fetch(`${base}/api/v1/analytics/summary?period=all`, H(tokenFor("1")));
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body.data["wins"], 2);
      assert.equal(body.data["losses"], 1);
      assert.equal(body.data["totalPnl"], "70.00");
      assert.equal(body.data["winRate"], "0.6667");
      assert.equal(body.data["averageR"], "0.5000");
      assert.equal(body.data["profitFactor"], "2.7500");

      const bad = await fetch(`${base}/api/v1/analytics/summary?period=forever`, H(tokenFor("1")));
      assert.equal(bad.status, 400);
      assert.equal((await json(bad)).error?.code, "VALIDATION_FAILED");
    },
    { analytics: new MemoryAnalyticsStore(analyticsRows) },
  );
});

test("GET /analytics/equity-curve buckets per day and accumulates", async () => {
  await withServer(
    async ({ base }) => {
      const res = await fetch(`${base}/api/v1/analytics/equity-curve`, H(tokenFor("1")));
      const body = await json<{ points: { day: string; cumulativePnl: string }[] }>(res);
      // Day 2 aggregates its TWO trades (-40.00 and +10.00) onto the running
      // total from day 1: 100.00 + (-30.00) = 70.00.
      assert.deepEqual(body.data.points, [
        { day: "2026-01-01", cumulativePnl: "100.00" },
        { day: "2026-01-02", cumulativePnl: "70.00" },
      ]);
    },
    { analytics: new MemoryAnalyticsStore(analyticsRows) },
  );
});

test("GET /analytics/heatmap groups by weekday and hour", async () => {
  await withServer(
    async ({ base }) => {
      const res = await fetch(`${base}/api/v1/analytics/heatmap`, H(tokenFor("1")));
      const body = await json<{ cells: { weekday: number; hour: number }[] }>(res);
      assert.equal(body.data.cells.length, 3);
      assert.deepEqual(
        body.data.cells.map((c) => [c.weekday, c.hour]),
        [
          [2, 9],
          [3, 10],
          [3, 11],
        ],
      );
    },
    { analytics: new MemoryAnalyticsStore(analyticsRows) },
  );
});

test("analytics windows are instant-bounded: `from` inclusive, `to` exclusive", async () => {
  const rows = [
    {
      tradeId: "1", accountId: "7", symbol: "EURUSD",
      occurredAt: "2026-01-01T23:59:59.999Z",
      netPnl: "10.00", rMultiple: "1.00000000", day: "2026-01-01", weekday: 4, hour: 23, strategy: null,
    },
    {
      tradeId: "2", accountId: "7", symbol: "EURUSD",
      occurredAt: "2026-01-02T00:00:00.000Z",
      netPnl: "20.00", rMultiple: "1.00000000", day: "2026-01-02", weekday: 5, hour: 0, strategy: null,
    },
    {
      tradeId: "3", accountId: "7", symbol: "EURUSD",
      occurredAt: "2026-01-02T12:00:00.000Z",
      netPnl: "30.00", rMultiple: "1.00000000", day: "2026-01-02", weekday: 5, hour: 12, strategy: null,
    },
  ];
  await withServer(
    async ({ base }) => {
      // A window starting EXACTLY at a trade's instant includes it ...
      const fromInclusive = await json(
        await fetch(`${base}/api/v1/analytics/summary?from=2026-01-02T00:00:00.000Z`, H(tokenFor("1"))),
      );
      assert.equal(fromInclusive.data.tradeCount, 2);

      // ... and a window ending exactly at a trade's instant EXCLUDES it.
      const toExclusive = await json(
        await fetch(`${base}/api/v1/analytics/summary?to=2026-01-02T12:00:00.000Z`, H(tokenFor("1"))),
      );
      assert.equal(toExclusive.data.tradeCount, 2);

      const full = await json(
        await fetch(`${base}/api/v1/analytics/summary?from=2026-01-01T00:00:00.000Z&to=2026-01-03T00:00:00.000Z`, H(tokenFor("1"))),
      );
      assert.equal(full.data.tradeCount, 3);
      assert.equal(full.data.totalPnl, "60.00", "money stays exact at scale 2");
    },
    { analytics: new MemoryAnalyticsStore(rows) },
  );
});

test("tags: create, list, duplicate conflict, cross-user isolation", async () => {
  const tags = new MemoryTagStore();
  tags.addTrade("1", "50");
  await withServer(
    async ({ base }) => {
      const created = await fetch(`${base}/api/v1/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({ name: "Breakout", kind: "strategy", color: "#A1B2C3" }),
      });
      assert.equal(created.status, 201);
      const tag = (await json(created)).data;
      assert.equal(tag["kind"], "STRATEGY", "kind is normalised to the 0015 vocabulary");

      const duplicate = await fetch(`${base}/api/v1/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({ name: "Breakout" }),
      });
      assert.equal(duplicate.status, 409);

      const badColor = await fetch(`${base}/api/v1/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({ name: "X", color: "red" }),
      });
      assert.equal(badColor.status, 400);

      const foreign = await fetch(`${base}/api/v1/tags`, H(tokenFor("2")));
      const foreignBody = await json<{ tags: unknown[] }>(foreign);
      assert.deepEqual(foreignBody.data.tags, [], "another user sees no tags");

      // Assign to a trade the caller owns; a foreign trade is a 404.
      const assigned = await fetch(`${base}/api/v1/trades/50/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({ tag_id: String(tag["id"]) }),
      });
      assert.equal(assigned.status, 201);

      const again = await fetch(`${base}/api/v1/trades/50/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({ tag_id: String(tag["id"]) }),
      });
      assert.equal(again.status, 409, "a duplicate assignment is a conflict, not a second row");

      const foreignTrade = await fetch(`${base}/api/v1/trades/51/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({ tag_id: String(tag["id"]) }),
      });
      assert.equal(foreignTrade.status, 404);

      const removed = await fetch(`${base}/api/v1/trades/50/tags/${String(tag["id"])}`, {
        method: "DELETE",
        headers: AUTH(tokenFor("1")),
      });
      assert.equal(removed.status, 204);
    },
    { tags },
  );
});

test("attachments: raw upload validates type and size, and content is ownership scoped", async () => {
  const store = new MemoryAttachmentStore();
  store.addTrade("1", "50");
  const service = new AttachmentService(store, new MemoryAttachmentStorage());
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  await withServer(
    async ({ base }) => {
      const ok = await fetch(`${base}/api/v1/trades/50/attachments?file_name=chart.jpg`, {
        method: "POST",
        headers: { "Content-Type": "image/jpeg", ...AUTH(tokenFor("1")) },
        body: new Uint8Array(bytes),
      });
      assert.equal(ok.status, 201);
      const record = (await json(ok)).data;
      assert.equal(record["mime"], "image/jpeg");
      assert.equal(record["sizeBytes"], bytes.length);
      assert.match(String(record["checksumSha256"]), /^[0-9a-f]{64}$/);

      // Path components in a client-supplied name are stripped, never stored.
      const named = await fetch(`${base}/api/v1/trades/50/attachments?file_name=../../etc/passwd.png`, {
        method: "POST",
        headers: { "Content-Type": "image/png", ...AUTH(tokenFor("1")) },
        body: new Uint8Array([1, 2, 3, 4]),
      });
      assert.equal(named.status, 201);
      assert.equal((await json(named)).data["fileName"], "passwd.png");

      const wrongType = await fetch(`${base}/api/v1/trades/50/attachments?file_name=x.svg`, {
        method: "POST",
        headers: { "Content-Type": "image/svg+xml", ...AUTH(tokenFor("1")) },
        body: new Uint8Array([1, 2, 3]),
      });
      assert.equal(wrongType.status, 422);
      assert.equal((await json(wrongType)).error?.code, "UNSUPPORTED_MEDIA_TYPE");

      const empty = await fetch(`${base}/api/v1/trades/50/attachments?file_name=empty.png`, {
        method: "POST",
        headers: { "Content-Type": "image/png", ...AUTH(tokenFor("1")) },
        body: new Uint8Array([]),
      });
      assert.equal(empty.status, 400);

      const tooBig = await fetch(`${base}/api/v1/trades/50/attachments?file_name=big.png`, {
        method: "POST",
        headers: { "Content-Type": "image/png", ...AUTH(tokenFor("1")) },
        body: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
      });
      assert.equal(tooBig.status, 413);

      // Content is served back byte-identical, private and non-sniffable.
      const content = await fetch(`${base}/api/v1/attachments/${String(record["id"])}/content`, H(tokenFor("1")));
      assert.equal(content.status, 200);
      assert.equal(content.headers.get("content-type"), "image/jpeg");
      assert.equal(content.headers.get("cache-control"), "private, no-store");
      assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);

      const foreign = await fetch(`${base}/api/v1/attachments/${String(record["id"])}/content`, H(tokenFor("2")));
      assert.equal(foreign.status, 404);

      const deleted = await fetch(`${base}/api/v1/attachments/${String(record["id"])}`, {
        method: "DELETE",
        headers: AUTH(tokenFor("1")),
      });
      assert.equal(deleted.status, 204);
      const afterDelete = await fetch(`${base}/api/v1/attachments/${String(record["id"])}/content`, H(tokenFor("1")));
      assert.equal(afterDelete.status, 404, "a soft-deleted attachment is not served");
    },
    { attachments: service },
  );
});

// ---------------------------------------------------------------------------
// v1.0 — billing, AI coach, admin
// ---------------------------------------------------------------------------

test("a Stripe webhook with an invalid signature is 400 and changes nothing", async () => {
  const subs = new MemorySubscriptionStore();
  // The route reads the signing secret from the environment at request time
  // (so a rotation needs no restart); the test sets it for the duration.
  const previous = process.env["STRIPE_WEBHOOK_SECRET"];
  process.env["STRIPE_WEBHOOK_SECRET"] = "whsec_test_only_value";
  await withServer(
    async ({ base }) => {
      const body = JSON.stringify({ type: "customer.subscription.updated", data: { object: { id: "sub_1" } } });
      const res = await fetch(`${base}/api/v1/webhooks/stripe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
        body,
      });
      assert.equal(res.status, 400);
      assert.equal((await json(res)).error?.code, "SIGNATURE_INVALID");
      assert.equal(await subs.findForUser("1"), null);

      // A VALID signature over the same bytes is accepted and applied.
      const ts = String(Math.floor(Date.now() / 1000));
      const good = createHmac("sha256", "whsec_test_only_value").update(`${ts}.${body}`).digest("hex");
      const linked = await fetch(`${base}/api/v1/webhooks/stripe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "stripe-signature": `t=${ts},v1=${good}` },
        body,
      });
      assert.equal(linked.status, 200);
      if (previous === undefined) delete process.env["STRIPE_WEBHOOK_SECRET"];
      else process.env["STRIPE_WEBHOOK_SECRET"] = previous;
    },
    { subscriptions: subs },
  );
});

test("GET /subscriptions/me reports the EFFECTIVE plan and keeps entitlement separate from billing state", async () => {
  const subs = new MemorySubscriptionStore();
  await withServer(
    async ({ base }) => {
      // A user with no subscription and no plan: the entitlement is FREE and the
      // billing record is absent — two different facts, reported separately.
      const free = await json(
        await fetch(`${base}/api/v1/subscriptions/me`, H(tokenFor("1"))),
      );
      assert.equal(free.data["plan"], "free", "the effective plan is free by default");
      assert.equal(free.data["entitled"], false);
      assert.equal(free.data["subscription"], null);

      // A purchased but INACTIVE subscription: `subscriptions.plan` says what was
      // bought, while entitlement follows `users.plan`. Pass 1 returned the
      // subscription row only, so a downgraded user still looked subscribed and
      // the two facts were indistinguishable.
      await subs.upsert({
        userId: "1",
        plan: "pro",
        status: "past_due",
        provider: "stripe",
        providerCustomerId: "cus_1",
        providerSubscriptionId: "sub_1",
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      });
      const pastDue = await json(
        await fetch(`${base}/api/v1/subscriptions/me`, H(tokenFor("1"))),
      );
      assert.equal(pastDue.data["purchasedPlan"], "pro");
      assert.equal(pastDue.data["plan"], "free", "entitlement does not follow a past_due purchase");
      assert.equal(pastDue.data["entitled"], false);
      assert.equal((pastDue.data["subscription"] as Record<string, unknown>)["status"], "past_due");

      // An ACTIVE subscription with the entitlement granted by the webhook path.
      await subs.setUserPlan("1", "pro");
      const active = await json(
        await fetch(`${base}/api/v1/subscriptions/me`, H(tokenFor("1"))),
      );
      assert.equal(active.data["plan"], "pro");
      assert.equal(active.data["entitled"], true);
      assert.equal(active.data["purchasedPlan"], "pro");

      // A DOWNGRADE is observable: the entitlement drops even though the billing
      // record still shows the purchase.
      await subs.setUserPlan("1", "free");
      const downgraded = await json(
        await fetch(`${base}/api/v1/subscriptions/me`, H(tokenFor("1"))),
      );
      assert.equal(downgraded.data["plan"], "free");
      assert.equal(downgraded.data["entitled"], false);
      assert.equal(downgraded.data["purchasedPlan"], "pro", "the purchase history is not rewritten");

      const unauthenticated = await fetch(`${base}/api/v1/subscriptions/me`);
      assert.equal(unauthenticated.status, 401);
    },
    { subscriptions: subs },
  );
});

test("checkout is provider-gated: 503 without a provider credential, never a fake session", async () => {
  await withServer(
    async ({ base }) => {
      const res = await fetch(`${base}/api/v1/subscriptions/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({ interval: "month" }),
      });
      assert.equal(res.status, 503);
      assert.equal((await json(res)).error?.code, "BILLING_NOT_CONFIGURED");
    },
    { subscriptions: new MemorySubscriptionStore() },
  );
});

test("AI coach: insights are withheld until consent is granted", async () => {
  const ai = new MemoryAiCoachStore();
  ai.add("1", {
    id: "1",
    provider: "openai",
    model: "gpt-x",
    promptVersion: "v1",
    tradesAnalyzed: 10,
    insight: { summary: "you overtrade after losses" },
    outcome: "success",
    createdAt: new Date().toISOString(),
  });
  await withServer(
    async ({ base }) => {
      const before = await json<{ consent: { consented: boolean }; insights: unknown[] }>(
        await fetch(`${base}/api/v1/ai-coach/latest-insights`, H(tokenFor("1"))),
      );
      assert.equal(before.data.consent.consented, false);
      assert.deepEqual(before.data.insights, [], "no consent ⇒ no third-party-processed data is served");

      const granted = await fetch(`${base}/api/v1/ai-coach/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({ granted: true }),
      });
      assert.equal(granted.status, 200);

      const after = await json<{ insights: unknown[] }>(
        await fetch(`${base}/api/v1/ai-coach/latest-insights`, H(tokenFor("1"))),
      );
      assert.equal(after.data.insights.length, 1);

      const invalid = await fetch(`${base}/api/v1/ai-coach/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({ granted: "yes" }),
      });
      assert.equal(invalid.status, 400);
    },
    { aiCoach: ai },
  );
});

test("admin routes require the admin.panel.access authority", async () => {
  const audit = [
    {
      id: "2",
      occurredAt: "2026-01-02T00:00:00.000Z",
      action: "USER_ROLE_CHANGED",
      actorUserId: "1",
      targetUserId: "3",
      outcome: "success",
      requestId: "req-1",
    },
  ];
  await withServer(
    async ({ base }) => {
      const asUser = await fetch(`${base}/api/v1/admin/audit-logs`, H(tokenFor("5", "user")));
      assert.equal(asUser.status, 403);

      const anonymous = await fetch(`${base}/api/v1/admin/audit-logs`);
      assert.equal(anonymous.status, 401);

      const asAdmin = await fetch(`${base}/api/v1/admin/audit-logs`, H(tokenFor("5", "admin")));
      assert.equal(asAdmin.status, 200);
      assert.equal((await json<{ entries: unknown[] }>(asAdmin)).data.entries.length, 1);

      const metrics = await fetch(`${base}/api/v1/admin/metrics`, H(tokenFor("5", "admin")));
      assert.equal(metrics.status, 200);
    },
    { admin: new MemoryAdminStore(audit) },
  );
});

// ---------------------------------------------------------------------------
// v1.5 — portfolio / prop drawdown
// ---------------------------------------------------------------------------

test("portfolio summary reports each account and never invents an FX rate", async () => {
  const store = new MemoryPortfolioStore(
    [
      {
        accountId: "7",
        label: "Main",
        currency: "USD",
        provider: "METAAPI",
        syncState: "CONNECTED",
        balance: "1000.00",
        equity: "1100.00",
        startingBalance: "1000.00",
        peakEquity: "1150.00",
      },
    ],
    [{ accountId: "7", netPnl: "100.00", rMultiple: "2.00000000", symbol: "EURUSD", strategy: null }],
  );
  await withServer(
    async ({ base }) => {
      const res = await fetch(`${base}/api/v1/portfolio/summary`, H(tokenFor("1")));
      assert.equal(res.status, 200);
      const body = await json<{ accounts: { accountId: string }[]; convertedTotalPnl: string; unconvertibleAccounts: number }>(res);
      assert.equal(body.data.accounts.length, 1);
      assert.equal(body.data.convertedTotalPnl, "100.00");
      assert.equal(body.data.unconvertibleAccounts, 0);
    },
    { portfolio: store },
  );
});

test("a currency with no stored rate is counted as unconvertible, never converted at 1:1", async () => {
  const store = new MemoryPortfolioStore(
    [
      {
        accountId: "8",
        label: "EUR book",
        currency: "EUR",
        provider: "MANUAL",
        syncState: "DISCONNECTED",
        balance: "500.00",
        equity: "500.00",
        startingBalance: "500.00",
        peakEquity: null,
      },
    ],
    [{ accountId: "8", netPnl: "50.00", rMultiple: null, symbol: "EURUSD", strategy: null }],
  );
  await withServer(
    async ({ base }) => {
      const body = await json<{ convertedTotalPnl: string; unconvertibleAccounts: number }>(
        await fetch(`${base}/api/v1/portfolio/summary`, H(tokenFor("1"))),
      );
      assert.equal(body.data.unconvertibleAccounts, 1);
      assert.equal(body.data.convertedTotalPnl, "0.00", "an unconvertible account contributes nothing, not a guessed rate");
    },
    { portfolio: store },
  );
});

test("prop-status reports the 80% alert separately from a breach", async () => {
  const store = new MemoryPortfolioStore(
    [
      {
        accountId: "9",
        label: "Challenge",
        currency: "USD",
        provider: "METAAPI",
        syncState: "CONNECTED",
        balance: "900.00",
        equity: "900.00",
        startingBalance: "1000.00",
        peakEquity: "1000.00",
      },
    ],
    [],
    new Map(),
    new Map([
      [
        "9",
        {
          ruleSetName: "FTMO 100k",
          maxDailyDrawdown: "5000.00",
          maxTotalDrawdown: "10000.00",
          profitTarget: "8000.00",
          drawdownBasis: "balance",
          alertThresholdPct: "80.00",
        },
      ],
    ]),
  );
  await withServer(
    async ({ base }) => {
      const body = await json<{ currentDrawdown: string; drawdownPct: string | null; alert: boolean; breached: boolean }>(
        await fetch(`${base}/api/v1/portfolio/prop-status?account_id=9`, H(tokenFor("1"))),
      );
      assert.equal(body.data.currentDrawdown, "100.00");
      assert.equal(body.data.drawdownPct, "1.00");
      assert.equal(body.data.alert, false);
      assert.equal(body.data.breached, false);

      const missing = await fetch(`${base}/api/v1/portfolio/prop-status?account_id=999`, H(tokenFor("1")));
      assert.equal(missing.status, 404);
    },
    { portfolio: store },
  );
});

// ---------------------------------------------------------------------------
// v2.0 — EA ingestion and device registration
// ---------------------------------------------------------------------------

const eaStore = (): MemoryEaStore => {
  const store = new MemoryEaStore();
  store.addAccount({
    accountId: "11",
    userId: "1",
    metaapiAccountId: "acct-1",
    label: "EA account",
    eaKeyHash: createHashHex("ea-secret-key-value"),
    syncCursor: null,
  });
  return store;
};

function createHashHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("EA handshake rejects an unknown key and accepts a known one", async () => {
  await withServer(
    async ({ base }) => {
      const unknown = await fetch(`${base}/api/v1/ea/handshake`, {
        method: "POST",
        headers: { Authorization: "Bearer not-a-real-key" },
      });
      assert.equal(unknown.status, 401);

      const known = await fetch(`${base}/api/v1/ea/handshake`, {
        method: "POST",
        headers: { Authorization: "Bearer ea-secret-key-value" },
      });
      assert.equal(known.status, 200);
      const body = await json(known);
      assert.equal(body.data["account_id"], "11");
      assert.equal("key" in body.data, false, "the handshake never echoes the key");
      assert.equal("ea_api_key_hash" in body.data, false);
      // The handshake states the scheme that is ACTUALLY enforced. Pass 1
      // advertised `hmac_required: true` while nothing verified a signature —
      // a contract claim with no implementation behind it.
      assert.equal(body.data["auth_scheme"], "bearer-ea-key");
      assert.equal("hmac_required" in body.data, false, "no phantom signature requirement");
    },
    { ea: eaStore(), eaSync: { requestSync: async () => true } },
  );
});

test("EA trade-event is accepted and asks for a sync; a bad body is refused", async () => {
  await withServer(
    async ({ base }) => {
      const ok = await fetch(`${base}/api/v1/ea/trade-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer ea-secret-key-value" },
        body: JSON.stringify({ symbol: "EURUSD", direction: "buy", volume: "0.10", price: "1.1000" }),
      });
      assert.equal(ok.status, 202);

      const bad = await fetch(`${base}/api/v1/ea/trade-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer ea-secret-key-value" },
        body: JSON.stringify({ symbol: "" }),
      });
      assert.equal(bad.status, 400);
    },
    { ea: eaStore(), eaSync: { requestSync: async () => true } },
  );
});

test("EA keys are issued once, rotate on re-issue, and revocation is ownership scoped", async () => {
  await withServer(
    async ({ base }) => {
      // Issuing a key is a HUMAN action (bearer auth), scoped to an account the
      // caller owns — an EA itself can never mint credentials.
      const issued = await fetch(`${base}/api/v1/accounts/11/ea-key`, {
        method: "POST",
        headers: AUTH(tokenFor("1")),
      });
      assert.equal(issued.status, 201);
      const issuedBody = await json(issued);
      const key = String(issuedBody.data["ea_key"]);
      assert.match(key, /^[A-Za-z0-9_-]{20,}$/);
      assert.equal(issuedBody.data["key_shown_once"], true);
      assert.equal("ea_api_key_hash" in issuedBody.data, false, "only the hash is stored");

      // The newly issued key authenticates the EA immediately ...
      const handshake = await fetch(`${base}/api/v1/ea/handshake`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
      });
      assert.equal(handshake.status, 200);

      // ... and re-issuing ROTATES: the plaintext is never recoverable, so the
      // previous key stops working (a lost key is replaced, not revealed).
      const rotated = await fetch(`${base}/api/v1/accounts/11/ea-key`, {
        method: "POST",
        headers: AUTH(tokenFor("1")),
      });
      assert.equal(rotated.status, 201);
      const rotatedKey = String((await json(rotated)).data["ea_key"]);
      assert.notEqual(rotatedKey, key);
      const oldKey = await fetch(`${base}/api/v1/ea/handshake`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
      });
      assert.equal(oldKey.status, 401, "the rotated-out key no longer authenticates");

      // Another user cannot issue or revoke a key for this account.
      const foreign = await fetch(`${base}/api/v1/accounts/11/ea-key`, {
        method: "POST",
        headers: AUTH(tokenFor("2")),
      });
      assert.equal(foreign.status, 404, "non-disclosing: not yours == not found");

      const unauthenticated = await fetch(`${base}/api/v1/accounts/11/ea-key`, { method: "POST" });
      assert.equal(unauthenticated.status, 401);

      const methodNotAllowed = await fetch(`${base}/api/v1/accounts/11/ea-key`, {
        method: "PUT",
        headers: AUTH(tokenFor("1")),
      });
      assert.equal(methodNotAllowed.status, 405);

      // Revocation deletes the usable hash, so the key stops authenticating ...
      const revoked = await fetch(`${base}/api/v1/accounts/11/ea-key`, {
        method: "DELETE",
        headers: AUTH(tokenFor("1")),
      });
      assert.equal(revoked.status, 204);
      const afterRevoke = await fetch(`${base}/api/v1/ea/handshake`, {
        method: "POST",
        headers: { Authorization: `Bearer ${rotatedKey}` },
      });
      assert.equal(afterRevoke.status, 401);
      // ... and revoking twice is a non-disclosing 404, not a silent success.
      const twice = await fetch(`${base}/api/v1/accounts/11/ea-key`, {
        method: "DELETE",
        headers: AUTH(tokenFor("1")),
      });
      assert.equal(twice.status, 404);
    },
    { ea: eaStore(), eaSync: { requestSync: async () => true } },
  );
});

test("device registration requires bearer auth AND an encryptor; the token is never echoed", async () => {
  await withServer(
    async ({ base }) => {
      const anonymous = await fetch(`${base}/api/v1/devices/register-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "android", token: "x".repeat(32) }),
      });
      assert.equal(anonymous.status, 401);

      const withoutKey = await fetch(`${base}/api/v1/devices/register-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({ platform: "android", token: "x".repeat(32) }),
      });
      assert.equal(withoutKey.status, 503, "no master key ⇒ the capability is absent, never plaintext storage");
    },
    { ea: new MemoryEaStore() },
  );

  await withServer(
    async ({ base }) => {
      const ok = await fetch(`${base}/api/v1/devices/register-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({ platform: "android", token: "device-token-value-1234567890" }),
      });
      assert.equal(ok.status, 201);
      const body = await json(ok);
      assert.equal("token" in body.data, false);
      assert.equal("token_ciphertext" in body.data, false);

      const badPlatform = await fetch(`${base}/api/v1/devices/register-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({ platform: "symbian", token: "device-token-value-1234567890" }),
      });
      assert.equal(badPlatform.status, 400);
    },
    {
      ea: new MemoryEaStore(),
      deviceTokens: {
        keyVersion: 1,
        encrypt: (plaintext) => ({
          iv: Buffer.alloc(12, 1),
          authTag: Buffer.alloc(16, 2),
          ciphertext: Buffer.from(plaintext, "utf8"),
        }),
      },
    },
  );
});

// ---------------------------------------------------------------------------
// v2.5 / v3.0 — public profile, copy trading, developer keys
// ---------------------------------------------------------------------------

test("the public profile endpoint is readable without a token and hides amounts unless published", async () => {
  const store = new MemoryTenancyStore();
  const metrics = {
    tradeCount: 4,
    wins: 3,
    losses: 1,
    breakeven: 0,
    winRate: "0.7500",
    totalPnl: "250.00",
    profitFactor: "3.0000",
    averageR: "1.2000",
    bestTrade: "200.00",
    worstTrade: "-50.00",
  };
  store.addProfile("trader_one", "a".repeat(64), {
    handle: "trader_one",
    showAbsoluteAmounts: false,
    verified: true,
    metrics,
    totalPnl: null,
  });
  await withServer(
    async ({ base }) => {
      const res = await fetch(`${base}/api/v1/public/verify/${"a".repeat(64)}`);
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body.data["handle"], "trader_one");
      assert.equal(body.data["winRate"], "0.7500");
      assert.equal("totalPnl" in body.data, false, "amounts are OMITTED, never zeroed");
      assert.equal("userId" in body.data, false);

      const unknown = await fetch(`${base}/api/v1/public/verify/${"b".repeat(64)}`);
      assert.equal(unknown.status, 404);

      const byHandle = await fetch(`${base}/api/v1/public/profiles/trader_one`);
      assert.equal(byHandle.status, 200);
    },
    { tenancy: store },
  );
});

test("copy-trading: the LEADER is derived server-side, and status changes are authorized", async () => {
  const store = new MemoryTenancyStore();
  store.addAccount("1", "77"); // follower account, owned by the caller
  store.addAccount("2", "88"); // leader account, owned by ANOTHER user
  await withServer(
    async ({ base }) => {
      // A follower account the caller does not own is non-disclosing 404 ...
      const foreign = await fetch(`${base}/api/v1/copy-trading/relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({ leader_account_id: "88", follower_account_id: "99" }),
      });
      assert.equal(foreign.status, 404);

      // ... and an unknown leader account is reported as such (404), not as a
      // conflict: the two conditions are distinguishably different failures.
      const unknownLeader = await fetch(`${base}/api/v1/copy-trading/relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({ leader_account_id: "1234", follower_account_id: "77" }),
      });
      assert.equal(unknownLeader.status, 404);

      // The request carries a FORGED leader_user_id: it must be ignored, because
      // the leader identity is derived from the leader ACCOUNT row. (Pass-1 took
      // this field straight from the body and wrote it into the row, which let a
      // caller name anyone as their leader.)
      const created = await fetch(`${base}/api/v1/copy-trading/relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({
          leader_user_id: "1",
          leader_account_id: "88",
          follower_account_id: "77",
          allocation_mode: "proportional",
          allocation_value: "1.00000000",
        }),
      });
      assert.equal(created.status, 201);
      const createdBody = await json(created);
      assert.equal(createdBody.data["status"], "pending");
      assert.equal(
        createdBody.data["leaderUserId"],
        "2",
        "the leader identity comes from the ACCOUNT row, never from the request body",
      );
      assert.equal(
        "leader_user_id" in createdBody.data,
        false,
        "the response follows this module's camelCase contract",
      );
      const relationshipId = String(createdBody.data["id"]);

      const duplicate = await fetch(`${base}/api/v1/copy-trading/relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({ leader_account_id: "88", follower_account_id: "77" }),
      });
      assert.equal(duplicate.status, 409);

      // A follower cannot activate its own relationship (it would broadcast the
      // leader's signals on the leader's behalf) ...
      const followerActivate = await fetch(`${base}/api/v1/copy-trading/relationships/${relationshipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({ status: "active" }),
      });
      assert.equal(followerActivate.status, 404, "a row the caller may not change is non-disclosing");

      // ... the leader can.
      const leaderActivate = await fetch(`${base}/api/v1/copy-trading/relationships/${relationshipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("2")) },
        body: JSON.stringify({ status: "active" }),
      });
      assert.equal(leaderActivate.status, 200);
      assert.equal((await json(leaderActivate)).data["status"], "active");

      // Either side may pause.
      const followerPause = await fetch(`${base}/api/v1/copy-trading/relationships/${relationshipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({ status: "paused" }),
      });
      assert.equal(followerPause.status, 200);
      assert.equal((await json(followerPause)).data["status"], "paused");

      // A third party can neither see nor touch it.
      const thirdParty = await fetch(`${base}/api/v1/copy-trading/relationships/${relationshipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("3")) },
        body: JSON.stringify({ status: "paused" }),
      });
      assert.equal(thirdParty.status, 404);

      // An unknown status is a validation error, not a silent no-op. (400
      // VALIDATION_FAILED is this surface's convention — see routes/responses.ts.)
      const badStatus = await fetch(`${base}/api/v1/copy-trading/relationships/${relationshipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("2")) },
        body: JSON.stringify({ status: "cancelled" }),
      });
      assert.equal(badStatus.status, 400);
      assert.equal((await json(badStatus)).error?.code, "VALIDATION_FAILED");

      const unauthenticated = await fetch(`${base}/api/v1/copy-trading/relationships/${relationshipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });
      assert.equal(unauthenticated.status, 401);

      const listed = await json<{ relationships: unknown[] }>(
        await fetch(`${base}/api/v1/copy-trading/relationships`, H(tokenFor("1"))),
      );
      assert.equal(listed.data.relationships.length, 1);
    },
    { tenancy: store },
  );
});

test("a developer key is returned exactly once and its scopes are validated", async () => {
  await withServer(
    async ({ base }) => {
      const created = await fetch(`${base}/api/v1/developer/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({ name: "my bot", scopes: ["trades:read", "analytics:read"] }),
      });
      assert.equal(created.status, 201);
      const body = await json(created);
      assert.match(String(body.data["secret"]), /^[0-9a-f]{8}_[A-Za-z0-9_-]+$/);
      assert.equal(body.data["secret_shown_once"], true);
      assert.equal("key_hash" in body.data, false, "the hash never leaves the server");

      const listed = await json<{ keys: Record<string, unknown>[] }>(
        await fetch(`${base}/api/v1/developer/keys`, H(tokenFor("1"))),
      );
      assert.equal(listed.data.keys.length, 1);
      assert.equal("secret" in (listed.data.keys[0] ?? {}), false, "a read path never re-discloses the secret");

      const badScope = await fetch(`${base}/api/v1/developer/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH(tokenFor("1")) },
        body: JSON.stringify({ name: "bad", scopes: ["admin:everything"] }),
      });
      assert.equal(badScope.status, 400);

      const revoked = await fetch(`${base}/api/v1/developer/keys/${String(body.data["id"])}`, {
        method: "DELETE",
        headers: AUTH(tokenFor("1")),
      });
      assert.equal(revoked.status, 204);
      const after = await json<{ keys: unknown[] }>(await fetch(`${base}/api/v1/developer/keys`, H(tokenFor("1"))));
      assert.deepEqual(after.data.keys, [], "a revoked key disappears from the list");
    },
    { developer: new MemoryDeveloperStore() },
  );
});
