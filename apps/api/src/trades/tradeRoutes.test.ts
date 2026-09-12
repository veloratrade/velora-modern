// Trades HTTP contract tests — Phase C increment 3. Kernel-level evidence over
// real HTTP with the real services on in-memory stores: the auth boundary,
// fail-closed 503, the owner journey (create → read → search → symbols →
// journaling correction → exits → cancellation → tombstone), the 403/409
// ADR-002 semantics, validation envelopes, and cross-user non-disclosure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listen } from "../kernel/server.js";
import { AuthService } from "../auth/authService.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { VeloraHasher } from "../auth/hashing.js";
import { JwtService } from "../auth/jwt.js";
import { AccountService } from "../accounts/accountService.js";
import { MemoryAccountStore } from "../accounts/memoryAccountStore.js";
import { TradeService } from "./tradeService.js";
import { MemoryTradeStore } from "./memoryTradeStore.js";

const SECRET = "trades-routes-test-secret-0123456789abcdef"; // 40 chars, test-only

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
  strategyTag: "Breakout", emotionalScore: 4, notes: "Clean H1 breakout trade",
};

async function withServer(
  fn: (base: string, ctx: { ownerToken: string; otherToken: string }) => Promise<void>,
): Promise<void> {
  const tokens: string[] = [];
  const userStore = new MemoryUserStore();
  const accountStore = new MemoryAccountStore();
  const auth = new AuthService({
    store: userStore,
    hasher: new VeloraHasher(),
    jwt: JwtService.create(SECRET),
    generateVerificationToken: () => {
      const t = `trades-test-verification-token-${Math.random().toString(36).slice(2)}-0123456789`;
      tokens.push(t);
      return t;
    },
  });
  const accounts = new AccountService({
    store: accountStore,
    getPlan: async (userId) => (await userStore.findUserById(userId))?.plan ?? "free",
  });
  const trades = new TradeService({
    store: new MemoryTradeStore(),
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
    await fn(base, { ownerToken, otherToken });
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

test("TRADES HTTP: unauthenticated → 401 on every trades route", async () => {
  await withServer(async (base) => {
    for (const [method, path, body] of [
      ["GET", "/api/v1/trades", undefined],
      ["POST", "/api/v1/trades", {}],
      ["GET", "/api/v1/trades/symbols", undefined],
      ["GET", "/api/v1/trades/1", undefined],
      ["PUT", "/api/v1/trades/1", {}],
      ["DELETE", "/api/v1/trades/1", undefined],
      ["GET", "/api/v1/trades/1/exits", undefined],
      ["POST", "/api/v1/trades/1/exits", {}],
      ["DELETE", "/api/v1/trades/exits/1", undefined],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(((await res.json()) as Envelope<null>).error?.code, "UNAUTHENTICATED");
    }
  });
});

test("TRADES HTTP: fail closed (503) when the capability is unconfigured", async () => {
  const app = createApp({
    allowedOrigins: ["https://veloratrade.ir"],
    checks: { database: async () => "ok" as const },
    auth: new AuthService({ store: new MemoryUserStore(), hasher: new VeloraHasher(), jwt: JwtService.create(SECRET) }),
    // trades deliberately NOT configured
  });
  const port = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/trades`);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as Envelope<null>).error?.code, "SERVICE_UNAVAILABLE");
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
});

test("TRADES HTTP: owner journey — create (vector A), read, search, symbols", async () => {
  await withServer(async (base, { ownerToken }) => {
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` };
    const create = await fetch(`${base}/api/v1/trades`, { method: "POST", headers: auth, body: JSON.stringify(VECTOR_A) });
    assert.equal(create.status, 201);
    const body = (await create.json()) as Envelope<Record<string, unknown>>;
    assert.equal(body.status, "success");
    assert.equal(body.error, null);
    const t = body.data;
    assert.equal(t.entryPrice, "1.1"); // trimZeros
    assert.equal(t.profitLoss, "493.5"); // Local engine, golden vector A
    assert.equal(t.rMultiple, "1.645");
    assert.equal(t.version, 0);
    assert.equal(t.session, "unconfigured");
    assert.equal(t.source, "manual");
    assert.equal(t.openTime, "2026-09-10T10:00:00.000Z"); // profile TZ UTC (default)
    assert.equal(t.timeStatus, "resolved");
    const id = t.id as string;

    const get = await fetch(`${base}/api/v1/trades/${id}`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(get.status, 200);
    assert.equal(((await get.json()) as Envelope<{ id: string }>).data.id, id);

    const search = await fetch(`${base}/api/v1/trades?symbol=eur&direction=buy&limit=10`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(search.status, 200);
    const sb = ((await search.json()) as Envelope<{ items: unknown[]; pagination: Record<string, number> }>).data;
    assert.equal(sb.items.length, 1);
    assert.deepEqual(sb.pagination, { page: 1, limit: 10, total: 1, totalPages: 1 });

    const symbols = await fetch(`${base}/api/v1/trades/symbols`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(symbols.status, 200);
    assert.deepEqual(((await symbols.json()) as Envelope<{ symbols: string[] }>).data.symbols, ["EURUSD"]);
  });
});

test("TRADES HTTP: corrections — journaling 200, financial 403, stale version 409, empty PUT no-op", async () => {
  await withServer(async (base, { ownerToken }) => {
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` };
    const id = await createTrade(base, ownerToken);

    const put = await fetch(`${base}/api/v1/trades/${id}`, { method: "PUT", headers: auth, body: JSON.stringify({ notes: "reviewed" }) });
    assert.equal(put.status, 200);
    const updated = ((await put.json()) as Envelope<{ notes: string; version: number; profitLoss: string }>).data;
    assert.equal(updated.notes, "reviewed");
    assert.equal(updated.version, 1);
    assert.equal(updated.profitLoss, "493.5"); // financials untouched

    const fin = await fetch(`${base}/api/v1/trades/${id}`, { method: "PUT", headers: auth, body: JSON.stringify({ entryPrice: "1.2" }) });
    assert.equal(fin.status, 403);
    const finBody = (await fin.json()) as Envelope<null>;
    assert.equal(finBody.error?.code, "FORBIDDEN");
    assert.equal(finBody.error?.details?.messageKey, "errors.trades.financialImmutable");

    const stale = await fetch(`${base}/api/v1/trades/${id}`, { method: "PUT", headers: auth, body: JSON.stringify({ notes: "stale", version: 0 }) });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as Envelope<null>).error?.code, "CONFLICT");

    const noop = await fetch(`${base}/api/v1/trades/${id}`, { method: "PUT", headers: auth, body: JSON.stringify({}) });
    assert.equal(noop.status, 200);
    assert.equal(((await noop.json()) as Envelope<{ version: number }>).data.version, 1);
  });
});

test("TRADES HTTP: exits — create 201, list, cumulative cap 422, cancellation, ghost 404", async () => {
  await withServer(async (base, { ownerToken }) => {
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` };
    const id = await createTrade(base, ownerToken, { ...VECTOR_A, commission: "10.00", swap: "0", stopLoss: undefined });

    const e1 = await fetch(`${base}/api/v1/trades/${id}/exits`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ exitType: "tp", exitPrice: "1.1030", volume: "0.5", exitedAt: "2026-09-10 11:00:00", notes: "TP1" }),
    });
    assert.equal(e1.status, 201);
    const created = ((await e1.json()) as Envelope<{ id: string; messageKey: string }>).data;
    assert.equal(created.messageKey, "trades.exitCreated");

    const cap = await fetch(`${base}/api/v1/trades/${id}/exits`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ exitType: "tp", exitPrice: "1.1040", volume: "0.6", exitedAt: "2026-09-10 11:30:00" }),
    });
    assert.equal(cap.status, 422);
    const capBody = (await cap.json()) as Envelope<null>;
    assert.equal(capBody.error?.code, "VALIDATION_FAILED");
    assert.equal(capBody.error?.details?.volume, "EXIT_VOLUME_EXCEEDED");

    const list = await fetch(`${base}/api/v1/trades/${id}/exits`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(list.status, 200);
    const items = ((await list.json()) as Envelope<{ items: Array<Record<string, unknown>> }>).data.items;
    assert.equal(items.length, 1);
    assert.equal(items[0]!.pnl, "145"); // 150.00 gross − 5.00 allocated commission
    assert.equal(items[0]!.exitPrice, "1.103");

    const del = await fetch(`${base}/api/v1/trades/exits/${created.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(del.status, 200);
    assert.deepEqual(((await del.json()) as Envelope<{ deleted: boolean }>).data, { deleted: true });

    const ghost = await fetch(`${base}/api/v1/trades/exits/${created.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(ghost.status, 404);
    assert.equal(((await ghost.json()) as Envelope<null>).error?.message, "Trade exit not found.");

    const reRecord = await fetch(`${base}/api/v1/trades/${id}/exits`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ exitType: "manual", exitPrice: "1.1050", volume: "0.6", exitedAt: "2026-09-10 11:45:00" }),
    });
    assert.equal(reRecord.status, 201); // freed allocation is reusable
  });
});

test("TRADES HTTP: tombstone — delete {deleted:true}, then 404 everywhere, excluded from search/symbols", async () => {
  await withServer(async (base, { ownerToken }) => {
    const id = await createTrade(base, ownerToken);
    const del = await fetch(`${base}/api/v1/trades/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(del.status, 200);
    assert.deepEqual(((await del.json()) as Envelope<{ deleted: boolean }>).data, { deleted: true });

    const get = await fetch(`${base}/api/v1/trades/${id}`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(get.status, 404);
    assert.equal(((await get.json()) as Envelope<null>).error?.message, "Trade not found.");
    const again = await fetch(`${base}/api/v1/trades/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(again.status, 404);

    const search = await fetch(`${base}/api/v1/trades`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(((await search.json()) as Envelope<{ items: unknown[] }>).data.items.length, 0);
    const symbols = await fetch(`${base}/api/v1/trades/symbols`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.deepEqual(((await symbols.json()) as Envelope<{ symbols: string[] }>).data.symbols, []);
  });
});

test("TRADES HTTP: cross-user access — identical non-disclosing 404s (missing ≡ foreign)", async () => {
  await withServer(async (base, { ownerToken, otherToken }) => {
    const otherAuth = { "Content-Type": "application/json", Authorization: `Bearer ${otherToken}` };
    const id = await createTrade(base, ownerToken);
    const exit = await fetch(`${base}/api/v1/trades/${id}/exits`, {
      method: "POST", headers: otherAuth,
      body: JSON.stringify({ exitType: "tp", exitPrice: "1.1030", volume: "0.5", exitedAt: "2026-09-10 11:00:00" }),
    });
    assert.equal(exit.status, 404);

    for (const [method, path, body] of [
      ["GET", `/api/v1/trades/${id}`, undefined],
      ["PUT", `/api/v1/trades/${id}`, { notes: "steal" }],
      ["DELETE", `/api/v1/trades/${id}`, undefined],
      ["GET", `/api/v1/trades/${id}/exits`, undefined],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method, headers: { Authorization: `Bearer ${otherToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(res.status, 404, `${method} ${path}`);
      const e = ((await res.json()) as Envelope<null>).error;
      assert.equal(e?.code, "NOT_FOUND");
      assert.equal(e?.message, "Trade not found.");
    }
    // a nonexistent id is indistinguishable from a foreign one
    const ghost = await fetch(`${base}/api/v1/trades/999999`, { headers: { Authorization: `Bearer ${otherToken}` } });
    assert.equal(ghost.status, 404);
    assert.equal(((await ghost.json()) as Envelope<null>).error?.message, "Trade not found.");
    // owner unaffected
    const search = await fetch(`${base}/api/v1/trades`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(((await search.json()) as Envelope<{ items: unknown[] }>).data.items.length, 1);
  });
});

test("TRADES HTTP: validation envelopes + account ownership on create", async () => {
  await withServer(async (base, { ownerToken, otherToken }) => {
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` };

    const bad = await fetch(`${base}/api/v1/trades`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ ...VECTOR_A, direction: "hold" }),
    });
    assert.equal(bad.status, 400);
    const badBody = (await bad.json()) as Envelope<null>;
    assert.equal(badBody.error?.code, "VALIDATION_FAILED");
    assert.deepEqual(badBody.error?.details, { field: "direction", messageKey: "errors.validation.choice" });

    // other user's account → 400 accountNotOwned (lineages agree; not a 404)
    const otherAccount = await fetch(`${base}/api/v1/accounts`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherToken}` },
      body: JSON.stringify({ provider: "MT4", label: "Other's" }),
    });
    assert.equal(otherAccount.status, 201);
    const otherAccountId = ((await otherAccount.json()) as Envelope<{ account: { id: string } }>).data.account.id;
    const notOwned = await fetch(`${base}/api/v1/trades`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ ...VECTOR_A, accountId: otherAccountId }),
    });
    assert.equal(notOwned.status, 400);
    const notOwnedBody = (await notOwned.json()) as Envelope<null>;
    assert.equal(notOwnedBody.error?.code, "VALIDATION_FAILED");
    assert.equal(notOwnedBody.error?.details?.messageKey, "errors.trades.accountNotOwned");

    // own account → accepted, linked
    const own = await fetch(`${base}/api/v1/accounts`, {
      method: "POST", headers: auth, body: JSON.stringify({ provider: "MT4", label: "Main" }),
    });
    assert.equal(own.status, 201);
    const ownId = ((await own.json()) as Envelope<{ account: { id: string } }>).data.account.id;
    const linked = await fetch(`${base}/api/v1/trades`, {
      method: "POST", headers: auth, body: JSON.stringify({ ...VECTOR_A, accountId: ownId }),
    });
    assert.equal(linked.status, 201);
    assert.equal(((await linked.json()) as Envelope<{ accountId: string }>).data.accountId, ownId);
  });
});
