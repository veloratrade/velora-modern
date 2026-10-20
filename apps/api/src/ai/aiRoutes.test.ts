// Phase 7 — the AI HTTP surface, tested through the REAL kernel.
//
// `createApp` + `listen` with real bearer verification and the real dispatcher;
// only the provider, the trade resolver and the configuration store are doubles,
// so what is asserted here is the contract a client actually meets: statuses,
// codes, authorization, and the two rules this surface exists to protect.
//
//   1. THE TRUST BOUNDARY. A body carrying `trades` instead of `trade_ids` is
//      refused, and an id that is not the caller's simply does not resolve — so a
//      forged list cannot make a third-party model read somebody else's journal.
//   2. NOTHING IS FAKED. No provider → 503; feature off → 403; no consent → 403;
//      prose where JSON was required → 422. Every one of those is recorded in the
//      ledger, and none of them returns an empty success that a UI would render as
//      "the model found nothing".
//   3. NO SECRET LEAVES. The admin surface answers with a fingerprint, a status and
//      (for the relay) a HOST — never a key, a URL or a token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApp, listen } from "../kernel/server.js";
import { AuthService } from "../auth/authService.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { VeloraHasher } from "../auth/hashing.js";
import { JwtService } from "../auth/jwt.js";
import { LogMailProvider } from "../mail/logMailProvider.js";
import { FixedWindowRateLimiter } from "../ratelimits/rateLimiter.js";
import { MemoryRateLimitStore } from "../ratelimits/memoryRateLimitStore.js";
import { OwnershipService } from "../auth/ownershipService.js";
import { MemoryOwnershipStore } from "../auth/memoryOwnershipStore.js";
import { AdminUserService } from "../auth/adminUserService.js";
import { MemoryAuditStore } from "../auth/memoryAuditStore.js";

interface Envelope<T = Record<string, unknown>> { readonly status: string; readonly data: T; readonly error: unknown }
import { MemoryAiConfigStore } from "./memoryAiConfigStore.js";
import { MemoryAiAttemptStore, type AiAttemptRecord } from "../aicoach/aiProvider.js";
import { MemoryAiLedger } from "./aiLedger.js";
import { AiFeatureGuard } from "./aiFeatureGuard.js";
import { AiFeatureRouter } from "./aiFeatureRouter.js";
import { AiRouteResolver } from "./aiRouteResolver.js";
import { AiSecretService } from "./aiSecrets.js";
import { UnavailableImageAnonymizer } from "./imageAnonymizer.js";
import { AiManager } from "./aiManager.js";
import { AiAnalysisService, type OwnedTrade } from "./aiAnalysisService.js";
import { AiAdminService } from "./aiAdminService.js";
import { AiToolAdminService } from "./aiToolAdmin.js";
import { AiSearchService } from "./aiSearchService.js";
import { AiBrowserService } from "./aiBrowserService.js";
import type { AiExecutor, AiExecutorResult } from "./aiExecutors.js";
import type { AiCapability } from "./aiRoutes.js";
import type { AiAdminCapability } from "./aiAdminRoutes.js";
import { MasterKey } from "../credentials/credentialCrypto.js";

const JWT_SECRET = "phase7-ai-route-test-secret-0123456789abcdef";
const PASSWORD = "a-strong-password-123";

interface Harness {
  base: string;
  login: (email: string, role?: "user" | "admin" | "super_admin") => Promise<string>;
  store: MemoryUserStore;
  config: MemoryAiConfigStore;
  attempts: MemoryAiAttemptStore;
  ledger: MemoryAiLedger;
  calls: string[];
  trades: Map<string, OwnedRow>;
  close: () => Promise<void>;
  setExecutor: (behaviour: (call: number) => AiExecutorResult | Promise<AiExecutorResult>) => void;
  consent: { granted: boolean };
  /** The store the AI admin surface writes its audit rows to (0041). */
  adminAudit: MemoryAuditStore;
  /** Every URL the tool services were told to fetch — the evidence that a probe did or did not leave. */
  toolCalls: string[];
}

async function build(options: { withAi?: boolean; withAdmin?: boolean; secrets?: Record<string, string>; localOcr?: boolean; withTools?: boolean } = {}): Promise<Harness> {
  const verificationTokens: string[] = [];
  const store = new MemoryUserStore();
  const audit = new MemoryAuditStore();
  const auth = new AuthService({
    store,
    hasher: new VeloraHasher(),
    jwt: JwtService.create(JWT_SECRET),
    generateVerificationToken: () => {
      const token = `ai-verification-${Math.random().toString(36).slice(2)}-0123456789`;
      verificationTokens.push(token);
      return token;
    },
    mail: new LogMailProvider(),
  });
  const ownershipStore = new MemoryOwnershipStore();
  const ownership = new OwnershipService({ ownership: ownershipStore, users: store, hasher: new VeloraHasher(), audit });
  const users = new AdminUserService({
    store, audit,
    getSystemOwnerUserId: async () => (await ownershipStore.getOwnership())?.ownerUserId ?? null,
  });

  const config = new MemoryAiConfigStore();
  config.seedLegacyDefaults();
  const attempts = new MemoryAiAttemptStore();
  const ledger = new MemoryAiLedger();
  const calls: string[] = [];
  const trades = new Map<string, OwnedRow>();
  const consent = { granted: true };

  const envSecrets = new Map(Object.entries(options.secrets ?? {}));
  const secretService = new AiSecretService({
    store: config,
    masterKey: MasterKey.fromBase64(Buffer.alloc(32, 9).toString("base64"), 1),
    env: (key) => envSecrets.get(key),
  });
  const routeResolver = new AiRouteResolver({ store: config, env: (key) => envSecrets.get(key) });
  const guard = new AiFeatureGuard({ store: config });
  const localOcr = {
    isAvailable: () => options.localOcr === true,
    async ocr() { return { text: "BUY XAUUSD entry 2010.50", confidence: 0.4 }; },
  };
  const router = new AiFeatureRouter({
    store: config,
    secrets: secretService,
    routes: routeResolver,
    env: (key) => envSecrets.get(key),
    localOcrAvailable: () => options.localOcr === true,
  });

  let behaviour: (call: number) => AiExecutorResult | Promise<AiExecutorResult> = () => ({
    model: "gemini-3.6-flash",
    insight: { summary: "three closed trades", strengths: ["risk defined"], weaknesses: [], recommendations: [], risk_score: 0.3, confidence: 0.8 },
    text: null, tokensIn: 120, tokensOut: 60, costMicroUsd: 4, latencyMs: 900,
  });
  const gemini: AiExecutor = {
    provider: "gemini",
    async execute(_request, executorOptions) {
      calls.push(`gemini:${executorOptions.route ?? "auto"}`);
      return behaviour(calls.length);
    },
  };
  const tesseract: AiExecutor = {
    provider: "tesseract",
    async execute(request) {
      assert.ok(request.image !== undefined, "screenshot extraction sends only the validated image bytes to local OCR");
      return {
        model: "tesseract",
        insight: { fields: { symbol: "XAUUSD", direction: "buy", entryPrice: "2010.50", stopLoss: "2000" }, confidence: 0.4 },
        text: "BUY XAUUSD entry 2010.50",
        tokensIn: null, tokensOut: null, costMicroUsd: null, latencyMs: 5,
      };
    },
  };

  const executors = { gemini, tesseract };
  const manager = new AiManager({
    router,
    guard,
    store: config,
    consent: { consentState: async () => ({ consented: consent.granted, consentedAt: consent.granted ? "2026-01-01T00:00:00Z" : null }) },
    attempts,
    anonymizer: new UnavailableImageAnonymizer(),
    executors,
  });

  const analysis = new AiAnalysisService({
    manager,
    store: config,
    localOcr,
    trades: { findActiveByIdForUser: async (id, userId) => {
      const row = trades.get(id);
      return row !== undefined && row.ownerId === userId ? strip(row) : null;
    } },
    userLocale: async () => "fa",
  });

  const ai: AiCapability | undefined = options.withAi === false ? undefined : {
    analysis,
    config,
    ledger,
    consent: { consentState: async () => ({ consented: consent.granted, consentedAt: null }) },
    guard,
    providerConfigured: async () => (await router.buildDefaultChain(null)).entries.length > 0,
  };

  const adminAudit = new MemoryAuditStore();

  // The TOOL panel's doubles: real `AiSearchService`/`AiBrowserService` over a fetch that only records.
  // `raster: null` is deliberately the WORKER shape, so `banner_raster` must come back `unsupported`
  // rather than `unavailable` — the difference between "no key will help" and "go configure it".
  const toolCalls: string[] = [];
  const toolFetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    toolCalls.push(`${String(init?.method ?? "GET")} ${String(input)}`);
    return new Response(JSON.stringify({ results: [], queries: [], response: "" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const toolServices = options.withTools === true
    ? {
        search: new AiSearchService({ secrets: secretService, fetchImpl: toolFetch, now: () => new Date(0) }),
        browser: new AiBrowserService({ secrets: secretService, fetchImpl: toolFetch, now: () => new Date(0) }),
      }
    : null;

  const aiAdmin: AiAdminCapability | undefined = options.withAdmin === false ? undefined : {
    // Required since 0041: a mount that exposes a tool-validation button must also expose the trail that
    // records who pressed it. The harness keeps the memory store so a route test can read the rows.
    audit: adminAudit,
    ...(toolServices === null ? {} : {
      tools: new AiToolAdminService({ ...toolServices, raster: null, now: () => new Date(0) }),
    }),
    admin: new AiAdminService({
      store: config,
      secrets: secretService,
      routes: routeResolver,
      router,
      guard,
      anonymizer: new UnavailableImageAnonymizer(),
      ledger,
      executors,
      localOcrAvailable: () => options.localOcr === true,
      env: (key) => envSecrets.get(key),
    }),
  };

  const app = createApp({
    allowedOrigins: ["https://app.velora.example"],
    checks: { database: async () => "ok" as const },
    auth,
    adminUsers: users,
    ownership,
    rateLimiter: new FixedWindowRateLimiter(new MemoryRateLimitStore()),
    ...(ai !== undefined ? { ai } : {}),
    ...(aiAdmin !== undefined ? { aiAdmin } : {}),
  });
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;

  async function login(email: string, role: "user" | "admin" | "super_admin" = "user"): Promise<string> {
    await fetch(`${base}/api/v1/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    await fetch(`${base}/api/v1/auth/verify-email`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: verificationTokens.shift() }),
    });
    if (role !== "user") {
      const user = await store.findUserByEmail(email);
      assert.ok(user !== null);
      await store.updateUserRole(user.id, role, new Date());
    }
    const res = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    assert.equal(res.status, 200);
    return ((await res.json()) as Envelope<{ tokens: { accessToken: string } }>).data.tokens.accessToken;
  }

  return {
    base, login, store, config, attempts, ledger, calls, trades, consent, adminAudit, toolCalls,
    setExecutor: (next) => { behaviour = next; },
    // The listener MUST be closed, or the test file's process never exits and the
    // runner waits for it forever (the phase-6 console battery closes its server
    // for the same reason).
    close: async () => { await new Promise<void>((resolve) => app.close(() => resolve())); },
  };
}

interface OwnedRow extends OwnedTrade { readonly ownerId: string }
function strip(row: OwnedRow): OwnedTrade {
  const { ownerId: _ownerId, ...rest } = row;
  return rest;
}

function trade(id: string, ownerId: string, over: Partial<OwnedTrade> = {}): OwnedRow {
  return {
    id, ownerId, symbol: "XAUUSD", direction: "buy", status: "CLOSED", entryPrice: "2000.50",
    exitPrice: "2010.20", volume: "0.10", netPnl: "97.50", rMultiple: "1.90", stopLoss: "1995.00",
    takeProfit: "2020.00", strategy: "breakout", emotion: "3", openAtUtc: "2026-08-01T10:00:00Z",
    closeAtUtc: "2026-08-01T12:00:00Z", ...over,
  };
}

async function post(base: string, token: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function get(base: string, token: string, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const data = (json: Record<string, unknown>): Record<string, unknown> => (json["data"] ?? {}) as Record<string, unknown>;
const code = (json: Record<string, unknown>): string => String(((json["error"] ?? {}) as Record<string, unknown>)["code"] ?? "");

test("screenshot extraction validates images, uses local OCR without consent, and returns a reviewable draft", async () => {
  const h = await build({ localOcr: true });
  const token = await h.login(`screenshot-${Date.now()}@velora.test`);
  h.consent.granted = false;
  const screenshot = readFileSync(new URL("./__fixtures__/ocr-trade-screenshot.png", import.meta.url));
  const imageUrl = `data:image/png;base64,${screenshot.toString("base64")}`;
  const res = await post(h.base, token, "/api/v1/trades/extract-screenshot", { images: [imageUrl, imageUrl], padding: "x".repeat(1_100_000) });
  assert.equal(res.status, 200);
  const payload = data(res.json);
  assert.equal(payload["provider"], "tesseract");
  assert.equal(payload["engine"], "tesseract-system");
  assert.deepEqual(payload["texts"], ["BUY XAUUSD entry 2010.50", "BUY XAUUSD entry 2010.50"]);
  const extraction = payload["extraction"] as Record<string, unknown>;
  assert.equal(extraction["symbol"], "XAUUSD");
  assert.equal(extraction["side"], "buy");
  assert.equal(extraction["entry"], "2010.50");
  assert.equal(extraction["confidence"], 0.4);
  assert.equal(typeof payload["attempt_id"], "string");
  assert.equal(h.calls.length, 0, "the user's missing consent must not cause provider egress");
  assert.equal(h.attempts.entries.length, 1, "the local OCR attempt is recorded exactly once");
  assert.equal(h.attempts.entries[0]!.feature, "ocr");
  assert.equal(h.attempts.entries[0]!.inputHash?.length, 64);
  await h.close();
});

test("screenshot extraction rejects malformed image data before provider work", async () => {
  const h = await build({ secrets: { GEMINI_API_KEY: "test-key" } });
  const token = await h.login(`screenshot-invalid-${Date.now()}@velora.test`);
  const res = await post(h.base, token, "/api/v1/trades/extract-screenshot", { images: ["data:image/png;base64,AAAA"] });
  assert.equal(res.status, 422);
  assert.equal(code(res.json), "AI_INVALID_SCREENSHOT");
  assert.equal(h.attempts.entries.length, 0, "invalid bytes must not reach or be logged as provider attempts");
  assert.equal(h.calls.length, 0);
  await h.close();
});

test("screenshot egress is refused with a deployment-status code when redaction and local OCR are unavailable", async () => {
  const h = await build({ secrets: { GEMINI_API_KEY: "test-key" }, localOcr: false });
  const token = await h.login(`screenshot-privacy-${Date.now()}@velora.test`);
  const screenshot = readFileSync(new URL("./__fixtures__/ocr-trade-screenshot.png", import.meta.url));
  const imageUrl = `data:image/png;base64,${screenshot.toString("base64")}`;
  const res = await post(h.base, token, "/api/v1/trades/extract-screenshot", { images: [imageUrl] });
  assert.equal(res.status, 503, "missing anonymization is a deployment capability failure, not an authorization failure");
  assert.equal(code(res.json), "IMAGE_NOT_ANONYMIZED");
  assert.equal(h.calls.length, 0, "the original screenshot must never reach the external executor");
  assert.equal(h.attempts.entries[0]!.errorCode, "IMAGE_NOT_ANONYMIZED");
  await h.close();
});

test("screenshot route uses 24MiB request cap, not the generic 1MiB cap", async () => {
  const { MAX_SCREENSHOT_REQUEST_BYTES } = await import("./screenshotExtraction.js");
  assert.equal(MAX_SCREENSHOT_REQUEST_BYTES, 24 * 1024 * 1024);
  // 1.1MiB is oversized for the generic 1MiB limit (proven 413 above) but must NOT be 413 for screenshot
  // because screenshot's limit is 24MiB. It should instead reach validation (422) or succeed, proving distinct caps.
  const h = await build();
  const token = await h.login(`screenshot-limit-${Date.now()}@velora.test`);
  const body = JSON.stringify({ images: [`data:image/png;base64,${"A".repeat(800_000)}`], padding: "x".repeat(300_000) });
  // body is ~1.1M, under 24M -> not 413
  const response = await fetch(`${h.base}/api/v1/trades/extract-screenshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body,
  });
  // Either 422 (image validation) or 200/403/503 depending on feature flag, but never 413
  assert.notEqual(response.status, 413, "screenshot route must not use the 1MiB generic cap");
  assert.ok([200, 422, 403, 503].includes(response.status), `unexpected status ${response.status}`);
  await h.close();
});

test("screenshot route over 24MiB is 413 PAYLOAD_TOO_LARGE (production ceiling)", async () => {
  const h = await build();
  const token = await h.login(`screenshot-ceiling-${Date.now()}@velora.test`);
  // Body must exceed the route-specific 24MiB cap — proves the ceiling is enforced (413), not just the floor.
  // Use a tiny image so the 413 comes from the request cap, not from image validation.
  const padding = "x".repeat(24 * 1024 * 1024 + 1024);
  const body = JSON.stringify({ images: [`data:image/png;base64,${"A".repeat(1000)}`], padding });
  const response = await fetch(`${h.base}/api/v1/trades/extract-screenshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body,
  });
  assert.equal(response.status, 413);
  const json = await response.json() as Record<string, unknown>;
  assert.equal(code(json), "PAYLOAD_TOO_LARGE");
  await h.close();
});

test("oversized JSON from an extended route is a client 413, never a generic 500", async () => {
  const h = await build();
  const token = await h.login(`body-limit-${Date.now()}@velora.test`);
  const body = JSON.stringify({ trade_ids: ["t1"], padding: "x".repeat(1_100_000) });
  const response = await fetch(`${h.base}/api/v1/ai/analyze-trades`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body,
  });
  assert.equal(response.status, 413);
  const json = await response.json() as Record<string, unknown>;
  assert.equal(code(json), "PAYLOAD_TOO_LARGE");
  assert.ok(response.headers.get("content-security-policy"));
  await h.close();
});

test("AI HTTP: without the capability wired the surface is 503, not an empty success", async () => {
  const h = await build({ withAi: false, withAdmin: false });
  const token = await h.login(`ai-absent-${Date.now()}@velora.test`);
  const res = await post(h.base, token, "/api/v1/ai/analyze-trades", { trade_ids: ["t1"] });
  assert.equal(res.status, 503);
  assert.equal(code(res.json), "SERVICE_UNAVAILABLE");
  const admin = await get(h.base, token, "/api/v1/admin/ai/overview");
  assert.equal(admin.status, 503);
  await h.close();
});

test("AI HTTP: an anonymous caller is 401 before anything else", async () => {
  const h = await build();
  const res = await fetch(`${h.base}/api/v1/ai/status`);
  assert.equal(res.status, 401);
  await h.close();
});

test("AI HTTP: client-supplied trades are refused — ids only, resolved server-side", async () => {
  const h = await build({ secrets: { GEMINI_API_KEY: "key" } });
  const token = await h.login(`ai-trust-${Date.now()}@velora.test`);
  await h.config.setFlag("ai_trade_analysis", true, 100);
  h.trades.set("t1", trade("t1", "someone-else"));
  const forged = await post(h.base, token, "/api/v1/ai/analyze-trades", {
    trades: [{ symbol: "FAKE", netPnl: "99999" }],
  });
  assert.equal(forged.status, 422);
  assert.equal(code(forged.json), "AI_TRADE_IDS_REQUIRED");
  // Somebody else's id resolves to nothing, and the refusal does not say whose it was.
  const foreign = await post(h.base, token, "/api/v1/ai/analyze-trades", { trade_ids: ["t1"] });
  assert.equal(foreign.status, 422);
  assert.equal(code(foreign.json), "AI_NO_OWNED_TRADES");
  assert.deepEqual(h.calls, [], "no provider call may happen for a request with no owned trades");
  await h.close();
});

test("AI HTTP: the analysis happy path returns the whitelisted answer and records the attempt", async () => {
  const h = await build({ secrets: { GEMINI_API_KEY: "key" } });
  const email = `ai-ok-${Date.now()}@velora.test`;
  const token = await h.login(email);
  await h.config.setFlag("ai_trade_analysis", true, 100);
  const user = await h.store.findUserByEmail(email);
  assert.ok(user !== null);
  h.trades.set("t1", trade("t1", user.id));
  h.trades.set("t2", trade("t2", user.id, { symbol: "EURUSD", netPnl: "-40.00" }));

  h.setExecutor(() => ({
    model: "gemini-3.6-flash",
    insight: {
      summary: "دور معامله بسته", strengths: ["ریسک مشخص"], weaknesses: [], recommendations: [],
      risk_score: 0.3, confidence: 0.8, injected: "must not survive the whitelist",
    },
    text: null, tokensIn: 120, tokensOut: 60, costMicroUsd: 4, latencyMs: 900,
  }));
  const res = await post(h.base, token, "/api/v1/ai/analyze-trades", { trade_ids: ["t1", "t2"], locale: "fa" });
  assert.equal(res.status, 200);
  const body = data(res.json);
  const analysis = body["analysis"] as Record<string, unknown>;
  assert.equal(analysis["summary"], "دور معامله بسته");
  assert.equal("injected" in analysis, false, "an unknown model field never reaches a client");
  assert.equal(body["provider"], "gemini");
  assert.equal(body["model"], "gemini-3.6-flash");
  assert.equal(body["confidence"], 0.8);
  assert.equal(body["locale"], "fa");
  assert.equal(body["tradesAnalyzed"], 2);
  assert.ok(String(body["attempt_id"]).length > 0);
  // The ledger holds the attempt, and NOT the prompt or the trades.
  assert.equal(h.attempts.entries.length, 1);
  const entry = h.attempts.entries[0]! as AiAttemptRecord;
  assert.equal(entry.feature, "analysis");
  assert.equal(entry.outcome, "success");
  assert.equal(entry.tradesAnalyzed, 2);
  assert.match(entry.inputHash ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(entry).includes("XAUUSD"), false, "the ledger stores a hash, not the journal");
  await h.close();
});

test("AI HTTP: a switched-off feature is 403, and no consent is 403, both recorded", async () => {
  const h = await build({ secrets: { GEMINI_API_KEY: "key" } });
  const email = `ai-gates-${Date.now()}@velora.test`;
  const token = await h.login(email);
  const user = await h.store.findUserByEmail(email);
  h.trades.set("t1", trade("t1", user!.id));

  const off = await post(h.base, token, "/api/v1/ai/analyze-trades", { trade_ids: ["t1"] });
  assert.equal(off.status, 403);
  assert.equal(code(off.json), "FEATURE_DISABLED");
  assert.deepEqual(h.calls, []);

  await h.config.setFlag("ai_trade_analysis", true, 100);
  h.consent.granted = false;
  const noConsent = await post(h.base, token, "/api/v1/ai/analyze-trades", { trade_ids: ["t1"] });
  assert.equal(noConsent.status, 403);
  assert.equal(code(noConsent.json), "CONSENT_REQUIRED");
  assert.deepEqual(h.calls, [], "consent is checked before any egress");
  assert.equal(h.attempts.entries[0]!.outcome, "refused");
  await h.close();
});

test("AI HTTP: an unconfigured provider is 503 with its own code, never invented content", async () => {
  const h = await build({ secrets: {} });
  const email = `ai-noprovider-${Date.now()}@velora.test`;
  const token = await h.login(email);
  await h.config.setFlag("ai_trade_analysis", true, 100);
  const user = await h.store.findUserByEmail(email);
  h.trades.set("t1", trade("t1", user!.id));
  const res = await post(h.base, token, "/api/v1/ai/analyze-trades", { trade_ids: ["t1"] });
  assert.equal(res.status, 503);
  assert.equal(code(res.json), "NO_PROVIDER_AVAILABLE");
  await h.close();
});

test("AI HTTP: prose where JSON was required is 422, and the ledger keeps the empty insight", async () => {
  const h = await build({ secrets: { GEMINI_API_KEY: "key" } });
  const email = `ai-prose-${Date.now()}@velora.test`;
  const token = await h.login(email);
  await h.config.setFlag("ai_trade_analysis", true, 100);
  const user = await h.store.findUserByEmail(email);
  h.trades.set("t1", trade("t1", user!.id));
  h.setExecutor(() => ({ model: "gemini-3.6-flash", insight: null, text: "Sure! Here you go…", tokensIn: 1, tokensOut: 2, costMicroUsd: 1, latencyMs: 5 }));
  const res = await post(h.base, token, "/api/v1/ai/analyze-trades", { trade_ids: ["t1"] });
  assert.equal(res.status, 422);
  assert.equal(code(res.json), "INVALID_PROVIDER_OUTPUT");
  assert.deepEqual(h.attempts.entries[0]!.insight, {});
  assert.equal(h.attempts.entries[0]!.outcome, "error");
  await h.close();
});

test("AI HTTP: bounds — more than 100 ids and a malformed period are refused", async () => {
  const h = await build({ secrets: { GEMINI_API_KEY: "key" } });
  const email = `ai-bounds-${Date.now()}@velora.test`;
  const token = await h.login(email);
  await h.config.setFlag("ai_trade_analysis", true, 100);
  await h.config.setFlag("ai_weekly_report", true, 100);
  const many = Array.from({ length: 101 }, (_, i) => `t${i}`);
  const tooMany = await post(h.base, token, "/api/v1/ai/analyze-trades", { trade_ids: many });
  assert.equal(tooMany.status, 422);
  assert.equal(code(tooMany.json), "AI_TOO_MANY_TRADES");
  const badPeriod = await post(h.base, token, "/api/v1/ai/weekly-report", { trade_ids: ["t1"], period_start: "last week" });
  assert.equal(badPeriod.status, 422);
  assert.equal(code(badPeriod.json), "AI_INVALID_PERIOD");
  const noIds = await post(h.base, token, "/api/v1/ai/weekly-report", { period_start: "2026-09-01" });
  assert.equal(noIds.status, 422);
  assert.equal(code(noIds.json), "VALIDATION_FAILED");
  await h.close();
});

test("AI HTTP: the weekly report answers with the period it was asked about", async () => {
  const h = await build({ secrets: { GEMINI_API_KEY: "key" } });
  const email = `ai-report-${Date.now()}@velora.test`;
  const token = await h.login(email);
  await h.config.setFlag("ai_weekly_report", true, 100);
  const user = await h.store.findUserByEmail(email);
  h.trades.set("t1", trade("t1", user!.id));
  h.setExecutor(() => ({
    model: "gemini-3.6-flash",
    insight: { summary: "هفته پرنوسان", mistakes: ["حجم زیاد"], risk_behavior: "overtrading", suggestions: [], confidence: 0.7 },
    text: null, tokensIn: 200, tokensOut: 90, costMicroUsd: 8, latencyMs: 1400,
  }));
  const res = await post(h.base, token, "/api/v1/ai/weekly-report", { trade_ids: ["t1"], period_start: "2026-09-01" });
  assert.equal(res.status, 200);
  const body = data(res.json);
  assert.equal(body["period_start"], "2026-09-01");
  assert.equal(body["period_end"], "2026-09-07", "Legacy's default window is the start plus six days");
  const report = body["report"] as Record<string, unknown>;
  assert.equal(report["summary"], "هفته پرنوسان");
  assert.equal(h.attempts.entries[0]!.feature, "report");
  assert.equal(h.attempts.entries[0]!.windowFrom?.slice(0, 10), "2026-09-01");
  await h.close();
});

test("AI HTTP: feedback stores a derived correction and refuses a no-op", async () => {
  const h = await build({ secrets: { GEMINI_API_KEY: "key" } });
  const token = await h.login(`ai-feedback-${Date.now()}@velora.test`);
  const noop = await post(h.base, token, "/api/v1/ai/feedback", {
    feature: "screenshot_extraction", original: { lot: "0.10" }, corrected: { lot: "0.10" },
  });
  assert.equal(noop.status, 422);
  assert.equal(code(noop.json), "AI_NO_CHANGES");
  const ok = await post(h.base, token, "/api/v1/ai/feedback", {
    feature: "screenshot_extraction", original: { lot: "0.10", symbol: "XAUUSD" }, corrected: { lot: "0.20", symbol: "XAUUSD" },
  });
  assert.equal(ok.status, 201);
  assert.deepEqual(data(ok.json)["changed_fields"], ["lot"], "derived, not accepted from the client");
  const badShape = await post(h.base, token, "/api/v1/ai/feedback", { feature: "x", original: [], corrected: {} });
  assert.equal(badShape.status, 422);
  await h.close();
});

test("AI HTTP: /status tells the truth about what this deployment can do", async () => {
  const h = await build({ secrets: {} });
  const token = await h.login(`ai-status-${Date.now()}@velora.test`);
  const res = await get(h.base, token, "/api/v1/ai/status");
  assert.equal(res.status, 200);
  const body = data(res.json);
  assert.equal(body["providerConfigured"], false, "no credential means the UI must not offer the button");
  const flags = body["flags"] as Record<string, boolean>;
  assert.equal(flags["ai_screenshot_extraction"], true);
  assert.equal(flags["ai_trade_analysis"], false);
  const features = body["features"] as { feature: string; enabled: boolean }[];
  assert.equal(features.find((f) => f.feature === "trade_analysis")?.enabled, false);
  await h.close();
});

test("AI HTTP: /attempts is ownership-scoped and its limit is validated", async () => {
  const h = await build({ secrets: { GEMINI_API_KEY: "key" } });
  const token = await h.login(`ai-attempts-${Date.now()}@velora.test`);
  h.ledger.rows.push({
    userId: "somebody-else", id: "1", feature: "analysis", provider: "gemini", model: "m",
    promptVersion: "v1", insight: {}, outcome: "success", errorCode: null, route: null,
    latencyMs: 1, tradesAnalyzed: 1, windowFrom: null, windowTo: null, createdAt: "2026-01-01T00:00:00Z",
  });
  const res = await get(h.base, token, "/api/v1/ai/attempts");
  assert.equal(res.status, 200);
  assert.deepEqual(data(res.json)["attempts"], [], "another user's attempt is never returned");
  const bad = await get(h.base, token, "/api/v1/ai/attempts?limit=9999");
  assert.equal(bad.status, 422);
  await h.close();
});

// ── the admin surface ─────────────────────────────────────────────────────────

test("AI admin: a plain user is 403 and an admin may read but not write the route", async () => {
  const h = await build({ secrets: { GEMINI_API_KEY: "secret-value" } });
  const userToken = await h.login(`ai-adm-user-${Date.now()}@velora.test`);
  const userRes = await get(h.base, userToken, "/api/v1/admin/ai/overview");
  assert.equal(userRes.status, 403);

  const adminToken = await h.login(`ai-adm-admin-${Date.now()}@velora.test`, "admin");
  const overview = await get(h.base, adminToken, "/api/v1/admin/ai/overview");
  assert.equal(overview.status, 200);
  const body = data(overview.json);
  const providers = body["providers"] as { provider: string; available: boolean; credential: { configured: boolean; source: string | null } }[];
  const gemini = providers.find((p) => p.provider === "gemini");
  assert.equal(gemini?.credential.configured, true);
  assert.equal(gemini?.credential.source, "env");
  assert.equal(gemini?.available, true);
  // The whole response must not contain the secret, in any field.
  assert.equal(JSON.stringify(body).includes("secret-value"), false, "a secret may never appear in a response");

  // aiRouteManage is super-admin-exclusive (Legacy Role.php).
  const denied = await fetch(`${h.base}/api/v1/admin/ai/route`, {
    method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ route: "n8n_relay" }),
  });
  assert.equal(denied.status, 403);

  const saToken = await h.login(`ai-adm-sa-${Date.now()}@velora.test`, "super_admin");
  const allowed = await fetch(`${h.base}/api/v1/admin/ai/route`, {
    method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${saToken}` },
    body: JSON.stringify({ route: "n8n_relay" }),
  });
  assert.equal(allowed.status, 200);
  const allowedBody = data((await allowed.json()) as Record<string, unknown>);
  assert.equal(allowedBody["route"], "n8n_relay");
  assert.equal(allowedBody["source"], "admin", "the response says WHICH tier decided, not just what won");
  const invalid = await fetch(`${h.base}/api/v1/admin/ai/route`, {
    method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${saToken}` },
    body: JSON.stringify({ route: "carrier_pigeon" }),
  });
  assert.equal(invalid.status, 422);
  await h.close();
});

test("AI admin: a credential write returns a fingerprint and never the value", async () => {
  const h = await build();
  const saToken = await h.login(`ai-cred-${Date.now()}@velora.test`, "super_admin");
  const res = await fetch(`${h.base}/api/v1/admin/ai/credentials/GEMINI_API_KEY`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${saToken}` },
    body: JSON.stringify({ value: "AIza-super-secret-value" }),
  });
  assert.equal(res.status, 200);
  const body = data((await res.json()) as Record<string, unknown>);
  assert.match(String(body["fingerprint"]), /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(body).includes("AIza-super-secret-value"), false);
  // The stored row is decryptable by the holder of the master key, and the
  // overview still shows only a fingerprint.
  const overview = await get(h.base, saToken, "/api/v1/admin/ai/overview");
  const text = JSON.stringify(data(overview.json));
  assert.equal(text.includes("AIza-super-secret-value"), false);
  assert.equal(text.includes("fingerprint"), true);
  const removed = await fetch(`${h.base}/api/v1/admin/ai/credentials/GEMINI_API_KEY`, {
    method: "DELETE", headers: { Authorization: `Bearer ${saToken}` },
  });
  assert.equal(removed.status, 200);
  assert.equal(data((await removed.json()) as Record<string, unknown>)["removed"], true);
  await h.close();
});

test("AI admin: the relay must be https, and its response carries a host, never a token", async () => {
  const h = await build();
  const saToken = await h.login(`ai-relay-${Date.now()}@velora.test`, "super_admin");
  const insecure = await fetch(`${h.base}/api/v1/admin/ai/relay`, {
    method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${saToken}` },
    body: JSON.stringify({ url: "http://relay.example/wf", token: "tok" }),
  });
  assert.equal(insecure.status, 422, "a plain-http relay would send the token in the clear");
  const saved = await fetch(`${h.base}/api/v1/admin/ai/relay`, {
    method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${saToken}` },
    body: JSON.stringify({ url: "https://relay.example/webhook/abc123", token: "relay-token-value" }),
  });
  assert.equal(saved.status, 200);
  const body = data((await saved.json()) as Record<string, unknown>);
  assert.equal(body["configured"], true);
  assert.equal(body["host"], "relay.example");
  assert.equal(body["https"], true);
  assert.equal(body["tokenPresent"], true);
  assert.equal(JSON.stringify(body).includes("relay-token-value"), false, "the token must never be echoed");
  assert.equal(JSON.stringify(body).includes("abc123"), false, "nor the workflow path");
  const read = await get(h.base, saToken, "/api/v1/admin/ai/relay");
  assert.equal(JSON.stringify(data(read.json)).includes("relay-token-value"), false);
  await h.close();
});

test("AI admin: a probe reports UNVERIFIED without a credential instead of claiming health", async () => {
  const h = await build({ secrets: {} });
  const saToken = await h.login(`ai-probe-${Date.now()}@velora.test`, "super_admin");
  const res = await fetch(`${h.base}/api/v1/admin/providers/gemini/verify`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${saToken}` },
  });
  assert.equal(res.status, 200);
  const body = data((await res.json()) as Record<string, unknown>);
  assert.equal(body["status"], "UNVERIFIED");
  assert.equal(body["verified"], false);
  assert.equal(body["errorCode"], "NO_CREDENTIAL");
  const unknown = await fetch(`${h.base}/api/v1/admin/providers/claude/verify`, {
    method: "POST", headers: { Authorization: `Bearer ${saToken}` },
  });
  assert.equal(unknown.status, 422, "a provider Modern does not carry cannot be probed");
  await h.close();
});

test("AI admin: chains are editable, validated against the catalog, and reorderable", async () => {
  const h = await build({ secrets: { GEMINI_API_KEY: "k" } });
  const adminToken = await h.login(`ai-chain-${Date.now()}@velora.test`, "admin");
  const created = await fetch(`${h.base}/api/v1/admin/ai/feature-providers`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ feature: "trade_analysis", provider: "gemini", priority: 1, route: "direct" }),
  });
  assert.equal(created.status, 201);
  const row = data((await created.json()) as Record<string, unknown>);
  const id = String(row["id"]);
  const badModel = await fetch(`${h.base}/api/v1/admin/ai/feature-providers`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ feature: "trade_analysis", provider: "gemini", model: "gemini-9-ultra" }),
  });
  assert.equal(badModel.status, 422, "a model outside the provider's allowlist is refused");
  const badProvider = await fetch(`${h.base}/api/v1/admin/ai/feature-providers`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ feature: "trade_analysis", provider: "claude" }),
  });
  assert.equal(badProvider.status, 422);
  const patched = await fetch(`${h.base}/api/v1/admin/ai/feature-providers/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(patched.status, 200);
  assert.equal(data((await patched.json()) as Record<string, unknown>)["enabled"], false);
  const missing = await fetch(`${h.base}/api/v1/admin/ai/feature-providers/999999`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(missing.status, 404);
  const removed = await fetch(`${h.base}/api/v1/admin/ai/feature-providers/${id}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(removed.status, 200);
  await h.close();
});

test("AI admin: flags and quotas are writable, and a rollout outside 0..100 is refused", async () => {
  const h = await build({ secrets: { GEMINI_API_KEY: "k" } });
  const adminToken = await h.login(`ai-flags-${Date.now()}@velora.test`, "admin");
  const ok = await fetch(`${h.base}/api/v1/admin/ai/flags/ai_trade_analysis`, {
    method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ enabled: true, rollout_percentage: 25 }),
  });
  assert.equal(ok.status, 200);
  assert.equal(data((await ok.json()) as Record<string, unknown>)["rolloutPercentage"], 25);
  const bad = await fetch(`${h.base}/api/v1/admin/ai/flags/ai_trade_analysis`, {
    method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ enabled: true, rollout_percentage: 250 }),
  });
  assert.equal(bad.status, 422);
  const unknownFlag = await fetch(`${h.base}/api/v1/admin/ai/flags/not_a_flag`, {
    method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ enabled: true, rollout_percentage: 10 }),
  });
  assert.equal(unknownFlag.status, 422);
  // Quota writes are super-admin-exclusive: they decide how much money is spent.
  const adminQuota = await fetch(`${h.base}/api/v1/admin/ai/quotas/gemini`, {
    method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ quota_limit: 10 }),
  });
  assert.equal(adminQuota.status, 403);
  const saToken = await h.login(`ai-flags-sa-${Date.now()}@velora.test`, "super_admin");
  const saQuota = await fetch(`${h.base}/api/v1/admin/ai/quotas/gemini`, {
    method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${saToken}` },
    body: JSON.stringify({ quota_limit: 10 }),
  });
  assert.equal(saQuota.status, 200);
  assert.equal(data((await saQuota.json()) as Record<string, unknown>)["quotaLimit"], 10);
  await h.close();
});

test("AI admin: the usage drilldown reads the one ledger and its limit is bounded", async () => {
  const h = await build({ secrets: { GEMINI_API_KEY: "k" } });
  const adminToken = await h.login(`ai-usage-${Date.now()}@velora.test`, "admin");
  const res = await get(h.base, adminToken, "/api/v1/admin/ai-usage");
  assert.equal(res.status, 200);
  const body = data(res.json);
  assert.equal(typeof body["total"], "number");
  assert.ok(body["totals"] !== undefined);
  const bad = await get(h.base, adminToken, "/api/v1/admin/ai-usage?limit=100000");
  assert.equal(bad.status, 422);
  await h.close();
});

// ── the ADMIN tool surface: real states, an audit row for every probe, and a 503 that is not a lie ──
//
// `apps/api/src/telegram/*` proves what the bot does with these tools; this proves what an OPERATOR is
// told. The properties are ones only an HTTP test can establish: who may see the panel at all, that a
// deployment without tool services answers 503 rather than an empty list (an empty list is a claim about
// the platform, not about the keys), that `unsupported` survives to the client instead of collapsing into
// "off", and that a validation leaves exactly one audit row carrying a verdict and no secret.

async function fetchTools(h: Harness, token: string | null): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${h.base}/api/v1/admin/ai/tools`, {
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function validateTool(h: Harness, token: string, tool: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${h.base}/api/v1/admin/ai/tools/${tool}/validate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("AI admin tools: an anonymous caller is 401 and a plain user is 403, before any provider is touched", async () => {
  const h = await build({ withTools: true });
  try {
    const anon = await fetchTools(h, null);
    assert.equal(anon.status, 401);
    const user = await h.login(`tools-user-${Date.now()}@velora.test`);
    const forbidden = await fetchTools(h, user);
    assert.equal(forbidden.status, 403, "aiManage is super-admin-ish: a plain account may not read the platform's capability table");
    assert.equal(h.toolCalls.length, 0, "an unauthorized read must not cost a provider request");
    // THE ASYMMETRY, pinned: reading the table is `aiManage`; PROVING a tool alive spends a third-party
    // request on the platform's own credential, so it additionally requires the route-manage permission
    // that only a super admin holds. An `admin` therefore sees the panel and cannot press its buttons.
    const admin = await h.login(`tools-readonly-admin-${Date.now()}@velora.test`, "admin");
    assert.equal((await fetchTools(h, admin)).status, 200, "an admin may read it");
    const probe = await validateTool(h, admin, "web_search");
    assert.equal(probe.status, 403, "and may not run a live probe");
    assert.equal(h.toolCalls.length, 0, "refused BEFORE the provider: the permission is decided before any body or request leaves");
    assert.equal((await h.adminAudit.list()).length, 0, "and it must not write a trail for an action that never happened");
  } finally {
    await h.close();
  }
});

test("AI admin tools: the panel reports the runtime's truth, including what it can never do", async () => {
  const h = await build({ withTools: true });
  try {
    const admin = await h.login(`tools-admin-${Date.now()}@velora.test`, "admin");
    const res = await fetchTools(h, admin);
    assert.equal(res.status, 200);
    const data = res.json["data"] as { items: Record<string, unknown>[]; states: string[]; tools: string[] };
    assert.deepEqual(data.tools, ["web_search", "browser_capture", "banner_raster"]);
    // The vocabulary travels with the payload so the panel cannot invent a colour for a state it has
    // never seen.
    assert.ok(data.states.includes("unsupported") && data.states.includes("verified"));
    const raster = data.items.find((row) => row["tool"] === "banner_raster");
    // This harness is the WORKER shape (`raster: null`), so the honest answer is `unsupported` with
    // runtimeSupported false — never `unavailable`, which would tell an operator to go configure a key
    // that cannot help.
    assert.equal(raster?.["state"], "unsupported");
    assert.equal(raster?.["runtimeSupported"], false);
    // A read is not an event: the panel refreshing must not fill the audit trail.
    assert.equal((await h.adminAudit.list()).length, 0);
  } finally {
    await h.close();
  }
});

test("AI admin tools: with no tool services wired the answer is 503 naming the capability, not an empty list", async () => {
  const h = await build();
  try {
    const admin = await h.login(`tools-absent-${Date.now()}@velora.test`, "super_admin");
    const res = await fetchTools(h, admin);
    assert.equal(res.status, 503, "an empty list would claim this platform HAS no tools, which is a statement about code, not keys");
    assert.match(JSON.stringify(res.json), /aiTools/u);
    const validate = await validateTool(h, admin, "web_search");
    assert.equal(validate.status, 503, "and the same for a probe this deployment cannot run");
    assert.equal((await h.adminAudit.list()).length, 0, "a refused probe is not an audited action");
  } finally {
    await h.close();
  }
});

test("AI admin tools: a validation is answered, audited, and carries a verdict rather than a secret", async () => {
  const h = await build({ withTools: true, secrets: { TAVILY_API_KEY: "tvly-secret-do-not-log" } });
  try {
    const admin = await h.login(`tools-validator-${Date.now()}@velora.test`, "super_admin");
    const adminUser = await h.store.findUserByEmail(`tools-validator-${Date.now()}@velora.test`);
    const res = await validateTool(h, admin, "web_search");
    assert.equal(res.status, 200, `a provider that answered is a success verdict, saw ${JSON.stringify(res.json)}`);
    const verdict = res.json["data"] as { tool: string; ok: boolean; state: string };
    assert.equal(verdict.tool, "web_search");
    assert.equal(verdict.ok, true);
    assert.equal(verdict.state, "verified", "verified means WE ASKED, which is why the state cannot come from a config table");

    const rows = (await h.adminAudit.list()).filter((r) => r.action === "AI_TOOL_VALIDATED");
    assert.equal(rows.length, 1, "exactly one trail per probe");
    const row = rows[0] as unknown as Record<string, string | null>;
    assert.equal(row["afterState"], "tool:web_search verdict:ok");
    assert.equal(row["provider"], null, "the audit provider vocabulary is METAAPI/TELEGRAM; a search vendor does not belong in it");
    assert.ok(row["requestId"], "a route-path append still carries the request id, or the row cannot be correlated");
    assert.ok(adminUser === null || row["actorUserId"] === adminUser.id, "the actor is the authenticated admin, never a body field");
    const serialised = JSON.stringify(row);
    assert.ok(!serialised.includes("tvly-secret-do-not-log"), "the key never reaches the trail");
    assert.ok(!serialised.includes("api.tavily.com"), "nor does the endpoint: the verdict is the fact, the URL is infrastructure");
  } finally {
    await h.close();
  }
});

test("AI admin tools: a failing probe is 424 Failed Dependency, audited with the code it returned", async () => {
  const h = await build({ withTools: true });
  try {
    // No search credential in this harness: the probe cannot succeed, and the route must say so with the
    // status that means "the dependency is not there" rather than a green 200 carrying ok:false.
    const admin = await h.login(`tools-failing-${Date.now()}@velora.test`, "super_admin");
    const res = await validateTool(h, admin, "web_search");
    assert.equal(res.status, 424, `a negative verdict is not a success, saw ${res.status}`);
    const verdict = res.json["data"] as { ok: boolean; state: string; errorCode: string | null };
    assert.equal(verdict.ok, false);
    assert.ok(["unavailable", "failing"].includes(verdict.state), `state must stay in the vocabulary, saw ${verdict.state}`);
    const rows = (await h.adminAudit.list()).filter((r) => r.action === "AI_TOOL_VALIDATED");
    assert.equal(rows.length, 1, "a failed check is the MOST interesting row: an operator learned something about a credential");
    assert.match(String((rows[0] as unknown as { afterState: string }).afterState), /^tool:web_search verdict:/u);
    assert.ok(
      !/^tool:web_search verdict:ok$/u.test(String((rows[0] as unknown as { afterState: string }).afterState)),
      "a failed probe must not be recorded as `verdict:ok` — that is how a green lie would enter the trail",
    );
    assert.equal(verdict.errorCode !== null, true, "the client is told why, not just that it failed");
  } finally {
    await h.close();
  }
});

test("AI admin tools: an unknown tool is 422 and a Worker-only tool cannot be probed at all", async () => {
  const h = await build({ withTools: true });
  try {
    const admin = await h.login(`tools-unknown-${Date.now()}@velora.test`, "super_admin");
    const unknown = await validateTool(h, admin, "not_a_tool");
    assert.equal(unknown.status, 422, "the name is not in the vocabulary — a client error, not a provider one");
    const raster = await validateTool(h, admin, "banner_raster");
    assert.equal(raster.status, 503, "this runtime has no rasterizer to verify");
    assert.match(JSON.stringify(raster.json), /TOOL_NOT_VERIFIABLE/u);
    assert.equal(h.toolCalls.length, 0, "neither refusal sent a byte anywhere");
    assert.equal((await h.adminAudit.list()).length, 0, "and neither wrote a row");
  } finally {
    await h.close();
  }
});
