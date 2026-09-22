// Developer-key AUTHENTICATION over real HTTP — v3.0 (R-5/R-11).
//
// The pass-2 gap was precise: keys could be minted but nothing accepted one.
// This battery drives the ACTUAL kernel with the real key lifecycle, the real
// scope table and the real limiter, so it proves the properties that matter at
// the boundary between a credential and a route:
//
//   1. a key authenticates AS ITS OWNER, and only over that owner's data;
//   2. the scope vocabulary decides which method on which route is reachable;
//   3. everything outside 0021's vocabulary is refused (admin, billing,
//      attachments, key management, …);
//   4. revocation is immediate, and a revoked key is never re-read as a session;
//   5. the per-key requests/minute limit is enforced, not merely stored;
//   6. the ordinary session path is untouched (regression cover for the kernel
//      change that introduced the guard).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listen, type ApiConfig } from "../kernel/server.js";
import { AuthService } from "../auth/authService.js";
import { JwtService } from "../auth/jwt.js";
import { VeloraHasher } from "../auth/hashing.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { LogMailProvider } from "../mail/logMailProvider.js";
import { AccountService } from "../accounts/accountService.js";
import { MemoryAccountStore } from "../accounts/memoryAccountStore.js";
import { TradeService } from "../trades/tradeService.js";
import { MemoryTradeStore } from "../trades/memoryTradeStore.js";
import { MemoryAnalyticsStore } from "../analytics/analyticsStore.js";
import { MemoryDeveloperStore, generateApiKey } from "./developerRoutes.js";
import { DeveloperKeyAuth, MemoryDeveloperKeyLookup, hashDeveloperKey } from "./developerAuth.js";
import { MemoryRateLimitStore } from "../ratelimits/memoryRateLimitStore.js";

const SECRET = "developer-key-http-test-secret-0123456789";

interface Envelope<T = Record<string, unknown>> {
  status: string;
  data: T;
  error: { code: string; message: string; details?: Record<string, unknown> } | null;
  timestamp: string;
}

interface Harness {
  base: string;
  keys: MemoryDeveloperKeyLookup;
  /** The in-memory identity/account stores, for fixtures that predate a request. */
  userStore: MemoryUserStore;
  accountStore: MemoryAccountStore;
}

async function withServer(fn: (h: Harness) => Promise<void>): Promise<void> {
  const userStore = new MemoryUserStore();
  const accountStore = new MemoryAccountStore();
  const tradeStore = new MemoryTradeStore();
  const lookup = new MemoryDeveloperKeyLookup();
  const auth = new AuthService({
    store: userStore,
    hasher: new VeloraHasher(),
    jwt: JwtService.create(SECRET),
    mail: new LogMailProvider(),
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
  const developerStore = new MemoryDeveloperStore();
  const config: ApiConfig = {
    allowedOrigins: ["https://veloratrade.ir"],
    checks: { database: async () => "ok" as const },
    auth,
    accounts,
    trades,
    analytics: new MemoryAnalyticsStore([]),
    developer: developerStore,
    developerKeys: new DeveloperKeyAuth({ lookup, limiter: new MemoryRateLimitStore() }),
  };
  const app = createApp(config);
  const port = await listen(app);
  try {
    await fn({ base: `http://127.0.0.1:${port}`, keys: lookup, userStore, accountStore });
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

/** Headers to SPREAD into an explicit headers object. */
function AUTH(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
/** A complete RequestInit for a bare authenticated request.
 *
 * This distinction is not cosmetic: `fetch(url, { Authorization: "…" })` is a
 * RequestInit with an UNKNOWN property, so the header is silently dropped and
 * the request is unauthenticated. Every authenticated call site in this file
 * therefore either passes H(...) as the init or spreads AUTH(...) into headers.
 */
function H(token: string): RequestInit {
  return { headers: AUTH(token) };
}

async function json<T = Record<string, unknown>>(res: Response): Promise<Envelope<T>> {
  return (await res.json()) as Envelope<T>;
}

/** Mint a key through the real route, then wire it into the lookup. */
async function mintKey(
  base: string,
  sessionToken: string,
  input: { name: string; scopes: string[]; rateLimitPerMin: number },
  lookup: MemoryDeveloperKeyLookup,
  userId: string,
): Promise<string> {
  const res = await fetch(`${base}/api/v1/developer/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH(sessionToken) },
    body: JSON.stringify({ name: input.name, scopes: input.scopes, rate_limit_per_min: input.rateLimitPerMin }),
  });
  assert.equal(res.status, 201);
  const body = await json<{ id: string; secret: string }>(res);
  // The route stores the hash; the memory port must mirror that exactly (the
  // real port is PgDeveloperKeyLookup, proven in db/tests/developerApiKeys.pg.test.ts).
  lookup.add(hashDeveloperKey(body.data.secret), {
    keyId: body.data.id,
    userId,
    scopes: input.scopes,
    rateLimitPerMin: input.rateLimitPerMin,
  });
  return body.data.secret;
}

test("a developer key authenticates as its owner and is scoped to its surfaces", async () => {
  await withServer(async ({ base, keys }) => {
    const session = JwtService.create(SECRET).sign({ sub: "1", role: "user" }, 900);
    const secret = await mintKey(
      base,
      session,
      { name: "reader", scopes: ["trades:read", "analytics:read", "accounts:read"], rateLimitPerMin: 100 },
      keys,
      "1",
    );

    // Read surface: allowed by scope.
    assert.equal((await fetch(`${base}/api/v1/trades`, H(secret))).status, 200, "trades:read reaches GET /trades");
    const analytics = await fetch(`${base}/api/v1/analytics/summary`, H(secret));
    assert.equal(analytics.status, 200, "analytics:read reaches the analytics surface");
    const accounts = await fetch(`${base}/api/v1/accounts`, H(secret));
    assert.equal(accounts.status, 200, "accounts:read reaches GET /accounts");

    // Write surface: NOT granted to this key.
    const write = await fetch(`${base}/api/v1/trades`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH(secret) },
      body: JSON.stringify({ symbol: "EURUSD", direction: "buy", entryPrice: "1.1", exitPrice: "1.2", volume: "1", openTime: "2026-09-10 10:00:00", closeTime: "2026-09-10 11:00:00" }),
    });
    assert.equal(write.status, 403);
    assert.deepEqual((await json(write)).error?.details, { required_scope: "trades:write" });
  });
});

test("everything outside the frozen scope vocabulary is refused", async () => {
  await withServer(async ({ base, keys }) => {
    const session = JwtService.create(SECRET).sign({ sub: "1", role: "user" }, 900);
    const secret = await mintKey(
      base,
      session,
      { name: "everything", scopes: ["trades:read", "trades:write", "analytics:read", "accounts:read"], rateLimitPerMin: 1000 },
      keys,
      "1",
    );

    for (const [method, path] of [
      ["GET", "/api/v1/developer/keys"], // key management is session-only
      ["GET", "/api/v1/billing/subscription"],
      ["POST", "/api/v1/accounts"], // no accounts:write exists in the vocabulary
      ["GET", "/api/v1/admin/rbac/self"], // never reachable with a programmatic key
      ["GET", "/api/v1/auth/me"],
      ["GET", "/api/v1/trades/1/attachments"], // a different capability, no scope
    ] as const) {
      const res = await fetch(`${base}${path}`, { method, ...H(secret) });
      const body = await json(res);
      // 401 would mean the key never authenticated (a header that did not
      // arrive), 403 with FORBIDDEN is the guard refusing the surface.
      assert.equal(body.error?.code, "FORBIDDEN", `${method} ${path} → ${res.status} ${JSON.stringify(body.error)}`);
      assert.equal(res.status, 403, `${method} ${path} must be refused`);
    }
  });
});

test("a revoked key is 401 immediately and is never re-read as a session", async () => {
  await withServer(async ({ base, keys }) => {
    const session = JwtService.create(SECRET).sign({ sub: "1", role: "user" }, 900);
    const secret = await mintKey(base, session, { name: "revocable", scopes: ["trades:read"], rateLimitPerMin: 100 }, keys, "1");
    assert.equal((await fetch(`${base}/api/v1/trades`, H(secret))).status, 200);

    keys.remove(hashDeveloperKey(secret)); // what revocation does to the lookup

    const after = await fetch(`${base}/api/v1/trades`, H(secret));
    assert.equal(after.status, 401);
    assert.equal((await json(after)).error?.code, "UNAUTHENTICATED");
  });
});

test("the per-key requests/minute limit is enforced with a Retry-After", async () => {
  await withServer(async ({ base, keys }) => {
    const session = JwtService.create(SECRET).sign({ sub: "1", role: "user" }, 900);
    const secret = await mintKey(base, session, { name: "tiny", scopes: ["trades:read"], rateLimitPerMin: 2 }, keys, "1");

    assert.equal((await fetch(`${base}/api/v1/trades`, H(secret))).status, 200);
    assert.equal((await fetch(`${base}/api/v1/trades`, H(secret))).status, 200);
    const third = await fetch(`${base}/api/v1/trades`, H(secret));
    assert.equal(third.status, 429);
    assert.equal((await json(third)).error?.code, "TOO_MANY_REQUESTS");
    assert.ok(Number(third.headers.get("retry-after")) >= 1, "Retry-After is a positive number of seconds");

    // The bucket is PER KEY: a second key is unaffected by the first one's burn.
    const other = await mintKey(base, session, { name: "other", scopes: ["trades:read"], rateLimitPerMin: 2 }, keys, "1");
    assert.equal((await fetch(`${base}/api/v1/trades`, H(other))).status, 200);
  });
});

test("a key is not a session: a malformed or unknown key-shaped bearer is 401, and session tokens still work", async () => {
  await withServer(async ({ base }) => {
    // Shape-matched, never issued: 401 rather than a fallback.
    const unknown = "deadbeef_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const res = await fetch(`${base}/api/v1/trades`, H(unknown));
    assert.equal(res.status, 401);

    // A session token is unaffected by the guard (it is not key-shaped).
    const session = JwtService.create(SECRET).sign({ sub: "1", role: "user" }, 900);
    assert.equal((await fetch(`${base}/api/v1/trades`, H(session))).status, 200);

    // No bearer at all: unchanged 401 from the kernel.
    assert.equal((await fetch(`${base}/api/v1/trades`)).status, 401);
  });
});

test("the minted prefix is a non-secret display value and the secret is shown once", async () => {
  await withServer(async ({ base }) => {
    const session = JwtService.create(SECRET).sign({ sub: "1", role: "user" }, 900);
    const created = await fetch(`${base}/api/v1/developer/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH(session) },
      body: JSON.stringify({ name: "shown-once", scopes: ["trades:read"] }),
    });
    const body = await json<{ secret: string; keyPrefix: string; secret_shown_once: boolean }>(created);
    assert.equal(body.data.secret_shown_once, true);
    assert.ok(body.data.secret.startsWith(body.data.keyPrefix));
    // The list path never returns the secret or its hash.
    const listed = await fetch(`${base}/api/v1/developer/keys`, H(session));
    const text = JSON.stringify(await json(listed));
    assert.ok(!text.includes(body.data.secret));
    assert.ok(!text.includes(hashDeveloperKey(body.data.secret)));
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation: a key is the owner's user id, and NOTHING more.
// ---------------------------------------------------------------------------

interface Fixture {
  userId: string;
  session: string;
  accountId: string;
}

/** Seed a user + one MANUAL account and return a session for that user. */
async function seedUser(
  store: { userStore: MemoryUserStore; accountStore: MemoryAccountStore },
  email: string,
): Promise<Fixture> {
  const user = await store.userStore.createUser({
    email,
    passwordHash: "not-used-by-this-battery",
    fullName: email.split("@")[0] as string,
    timezone: "UTC",
    locale: "en",
    now: new Date(),
  });
  const account = await store.accountStore.create(
    user.id,
    {
      provider: "MANUAL",
      platform: "manual",
      label: "seeded",
      accountNumber: `seed-${user.id}`,
      currency: "USD",
      leverage: "100",
      timezone: null,
      timezoneSource: "unknown",
      status: "connected",
    },
    new Date(),
  );
  return { userId: user.id, session: JwtService.create(SECRET).sign({ sub: user.id, role: "user" }, 900), accountId: account.id };
}

const TRADE_BODY = {
  symbol: "EURUSD",
  direction: "buy",
  entryPrice: "1.1000",
  exitPrice: "1.1050",
  volume: "1.0",
  contractSize: "100000",
  commission: "5.00",
  swap: "1.50",
  stopLoss: "1.0970",
  openTime: "2026-09-10 10:00:00",
  closeTime: "2026-09-10 12:00:00",
};

async function createTrade(base: string, session: string, accountId: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/trades`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH(session) },
    body: JSON.stringify({ ...TRADE_BODY, accountId }),
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  return (JSON.parse(text) as { data: { id: string } }).data.id;
}

test("a key sees only its owner's rows, and writes land on the owner", async () => {
  await withServer(async ({ base, keys, userStore, accountStore }) => {
    const a = await seedUser({ userStore, accountStore }, "key-a@velora.example");
    const b = await seedUser({ userStore, accountStore }, "key-b@velora.example");
    const bTrade = await createTrade(base, b.session, b.accountId);

    const secret = await mintKey(
      base,
      a.session,
      { name: "rw", scopes: ["trades:read", "trades:write"], rateLimitPerMin: 100 },
      keys,
      a.userId,
    );

    // Read isolation: A's LIST cannot see B's trade.
    const list = await json<{ items: { id: string }[] }>(await fetch(`${base}/api/v1/trades`, H(secret)));
    assert.deepEqual(list.data.items.map((t) => t.id), [], "another user's ledger is never listed");

    // Read isolation: A cannot fetch B's row by id (non-disclosing 404).
    const peek = await fetch(`${base}/api/v1/trades/${bTrade}`, H(secret));
    assert.equal(peek.status, 404);
    assert.equal((await json(peek)).error?.code, "NOT_FOUND");

    // Write isolation: a DELETE via A's key cannot tombstone B's row.
    const del = await fetch(`${base}/api/v1/trades/${bTrade}`, { method: "DELETE", ...H(secret) });
    assert.equal(del.status, 404);
    assert.equal((await fetch(`${base}/api/v1/trades/${bTrade}`, H(b.session))).status, 200, "B's trade is untouched");

    // Writes through the key are the OWNER's writes: they appear for A, not B.
    const aTrade = await createTrade(base, secret, a.accountId);
    assert.equal((await fetch(`${base}/api/v1/trades/${aTrade}`, H(a.session))).status, 200);
    assert.equal((await fetch(`${base}/api/v1/trades/${aTrade}`, H(b.session))).status, 404);
  });
});

test("the scope check precedes body parsing (a read-only key never gets a validation error)", async () => {
  await withServer(async ({ base, keys, userStore, accountStore }) => {
    const a = await seedUser({ userStore, accountStore }, "key-scope@velora.example");
    const ro = await mintKey(base, a.session, { name: "ro", scopes: ["trades:read"], rateLimitPerMin: 100 }, keys, a.userId);

    // Malformed JSON would normally be 400 VALIDATION_FAILED — authorization
    // must decide first, so a read-only key is refused without any body work.
    const res = await fetch(`${base}/api/v1/trades`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH(ro) },
      body: "{ this is not json",
    });
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error?.code, "FORBIDDEN");
  });
});

test("concurrent requests against a per-key limit admit exactly the allowance", async () => {
  await withServer(async ({ base, keys, userStore, accountStore }) => {
    const a = await seedUser({ userStore, accountStore }, "key-race@velora.example");
    const secret = await mintKey(base, a.session, { name: "one", scopes: ["trades:read"], rateLimitPerMin: 1 }, keys, a.userId);

    // Eight simultaneous requests, a limit of one per minute: the limiter must
    // serialize the window increment, so exactly one succeeds.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => fetch(`${base}/api/v1/trades`, H(secret)).then((r) => r.status)),
    );
    const ok = results.filter((s) => s === 200).length;
    const limited = results.filter((s) => s === 429).length;
    assert.equal(ok, 1, `statuses: ${results.join(",")}`);
    assert.equal(limited, 7, `statuses: ${results.join(",")}`);
  });
});

test("generateApiKey mints keys that satisfy the documented shape", () => {
  for (let i = 0; i < 5; i += 1) {
    const { secret, prefix, hash } = generateApiKey();
    assert.match(secret, /^[0-9a-f]{8}_[A-Za-z0-9_-]{32}$/);
    assert.equal(secret.slice(0, 8), prefix);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash, hashDeveloperKey(secret));
  }
});
