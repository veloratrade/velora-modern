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
import { join } from "node:path";
import { createEngine, migrate } from "../migrate.ts";
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

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
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
  const { Pool } = await import("pg");
  const engine = await createEngine(PG_URL as string);
  await migrate(engine, MIGRATIONS);
  await engine.close();
  const pool = new Pool({ connectionString: PG_URL });
  const q = poolQuery(pool);

  const email = `${label}-owner@velora.test`;
  const otherEmail = `${label}-other@velora.test`;
  // CLEAN SLATE PER TEST. The battery may be re-run against the same cluster
  // (the evidence workflow never recreates it), and several assertions are
  // exact counts. Deleting the two test users cascades to every row they own —
  // accounts, trades, tags, subscriptions, keys — so each run starts from the
  // same state instead of accumulating.
  const existing = await pool.query("SELECT id FROM users WHERE email IN ($1,$2)", [email, otherEmail]);
  const existingIds = existing.rows.map((r: { id: string | number }) => String(r.id));
  if (existingIds.length > 0) {
    // Explicit child-first cleanup: several of these FKs are NOT cascading, so a
    // bare `DELETE FROM users` is refused (verified). Order matters, and every
    // statement is bounded to the two test users.
    const cleanups: readonly (readonly [string, string])[] = [
      ["trade_tags", "user_id"],
      ["trade_attachments", "user_id"],
      // trade_exits has no user_id (it is scoped through its parent trade), so
      // it is cleaned via a subquery over the trades being removed.
      ["trades", "user_id"],
      ["tags", "user_id"],
      ["subscriptions", "user_id"],
      ["ai_coaching_logs", "user_id"],
      ["public_profiles", "user_id"],
      ["copy_relationships", "follower_user_id"],
      ["copy_relationships", "leader_user_id"],
      ["signal_queue", "leader_user_id"],
      ["developer_api_keys", "user_id"],
      ["ml_model_predictions", "user_id"],
      ["device_tokens", "user_id"],
      ["voice_session_logs", "user_id"],
      ["prop_firm_rules", "user_id"],
      ["account_group_members", "user_id"],
      ["trading_accounts", "user_id"],
      ["account_groups", "user_id"],
    ];
    for (const [table, column] of cleanups) {
      await pool.query(`DELETE FROM ${table} WHERE ${column} = ANY($1::bigint[])`, [existingIds]);
    }
    await pool.query(
      "DELETE FROM trade_exits WHERE trade_id IN (SELECT id FROM trades WHERE user_id = ANY($1::bigint[]))",
      [existingIds],
    );
    await pool.query("DELETE FROM users WHERE id = ANY($1::bigint[])", [existingIds]);
  }
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

  // IDEMPOTENT: the battery may be re-run against the same database (the
  // evidence workflow migrates idempotently but does not recreate the cluster),
  // and `trading_accounts_metaapi_unique` would reject a second insert for the
  // same provider account.
  const metaapiId = `metaapi-${label}`;
  await pool.query(
    `INSERT INTO trading_accounts (user_id, provider, platform, label, currency, metaapi_account_id, timezone, timezone_source)
     SELECT $1, 'MT5', 'MT5', $2, 'USD', $3, 'UTC', 'account'
      WHERE NOT EXISTS (SELECT 1 FROM trading_accounts WHERE metaapi_account_id = $3)`,
    [userId, `${label} account`, metaapiId],
  );
  const account = await pool.query("SELECT id FROM trading_accounts WHERE metaapi_account_id = $1", [metaapiId]);

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
    const created = await store.createRelationship({
      leaderUserId: ctx.otherUserId,
      followerUserId: ctx.userId,
      leaderAccountId,
      followerAccountId: ctx.accountId,
      allocationMode: "proportional",
      allocationValue: "1.00000000",
    });
    assert.equal(created?.status, "pending");

    // 0020's partial UNIQUE index rejects a second live pair.
    const duplicate = await store.createRelationship({
      leaderUserId: ctx.otherUserId,
      followerUserId: ctx.userId,
      leaderAccountId,
      followerAccountId: ctx.accountId,
      allocationMode: "proportional",
      allocationValue: "1.00000000",
    });
    assert.equal(duplicate, null);

    assert.equal((await store.listRelationships(ctx.userId)).length, 1);
    assert.equal(await store.revokeRelationship(ctx.userId, created?.id as string), true);
    assert.equal((await store.listRelationships(ctx.userId)).length, 0);

    // Self-copy is refused by the engine.
    await assert.rejects(() =>
      ctx.q(
        `INSERT INTO copy_relationships (leader_user_id, follower_user_id, leader_account_id, follower_account_id)
         VALUES ($1, $1, $2, $2)`,
        [ctx.userId, ctx.accountId],
      ),
    );

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
