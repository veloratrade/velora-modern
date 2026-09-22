// Provider-boundary battery for the AI Coach (directive t, pass 2).
//
// WHAT THIS PROVES: consent is checked BEFORE any provider call, the payload bound
// is enforced before egress, provider output is validated before persistence, and
// every attempt — success, refusal, error — is recorded with an outcome 0017's
// CHECK accepts.
//
// WHAT IT DOES NOT PROVE: that any real provider answers. There is no credential in
// this environment, so every live path is NOT_PROVEN and the boundary is exercised
// with a stub. No test asserts on model text, and none fabricates an insight.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_INSIGHT_BYTES,
  MAX_PAYLOAD_BYTES,
  MemoryAiAttemptStore,
  UnconfiguredAiProvider,
  checkPayloadSize,
  validateInsight,
  type AiGenerationResult,
  type AiProvider,
} from "./aiProvider.js";
import { AiCoachService, INSIGHT_PROMPT_VERSION } from "./aiCoachService.js";

const CONSENTED = { consentState: async () => ({ consented: true, consentedAt: "2026-09-01T00:00:00.000Z" }) };
const UNCONSENTED = { consentState: async () => ({ consented: false, consentedAt: null }) };

/** A stub that counts calls, so "the provider was never called" is assertable. */
class StubProvider implements AiProvider {
  readonly name = "openai" as const;
  readonly model = "stub-model-v1";
  calls = 0;
  constructor(private readonly behaviour: "ok" | "throw" | "malformed" | "empty" | "huge") {}

  async generate(): Promise<AiGenerationResult> {
    this.calls += 1;
    if (this.behaviour === "throw") throw new Error("provider said: <user notes leaked here>");
    const insight =
      this.behaviour === "ok"
        ? { summary: "two losing trades on Fridays", recommendations: ["reduce size"] }
        : this.behaviour === "malformed"
          ? ("not an object" as unknown as Record<string, unknown>)
          : this.behaviour === "empty"
            ? {}
            : { blob: "x".repeat(MAX_INSIGHT_BYTES + 1) };
    return { model: this.model, insight, tokensIn: 120, tokensOut: 60, costMicroUsd: 900 };
  }
}

const service = (provider: AiProvider, consent: typeof CONSENTED, attempts: MemoryAiAttemptStore) =>
  new AiCoachService({ provider, consent, attempts, allowedProviders: ["openai", "gemini"] });

test("without consent the provider is NEVER called, and the refusal is recorded", async () => {
  const provider = new StubProvider("ok");
  const attempts = new MemoryAiAttemptStore();
  const outcome = await service(provider, UNCONSENTED, attempts).generate({ userId: "1", facts: { tradeCount: 3 } });

  assert.deepEqual(outcome, { status: "refused", code: "CONSENT_REQUIRED" });
  assert.equal(provider.calls, 0, "consent is checked BEFORE the payload reaches a provider");
  assert.equal(attempts.entries.length, 1, "a refusal is data, not silence");
  assert.equal(attempts.entries[0]?.outcome, "refused");
  assert.equal(attempts.entries[0]?.errorCode, "CONSENT_REQUIRED");
  assert.deepEqual(attempts.entries[0]?.insight, {}, "0017 requires a JSON object; nothing is invented");
  assert.equal(attempts.entries[0]?.promptVersion, INSIGHT_PROMPT_VERSION);
});

test("no provider credential: a typed refusal, no insight, and NOTHING fabricated", async () => {
  const attempts = new MemoryAiAttemptStore();
  const outcome = await service(new UnconfiguredAiProvider(), CONSENTED, attempts).generate({
    userId: "1",
    facts: { tradeCount: 1 },
  });

  assert.deepEqual(outcome, { status: "refused", code: "PROVIDER_NOT_CONFIGURED" });
  assert.equal(attempts.entries[0]?.outcome, "refused");
  assert.equal(attempts.entries[0]?.errorCode, "PROVIDER_NOT_CONFIGURED");
  assert.equal("insight" in outcome, false, "the caller receives no content at all");
});

test("an oversized fact payload is refused BEFORE any network call", async () => {
  const provider = new StubProvider("ok");
  const attempts = new MemoryAiAttemptStore();
  const facts = { notes: "y".repeat(MAX_PAYLOAD_BYTES + 1) };
  const outcome = await service(provider, CONSENTED, attempts).generate({ userId: "1", facts });

  assert.deepEqual(outcome, { status: "refused", code: "PAYLOAD_TOO_LARGE" });
  assert.equal(provider.calls, 0, "the bound is enforced before egress, not after");
  assert.equal(checkPayloadSize({ ok: true }).ok, true);
});

test("a successful generation is persisted with its provenance and tokens", async () => {
  const provider = new StubProvider("ok");
  const attempts = new MemoryAiAttemptStore();
  const outcome = await service(provider, CONSENTED, attempts).generate({
    userId: "1",
    facts: { tradeCount: 12, winRate: "0.5000" },
    windowFrom: "2026-09-01T00:00:00.000Z",
    windowTo: "2026-09-20T00:00:00.000Z",
    tradesAnalyzed: 12,
  });

  assert.equal(outcome.status, "generated");
  assert.equal(provider.calls, 1);
  const entry = attempts.entries[0];
  assert.equal(entry?.outcome, "success");
  assert.equal(entry?.errorCode, null);
  assert.equal(entry?.model, "stub-model-v1");
  assert.equal(entry?.tokensIn, 120);
  assert.equal(entry?.tokensOut, 60);
  assert.equal(entry?.costMicroUsd, 900);
  assert.equal(entry?.tradesAnalyzed, 12);
  // 0017's contract: the STRUCTURED insight only — no raw prompt, no raw response.
  assert.deepEqual(Object.keys(entry?.insight ?? {}), ["summary", "recommendations"]);
});

test("provider failures are recorded as errors, and the provider's own message is never stored", async () => {
  const attempts = new MemoryAiAttemptStore();
  const outcome = await service(new StubProvider("throw"), CONSENTED, attempts).generate({ userId: "1", facts: {} });

  assert.deepEqual(outcome, { status: "error", code: "PROVIDER_ERROR" });
  const entry = attempts.entries[0];
  assert.equal(entry?.outcome, "error");
  assert.equal(entry?.errorCode, "PROVIDER_ERROR");
  assert.equal(JSON.stringify(entry).includes("leaked"), false, "a provider message may quote user content — it is dropped");
});

test("malformed or empty provider output is refused before it is stored as an insight", async () => {
  for (const behaviour of ["malformed", "empty", "huge"] as const) {
    const attempts = new MemoryAiAttemptStore();
    const outcome = await service(new StubProvider(behaviour), CONSENTED, attempts).generate({
      userId: "1",
      facts: {},
    });
    assert.deepEqual(outcome, { status: "error", code: "INVALID_PROVIDER_OUTPUT" }, behaviour);
    assert.equal(attempts.entries[0]?.outcome, "error");
    assert.deepEqual(attempts.entries[0]?.insight, {}, "no partial or unvalidated content is stored");
  }
  assert.deepEqual(validateInsight({ a: 1 }), { ok: true });
  assert.deepEqual(validateInsight([]), { ok: false, reason: "not-an-object" });
  assert.deepEqual(validateInsight({}), { ok: false, reason: "empty-insight" });
});

test("a provider name the schema cannot store is never called", async () => {
  class RogueProvider extends StubProvider {
    readonly name = "anthropic" as unknown as "openai";
  }
  const provider = new RogueProvider("ok");
  const attempts = new MemoryAiAttemptStore();
  const outcome = await service(provider, CONSENTED, attempts).generate({ userId: "1", facts: {} });

  assert.deepEqual(outcome, { status: "error", code: "PROVIDER_NAME_INVALID" });
  assert.equal(provider.calls, 0, "an unrecordable call is an unaccountable one");
});
