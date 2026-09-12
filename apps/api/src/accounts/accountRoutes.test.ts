// Accounts HTTP contract tests — Phase C increment 2 (wave 3). Kernel-level
// evidence over real HTTP with the real services on in-memory stores: the
// full ownership matrix, auth boundary, validation, and quota contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listen } from "../kernel/server.js";
import { AuthService } from "../auth/authService.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { VeloraHasher } from "../auth/hashing.js";
import { JwtService } from "../auth/jwt.js";
import { AccountService } from "./accountService.js";
import { MemoryAccountStore } from "./memoryAccountStore.js";

const SECRET = "accounts-routes-test-secret-0123456789abcdef"; // 40 chars, test-only

interface Envelope<T = unknown> {
  status: string;
  data: T;
  error: { code: string; message: string; details?: Record<string, string | number> } | null;
  timestamp: string;
}

async function withServer(
  fn: (base: string, ctx: {
    ownerToken: string; otherToken: string; tokens: string[];
    plans: Map<string, string>;
  }) => Promise<void>,
): Promise<void> {
  const tokens: string[] = [];
  const plans = new Map<string, string>();
  const auth = new AuthService({
    store: new MemoryUserStore(),
    hasher: new VeloraHasher(),
    jwt: JwtService.create(SECRET),
    generateVerificationToken: () => {
      const t = `accounts-test-verification-token-${Math.random().toString(36).slice(2)}-0123456789`;
      tokens.push(t);
      return t;
    },
  });
  const accounts = new AccountService({
    store: new MemoryAccountStore(),
    getPlan: async (userId) => plans.get(userId) ?? "free",
  });
  const app = createApp({
    allowedOrigins: ["https://veloratrade.ir"],
    checks: { database: async () => "ok" as const },
    auth,
    accounts,
  });
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;
  async function makeUser(email: string): Promise<string> {
    const reg = await fetch(`${base}/api/v1/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "a-strong-password-123" }),
    });
    assert.equal(reg.status, 201);
    await fetch(`${base}/api/v1/auth/verify-email`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: tokens.shift() }),
    });
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "a-strong-password-123" }),
    });
    assert.equal(login.status, 200);
    return ((await login.json()) as Envelope<{ tokens: { accessToken: string } }>).data.tokens.accessToken;
  }
  try {
    const ownerToken = await makeUser("owner@velora.example");
    const otherToken = await makeUser("other@velora.example");
    await fn(base, { ownerToken, otherToken, tokens, plans });
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

test("ACCOUNTS HTTP: unauthenticated → 401 on every accounts route", async () => {
  await withServer(async (base) => {
    for (const [method, path] of [
      ["GET", "/api/v1/accounts"],
      ["POST", "/api/v1/accounts"],
      ["POST", "/api/v1/accounts/detect-server"],
      ["PATCH", "/api/v1/accounts/1/timezone"],
      ["DELETE", "/api/v1/accounts/1"],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(((await res.json()) as Envelope<null>).error?.code, "UNAUTHENTICATED");
    }
  });
});

test("ACCOUNTS HTTP: owner journey — create → list → get-via-update → delete", async () => {
  await withServer(async (base, { ownerToken }) => {
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` };

    // create → 201 {account}
    const create = await fetch(`${base}/api/v1/accounts`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ provider: "MT5", label: "Main", accountNumber: "10001", currency: "usd", leverage: "1:500", timezone: "Asia/Tehran" }),
    });
    assert.equal(create.status, 201);
    const account = ((await create.json()) as Envelope<{ account: { id: string; currency: string } }>).data.account;
    assert.equal(account.currency, "USD");
    const accountId = account.id;

    // list → {accounts: [ … ]} (single — free quota)
    const list = await fetch(`${base}/api/v1/accounts`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as Envelope<{ accounts: { id: string }[] }>;
    assert.equal(listBody.data.accounts.length, 1);
    assert.equal(listBody.data.accounts[0]!.id, accountId);

    // update timezone → 200 {account}
    const patch = await fetch(`${base}/api/v1/accounts/${accountId}/timezone`, {
      method: "PATCH", headers: auth, body: JSON.stringify({ timezone: "Europe/Amsterdam" }),
    });
    assert.equal(patch.status, 200);
    assert.equal(((await patch.json()) as Envelope<{ account: { timezone: string } }>).data.account.timezone, "Europe/Amsterdam");

    // delete → {deleted: true}; list empty afterwards
    const del = await fetch(`${base}/api/v1/accounts/${accountId}`, { method: "DELETE", headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(del.status, 200);
    assert.deepEqual(((await del.json()) as Envelope<{ deleted: boolean }>).data, { deleted: true });
    const after = await fetch(`${base}/api/v1/accounts`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(((await after.json()) as Envelope<{ accounts: unknown[] }>).data.accounts.length, 0);
  });
});

test("ACCOUNTS HTTP: cross-user access → identical non-disclosing 404; quota → 429 with details", async () => {
  await withServer(async (base, { ownerToken, otherToken }) => {
    const ownerAuth = { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` };
    const otherAuth = { "Content-Type": "application/json", Authorization: `Bearer ${otherToken}` };

    const create = await fetch(`${base}/api/v1/accounts`, {
      method: "POST", headers: ownerAuth, body: JSON.stringify({ provider: "MT4", label: "Owner's" }),
    });
    const accountId = ((await create.json()) as Envelope<{ account: { id: string } }>).data.account.id;

    // second user: update/delete on the owner's account → 404 NOT_FOUND (same as a missing id)
    for (const [method, path] of [
      ["PATCH", `/api/v1/accounts/${accountId}/timezone`],
      ["DELETE", `/api/v1/accounts/${accountId}`],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method, headers: otherAuth, body: JSON.stringify({ timezone: "UTC" }) });
      assert.equal(res.status, 404);
      const body = (await res.json()) as Envelope<null>;
      assert.equal(body.error?.code, "NOT_FOUND");
      assert.equal(body.error?.message, "Account not found.");
    }
    // …and a nonexistent id is indistinguishable
    const ghost = await fetch(`${base}/api/v1/accounts/999999`, { method: "DELETE", headers: otherAuth });
    assert.equal(ghost.status, 404);
    assert.equal(((await ghost.json()) as Envelope<null>).error?.message, "Account not found.");

    // owner still sees exactly their account
    const list = await fetch(`${base}/api/v1/accounts`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(((await list.json()) as Envelope<{ accounts: unknown[] }>).data.accounts.length, 1);

    // free-plan quota: second create → 429 ACCOUNT_QUOTA_EXCEEDED + Remote quota details
    const quota = await fetch(`${base}/api/v1/accounts`, {
      method: "POST", headers: ownerAuth, body: JSON.stringify({ provider: "MT4", label: "Second" }),
    });
    assert.equal(quota.status, 429);
    const quotaBody = (await quota.json()) as Envelope<null>;
    assert.equal(quotaBody.error?.code, "ACCOUNT_QUOTA_EXCEEDED");
    assert.deepEqual(quotaBody.error?.details, {
      messageKey: "errors.accounts.quotaExceeded", // Remote-verified (integration test)
      plan: "free",
      currentCount: 1,
      maxAllowed: 1,
    });
  });
});

test("ACCOUNTS HTTP: validation errors (400 VALIDATION_FAILED with field details)", async () => {
  await withServer(async (base, { ownerToken }) => {
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` };

    const badProvider = await fetch(`${base}/api/v1/accounts`, {
      method: "POST", headers: auth, body: JSON.stringify({ provider: "MT6" }),
    });
    assert.equal(badProvider.status, 400);
    assert.deepEqual(((await badProvider.json()) as Envelope<null>).error?.details, { provider: "INVALID_PROVIDER" });

    const badTz = await fetch(`${base}/api/v1/accounts`, {
      method: "POST", headers: auth, body: JSON.stringify({ provider: "MT4", timezone: "Nowhere/Bogus" }),
    });
    assert.equal(badTz.status, 400);
    assert.deepEqual(((await badTz.json()) as Envelope<null>).error?.details, { timezone: "INVALID_TIMEZONE" });

    // detect-server: invalid login → 422 VALIDATION_ERROR (verified code)
    const badLogin = await fetch(`${base}/api/v1/accounts/detect-server`, {
      method: "POST", headers: auth, body: JSON.stringify({ mt_login: "abcd" }),
    });
    assert.equal(badLogin.status, 422);
    assert.equal(((await badLogin.json()) as Envelope<null>).error?.code, "VALIDATION_ERROR");

    // detect-server: valid → suggestion payload
    const okLogin = await fetch(`${base}/api/v1/accounts/detect-server`, {
      method: "POST", headers: auth, body: JSON.stringify({ mt_login: "5012345" }),
    });
    assert.equal(okLogin.status, 200);
    const detect = ((await okLogin.json()) as Envelope<{ suggestedServers: string[]; messageKey: string }>).data;
    assert.deepEqual(detect.suggestedServers, ["ICMarkets-Demo", "ICMarkets-Live", "Pepperstone-Demo"]);
    assert.equal(detect.messageKey, "accounts.detectServerHint");
  });
});

test("ACCOUNTS HTTP: concurrent creation serializes to exactly [201, 429] (Remote Blocker B)", async () => {
  await withServer(async (base, { ownerToken }) => {
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` };
    // two simultaneous creations on the free plan (1-account quota)
    const [a, b] = await Promise.all([
      fetch(`${base}/api/v1/accounts`, { method: "POST", headers: auth, body: JSON.stringify({ provider: "MANUAL", label: "Concurrent A" }) }),
      fetch(`${base}/api/v1/accounts`, { method: "POST", headers: auth, body: JSON.stringify({ provider: "MT4", label: "Concurrent B" }) }),
    ]);
    const codes = [a.status, b.status].sort();
    assert.deepEqual(codes, [201, 429]); // exactly one wins
    const failed = a.status === 429 ? a : b;
    const failedBody = (await failed.json()) as Envelope<null>;
    assert.equal(failedBody.error?.code, "ACCOUNT_QUOTA_EXCEEDED");
    assert.equal(failedBody.error?.details?.messageKey, "errors.accounts.quotaExceeded");
    // exactly one account exists afterwards
    const list = await fetch(`${base}/api/v1/accounts`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(((await list.json()) as Envelope<{ accounts: unknown[] }>).data.accounts.length, 1);
  });
});

test("ACCOUNTS HTTP: provider-bypass prevention — quota counts across MANUAL/MT4/MT5", async () => {
  await withServer(async (base, { ownerToken }) => {
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` };
    const manual = await fetch(`${base}/api/v1/accounts`, { method: "POST", headers: auth, body: JSON.stringify({ provider: "MANUAL", label: "Manual Account" }) });
    assert.equal(manual.status, 201);
    const mt4 = await fetch(`${base}/api/v1/accounts`, { method: "POST", headers: auth, body: JSON.stringify({ provider: "MT4", label: "MT4 Bypass Attempt" }) });
    assert.equal(mt4.status, 429);
    assert.equal(((await mt4.json()) as Envelope<null>).error?.code, "ACCOUNT_QUOTA_EXCEEDED");
    const mt5 = await fetch(`${base}/api/v1/accounts`, { method: "POST", headers: auth, body: JSON.stringify({ provider: "MT5", label: "MT5 Bypass Attempt" }) });
    assert.equal(mt5.status, 429);
    assert.equal(((await mt5.json()) as Envelope<null>).error?.code, "ACCOUNT_QUOTA_EXCEEDED");
  });
});

test("ACCOUNTS HTTP: routes fail closed (503) when the capability is unconfigured", async () => {
  const auth = new AuthService({
    store: new MemoryUserStore(),
    hasher: new VeloraHasher(),
    jwt: JwtService.create(SECRET),
  });
  const app = createApp({
    allowedOrigins: ["https://veloratrade.ir"],
    checks: { database: async () => "ok" as const },
    auth, // accounts deliberately NOT configured
  });
  const port = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/accounts`);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as Envelope<null>).error?.code, "SERVICE_UNAVAILABLE");
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
});
