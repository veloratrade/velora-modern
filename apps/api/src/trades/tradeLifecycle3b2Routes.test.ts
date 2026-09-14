// Phase 3B-2 — trade lifecycle HTTP contract tests.
//
// Kernel-level evidence over real HTTP for the behaviour CHANGED by 3B-2:
//   OD-2  DELETE => 204 No Content, empty body, mandatory optimistic concurrency
//         (If-Match or body `version`), stale => 409 with no mutation
//   OD-6  net_pnl recomputed from the realized exit ledger, observable via GET
//
// The pre-existing owner journey stays in tradeRoutes.test.ts and is not
// duplicated here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listen } from "../kernel/server.js";
import { AuthService } from "../auth/authService.js";
import { LogMailProvider } from "../mail/logMailProvider.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { VeloraHasher } from "../auth/hashing.js";
import { JwtService } from "../auth/jwt.js";
import { AccountService } from "../accounts/accountService.js";
import { MemoryAccountStore } from "../accounts/memoryAccountStore.js";
import { TradeService } from "./tradeService.js";
import { MemoryTradeStore } from "./memoryTradeStore.js";

const SECRET = "trades-3b2-routes-test-secret-0123456789abcdef"; // test-only

interface Envelope<T = unknown> {
  status: string;
  data: T;
  error: { code: string; message: string; details?: Record<string, string | number> } | null;
  timestamp: string;
}

const VECTOR_A = {
  symbol: "EURUSD", direction: "buy", entryPrice: "1.1000", exitPrice: "1.1050",
  volume: "1.0", contractSize: "100000", commission: "5.00", swap: "1.50", stopLoss: "1.0970",
  openTime: "2026-09-10 10:00:00", closeTime: "2026-09-10 12:00:00",
};

async function withServer(
  fn: (base: string, ctx: { ownerToken: string; otherToken: string; store: MemoryTradeStore }) => Promise<void>,
): Promise<void> {
  const tokens: string[] = [];
  const userStore = new MemoryUserStore();
  const accountStore = new MemoryAccountStore();
  const tradeStore = new MemoryTradeStore();
  const auth = new AuthService({
    store: userStore,
    hasher: new VeloraHasher(),
    jwt: JwtService.create(SECRET),
    generateVerificationToken: () => {
      const t = `trades-3b2-verification-token-${Math.random().toString(36).slice(2)}-0123456789`;
      tokens.push(t);
      return t;
    },
    mail: new LogMailProvider(), // explicit offline outbox — never a silent no-op
  });
  const accounts = new AccountService({
    store: accountStore,
    getPlan: async (userId) => (await userStore.findUserById(userId))?.plan ?? "free",
  });
  const trades = new TradeService({
    store: tradeStore,
    getUserTimezone: async (userId) => (await userStore.findUserById(userId))?.timezone ?? "UTC",
    verifyAccountOwnership: async (accountId, userId) =>
      (await accountStore.findByIdForUser(accountId, userId)) !== null,
  });
  const app = createApp({
    allowedOrigins: ["https://veloratrade.ir"],
    checks: { database: async () => "ok" as const },
    auth, accounts, trades,
  });
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;
  async function makeUser(email: string): Promise<string> {
    await fetch(`${base}/api/v1/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "a-strong-password-123" }),
    });
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
    const ownerToken = await makeUser("owner3b2@velora.example");
    const otherToken = await makeUser("other3b2@velora.example");
    await fn(base, { ownerToken, otherToken, store: tradeStore });
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

async function createTrade(base: string, token: string, payload: Record<string, unknown> = VECTOR_A): Promise<string> {
  const res = await fetch(`${base}/api/v1/trades`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  return (JSON.parse(text) as Envelope<{ id: string }>).data.id;
}

async function getTrade(base: string, token: string, id: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/api/v1/trades/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  return ((await res.json()) as Envelope<Record<string, unknown>>).data;
}

// ---------------------------------------------------------------------------
// OD-2 — DELETE contract
// ---------------------------------------------------------------------------

test("3B-2 HTTP delete: 204 with a genuinely empty body and no Content-Type", async () => {
  await withServer(async (base, { ownerToken }) => {
    const id = await createTrade(base, ownerToken);
    const res = await fetch(`${base}/api/v1/trades/${id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
    assert.equal(res.headers.get("content-type"), null);
    // Security headers still applied on a 204.
    assert.ok(res.headers.get("x-request-id"));
  });
});

test("3B-2 HTTP delete: If-Match with the CURRENT version succeeds (204)", async () => {
  await withServer(async (base, { ownerToken }) => {
    const id = await createTrade(base, ownerToken);
    const v = (await getTrade(base, ownerToken, id)).version as number;
    const res = await fetch(`${base}/api/v1/trades/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ownerToken}`, "If-Match": `"${v}"` },
    });
    assert.equal(res.status, 204);
    const gone = await fetch(`${base}/api/v1/trades/${id}`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(gone.status, 404);
  });
});

test("3B-2 HTTP delete: STALE If-Match => 409 CONFLICT, trade still readable, no event", async () => {
  await withServer(async (base, { ownerToken, store }) => {
    const id = await createTrade(base, ownerToken);
    const before = store.eventLog().length;

    const res = await fetch(`${base}/api/v1/trades/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ownerToken}`, "If-Match": '"99"' },
    });
    assert.equal(res.status, 409);
    const env = (await res.json()) as Envelope<null>;
    assert.equal(env.status, "error");
    assert.equal(env.error?.code, "CONFLICT");

    assert.equal(store.eventLog().length, before, "a rejected delete must not append an event");
    const still = await fetch(`${base}/api/v1/trades/${id}`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(still.status, 200);
  });
});

test("3B-2 HTTP delete: stale version in the JSON BODY => 409 (both channels honoured)", async () => {
  await withServer(async (base, { ownerToken }) => {
    const id = await createTrade(base, ownerToken);
    const res = await fetch(`${base}/api/v1/trades/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 42 }),
    });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as Envelope<null>).error?.code, "CONFLICT");
  });
});

test("3B-2 HTTP delete: cross-user delete is a non-disclosing 404, even with a valid version", async () => {
  await withServer(async (base, { ownerToken, otherToken }) => {
    const id = await createTrade(base, ownerToken);
    const v = (await getTrade(base, ownerToken, id)).version as number;
    const res = await fetch(`${base}/api/v1/trades/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${otherToken}`, "If-Match": `"${v}"` },
    });
    assert.equal(res.status, 404); // never 403 — existence is not disclosed
    // The owner's trade is untouched.
    assert.equal((await getTrade(base, ownerToken, id)).id, id);
  });
});

// ---------------------------------------------------------------------------
// OD-6 — recomputed financials over HTTP
// ---------------------------------------------------------------------------

test("3B-2 HTTP exits: partial exit recomputes profitLoss on the parent trade", async () => {
  await withServer(async (base, { ownerToken }) => {
    const id = await createTrade(base, ownerToken);
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` };

    assert.equal((await getTrade(base, ownerToken, id)).profitLoss, "493.5"); // close-price figure

    const ex = await fetch(`${base}/api/v1/trades/${id}/exits`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ exitType: "partial", exitPrice: "1.1050", volume: "0.5", exitedAt: "2026-09-10 11:00:00" }),
    });
    assert.equal(ex.status, 201);

    // Canonical field updated in place — OD-6: no second financial field.
    const after = await getTrade(base, ownerToken, id);
    assert.equal(after.profitLoss, "246.75");
    assert.equal(after.rMultiple, "0.8225");
    assert.equal("netPnl" in after, false, "net_pnl must not leak as a duplicate API field");
  });
});

test("3B-2 HTTP exits: cancelling an exit restores the realized figure", async () => {
  await withServer(async (base, { ownerToken }) => {
    const id = await createTrade(base, ownerToken);
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` };

    const created = await fetch(`${base}/api/v1/trades/${id}/exits`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ exitType: "partial", exitPrice: "1.1050", volume: "0.5", exitedAt: "2026-09-10 11:00:00" }),
    });
    const exitId = ((await created.json()) as Envelope<{ id: string }>).data.id;
    assert.equal((await getTrade(base, ownerToken, id)).profitLoss, "246.75");

    const del = await fetch(`${base}/api/v1/trades/exits/${exitId}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(del.status, 200); // exit cancellation keeps its existing 200 contract
    assert.equal((await getTrade(base, ownerToken, id)).profitLoss, "0");
  });
});

test("3B-2 HTTP: envelope shape preserved on the changed routes", async () => {
  await withServer(async (base, { ownerToken }) => {
    const id = await createTrade(base, ownerToken);
    const conflict = await fetch(`${base}/api/v1/trades/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ownerToken}`, "If-Match": '"999"' },
    });
    const env = (await conflict.json()) as Envelope<null>;
    assert.equal(env.status, "error");
    assert.equal(env.data, null);
    assert.ok(typeof env.error?.code === "string");
    assert.ok(!Number.isNaN(Date.parse(env.timestamp)));
  });
});
