import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryAdminPlatformStore } from "./memoryAdminPlatformStore.js";
import { AdminPlatformService, CANONICAL_FLAGS } from "./adminPlatformService.js";

function makeService(env?: (k: string) => string | undefined) {
  const store = new MemoryAdminPlatformStore({ users: [{ id: "1", email: "a@example.com", plan: "free" }, { id: "2", email: "b@example.com", plan: "pro" }] });
  const svc = new AdminPlatformService({ store, env: env ?? (() => undefined) });
  return { svc, store };
}

// ── settings ─────────────────────────────────────────────────────────────────

test("settings inventory exposes writable catalog plus supervisory reads", async () => {
  const { svc } = makeService();
  const inv = await svc.settingsInventory();
  const defLocale = inv.find((r) => r.key === "platform.default_locale");
  assert.ok(defLocale);
  assert.equal(defLocale.writable, true);
  assert.equal(defLocale.module, "platform");
  assert.equal(defLocale.value, null);
  assert.equal(defLocale.source, "env-default");
  // supervisory
  const meta = inv.find((r) => r.key === "METAAPI_BASE_URL");
  assert.ok(meta);
  assert.equal(meta.writable, false);
});

test("settings: update platform.default_locale accepts fa/en, rejects unknown/invalid", async () => {
  const { svc } = makeService();
  // valid fa
  let res = await svc.updateSetting("platform.default_locale", "fa", "1");
  assert.equal(res.new, "fa");
  // valid en (case-insensitive, trimmed)
  res = await svc.updateSetting("platform.default_locale", " En ", "1");
  assert.equal(res.new, "en");
  const inv = await svc.settingsInventory();
  assert.equal(inv.find((r) => r.key === "platform.default_locale")?.value, "en");

  // invalid choice
  await assert.rejects(() => svc.updateSetting("platform.default_locale", "de", "1"), (e: unknown) => {
    const err = e as { details?: Record<string, readonly string[]> };
    return Array.isArray(err.details?.["value"]) && err.details!["value"].includes("INVALID_CHOICE");
  });
  // unknown key (secret-shaped also)
  await assert.rejects(() => svc.updateSetting("UNKNOWN_KEY", "fa", "1"), (e: unknown) => {
    const err = e as { details?: Record<string, readonly string[]> };
    return Array.isArray(err.details?.["key"]) && err.details!["key"].includes("UNKNOWN_SETTING");
  });
  await assert.rejects(() => svc.updateSetting("METAAPI_TOKEN", "secret", "1"), (e: unknown) => {
    const err = e as { details?: Record<string, readonly string[]> };
    return Array.isArray(err.details?.["key"]);
  });
  // supervisory keys are not writable via settings
  await assert.rejects(() => svc.updateSetting("MAIL_DRIVER", "smtp", "1"), (e: unknown) => Array.isArray((e as { details?: Record<string, readonly string[]> }).details?.["key"]));
});

test("settings: reset removes DB row, rejects unknown", async () => {
  const { svc } = makeService();
  await svc.updateSetting("platform.default_locale", "en", "1");
  let inv = await svc.settingsInventory();
  assert.equal(inv.find((r) => r.key === "platform.default_locale")?.value, "en");
  const res = await svc.resetSetting("platform.default_locale");
  assert.equal(res.old, "en");
  inv = await svc.settingsInventory();
  assert.equal(inv.find((r) => r.key === "platform.default_locale")?.value, null);
  await assert.rejects(() => svc.resetSetting("MAIL_DRIVER"), (e: unknown) => Array.isArray((e as { details?: Record<string, readonly string[]> }).details?.["key"]));
});

// ── feature flags ────────────────────────────────────────────────────────────

test("feature flags: list returns canonical 4 with defaults", async () => {
  const { svc } = makeService();
  const flags = await svc.listFeatureFlags();
  assert.equal(flags.length, CANONICAL_FLAGS.length);
  for (const f of CANONICAL_FLAGS) {
    const row = flags.find((r) => r.feature === f);
    assert.ok(row, `missing ${f}`);
    if (f === "ai_screenshot_extraction") {
      assert.equal(row.enabled, true);
      assert.equal(row.rollout, 100);
      assert.equal(row.effective, "on");
    } else {
      assert.equal(row.enabled, false);
      assert.equal(row.rollout, 0);
      assert.equal(row.effective, "off");
    }
  }
});

test("feature flags: update validates feature/enabled/rollout and persists", async () => {
  const { svc } = makeService();
  // enable
  let row = await svc.updateFeatureFlag("ai_trade_analysis", true, 50, "1");
  assert.equal(row.enabled, true);
  assert.equal(row.rollout, 50);
  assert.equal(row.effective, "rollout:50");
  // disable
  row = await svc.updateFeatureFlag("ai_trade_analysis", false, 0, "1");
  assert.equal(row.enabled, false);
  assert.equal(row.effective, "off");
  // rollout 100 -> on
  row = await svc.updateFeatureFlag("ai_weekly_report", true, 100, "1");
  assert.equal(row.effective, "on");

  // unknown feature
  await assert.rejects(() => svc.updateFeatureFlag("unknown_flag", true, 100, "1"), (e: unknown) => Array.isArray((e as { details?: Record<string, readonly string[]> }).details?.["feature"]));
  // enabled not boolean
  await assert.rejects(() => svc.updateFeatureFlag("ai_assistant", "true" as unknown as boolean, 100, "1"), (e: unknown) => Array.isArray((e as { details?: Record<string, readonly string[]> }).details?.["enabled"]));
  // rollout out of range
  await assert.rejects(() => svc.updateFeatureFlag("ai_assistant", true, -1, "1"), (e: unknown) => Array.isArray((e as { details?: Record<string, readonly string[]> }).details?.["rollout"]));
  await assert.rejects(() => svc.updateFeatureFlag("ai_assistant", true, 101, "1"), (e: unknown) => Array.isArray((e as { details?: Record<string, readonly string[]> }).details?.["rollout"]));
  await assert.rejects(() => svc.updateFeatureFlag("ai_assistant", true, 1.5, "1"), (e: unknown) => Array.isArray((e as { details?: Record<string, readonly string[]> }).details?.["rollout"]));
});

// ── system logs ──────────────────────────────────────────────────────────────

test("system logs: list newest-first, pagination, filters", async () => {
  const { svc, store } = makeService();
  await store.createSystemLog({ severity: "INFO", source: "api", message: "first" });
  await store.createSystemLog({ severity: "ERROR", source: "worker", message: "boom" });
  await store.createSystemLog({ severity: "INFO", source: "api", message: "second", requestId: "req-1" });

  let res = await svc.listSystemLogs({}, 1, 50);
  assert.equal(res.total, 3);
  assert.equal(res.items.length, 3);
  assert.equal(res.items[0]?.message, "second"); // newest first

  res = await svc.listSystemLogs({ severity: "ERROR" }, 1, 50);
  assert.equal(res.total, 1);
  assert.equal(res.items[0]?.severity, "ERROR");

  res = await svc.listSystemLogs({ source: "api" }, 1, 50);
  assert.equal(res.total, 2);

  res = await svc.listSystemLogs({ q: "boom" }, 1, 50);
  assert.equal(res.total, 1);

  // pagination
  res = await svc.listSystemLogs({}, 1, 2);
  assert.equal(res.items.length, 2);
  assert.equal(res.total, 3);
  res = await svc.listSystemLogs({}, 2, 2);
  assert.equal(res.items.length, 1);
});

test("system logs: invalid severity rejected", async () => {
  const { svc } = makeService();
  await assert.rejects(() => svc.listSystemLogs({ severity: "CRITICAL" }, 1, 50), (e: unknown) => Array.isArray((e as { details?: Record<string, readonly string[]> }).details?.["severity"]));
});

// ── billing ──────────────────────────────────────────────────────────────────

test("billing overview: honest unavailable provider/history, plan distribution, entitlements", async () => {
  const { svc } = makeService(() => undefined);
  const over = await svc.billingOverview();
  assert.equal(over.provider.available, false);
  assert.ok(over.provider.reason.includes("No external payment"));
  assert.equal(over.history.available, false);
  assert.equal(over.plans.length, 3);
  // distribution counts free=1 pro=1 enterprise=0 (seed)
  const free = over.distribution.plan.find((p) => p.key === "free");
  assert.equal(free?.count, 1);
  const pro = over.distribution.plan.find((p) => p.key === "pro");
  assert.equal(pro?.count, 1);
  assert.equal(over.entitlements.tradingAccountsPerUser.limit, 10);
  assert.equal(over.entitlements.tradingAccountsPerUser.source, "config:metaapi.max_accounts_per_user");
  assert.ok(over.entitlements.providerBudget.available === false || over.entitlements.providerBudget.available === true);
});

test("billing overview: env limit respected", async () => {
  const env = (k: string) => (k === "METAAPI_MAX_ACCOUNTS_PER_USER" ? "7" : undefined);
  const { svc } = makeService(env);
  const over = await svc.billingOverview();
  assert.equal(over.entitlements.tradingAccountsPerUser.limit, 7);
});

test("billing user: returns per-user, handles not found and invalid id", async () => {
  const { svc } = makeService();
  const data = await svc.billingUser("1");
  assert.equal(data.user.id, "1");
  assert.equal(data.user.email, "a@example.com");
  assert.equal(data.subscription.plan, "free");
  assert.equal(data.history.available, false);
  assert.ok(data.entitlements.tradingAccounts.limit >= 1);

  await assert.rejects(() => svc.billingUser("999"), (e: unknown) => {
    const err = e as Error;
    return err.message === "User not found.";
  });
  await assert.rejects(() => svc.billingUser("abc"), (e: unknown) => Array.isArray((e as { details?: Record<string, readonly string[]> }).details?.["id"]));
});

// ── audit note ───────────────────────────────────────────────────────────────
// The service purposefully does NOT write audit rows for this phase — it is
// read-mostly observability. Mutations (settings/flags) are already covered by
// the store's updated_by/updated_at; audit can be added when worker delivers
// the effेcts these knobs gate.
