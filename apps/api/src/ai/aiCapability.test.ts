// Phase 7 — the AI capability's own tests.
//
// WHAT THIS FILE PROVES, AND WITH WHAT
//   * the chain walk: a switched-off feature never reaches a provider; an empty
//     chain is a refusal and not an empty success; consent stops the walk before
//     any egress; a spent quota skips to the next provider and says so; an image
//     that cannot be redacted never leaves the machine; a failure falls through to
//     the next entry; and EVERY attempt — success, refusal, error — reaches the
//     ledger (unit-level, with the in-memory config store and fake executors);
//   * the n8n relay contract: the payload shape, https-only, the token in the
//     header and nowhere else, and the error mapping (injected fetch, no network);
//   * the rollout gate: deterministic per user, and the default posture Legacy
//     ships (extraction on, everything else off);
//   * the LOCAL OCR fallback: against the REAL tesseract binary on a real image —
//     this is the one AI provider whose live behaviour this repository can prove
//     without a credential, so it is proved rather than mocked;
//   * the output rules: Legacy's whitelists, the locale resolution order, and
//     `changed_fields` being derived rather than accepted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AiManager, type AiCallRequest } from "./aiManager.js";
import { AiFeatureGuard, rolloutBucket } from "./aiFeatureGuard.js";
import { AiFeatureRouter } from "./aiFeatureRouter.js";
import { AiRouteResolver } from "./aiRouteResolver.js";
import { MemoryAiConfigStore } from "./memoryAiConfigStore.js";
import { UnavailableImageAnonymizer, type ImageAnonymizer } from "./imageAnonymizer.js";
import { N8nRelayTransport, relayIsConfigured } from "./n8nRelayTransport.js";
import { TesseractProvider, findTesseractBinary, parseOcrTradeFields } from "./tesseractProvider.js";
import type { AiExecutor, AiExecutorResult } from "./aiExecutors.js";
import { AiFailure } from "./aiErrors.js";
import { MemoryAiAttemptStore } from "../aicoach/aiProvider.js";
import {
  ANALYSIS_OUTPUT_FIELDS, changedFieldNames, resolveAiLocale, whitelistOutput,
} from "./aiAnalysisService.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "__fixtures__", "ocr-trade-screenshot.png");

function executor(provider: "gemini" | "openai" | "tesseract", behaviour: (n: number) => Promise<AiExecutorResult> | AiExecutorResult, calls: string[]): AiExecutor {
  let n = 0;
  return {
    provider,
    async execute(request, options) {
      n += 1;
      calls.push(`${provider}:${options.route ?? "auto"}#${n}`);
      return behaviour(n);
    },
  };
}

const okResult = (model: string, insight: Record<string, unknown>): AiExecutorResult => ({
  model, insight, text: null, tokensIn: 10, tokensOut: 20, costMicroUsd: 5, latencyMs: 12,
});

function harness(options: {
  flags?: [string, boolean, number][];
  chains?: { feature: string; provider: "gemini" | "openai" | "tesseract"; priority: number; route?: "direct" | "n8n_relay" | null }[];
  consented?: boolean;
  quota?: Record<string, number>;
  secrets?: Record<string, string>;
  anonymizer?: ImageAnonymizer;
  executors?: Partial<Record<"gemini" | "openai" | "tesseract", AiExecutor>>;
  localOcr?: boolean;
} = {}) {
  const store = new MemoryAiConfigStore();
  store.seedLegacyDefaults();
  for (const [name, enabled, rollout] of options.flags ?? []) void store.setFlag(name, enabled, rollout);
  const secrets = new Map(Object.entries(options.secrets ?? {}));
  const secretService = {
    resolve: async (key: string) => (secrets.has(key) ? { value: secrets.get(key)!, source: "env" as const } : { value: null, source: null }),
    status: async (key: string) => ({ key, configured: secrets.has(key), source: secrets.has(key) ? ("env" as const) : null, fingerprint: null }),
    statusAll: async (keys: readonly string[]) => Promise.all(keys.map((k) => secretService.status(k))),
    fingerprint: (value: string) => `fp-${value.length}`,
    replace: async () => ({ fingerprint: "fp" }),
    remove: async () => true,
  };
  const routeResolver = new AiRouteResolver({
    store,
    env: (key) => (key === "GEMINI_ROUTE" ? undefined : undefined),
  });
  const router = new AiFeatureRouter({
    store,
    // The router only needs resolve/status; the double above satisfies both.
    secrets: secretService as never,
    routes: routeResolver,
    env: () => undefined,
    localOcrAvailable: () => options.localOcr ?? true,
  });
  for (const row of options.chains ?? []) {
    void store.upsertRoute({
      feature: row.feature as never, provider: row.provider, model: null,
      priority: row.priority, enabled: true, route: row.route ?? null,
    });
  }
  for (const [provider, limit] of Object.entries(options.quota ?? {})) void store.setQuotaLimit(provider, limit);
  const attempts = new MemoryAiAttemptStore();
  const consented = options.consented ?? true;
  const manager = new AiManager({
    router,
    guard: new AiFeatureGuard({ store }),
    store,
    consent: { consentState: async () => ({ consented, consentedAt: consented ? "2026-01-01T00:00:00Z" : null }) },
    attempts,
    anonymizer: options.anonymizer ?? new UnavailableImageAnonymizer(),
    executors: options.executors ?? {},
  });
  return { store, attempts, manager, router, secretService, routeResolver };
}

const baseCall = (over: Partial<AiCallRequest> = {}): AiCallRequest => ({
  userId: "user-1",
  feature: "trade_analysis",
  ledgerFeature: "analysis",
  promptVersion: "trade_analysis_v1",
  prompt: "analyze",
  facts: { tradeCount: 3 },
  deadlineMs: Date.now() + 20_000,
  requiresStructuredOutput: true,
  ...over,
});

test("AI: a switched-off feature never reaches a provider", async () => {
  const calls: string[] = [];
  const h = harness({
    flags: [["ai_trade_analysis", false, 0]],
    executors: { gemini: executor("gemini", () => okResult("gemini-3.6-flash", { summary: "x" }), calls) },
    secrets: { GEMINI_API_KEY: "key" },
  });
  const out = await h.manager.call(baseCall());
  assert.equal(out.status, "refused");
  assert.equal(out.status === "refused" && out.code, "FEATURE_DISABLED");
  assert.deepEqual(calls, [], "no executor may run for a disabled feature");
  assert.equal(h.attempts.entries.length, 0, "a gate refusal happens before any provider attempt");
});

test("AI: an unconfigured deployment refuses instead of inventing an answer", async () => {
  const h = harness({ flags: [["ai_trade_analysis", true, 100]], secrets: {}, localOcr: false });
  const out = await h.manager.call(baseCall());
  assert.equal(out.status, "refused");
  assert.equal(out.status === "refused" && out.code, "NO_PROVIDER_AVAILABLE");
});

test("AI: consent is checked before any egress and stops the whole walk", async () => {
  const calls: string[] = [];
  const h = harness({
    flags: [["ai_trade_analysis", true, 100]],
    consented: false,
    secrets: { GEMINI_API_KEY: "key" },
    executors: { gemini: executor("gemini", () => okResult("m", { summary: "x" }), calls) },
  });
  const out = await h.manager.call(baseCall());
  assert.equal(out.status, "refused");
  assert.equal(out.status === "refused" && out.code, "CONSENT_REQUIRED");
  assert.deepEqual(calls, []);
  // The refusal IS data: one ledger row naming the provider we declined to call.
  assert.equal(h.attempts.entries.length, 1);
  assert.equal(h.attempts.entries[0]!.outcome, "refused");
  assert.equal(h.attempts.entries[0]!.errorCode, "CONSENT_REQUIRED");
});

test("AI: an exhausted quota skips to the next provider and records why", async () => {
  const calls: string[] = [];
  const h = harness({
    flags: [["ai_screenshot_extraction", true, 100]],
    secrets: { GEMINI_API_KEY: "key" },
    quota: { gemini: 0 },
    chains: [
      { feature: "screenshot_extraction", provider: "gemini", priority: 1 },
      { feature: "screenshot_extraction", provider: "tesseract", priority: 2 },
    ],
    executors: {
      gemini: executor("gemini", () => okResult("m", { fields: {} }), calls),
      tesseract: executor("tesseract", () => ({ model: "tesseract", insight: { fields: { symbol: "XAUUSD" } }, text: "XAUUSD", tokensIn: null, tokensOut: null, costMicroUsd: null, latencyMs: 3 }), calls),
    },
  });
  const out = await h.manager.call(baseCall({ feature: "screenshot_extraction", ledgerFeature: "ocr", requiresStructuredOutput: false }));
  assert.equal(out.status, "generated");
  assert.equal(out.status === "generated" && out.provider, "tesseract");
  assert.deepEqual(calls, ["tesseract:auto#1"], "the quota-less provider must not be called at all");
  const outcomes = h.attempts.entries.map((e) => `${e.provider}:${e.outcome}:${e.errorCode ?? "-"}`);
  assert.deepEqual(outcomes, ["gemini:refused:QUOTA_EXHAUSTED", "tesseract:success:-"]);
  // The chain position is recorded, so "the fallback answered" is readable later.
  assert.equal(h.attempts.entries[1]!.fallbackIndex, 1);
});

test("AI: an image that cannot be redacted never leaves the machine", async () => {
  const calls: string[] = [];
  const h = harness({
    flags: [["ai_screenshot_extraction", true, 100]],
    secrets: { GEMINI_API_KEY: "key" },
    anonymizer: new UnavailableImageAnonymizer(),
    chains: [
      { feature: "screenshot_extraction", provider: "gemini", priority: 1 },
      { feature: "screenshot_extraction", provider: "tesseract", priority: 2 },
    ],
    executors: {
      gemini: executor("gemini", () => okResult("m", { fields: {} }), calls),
      tesseract: executor("tesseract", () => ({ model: "tesseract", insight: { fields: {} }, text: "read locally", tokensIn: null, tokensOut: null, costMicroUsd: null, latencyMs: 2 }), calls),
    },
  });
  const out = await h.manager.call(baseCall({
    feature: "screenshot_extraction", ledgerFeature: "vision_extract",
    image: { bytes: Buffer.from("not-really-an-image"), mimeType: "image/png" },
    requiresStructuredOutput: false,
  }));
  assert.equal(out.status, "generated");
  assert.equal(out.status === "generated" && out.provider, "tesseract");
  assert.deepEqual(calls, ["tesseract:auto#1"], "the external provider must never see an unredacted image");
  assert.equal(h.attempts.entries[0]!.errorCode, "IMAGE_NOT_ANONYMIZED");
});

test("AI: a redacting anonymizer lets the external provider run, with the redacted bytes", async () => {
  const seen: number[] = [];
  const anonymizer: ImageAnonymizer = {
    shouldAnonymize: () => true,
    anonymize: (image) => { seen.push(image.length); return Buffer.from("redacted"); },
    info: () => ({ anonymized: true, method: "blur_top_15_percent", topPercent: 15, failClosed: true }),
  };
  const h = harness({
    flags: [["ai_screenshot_extraction", true, 100]],
    secrets: { GEMINI_API_KEY: "key" },
    anonymizer,
    executors: {
      gemini: {
        provider: "gemini",
        async execute(request) {
          assert.equal(request.image?.bytes.toString("utf8"), "redacted");
          return { model: "gemini-3.6-flash", insight: { fields: { symbol: "XAUUSD" } }, text: null, tokensIn: 1, tokensOut: 2, costMicroUsd: 3, latencyMs: 9 };
        },
      },
    },
  });
  const out = await h.manager.call(baseCall({
    feature: "screenshot_extraction", ledgerFeature: "vision_extract",
    image: { bytes: Buffer.from("original"), mimeType: "image/png" },
    requiresStructuredOutput: false,
  }));
  assert.equal(out.status, "generated");
  assert.deepEqual(seen, [8], "the anonymizer saw the original exactly once");
});

test("AI: a provider failure falls through, and the ledger keeps both attempts", async () => {
  const calls: string[] = [];
  const h = harness({
    flags: [["ai_trade_analysis", true, 100]],
    // The relay route is pinned on the first entry, so the relay itself must be
    // configured — otherwise the router is right to skip that entry, and the test
    // would be asserting something other than a fall-through.
    secrets: { GEMINI_API_KEY: "key", OPENAI_API_KEY: "key", GEMINI_RELAY_URL: "https://relay.example/wf", GEMINI_RELAY_TOKEN: "tok" },
    chains: [
      { feature: "trade_analysis", provider: "gemini", priority: 1, route: "n8n_relay" },
      { feature: "trade_analysis", provider: "openai", priority: 2 },
    ],
    executors: {
      gemini: executor("gemini", () => { throw new AiFailure("UPSTREAM_UNAVAILABLE", "error", "gemini", true); }, calls),
      openai: executor("openai", () => okResult("gpt-5-mini", { summary: "second try" }), calls),
    },
  });
  const out = await h.manager.call(baseCall());
  assert.equal(out.status, "generated");
  assert.equal(out.status === "generated" && out.provider, "openai");
  assert.deepEqual(calls, ["gemini:n8n_relay#1", "openai:auto#1"]);
  assert.deepEqual(h.attempts.entries.map((e) => `${e.provider}:${e.outcome}:${e.route ?? "-"}`),
    ["gemini:error:n8n_relay", "openai:success:-"]);
});

test("AI: prose where a JSON object was required is an error, never stored content", async () => {
  const h = harness({
    flags: [["ai_trade_analysis", true, 100]],
    secrets: { GEMINI_API_KEY: "key" },
    executors: {
      gemini: {
        provider: "gemini",
        async execute() {
          return { model: "gemini-3.6-flash", insight: null, text: "Sure! Here is your analysis…", tokensIn: 1, tokensOut: 2, costMicroUsd: 3, latencyMs: 9 };
        },
      },
    },
  });
  const out = await h.manager.call(baseCall());
  assert.equal(out.status, "error");
  assert.equal(out.status === "error" && out.code, "INVALID_PROVIDER_OUTPUT");
  assert.equal(h.attempts.entries[0]!.outcome, "error");
  assert.deepEqual(h.attempts.entries[0]!.insight, {}, "an empty object, not the model's prose");
});

test("AI: the caller's deadline stops the walk before another call", async () => {
  const calls: string[] = [];
  const h = harness({
    flags: [["ai_trade_analysis", true, 100]],
    secrets: { GEMINI_API_KEY: "key" },
    executors: { gemini: executor("gemini", () => okResult("m", { summary: "x" }), calls) },
  });
  const out = await h.manager.call(baseCall({ deadlineMs: Date.now() - 1 }));
  assert.equal(out.status, "error");
  assert.equal(out.status === "error" && out.code, "DEADLINE_EXCEEDED");
  assert.deepEqual(calls, []);
});

// ── the rollout gate ──────────────────────────────────────────────────────────

test("AI flags: the rollout decision is deterministic per user and stable across reads", async () => {
  const store = new MemoryAiConfigStore();
  await store.setFlag("ai_trade_analysis", true, 50);
  const guard = new AiFeatureGuard({ store });
  const userId = "user-42";
  const first = await guard.isEnabled("ai_trade_analysis", userId);
  for (let i = 0; i < 5; i += 1) assert.equal(await guard.isEnabled("ai_trade_analysis", userId), first);
  const bucket = rolloutBucket("ai_trade_analysis", userId);
  assert.equal(first, bucket < 50);
  assert.ok(bucket >= 0 && bucket < 100);
});

test("AI flags: rollout 0 is off for everyone and 100 is on for everyone", async () => {
  const store = new MemoryAiConfigStore();
  const guard = new AiFeatureGuard({ store });
  await store.setFlag("ai_weekly_report", true, 0);
  assert.equal(await guard.isEnabled("ai_weekly_report", "u1"), false);
  await store.setFlag("ai_weekly_report", true, 100);
  assert.equal(await guard.isEnabled("ai_weekly_report", "u1"), true);
  await store.setFlag("ai_weekly_report", false, 100);
  assert.equal(await guard.isEnabled("ai_weekly_report", "u1"), false, "disabled beats any rollout");
});

test("AI flags: with no row at all only screenshot extraction is on (Legacy's default posture)", async () => {
  const guard = new AiFeatureGuard({ store: new MemoryAiConfigStore() });
  assert.equal(await guard.isEnabled("ai_screenshot_extraction", "u1"), true);
  assert.equal(await guard.isEnabled("ai_trade_analysis", "u1"), false);
  assert.equal(await guard.isEnabled("ai_assistant", "u1"), false);
});

// ── the relay contract ────────────────────────────────────────────────────────

test("relay: https and a token, or it is not configured", () => {
  assert.equal(relayIsConfigured("https://relay.example/wf", "tok"), true);
  assert.equal(relayIsConfigured("http://relay.example/wf", "tok"), false, "plain http would send the token in the clear");
  assert.equal(relayIsConfigured("https://relay.example/wf", ""), false);
  assert.equal(relayIsConfigured("", "tok"), false);
  assert.equal(relayIsConfigured(null, null), false);
});

test("relay: the payload is Legacy's shape and the token travels in the header only", async () => {
  // A holder object: TypeScript narrows a `let` captured by a closure to `null`,
  // which would make the assertions below untypeable.
  const seen: { current: { url: string; headers: Record<string, string>; body: string } | null } = { current: null };
  const transport = new N8nRelayTransport({
    url: "https://relay.example/webhook/gemini",
    token: "super-secret-token",
    fetchImpl: async (url, init) => {
      seen.current = { url, headers: init?.headers ?? {}, body: init?.body ?? "" };
      return {
        ok: true, status: 200,
        json: async () => ({ success: true, request_id: "r1", provider: "gemini", model: "gemini-3.6-flash", extraction: { symbol: "XAUUSD" }, error: null, meta: { upstream_http_status: 200, latency_ms: 42 } }),
        text: async () => "",
      };
    },
  });
  const result = await transport.generateContent("read this chart", { bytes: Buffer.from("png-bytes"), mimeType: "image/png" });
  const captured = seen.current;
  assert.ok(captured !== null);
  assert.equal(captured!.url, "https://relay.example/webhook/gemini");
  assert.equal(captured!.headers["X-Velora-Relay-Token"], "super-secret-token");
  assert.equal(captured!.headers["Content-Type"], "application/json");
  const body = JSON.parse(captured!.body) as Record<string, string>;
  assert.match(body["request_id"]!, /^velora-[0-9a-f]{16}$/u);
  assert.equal(body["prompt"], "read this chart");
  assert.equal(body["mime_type"], "image/png");
  assert.equal(Buffer.from(body["image_base64"]!, "base64").toString("utf8"), "png-bytes");
  // The token appears in the header and NOWHERE else.
  assert.equal(captured!.url.includes("super-secret-token"), false);
  assert.equal(captured!.body.includes("super-secret-token"), false);
  assert.equal(result.text, JSON.stringify({ symbol: "XAUUSD" }));
  assert.equal(result.model, "gemini-3.6-flash");
  assert.equal(result.latencyMs, 42);
});

test("relay: a normalized upstream error becomes a typed failure, never the upstream message", async () => {
  const cases: [string, string][] = [
    ["UPSTREAM_QUOTA_EXHAUSTED", "UPSTREAM_QUOTA_EXHAUSTED"],
    ["UPSTREAM_AUTH", "UPSTREAM_AUTH"],
    ["NETWORK_TIMEOUT", "UPSTREAM_TIMEOUT"],
    ["MALFORMED", "UPSTREAM_MALFORMED"],
    ["SOMETHING_NEW", "PROVIDER_ERROR"],
  ];
  for (const [relayCode, expected] of cases) {
    const transport = new N8nRelayTransport({
      url: "https://relay.example/wf", token: "tok",
      fetchImpl: async () => ({
        ok: false, status: 200,
        json: async () => ({ success: false, error: { code: relayCode, http_status: 500, message: "internal detail that must not travel" } }),
        text: async () => "",
      }),
    });
    await assert.rejects(() => transport.generateContent("p", null), (err: unknown) => {
      assert.ok(err instanceof AiFailure);
      assert.equal(err.code, expected);
      assert.equal(err.message.includes("internal detail"), false, "an upstream body must not become our message");
      return true;
    });
  }
});

test("relay: 401/403/404 are classified separately, because they mean different fixes", async () => {
  for (const [status, code] of [[401, "RELAY_REJECTED_CREDENTIALS"], [403, "RELAY_REJECTED_CREDENTIALS"], [404, "RELAY_NOT_FOUND"], [500, "UPSTREAM_UNAVAILABLE"], [429, "UPSTREAM_QUOTA_EXHAUSTED"]] as [number, string][]) {
    const transport = new N8nRelayTransport({
      url: "https://relay.example/wf", token: "tok",
      fetchImpl: async () => ({ ok: false, status, json: async () => ({}), text: async () => "" }),
    });
    await assert.rejects(() => transport.generateContent("p", null), (err: unknown) => {
      assert.ok(err instanceof AiFailure);
      assert.equal(err.code, code);
      return true;
    });
  }
});

test("relay: an unconfigured relay refuses rather than calling an empty URL", async () => {
  const transport = new N8nRelayTransport({ url: "", token: "", fetchImpl: async () => { throw new Error("must not be called"); } });
  await assert.rejects(() => transport.generateContent("p", null), (err: unknown) => err instanceof AiFailure && err.code === "PROVIDER_NOT_CONFIGURED");
});

// ── the local OCR fallback, against the REAL binary ───────────────────────────

test("OCR: the real tesseract binary reads a real screenshot", { skip: findTesseractBinary() === null ? "tesseract is not installed here" : false }, async () => {
  assert.ok(existsSync(FIXTURE), "the fixture image must exist");
  const provider = new TesseractProvider();
  assert.equal(provider.isAvailable(), true);
  const result = await provider.ocr(readFileSync(FIXTURE));
  // The fixture is generated text, so these assertions are about the pipeline:
  // real bytes in, real words out, and the confidence stays at the honest low
  // value an OCR reading deserves.
  assert.match(result.text, /XAUUSD/u);
  assert.match(result.text, /BUY/u);
  assert.match(result.text, /2000\.50/u);
  assert.equal(result.model, "tesseract");
  assert.equal(result.confidence, 0.4);
  assert.ok(result.latencyMs >= 0);
  const fields = parseOcrTradeFields(result.text);
  assert.equal(fields.symbol, "XAUUSD");
  assert.equal(fields.direction, "buy");
  assert.equal(fields.entryPrice, "2000.50");
  assert.equal(fields.stopLoss, "1995.00");
  assert.equal(fields.takeProfit, "2020.00");
});

test("OCR: no binary means OCR_UNAVAILABLE, never an empty string that looks like success", async () => {
  const provider = new TesseractProvider({ binaryPath: null });
  assert.equal(provider.isAvailable(), false);
  await assert.rejects(() => provider.ocr(Buffer.from("x")), (err: unknown) => err instanceof AiFailure && err.code === "OCR_UNAVAILABLE");
});

test("OCR: the size bound is enforced before any process is spawned", async () => {
  const provider = new TesseractProvider();
  await assert.rejects(() => provider.ocr(Buffer.alloc(9 * 1024 * 1024)), (err: unknown) => err instanceof AiFailure && err.code === "PAYLOAD_TOO_LARGE");
});

// ── the output rules ──────────────────────────────────────────────────────────

test("output: the whitelist drops unknown model fields and flattens arrays to strings", () => {
  const out = whitelistOutput({
    summary: "kept",
    strengths: ["a", 1, null, "b"],
    recommendations: "not-an-array",
    risk_score: 0.42,
    injected_field: "dropped",
    nested: { secret: "dropped" },
  }, ANALYSIS_OUTPUT_FIELDS);
  assert.deepEqual(out, { summary: "kept", strengths: ["a", "b"], recommendations: "not-an-array", risk_score: 0.42 });
  assert.equal("injected_field" in out, false);
  assert.equal("nested" in out, false);
});

test("locale: validated body value, then the user's persisted locale, then en", () => {
  assert.equal(resolveAiLocale("fa", "en"), "fa");
  assert.equal(resolveAiLocale("FA", null), "fa");
  assert.equal(resolveAiLocale("de", "fa"), "fa", "an unvalidated body value must not win");
  assert.equal(resolveAiLocale(undefined, "fa"), "fa");
  assert.equal(resolveAiLocale("<script>", null), "en", "an invalid value is never echoed");
});

test("feedback: changed_fields is derived, and a no-op correction is refused", () => {
  assert.deepEqual(changedFieldNames({ symbol: "XAUUSD", lot: "0.10" }, { symbol: "XAUUSD", lot: "0.20" }), ["lot"]);
  assert.deepEqual(changedFieldNames({ a: 1 }, { a: 1, b: 2 }), ["b"]);
  assert.deepEqual(changedFieldNames({ a: 1 }, { a: 1 }), [], "nothing changed is not feedback");
});
