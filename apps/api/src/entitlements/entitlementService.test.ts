// EntitlementService tests — Phase C increment 6. Ports the Remote
// tests/unit/entitlements.test.ts matrix (read-verified): plan normalization,
// SAFE-FAIL CLOSED to free for unknown plans, entitlement allow/block with
// the exact 429 contract, and the fail-closed getUserPlan invariant (Blocker A).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EntitlementService, EntitlementError, getPlanQuota } from "./entitlementService.js";

test("getPlanQuota: free for 'free', null, undefined, empty string", () => {
  for (const input of ["free", null, undefined, ""] as const) {
    assert.deepEqual(getPlanQuota(input), { plan: "free", maxTradingAccounts: 1, isUnlimited: false });
  }
});

test("getPlanQuota: pro unlimited, case-insensitive and whitespace-tolerant", () => {
  for (const input of ["pro", "PRO", " Pro "] as const) {
    assert.deepEqual(getPlanQuota(input), { plan: "pro", maxTradingAccounts: Number.POSITIVE_INFINITY, isUnlimited: true });
  }
});

test("getPlanQuota: enterprise unlimited, case-insensitive", () => {
  for (const input of ["enterprise", "ENTERPRISE", " Enterprise "] as const) {
    assert.deepEqual(getPlanQuota(input), { plan: "enterprise", maxTradingAccounts: Number.POSITIVE_INFINITY, isUnlimited: true });
  }
});

test("getPlanQuota: SAFE-FAIL CLOSED — unknown/unsupported plan strings degrade to free", () => {
  for (const input of ["unknown_plan_x", "vip_gold_plan", "PROPLUS", "pro "] as const) {
    // ('pro ' with trailing space trims to pro — the genuinely unknown ones fail closed)
    if (input === "pro ") continue;
    assert.deepEqual(getPlanQuota(input), { plan: "free", maxTradingAccounts: 1, isUnlimited: false }, input);
  }
});

test("checkTradingAccountEntitlement: free with 0 accounts → allowed", () => {
  const svc = new EntitlementService({ findUserById: async () => null });
  const res = svc.checkTradingAccountEntitlement("1", 0, "free");
  assert.deepEqual(res, { allowed: true, limit: 1, currentCount: 0 });
});

test("checkTradingAccountEntitlement: free with 1 account → 429 with the Remote contract", () => {
  const svc = new EntitlementService({ findUserById: async () => null });
  assert.throws(
    () => svc.checkTradingAccountEntitlement("1", 1, "free"),
    (e: unknown) => {
      assert.ok(e instanceof EntitlementError);
      assert.equal(e.status, 429);
      assert.equal(e.code, "ACCOUNT_QUOTA_EXCEEDED");
      assert.equal(e.message, "Trading account quota exceeded. Free plan allows up to 1 trading account.");
      assert.deepEqual(e.details, {
        messageKey: "errors.accounts.quotaExceeded",
        plan: "free",
        currentCount: 1,
        maxAllowed: 1,
      });
      return true;
    },
  );
});

test("checkTradingAccountEntitlement: pro/enterprise with many accounts → allowed (unlimited)", () => {
  const svc = new EntitlementService({ findUserById: async () => null });
  for (const plan of ["pro", "enterprise"]) {
    for (const count of [1, 5, 100]) {
      const res = svc.checkTradingAccountEntitlement("1", count, plan);
      assert.equal(res.allowed, true, `${plan} @ ${count}`);
      assert.equal(res.limit, Number.POSITIVE_INFINITY);
    }
  }
});

test("getUserPlan: missing user or null/empty plan → 'free'; plan normalized", async () => {
  const cases: Array<{ user: { plan: string | null } | null; expected: string }> = [
    { user: null, expected: "free" },
    { user: { plan: null }, expected: "free" },
    { user: { plan: "" }, expected: "free" },
    { user: { plan: "PRO" }, expected: "pro" },
    { user: { plan: " Free " }, expected: "free" },
  ];
  for (const { user, expected } of cases) {
    const svc = new EntitlementService({ findUserById: async () => user });
    assert.equal(await svc.getUserPlan("1"), expected);
  }
});

test("getUserPlan: FAIL-CLOSED — store errors throw 503, never a silent 'free' (Remote Blocker A)", async () => {
  const svc = new EntitlementService({
    findUserById: async () => {
      throw new Error("db down");
    },
  });
  await assert.rejects(
    svc.getUserPlan("1"),
    (e: unknown) => e instanceof EntitlementError && e.status === 503 && e.code === "SERVICE_UNAVAILABLE",
  );
});
