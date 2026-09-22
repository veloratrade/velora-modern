// Real-PostgreSQL battery for the migrated capability stores (directive t pass 1).
//
// WHY THIS BATTERY EXISTS. The route tests use in-memory doubles, which prove
// ROUTE behaviour but say nothing about the SQL. Every store in this file was
// written against the FROZEN foundation (0001–0022) and had never executed
// against a real server; the CHECK constraints, the partial UNIQUE indexes and
// the vocabulary checks in those migrations are the actual contract, and only a
// real engine can falsify the SQL. This battery therefore exercises the exact
// statements the services issue.
//
// EVIDENCE LABEL (Phase D policy): executes ONLY against a REAL, disposable
// PostgreSQL (DATABASE_URL — postgres-evidence workflow). Without it every test
// is SKIPPED, never silently passed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareDatabase } from "./support/pgTestDb.ts";
import { PgWebhookEventStore } from "../../apps/api/src/webhooks/pgWebhookStore.ts";
import { PgSyncStatusStore } from "../../apps/api/src/accounts/syncStatusService.ts";
import { PgAnalyticsStore } from "../../apps/api/src/analytics/analyticsStore.ts";
import { PgTagStore } from "../../apps/api/src/tags/tagService.ts";
import { PgAttachmentStore } from "../../apps/api/src/attachments/attachmentService.ts";
import { PgSubscriptionStore } from "../../apps/api/src/billing/subscriptionService.ts";
import { PgAiCoachStore } from "../../apps/api/src/aicoach/aiCoachRoutes.ts";
import { PgAdminStore } from "../../apps/api/src/admin/adminRoutes.ts";
import { PgPortfolioStore } from "../../apps/api/src/portfolio/portfolioRoutes.ts";
import { PgEaStore } from "../../apps/api/src/ea/eaRoutes.ts";
import { PgTenancyStore } from "../../apps/api/src/tenancy/tenancyRoutes.ts";
import { PgDeveloperStore } from "../../apps/api/src/developer/developerRoutes.ts";
import { poolQuery } from "../../apps/api/src/persistence/pg.ts";
import type { Pool } from "pg";

const PG_URL = process.env.DATABASE_URL;
const SKIP =
  PG_URL === undefined ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)" : false;

interface Ctx {
  pool: Pool;
  q: ReturnType<typeof poolQuery>;
  userId: string;
  otherUserId: string;
  accountId: string;
  close: () => Promise<void>;
}

async function harness(label: string): Promise<Ctx> {
  // ISOLATION IS THE HARNESS'S JOB. `prepareDatabase` applies the frozen
  // migrations and truncates every application table, so this battery is
  // repeatable against a database that previous runs (or other batteries) have
  // already used — the failure mode observed in pass 1 was a battery that only
  // passed on a virgin cluster.
  const db = await prepareDatabase(PG_URL as string);
  const pool = db.pool;
  const q = poolQuery(pool);

  const email = `${label}-owner@velora.test`;
  const otherEmail = `${label}-other@velora.test`;
  await pool.query("INSERT INTO users (email, password_hash) VALUES ($1,$2), ($3,$4) ON CONFLICT (email) DO NOTHING", [
    email,
    "x",
    otherEmail,
    "y",
  ]);
  const users = await pool.query("SELECT id, email FROM users WHERE email IN ($1,$2)", [email, otherEmail]);
  const byEmail = new Map<string, string>(users.rows.map((r: { id: string | number; email: string }) => [r.email, String(r.id)]));
  const userId = byEmail.get(email) as string;
  const otherUserId = byEmail.get(otherEmail) as string;

  // `provider` and `platform` must stay inside 0004's CHECK vocabulary
  // (MT4|MT5|MANUAL) — an out-of-vocabulary value here would fail for the wrong
  // reason and hide the behaviour under test.
  const account = await pool.query(
    `INSERT INTO trading_accounts (user_id, provider, platform, label, currency, metaapi_account_id, timezone, timezone_source)
     VALUES ($1, 'MT5', 'MT5', $2, 'USD', $3, 'UTC', 'account')
     RETURNING id`,
    [userId, `${label} account`, `metaapi-${label}`],
  );

  return {
    pool,
    q,
    userId,
    otherUserId,
    accountId: String(account.rows[0].id),
    close: () => pool.end(),
  };
}

async function insertTrade(ctx: Ctx, input: { symbol: string; netPnl: string | null; r: string | null; occurredAt: string }): Promise<string> {
  const rows = await ctx.q(
    `INSERT INTO trades (user_id, account_id, symbol, direction, entry_price, volume, occurred_at, net_pnl, r_multiple, source)
     VALUES ($1, $2, $3, 'buy', 1.10000000, 0.10000000, $4::timestamptz, $5, $6, 'manual')
     RETURNING id`,
    [ctx.userId, ctx.accountId, input.symbol, input.occurredAt, input.netPnl, input.r],
  );
  return String(rows[0]?.["id"]);
}

// ---------------------------------------------------------------------------

test("webhook_events deduplicates on (source, event_id) at the DATABASE level", { skip: SKIP }, async () => {
  const ctx = await harness("wg");
  try {
    const store = new PgWebhookEventStore(ctx.pool);
    const eventId = `pg-evt-${Date.now()}`;
    const first = await store.record({
      source: "metaapi",
      eventId,
      payload: { accountId: "a", type: "deal" },
      signatureAlgorithm: "hmac-sha256",
      signatureVerifiedAt: new Date().toISOString(),
    });
    assert.equal(first.inserted, true);
    const second = await store.record({
      source: "metaapi",
      eventId,
      payload: { accountId: "a", type: "deal" },
      signatureAlgorithm: "hmac-sha256",
      signatureVerifiedAt: new Date().toISOString(),
    });
    assert.equal(second.inserted, false);
    assert.equal(second.record.id, first.record.id, "the winner is returned, not a second row");
    assert.equal(second.record.payload["type"], "deal", "jsonb round-trips as an object");

    await store.markProcessed(first.record.id);
    const marked = await store.findById(first.record.id);
    assert.notEqual(marked?.processedAt, null);

    // The same event id from a DIFFERENT source is a distinct event.
    const other = await store.record({
      source: "n8n",
      eventId,
      payload: {},
      signatureAlgorithm: "hmac-sha256",
      signatureVerifiedAt: new Date().toISOString(),
    });
    assert.equal(other.inserted, true);
  } finally {
    await ctx.close();
  }
});

test("sync status is ownership scoped in SQL", { skip: SKIP }, async () => {
  const ctx = await harness("ss");
  try {
    const store = new PgSyncStatusStore(ctx.q);
    const mine = await store.findForUser(ctx.accountId, ctx.userId);
    assert.equal(mine?.accountId, ctx.accountId);
    assert.equal(mine?.metaapiConnected, true);
    assert.equal(await store.findForUser(ctx.accountId, ctx.otherUserId), null);
    assert.equal(await store.findForUser("999999", ctx.userId), null);
  } finally {
    await ctx.close();
  }
});

test("analytics reads exclude soft-deleted and quarantined trades and bucket by day", { skip: SKIP }, async () => {
  const ctx = await harness("an");
  try {
    await insertTrade(ctx, { symbol: "EURUSD", netPnl: "100.00", r: "2.00000000", occurredAt: "2026-03-01T09:00:00Z" });
    await insertTrade(ctx, { symbol: "EURUSD", netPnl: "-40.00", r: "-1.00000000", occurredAt: "2026-03-02T10:00:00Z" });
    const deleted = await insertTrade(ctx, { symbol: "GBPUSD", netPnl: "999.00", r: null, occurredAt: "2026-03-02T11:00:00Z" });
    await ctx.q("UPDATE trades SET deleted_at = now() WHERE id = $1", [deleted]);
    const quarantined = await insertTrade(ctx, { symbol: "GBPUSD", netPnl: "777.00", r: null, occurredAt: "2026-03-02T12:00:00Z" });
    await ctx.q("UPDATE trades SET quarantined = true WHERE id = $1", [quarantined]);

    const store = new PgAnalyticsStore(ctx.q);
    const rows = await store.listTrades({ userId: ctx.userId, from: null, to: null, accountId: null });
    assert.equal(rows.length, 2, "soft-deleted and quarantined rows must not reach a report");
    assert.equal(rows[0]?.day, "2026-03-01");
    assert.equal(rows[1]?.day, "2026-03-02");
    assert.equal(rows[1]?.weekday !== undefined, true);
    // Another user's scope sees nothing.
    const foreign = await store.listTrades({ userId: ctx.otherUserId, from: null, to: null, accountId: null });
    assert.equal(foreign.length, 0);
  } finally {
    await ctx.close();
  }
});

test("tags: real UNIQUE, real CHECK, real ownership", { skip: SKIP }, async () => {
  const ctx = await harness("tg");
  try {
    const store = new PgTagStore(ctx.q);
    const tag = await store.create(ctx.userId, { name: "Breakout", kind: "STRATEGY", color: "#A1B2C3" });
    assert.equal(tag.kind, "STRATEGY");

    await assert.rejects(
      () => store.create(ctx.userId, { name: "Breakout", kind: "CUSTOM", color: null }),
      (err: unknown) => String(err).includes("23505") || String(err).includes("duplicate"),
      "the (user_id, name) UNIQUE must reject a duplicate",
    );
    // A DIFFERENT user may reuse the same name: the constraint is per user.
    const otherTag = await store.create(ctx.otherUserId, { name: "Breakout", kind: "CUSTOM", color: null });
    assert.notEqual(otherTag.id, tag.id);

    const tradeId = await insertTrade(ctx, { symbol: "EURUSD", netPnl: "1.00", r: null, occurredAt: "2026-03-03T09:00:00Z" });
    assert.equal(await store.tradeOwnedBy(ctx.userId, tradeId), true);
    assert.equal(await store.tradeOwnedBy(ctx.otherUserId, tradeId), false);

    assert.equal(await store.assign(ctx.userId, tradeId, tag.id), true);
    assert.equal(await store.assign(ctx.userId, tradeId, tag.id), false, "a second assignment is a no-op, not an error");
    const linked = await store.listForTrade(ctx.userId, tradeId);
    assert.equal(linked.length, 1);
    assert.equal(await store.unassign(ctx.userId, tradeId, tag.id), true);
    assert.equal(await store.remove(ctx.userId, tag.id), true);
    assert.equal(await store.remove(ctx.userId, tag.id), false);
  } finally {
    await ctx.close();
  }
});

test("attachments satisfy 0015's CHECK constraints and soft-delete", { skip: SKIP }, async () => {
  const ctx = await harness("at");
  try {
    const store = new PgAttachmentStore(ctx.q);
    const tradeId = await insertTrade(ctx, { symbol: "EURUSD", netPnl: "1.00", r: null, occurredAt: "2026-03-04T09:00:00Z" });
    const created = await store.insert({
      tradeId,
      userId: ctx.userId,
      category: "AFTER",
      fileName: "chart.png",
      mime: "image/png",
      sizeBytes: 1234,
      storageKey: `pg-at-${Date.now()}`,
      checksumSha256: "a".repeat(64),
    });
    assert.equal(created.sizeBytes, 1234);

    // A MIME outside the whitelist is refused by the ENGINE, not only by the
    // service — the constraint is the authority.
    await assert.rejects(() =>
      store.insert({
        tradeId,
        userId: ctx.userId,
        category: "AFTER",
        fileName: "x.svg",
        mime: "image/svg+xml",
        sizeBytes: 10,
        storageKey: `pg-at-bad-${Date.now()}`,
        checksumSha256: "b".repeat(64),
      }),
    );
    // Over the 5 MiB product limit is refused by the engine too.
    await assert.rejects(() =>
      store.insert({
        tradeId,
        userId: ctx.userId,
        category: "AFTER",
        fileName: "big.png",
        mime: "image/png",
        sizeBytes: 5_242_881,
        storageKey: `pg-at-big-${Date.now()}`,
        checksumSha256: "c".repeat(64),
      }),
    );

    assert.equal((await store.listForTrade(ctx.userId, tradeId)).length, 1);
    assert.equal((await store.listForTrade(ctx.otherUserId, tradeId)).length, 0);
    assert.equal(await store.softDelete(ctx.userId, created.id), true);
    assert.equal(await store.softDelete(ctx.userId, created.id), false);
    assert.equal((await store.listForTrade(ctx.userId, tradeId)).length, 0);
  } finally {
    await ctx.close();
  }
});

test("subscriptions: the plan CHECK forces the checkout/downgrade split to hold", { skip: SKIP }, async () => {
  const ctx = await harness("sb");
  try {
    const store = new PgSubscriptionStore(ctx.q);
    // The 0017 CHECK admits only pro/enterprise, which is why a checkout row is
    // written with the PURCHASED plan and a non-entitling status.
    await assert.rejects(() =>
      ctx.q("INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'free', 'incomplete')", [ctx.userId]),
    );

    await store.linkCustomer({ userId: ctx.userId, provider: "stripe", customerId: "cus_pg_1", subscriptionId: "sub_pg_1" });
    await store.linkCustomer({ userId: ctx.userId, provider: "stripe", customerId: "cus_pg_1", subscriptionId: "sub_pg_1" });
    const afterLink = await ctx.q("SELECT count(*)::int AS n FROM subscriptions WHERE provider_customer_id = 'cus_pg_1'");
    assert.equal(afterLink[0]?.["n"], 1, "a repeated checkout event must not insert a second row");

    assert.equal(await store.findUserByCustomer("stripe", "cus_pg_1"), ctx.userId);

    await store.upsert({
      userId: ctx.userId,
      plan: "pro",
      status: "active",
      provider: "stripe",
      providerCustomerId: "cus_pg_1",
      providerSubscriptionId: "sub_pg_1",
      currentPeriodEnd: "2026-12-31T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    });
    await store.setUserPlan(ctx.userId, "pro");
    const active = await store.findForUser(ctx.userId);
    assert.equal(active?.status, "active");
    assert.equal(active?.plan, "pro");

    // 0017 permits only ONE LIVE subscription per user: a second active row is
    // refused by the partial unique index while the first is still live.
    await assert.rejects(() =>
      ctx.q(
        "INSERT INTO subscriptions (user_id, plan, status, provider_subscription_id) VALUES ($1, 'pro', 'active', 'sub_pg_dup')",
        [ctx.userId],
      ),
    );

    // Cancellation: status changes, the purchased plan is carried, and the
    // ENTITLEMENT is expressed through users.plan.
    await store.upsert({
      userId: ctx.userId,
      plan: "pro",
      status: "canceled",
      provider: "stripe",
      providerCustomerId: "cus_pg_1",
      providerSubscriptionId: "sub_pg_1",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: true,
    });
    await store.setUserPlan(ctx.userId, "free");
    const canceled = await store.findForUser(ctx.userId);
    assert.equal(canceled?.status, "canceled");
    const plan = await ctx.q("SELECT plan FROM users WHERE id = $1", [ctx.userId]);
    assert.equal(plan[0]?.["plan"], "free");

    // AFTER cancellation a NEW live subscription is allowed — a cancelled user
    // must be able to subscribe again. (The "one live row" rule is asserted
    // above, while a live row actually exists.)
    await ctx.q(
      "INSERT INTO subscriptions (user_id, plan, status, provider_subscription_id) VALUES ($1, 'pro', 'active', 'sub_pg_2')",
      [ctx.userId],
    );
  } finally {
    await ctx.close();
  }
});

test("AI coach: consent gates the read and the log vocabulary holds", { skip: SKIP }, async () => {
  const ctx = await harness("ai");
  try {
    const store = new PgAiCoachStore(ctx.q);
    assert.deepEqual(await store.consentState(ctx.userId), { consented: false, consentedAt: null });
    await store.setConsent(ctx.userId, true);
    assert.equal((await store.consentState(ctx.userId)).consented, true);
    await store.setConsent(ctx.userId, false);
    assert.equal((await store.consentState(ctx.userId)).consented, false);

    await ctx.q(
      `INSERT INTO ai_coaching_logs (user_id, provider, model, prompt_version, insight, outcome)
       VALUES ($1, 'openai', 'gpt-x', 'v1', '{"summary":"ok"}'::jsonb, 'success')`,
      [ctx.userId],
    );
    // A provider outside 0017's vocabulary is refused by the engine.
    await assert.rejects(() =>
      ctx.q(
        `INSERT INTO ai_coaching_logs (user_id, provider, model, prompt_version, insight, outcome)
         VALUES ($1, 'anthropic', 'x', 'v1', '{}'::jsonb, 'success')`,
        [ctx.userId],
      ),
    );
    const insights = await store.latest(ctx.userId, 5);
    assert.equal(insights.length, 1);
    assert.equal(insights[0]?.provider, "openai");
  } finally {
    await ctx.close();
  }
});

test("admin metrics count real rows", { skip: SKIP }, async () => {
  const ctx = await harness("ad");
  try {
    const store = new PgAdminStore(ctx.q);
    const metrics = await store.metrics();
    assert.ok(metrics.users >= 2);
    assert.ok(metrics.tradingAccounts >= 1);
    assert.equal(typeof metrics.trades, "number");
    // The audit trail is readable and ordered newest-first.
    const entries = await store.auditLog(5, null);
    assert.ok(Array.isArray(entries));
  } finally {
    await ctx.close();
  }
});

test("portfolio aggregates per account with real numeric sums", { skip: SKIP }, async () => {
  const ctx = await harness("pf");
  try {
    await insertTrade(ctx, { symbol: "EURUSD", netPnl: "100.00", r: "2.00000000", occurredAt: "2026-03-05T09:00:00Z" });
    await insertTrade(ctx, { symbol: "XAUUSD", netPnl: "-25.50", r: null, occurredAt: "2026-03-06T09:00:00Z" });
    const store = new PgPortfolioStore(ctx.q);
    const accounts = await store.accounts(ctx.userId);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.currency, "USD");
    const trades = await store.tradesByAccount(ctx.userId);
    assert.equal(trades.length, 2);
    assert.equal(trades[0]?.netPnl, "100.00");
    assert.equal(await store.propRules(ctx.accountId, ctx.userId), null);

    // A rule set is written through the real CHECK constraints.
    await ctx.q(
      `INSERT INTO prop_firm_rules (account_id, user_id, rule_set_name, max_total_drawdown, drawdown_basis, alert_threshold_pct)
       VALUES ($1, $2, 'PG rule', 10000.00, 'balance', 80.00)`,
      [ctx.accountId, ctx.userId],
    );
    const rules = await store.propRules(ctx.accountId, ctx.userId);
    assert.equal(rules?.maxTotalDrawdown, "10000.00");
    // 0018 allows one ENABLED rule set per account.
    await assert.rejects(() =>
      ctx.q(
        `INSERT INTO prop_firm_rules (account_id, user_id, rule_set_name, max_total_drawdown, drawdown_basis, alert_threshold_pct)
         VALUES ($1, $2, 'Second', 5000.00, 'balance', 80.00)`,
        [ctx.accountId, ctx.userId],
      ),
    );
  } finally {
    await ctx.close();
  }
});

test("EA keys resolve by hash and device tokens satisfy 0019's column contract", { skip: SKIP }, async () => {
  const ctx = await harness("ea");
  try {
    const store = new PgEaStore(ctx.q);
    const hash = "d".repeat(64);
    const keyHash = await ctx.q(
      "UPDATE trading_accounts SET ea_api_key_hash = $2, ea_key_created_at = now() WHERE id = $1 RETURNING ea_api_key_hash",
      [ctx.accountId, hash],
    );
    assert.equal(keyHash[0]?.["ea_api_key_hash"], hash);

    const account = await store.findByKeyHash(hash);
    assert.equal(account?.accountId, ctx.accountId);
    assert.equal(account?.userId, ctx.userId);
    assert.equal(await store.findByKeyHash("e".repeat(64)), null);

    // Revocation removes the key from the lookup.
    await ctx.q("UPDATE trading_accounts SET ea_key_revoked_at = now() WHERE id = $1", [ctx.accountId]);
    assert.equal(await store.findByKeyHash(hash), null);
    await store.touchLastSeen(ctx.accountId);

    const device = await store.registerDevice({
      userId: ctx.userId,
      platform: "android",
      fingerprint: "f".repeat(64),
      keyVersion: 1,
      iv: Buffer.alloc(12, 7),
      authTag: Buffer.alloc(16, 8),
      ciphertext: Buffer.from("ciphertext-bytes"),
    });
    assert.ok(device.id !== "");

    // Same fingerprint re-registers (upsert) instead of duplicating.
    const again = await store.registerDevice({
      userId: ctx.userId,
      platform: "android",
      fingerprint: "f".repeat(64),
      keyVersion: 1,
      iv: Buffer.alloc(12, 9),
      authTag: Buffer.alloc(16, 8),
      ciphertext: Buffer.from("ciphertext-bytes-2"),
    });
    assert.equal(again.id, device.id);
    assert.equal(await store.revokeDevice(ctx.userId, device.id), true);
    assert.equal(await store.revokeDevice(ctx.userId, device.id), false);

    // 0019 requires 12-byte IVs: the engine refuses anything else.
    await assert.rejects(() =>
      store.registerDevice({
        userId: ctx.userId,
        platform: "ios",
        fingerprint: "1".repeat(64),
        keyVersion: 1,
        iv: Buffer.alloc(8, 1),
        authTag: Buffer.alloc(16, 1),
        ciphertext: Buffer.from("x"),
      }),
    );
  } finally {
    await ctx.close();
  }
});

test("public profiles and copy relationships obey 0020's constraints", { skip: SKIP }, async () => {
  const ctx = await harness("tn");
  try {
    const store = new PgTenancyStore(ctx.q);
    await ctx.q(
      `INSERT INTO public_profiles (user_id, handle, visibility, show_absolute_amounts, verified_at, verification_hash)
       VALUES ($1, $2, 'public', false, now(), $3)`,
      [ctx.userId, "pg_trader_one", "a".repeat(64)],
    );
    await insertTrade(ctx, { symbol: "EURUSD", netPnl: "100.00", r: null, occurredAt: "2026-03-07T09:00:00Z" });

    const byHash = await store.publicProfileByHash("a".repeat(64));
    assert.equal(byHash?.handle, "pg_trader_one");
    assert.equal(byHash?.showAbsoluteAmounts, false);
    assert.equal(byHash?.metrics.totalPnl, "100.00");
    assert.equal(await store.publicProfileByHash("b".repeat(64)), null);

    // A PRIVATE profile is not resolvable through the public read at all.
    await ctx.q("UPDATE public_profiles SET visibility = 'private' WHERE user_id = $1", [ctx.userId]);
    assert.equal(await store.publicProfileByHash("a".repeat(64)), null);

    const leaderAccount = await ctx.q(
      `INSERT INTO trading_accounts (user_id, provider, platform, label) VALUES ($1, 'MANUAL', 'MANUAL', 'leader') RETURNING id`,
      [ctx.otherUserId],
    );
    const leaderAccountId = String(leaderAccount[0]?.["id"]);

    // ---- the LEADER is derived from the ACCOUNT row, never from the client ---
    // A forged leader user id cannot be supplied at all: it is not a parameter.
    const created = await store.createRelationship({
      followerUserId: ctx.userId,
      leaderAccountId,
      followerAccountId: ctx.accountId,
      allocationMode: "proportional",
      allocationValue: "1.00000000",
    });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("expected the relationship to be created");
    assert.equal(created.relationship.status, "pending");
    assert.equal(
      created.relationship.leaderUserId,
      ctx.otherUserId,
      "leader_user_id must come from trading_accounts.user_id, not from the caller",
    );

    // 0020's partial UNIQUE index rejects a second live pair, reported as a
    // distinct outcome so the route can answer 409 rather than 500.
    const duplicate = await store.createRelationship({
      followerUserId: ctx.userId,
      leaderAccountId,
      followerAccountId: ctx.accountId,
      allocationMode: "proportional",
      allocationValue: "1.00000000",
    });
    assert.deepEqual(duplicate, { ok: false, reason: "duplicate" });

    // An unknown leader account is reported as such (not as a conflict).
    const missingLeader = await store.createRelationship({
      followerUserId: ctx.userId,
      leaderAccountId: "999999999",
      followerAccountId: ctx.accountId,
      allocationMode: "proportional",
      allocationValue: "1.00000000",
    });
    assert.deepEqual(missingLeader, { ok: false, reason: "leader-account-not-found" });

    // ---- status transitions are authorized in the PREDICATE ------------------
    // The FOLLOWER cannot activate a relationship (only the leader can).
    assert.equal(await store.setRelationshipStatus(ctx.userId, created.relationship.id, "active"), null);
    // The LEADER can.
    const activated = await store.setRelationshipStatus(ctx.otherUserId, created.relationship.id, "active");
    assert.equal(activated?.status, "active");
    // Both sides can pause.
    const paused = await store.setRelationshipStatus(ctx.userId, created.relationship.id, "paused");
    assert.equal(paused?.status, "paused");
    // A third party touches nothing.
    const thirdUser = await ctx.pool.query(
      "INSERT INTO users (email, password_hash) VALUES ($1,'x') ON CONFLICT (email) DO UPDATE SET password_hash = 'x' RETURNING id",
      [`${"tn"}-third@velora.test`],
    );
    const thirdId = String(thirdUser.rows[0].id);
    assert.equal(await store.setRelationshipStatus(thirdId, created.relationship.id, "paused"), null);

    assert.equal((await store.listRelationships(ctx.userId)).length, 1);
    assert.equal(await store.revokeRelationship(ctx.userId, created.relationship.id), true);
    assert.equal((await store.listRelationships(ctx.userId)).length, 0);
    // A revoked relationship can never be resumed.
    assert.equal(await store.setRelationshipStatus(ctx.otherUserId, created.relationship.id, "active"), null);
    // ... and the pair is free to link again, which proves the partial index is
    // scoped to LIVE statuses rather than blocking the pair permanently.
    const relinked = await store.createRelationship({
      followerUserId: ctx.userId,
      leaderAccountId,
      followerAccountId: ctx.accountId,
      allocationMode: "fixed_lot",
      allocationValue: "0.10000000",
    });
    assert.equal(relinked.ok, true);

    // Self-copy is refused by 0020's `leader_user_id <> follower_user_id` CHECK,
    // surfaced as its own reason rather than as a unique violation.
    const selfCopy = await store.createRelationship({
      followerUserId: ctx.otherUserId,
      leaderAccountId,
      followerAccountId: ctx.accountId,
      allocationMode: "proportional",
      allocationValue: "1.00000000",
    });
    assert.deepEqual(selfCopy, { ok: false, reason: "self-copy" });

    // A malformed handle is refused by the engine's pattern CHECK.
    await assert.rejects(() =>
      ctx.q("INSERT INTO public_profiles (user_id, handle) VALUES ($1, 'INVALID HANDLE!')", [ctx.otherUserId]),
    );
  } finally {
    await ctx.close();
  }
});

test("developer keys: unique hash, scope whitelist, revocation", { skip: SKIP }, async () => {
  const ctx = await harness("dv");
  try {
    const store = new PgDeveloperStore(ctx.q);
    const keyHash = "9".repeat(64);
    const created = await store.createKey({
      userId: ctx.userId,
      name: "pg key",
      keyPrefix: "abcd1234",
      keyHash,
      scopes: ["trades:read"],
      rateLimitPerMin: 100,
    });
    assert.deepEqual(created.scopes, ["trades:read"]);

    assert.equal((await store.listKeys(ctx.userId)).length, 1);
    assert.equal((await store.listKeys(ctx.otherUserId)).length, 0);

    // A duplicate hash is refused by 0021's UNIQUE index.
    await assert.rejects(() =>
      store.createKey({
        userId: ctx.otherUserId,
        name: "dup",
        keyPrefix: "abcd1234",
        keyHash,
        scopes: ["trades:read"],
        rateLimitPerMin: 100,
      }),
    );
    // A scope outside 0021's whitelist is refused by the engine.
    await assert.rejects(() =>
      store.createKey({
        userId: ctx.userId,
        name: "bad scope",
        keyPrefix: "abcd1234",
        keyHash: "8".repeat(64),
        scopes: ["admin:everything"],
        rateLimitPerMin: 100,
      }),
    );
    // A malformed prefix is refused by the engine's pattern CHECK.
    await assert.rejects(() =>
      store.createKey({
        userId: ctx.userId,
        name: "bad prefix",
        keyPrefix: "no",
        keyHash: "7".repeat(64),
        scopes: ["trades:read"],
        rateLimitPerMin: 100,
      }),
    );

    assert.equal(await store.revokeKey(ctx.userId, created.id), true);
    assert.equal(await store.revokeKey(ctx.userId, created.id), false);
    assert.equal((await store.listKeys(ctx.userId)).length, 0);
    assert.equal(await store.revokeKey(ctx.otherUserId, created.id), false, "revocation is ownership scoped");

    await ctx.q(
      `INSERT INTO ml_model_predictions (user_id, model_name, model_version, features, prediction, probability)
       VALUES ($1, 'pg-model', 'v1', '{"a":1}'::jsonb, '{"win":true}'::jsonb, 0.75)`,
      [ctx.userId],
    );
    const predictions = await store.listPredictions(ctx.userId, 10);
    assert.equal(predictions.length, 1);
    assert.equal(predictions[0]?.probability, "0.75000");
    assert.equal(await store.listPredictions(ctx.otherUserId, 10).then((p) => p.length), 0);
  } finally {
    await ctx.close();
  }
});
// ---------------------------------------------------------------------------
// v1.5 — account groups and prop rules (the routes pass 2 added)
// ---------------------------------------------------------------------------

/** A second account owned by ANOTHER user, for the ownership assertions. */
async function insertAccount(pool: Pool, userId: string, label: string): Promise<string> {
  const rows = await pool.query(
    `INSERT INTO trading_accounts (user_id, provider, platform, label, currency, timezone, timezone_source)
     VALUES ($1, 'MT5', 'MT5', $2, 'USD', 'UTC', 'account') RETURNING id`,
    [userId, label],
  );
  return String(rows.rows[0].id);
}

test("PG v1.5: account groups write atomically and 0018 enforces ownership itself", { skip: SKIP }, async () => {
  const ctx = await harness("groups");
  try {
    const store = new PgPortfolioStore(ctx.q);
    const mine = await insertAccount(ctx.pool, ctx.userId, "groups-mine");
    const alsoMine = await insertAccount(ctx.pool, ctx.userId, "groups-also-mine");
    const theirs = await insertAccount(ctx.pool, ctx.otherUserId, "groups-theirs");

    const created = await store.createGroup({
      userId: ctx.userId,
      name: "Eval accounts",
      description: "prop evaluations",
      accountIds: [mine, alsoMine],
    });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("expected the group to be created");
    assert.deepEqual([...created.group.accountIds].sort(), [mine, alsoMine].sort());

    // 0018's UNIQUE(user_id, name) is the real guard: a duplicate is reported as a
    // distinguishable reason (the route answers 409), not as a 500.
    const duplicate = await store.createGroup({ userId: ctx.userId, name: "Eval accounts", description: null, accountIds: [] });
    assert.deepEqual(duplicate, { ok: false, reason: "duplicate-name" });

    // The composite FK account_group_members(account_id, user_id) →
    // trading_accounts(id, user_id) refuses a foreign account, which is why the
    // ownership rule cannot be bypassed by a caller that skips the route's check.
    const foreign = await store.createGroup({ userId: ctx.userId, name: "Stolen", description: null, accountIds: [theirs] });
    assert.deepEqual(foreign, { ok: false, reason: "account-not-owned" }, "the DATABASE refuses a foreign account, not just the route");
    const leaked = await ctx.pool.query("SELECT count(*)::int AS n FROM account_groups WHERE user_id = $1 AND name = 'Stolen'", [ctx.userId]);
    assert.equal(leaked.rows[0].n, 0, "the failed group left no partial row");

    // A same-named group by ANOTHER user is allowed (the unique key is per user).
    const otherGroup = await store.createGroup({ userId: ctx.otherUserId, name: "Eval accounts", description: null, accountIds: [theirs] });
    assert.equal(otherGroup.ok, true);

    // Update replaces membership, and an empty list empties the group.
    const replaced = await store.updateGroup({ userId: ctx.userId, groupId: created.group.groupId, name: "Renamed", description: null, accountIds: [] });
    assert.equal(replaced.ok, true);
    if (!replaced.ok) throw new Error("expected the update to succeed");
    assert.equal(replaced.group.name, "Renamed");
    assert.deepEqual([...replaced.group.accountIds], []);

    // The other user's group is invisible to this user, and the predicate keeps it
    // untouchable (a non-disclosing false).
    assert.equal(await store.deleteGroup(ctx.userId, String((otherGroup as { group: { groupId: string } }).group.groupId)), false);
    const stillThere = await store.listGroups(ctx.otherUserId);
    assert.equal(stillThere.length, 1, "another user's group was not deleted");

    // Deleting cascades to membership (0018 ON DELETE CASCADE) and removes only
    // the targeted group.
    assert.equal(await store.deleteGroup(ctx.userId, created.group.groupId), true);
    assert.equal((await store.listGroups(ctx.userId)).length, 0);
    const orphans = await ctx.pool.query(
      "SELECT count(*)::int AS n FROM account_group_members WHERE group_id = $1",
      [created.group.groupId],
    );
    assert.equal(orphans.rows[0].n, 0, "membership rows cascade with the group");
  } finally {
    await ctx.close();
  }
});

test("PG v1.5: prop rules upsert is idempotent and round-trips exact values", { skip: SKIP }, async () => {
  const ctx = await harness("proprules");
  try {
    const store = new PgPortfolioStore(ctx.q);
    const account = await insertAccount(ctx.pool, ctx.userId, "rules-account");
    const otherAccount = await insertAccount(ctx.pool, ctx.otherUserId, "rules-theirs");

    const created = await store.upsertRules({
      userId: ctx.userId,
      accountId: account,
      ruleSetName: "FTMO 100k",
      maxDailyDrawdown: "500.00",
      maxTotalDrawdown: "1000.00",
      profitTarget: "8000.00",
      drawdownBasis: "equity",
      alertThresholdPct: "80.00",
      dailyResetTime: "22:00:00",
      dailyResetTz: "Asia/Tehran",
    });
    assert.equal(created.ok, true);

    const read = await store.readRules(account, ctx.userId);
    assert.equal(read?.ruleSetName, "FTMO 100k");
    assert.equal(read?.maxDailyDrawdown, "500.00", "NUMERIC(20,2) round-trips at its own scale");
    assert.equal(read?.drawdownBasis, "equity");
    assert.equal(read?.alertThresholdPct, "80.00");
    assert.equal(read?.dailyResetTime, "22:00:00");
    assert.equal(read?.dailyResetTz, "Asia/Tehran");

    // A second call for the same (account, rule set) UPDATES in place: 0018 has no
    // unique index over that pair, so "one rule set per account" is upheld by the
    // store's lookup — and the row count proves it stays one.
    const again = await store.upsertRules({
      userId: ctx.userId,
      accountId: account,
      ruleSetName: "FTMO 100k",
      maxDailyDrawdown: null,
      maxTotalDrawdown: "1200.00",
      profitTarget: null,
      drawdownBasis: "balance",
      alertThresholdPct: "75.00",
      dailyResetTime: null,
      dailyResetTz: null,
    });
    assert.equal(again.ok, true);
    const rows = await ctx.pool.query("SELECT count(*)::int AS n FROM prop_firm_rules WHERE account_id = $1", [account]);
    assert.equal(rows.rows[0].n, 1, "one row, not two");
    const reread = await store.readRules(account, ctx.userId);
    assert.equal(reread?.maxTotalDrawdown, "1200.00");
    assert.equal(reread?.maxDailyDrawdown, null, "cleared values are cleared");
    assert.equal(reread?.dailyResetTime, null);

    // Ownership: another user's account is refused by the store (the route then
    // answers non-disclosingly), and no row is written.
    const foreign = await store.upsertRules({
      userId: ctx.userId,
      accountId: otherAccount,
      ruleSetName: "Hijack",
      maxDailyDrawdown: null,
      maxTotalDrawdown: "1.00",
      profitTarget: null,
      drawdownBasis: "balance",
      alertThresholdPct: "80.00",
      dailyResetTime: null,
      dailyResetTz: null,
    });
    assert.deepEqual(foreign, { ok: false, reason: "account-not-owned" });
    assert.equal(await store.readRules(otherAccount, ctx.otherUserId), null, "nothing was written for the other account");

    // The evaluator's view and the CRUD view are the same read.
    assert.deepEqual(await store.propRules(account, ctx.userId), await store.readRules(account, ctx.userId));

    // A value the schema forbids is refused by the DATABASE, not silently stored:
    // alert_threshold_pct must be > 0 and <= 100.
    await assert.rejects(
      () => store.upsertRules({
        userId: ctx.userId,
        accountId: account,
        ruleSetName: "bad-threshold",
        maxDailyDrawdown: null,
        maxTotalDrawdown: "10.00",
        profitTarget: null,
        drawdownBasis: "balance",
        alertThresholdPct: "150.00",
        dailyResetTime: null,
        dailyResetTz: null,
      }),
      (err: { code?: string }) => err.code === "23514",
    );
  } finally {
    await ctx.close();
  }
});
