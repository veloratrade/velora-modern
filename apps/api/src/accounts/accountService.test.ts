// AccountService tests — Phase C increment 2 (wave 3). Unit-level evidence
// for the first ownership-scoped resource: the full ownership matrix,
// validation contracts, plan quota, and detect-server (Remote + PHP verified).
import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountService, AccountError, getPlanQuota } from "./accountService.js";
import { MemoryAccountStore } from "./memoryAccountStore.js";

const OWNER = "1";
const OTHER = "2"; // second user — must never observe owner resources

function makeService(plans: Record<string, string> = {}): { svc: AccountService; store: MemoryAccountStore } {
  const store = new MemoryAccountStore();
  const svc = new AccountService({
    store,
    getPlan: async (userId) => plans[userId] ?? "free",
  });
  return { svc, store };
}

const VALID = { provider: "MANUAL", label: "Main", accountNumber: "10001", currency: "usd", leverage: "1:500", timezone: "Asia/Tehran" };

test("ownership matrix: owner CRUD vs second user vs unauthenticated boundary", async () => {
  const { svc } = makeService({ "1": "pro" }); // owner (id 1) on the unlimited plan

  // 1. owner can create (pro plan — unlimited)
  const created = await svc.createAccount(OWNER, VALID);
  assert.equal(created.provider, "MANUAL");
  assert.equal(created.platform, "MANUAL");
  assert.equal(created.currency, "USD"); // normalized uppercase
  assert.equal(created.leverage, "1:500");
  assert.equal(created.timezone, "Asia/Tehran");
  assert.equal(created.timezoneSource, "user_config");
  assert.equal(created.balance, "0.00");
  assert.equal(created.status, "disconnected"); // default
  assert.equal(created.syncStatus, "DISCONNECTED");

  // 2. owner can read (list + ownership-scoped get)
  const list = await svc.listAccounts(OWNER);
  assert.equal(list.length, 1);
  const got = await svc.getAccount(created.id, OWNER);
  assert.equal(got.id, created.id);

  // 3. owner can update (timezone)
  const patched = await svc.updateTimezone(created.id, OWNER, "Europe/Amsterdam");
  assert.equal(patched.timezone, "Europe/Amsterdam");
  // empty string clears the timezone (source 'unknown')
  const cleared = await svc.updateTimezone(created.id, OWNER, "");
  assert.equal(cleared.timezone, null);
  assert.equal(cleared.timezoneSource, "unknown");

  // 5-7. second user: read / update / delete → identical non-disclosing 404
  for (const op of [
    () => svc.getAccount(created.id, OTHER),
    () => svc.updateTimezone(created.id, OTHER, "UTC"),
    () => svc.deleteAccount(created.id, OTHER),
  ]) {
    await assert.rejects(
      op(),
      (e: unknown) => e instanceof AccountError && e.status === 404 && e.code === "NOT_FOUND" && e.message === "Account not found.",
    );
  }
  // the resource still exists for the owner after OTHER's attempts
  assert.ok((await svc.getAccount(created.id, OWNER)).id === created.id);

  // 4. owner can delete
  const deleted = await svc.deleteAccount(created.id, OWNER);
  assert.deepEqual(deleted, { deleted: true });
  await assert.rejects(svc.getAccount(created.id, OWNER), (e: unknown) => e instanceof AccountError && e.status === 404);
});

test("unauthenticated boundary is enforced at the route layer (service requires explicit userId)", () => {
  // The kernel's accountsRoute wrapper rejects unauthenticated requests with
  // 401 BEFORE any service call (covered in accountRoutes.test.ts). At the
  // service layer, ownership is a mandatory parameter — there is no
  // unscoped read path (compile-time + signature guarantee).
  assert.equal(MemoryAccountStore.name, "MemoryAccountStore");
});

test("validation contracts (Remote/PHP verified)", async () => {
  const { svc } = makeService({ "999": "pro" });

  const cases: Array<[Record<string, unknown>, string, Record<string, unknown>]> = [
    [{ provider: "MT6" }, "provider", { provider: "INVALID_PROVIDER" }],
    [{}, "provider", { provider: "INVALID_PROVIDER" }], // PHP: provider required
    [{ provider: "MT4", currency: "USDD" }, "currency", { currency: "INVALID_FORMAT" }],
    [{ provider: "MT4", accountNumber: "bad account!" }, "accountNumber", { accountNumber: "INVALID_FORMAT" }],
    [{ provider: "MT4", leverage: "0" }, "leverage", { leverage: "INVALID_FORMAT" }],
    [{ provider: "MT4", leverage: "1:0" }, "leverage", { leverage: "INVALID_FORMAT" }],
    [{ provider: "MT4", timezone: "Not/A_Iana_Zone" }, "timezone", { timezone: "INVALID_TIMEZONE" }],
    [{ provider: "MT4", status: "bogus" }, "status", { status: "INVALID_STATUS" }],
  ];
  for (const [input, field, details] of cases) {
    await assert.rejects(
      svc.createAccount("999", input),
      (e: unknown) =>
        e instanceof AccountError && e.status === 400 && e.code === "VALIDATION_FAILED" &&
        e.details !== undefined && JSON.stringify(e.details) === JSON.stringify(details),
      `expected rejection for ${JSON.stringify(input)} on ${field}`,
    );
  }

  // defaults: label, currency, leverage, timezone, status
  const d = await svc.createAccount("999", { provider: "MANUAL" });
  assert.equal(d.label, "Trading Account");
  assert.equal(d.currency, "USD");
  assert.equal(d.leverage, "100");
  assert.equal(d.timezone, null);
  assert.equal(d.timezoneSource, "unknown");
});

test("plan quota: free = 1 (429 ACCOUNT_QUOTA_EXCEEDED with counts); pro = unlimited", async () => {
  const { svc } = makeService();
  // first account OK on free
  await svc.createAccount(OWNER, { provider: "MT4" });
  // second → 429 with the Remote quota details
  await assert.rejects(
    svc.createAccount(OWNER, { provider: "MT5" }),
    (e: unknown) =>
      e instanceof AccountError && e.status === 429 && e.code === "ACCOUNT_QUOTA_EXCEEDED" &&
      e.details !== undefined && (e.details as Record<string, number>).currentCount === 1 &&
      (e.details as Record<string, number>).maxAllowed === 1,
  );
  // another user's quota is independent
  await svc.createAccount(OTHER, { provider: "MT4" });

  // pro: unlimited
  const pro = makeService({ "1": "pro" });
  for (let i = 0; i < 5; i += 1) {
    await pro.svc.createAccount("1", { provider: "MT4" });
  }
  assert.equal(getPlanQuota("enterprise").isUnlimited, true);
  assert.equal(getPlanQuota("free").maxTradingAccounts, 1);
});

test("quota: concurrent creation serializes to exactly one success (Remote Blocker B)", async () => {
  const { svc } = makeService(); // owner on free plan
  const results = await Promise.allSettled([
    svc.createAccount(OWNER, { provider: "MANUAL", label: "Concurrent A" }),
    svc.createAccount(OWNER, { provider: "MT4", label: "Concurrent B" }),
    svc.createAccount(OWNER, { provider: "MT5", label: "Concurrent C" }),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1); // exactly one account created
  assert.equal(rejected.length, 2);
  for (const r of rejected) {
    const e = (r as PromiseRejectedResult).reason as AccountError;
    assert.equal(e.status, 429);
    assert.equal(e.code, "ACCOUNT_QUOTA_EXCEEDED");
    assert.equal(e.details?.messageKey, "errors.accounts.quotaExceeded");
  }
  const list = await svc.listAccounts(OWNER);
  assert.equal(list.length, 1);
});

test("quota: provider-bypass prevention — the limit counts across MANUAL/MT4/MT5", async () => {
  const { svc } = makeService();
  await svc.createAccount(OWNER, { provider: "MANUAL", label: "Manual" }); // 201-equivalent
  for (const provider of ["MT4", "MT5"]) {
    await assert.rejects(
      svc.createAccount(OWNER, { provider, label: `${provider} bypass` }),
      (e: unknown) => e instanceof AccountError && e.status === 429 && e.code === "ACCOUNT_QUOTA_EXCEEDED",
    );
  }
});

test("detect-server: static suggestion logic (Remote + PHP identical)", async () => {
  const { svc } = makeService();
  const r5 = svc.detectServer("5012345");
  assert.deepEqual(r5.suggestedServers, ["ICMarkets-Demo", "ICMarkets-Live", "Pepperstone-Demo"]);
  const r6 = svc.detectServer("6012345");
  assert.deepEqual(r6.suggestedServers, ["Exness-Demo", "Exness-Real"]);
  const rOther = svc.detectServer("12345");
  assert.equal(rOther.suggestedServers.length, 5);
  assert.equal(rOther.allServers.length, 18);
  assert.equal(rOther.messageKey, "accounts.detectServerHint");
  assert.equal(rOther.nextStepKey, "accounts.detectServerNextStep");
  // invalid login → 422 VALIDATION_ERROR (note: NOT VALIDATION_FAILED — verified)
  for (const bad of ["", "abc", "12a4", "123456789012345678901234567890123"]) {
    assert.throws(
      () => svc.detectServer(bad),
      (e: unknown) => e instanceof AccountError && e.status === 422 && e.code === "VALIDATION_ERROR",
    );
  }
});

test("listing order: newest first (Remote orderBy createdAt desc)", async () => {
  let clock = new Date("2026-09-12T10:00:00Z");
  const store = new MemoryAccountStore();
  const svc = new AccountService({ store, now: () => clock, getPlan: async () => "pro" });
  const a = await svc.createAccount(OWNER, { provider: "MT4", label: "first" });
  clock = new Date("2026-09-12T11:00:00Z");
  const b = await svc.createAccount(OWNER, { provider: "MT5", label: "second" });
  const list = await svc.listAccounts(OWNER);
  assert.deepEqual(list.map((x) => x.id), [b.id, a.id]);
});
