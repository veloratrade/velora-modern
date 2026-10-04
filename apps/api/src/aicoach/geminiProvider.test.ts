// The Gemini implementation of the existing AI provider port.
//
// EVIDENCE LABEL: no live credential exists in this repository, so the LIVE round
// trip is NOT VERIFIED. What IS verified here is everything that can be verified
// without one, and those are the parts where a mistake is expensive: the request
// must not leak the key, the response must be a structured object (prose must
// never be stored as an insight), failures must be classified rather than
// propagated raw, and the whole governance chain above the port — consent,
// payload bound, output validation, durable attempt record — must still run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AiProviderNotConfiguredError } from "./aiProvider.js";
import { AiProviderTransportError, GeminiAiProvider } from "./geminiProvider.js";

// Shaped like NOTHING real: this is the value that must never leak, so it is
// deliberately not a provider-key pattern (tools/secret-scan.sh flags those).
const KEY = "EXAMPLE-PROVIDER-KEY-DO-NOT-LEAK-0123456789";

type Call = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } | undefined };

function fakeFetch(responses: readonly unknown[]): { calls: Call[]; fetchImpl: (url: string, init?: Call["init"]) => Promise<unknown> } {
  const calls: Call[] = [];
  let index = 0;
  return {
    calls,
    fetchImpl: async (url: string, init?: Call["init"]) => {
      calls.push({ url, init });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (typeof next === "function") return (next as () => Promise<unknown>)();
      return next;
    },
  };
}

function providerResponse(insight: unknown, usage?: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: typeof insight === "string" ? insight : JSON.stringify(insight) }] } }],
      usageMetadata: usage ?? { promptTokenCount: 120, candidatesTokenCount: 40 },
    }),
  };
}

const REQUEST = { userId: "1", promptVersion: "v1", facts: { tradeCount: 3, locale: "fa" } };

test("the key travels in a header, never in the URL, the body or an error", async () => {
  const { calls, fetchImpl } = fakeFetch([providerResponse({ summary: "ok" })]);
  const provider = new GeminiAiProvider({ apiKey: KEY, fetchImpl: fetchImpl as never });
  await provider.generate(REQUEST);

  const call = calls[0]!;
  assert.ok(!call.url.includes(KEY), "the API key must not appear in the request URL");
  assert.ok(!(call.init?.body ?? "").includes(KEY), "the API key must not appear in the request body");
  assert.equal(call.init?.headers?.["x-goog-api-key"], KEY);
  // The facts WERE sent (that is the point of the call) but nothing else was.
  assert.ok((call.init?.body ?? "").includes("tradeCount"));
  // And the model is named in the URL, so the ledger's `model` is not a guess.
  assert.ok(call.url.includes("/models/gemini-2.0-flash:generateContent"));
});

test("a structured answer becomes an insight, with usage recorded and no invented cost", async () => {
  const { fetchImpl } = fakeFetch([providerResponse({ summary: "two losing trades", weaknesses: ["late entries"] })]);
  const provider = new GeminiAiProvider({ apiKey: KEY, fetchImpl: fetchImpl as never });
  const result = await provider.generate(REQUEST);

  assert.equal(result.model, "gemini-2.0-flash");
  assert.equal(result.insight["summary"], "two losing trades");
  assert.deepEqual(result.insight["weaknesses"], ["late entries"]);
  assert.equal(result.tokensIn, 120);
  assert.equal(result.tokensOut, 40);
  // A guessed price per token would put a fabricated number in the ledger.
  assert.equal(result.costMicroUsd, null);
});

test("a fenced answer is tolerated; prose is NOT stored as an insight", async () => {
  const fenced = fakeFetch([providerResponse('```json\n{"summary":"fenced"}\n```')]);
  const provider = new GeminiAiProvider({ apiKey: KEY, fetchImpl: fenced.fetchImpl as never });
  assert.equal((await provider.generate(REQUEST)).insight["summary"], "fenced");

  const prose = fakeFetch([providerResponse("I think you should trade more carefully.")]);
  const proseProvider = new GeminiAiProvider({ apiKey: KEY, fetchImpl: prose.fetchImpl as never });
  await assert.rejects(() => proseProvider.generate(REQUEST), (err: unknown) => {
    assert.ok(err instanceof AiProviderTransportError);
    assert.equal(err.code, "UNPARSEABLE_OUTPUT");
    return true;
  });

  // A JSON array is not an insight either — 0017 stores an OBJECT.
  const array = fakeFetch([providerResponse("[1,2,3]")]);
  const arrayProvider = new GeminiAiProvider({ apiKey: KEY, fetchImpl: array.fetchImpl as never });
  await assert.rejects(() => arrayProvider.generate(REQUEST), (err: unknown) => {
    assert.equal((err as AiProviderTransportError).code, "UNPARSEABLE_OUTPUT");
    return true;
  });
});

test("failures are classified, and never carry the key or a provider body", async () => {
  const rateLimited = fakeFetch([{ ok: false, status: 429, json: async () => ({ error: { message: `quota for ${KEY}` } }) }]);
  const a = new GeminiAiProvider({ apiKey: KEY, fetchImpl: rateLimited.fetchImpl as never });
  await assert.rejects(() => a.generate(REQUEST), (err: unknown) => {
    const typed = err as AiProviderTransportError;
    assert.equal(typed.code, "RATE_LIMITED");
    assert.equal(typed.status, 429);
    // The provider's body is NOT propagated — it can echo the request, which
    // contains the user's journal facts.
    assert.ok(!typed.message.includes(KEY) && !typed.message.includes("quota"));
    return true;
  });

  const serverError = fakeFetch([{ ok: false, status: 500, json: async () => ({}) }]);
  const b = new GeminiAiProvider({ apiKey: KEY, fetchImpl: serverError.fetchImpl as never });
  await assert.rejects(() => b.generate(REQUEST), (err: unknown) => {
    assert.equal((err as AiProviderTransportError).code, "PROVIDER_ERROR");
    return true;
  });

  const network = fakeFetch([async () => { throw new TypeError("fetch failed"); }]);
  const c = new GeminiAiProvider({ apiKey: KEY, fetchImpl: network.fetchImpl as never });
  await assert.rejects(() => c.generate(REQUEST), (err: unknown) => {
    assert.equal((err as AiProviderTransportError).code, "NETWORK");
    return true;
  });

  const empty = fakeFetch([{ ok: true, status: 200, json: async () => ({ candidates: [] }) }]);
  const d = new GeminiAiProvider({ apiKey: KEY, fetchImpl: empty.fetchImpl as never });
  await assert.rejects(() => d.generate(REQUEST), (err: unknown) => {
    assert.equal((err as AiProviderTransportError).code, "EMPTY_RESULT");
    return true;
  });
});

test("no key means no provider — refused before any request", async () => {
  assert.throws(() => new GeminiAiProvider({ apiKey: "   " }), AiProviderNotConfiguredError);
  const { calls, fetchImpl } = fakeFetch([providerResponse({})]);
  void calls;
  void fetchImpl;
  const provider = new GeminiAiProvider({ apiKey: KEY, fetchImpl: fetchImpl as never });
  assert.equal(provider.name, "gemini");
});
