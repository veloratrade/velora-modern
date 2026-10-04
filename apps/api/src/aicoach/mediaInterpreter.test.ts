// Media interpretation — voice and screenshots at the SAME AI boundary.
//
// THE DEFAULT IS THE PRODUCT DECISION HERE, NOT AN IMPLEMENTATION DETAIL. With no
// provider credential the interpreter throws a typed not-configured error, the
// user gets a clear sentence, and no transcript, no "best guess" OCR and no
// partial field is invented. A local heuristic that guessed at a garbled voice
// message would put a number into a financial record that the trader never said.
//
// THE REST OF THE FILE PINS THE GOVERNANCE QUESTIONS AN AUDITOR ASKS:
//   * is every attempt on the ledger, including refusals and failures?
//   * does a raw provider answer ever get stored or shown?
//   * can a misread screenshot overwrite something the user typed?
//   * does the API key leak into an error, a URL or a stored field?
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GeminiMediaInterpreter,
  MAX_MEDIA_BYTES,
  MediaInterpreterError,
  UnconfiguredMediaInterpreter,
  interpretImageAndRecord,
  transcribeAndRecord,
} from "./mediaInterpreter.js";
import type { AiAttemptRecord, AiAttemptStore } from "./aiProvider.js";

class Ledger implements AiAttemptStore {
  readonly rows: AiAttemptRecord[] = [];
  readonly debugRow = (i: number) => this.rows[i];
  async record(entry: AiAttemptRecord): Promise<{ id: string }> {
    this.rows.push(entry);
    return { id: `attempt-${this.rows.length}` };
  }
}

class ExplodingLedger implements AiAttemptStore {
  async record(): Promise<{ id: string }> {
    throw new Error("ledger is down");
  }
}

/** A transport that answers with a fixed body and records the request. */
function gemini(body: unknown, options: { ok?: boolean; status?: number; throwAbort?: boolean } = {}) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const impl = async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, headers: init?.headers ?? {}, body: init?.body ?? "" });
    if (options.throwAbort === true) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    return { ok: options.ok ?? true, status: options.status ?? 200, json: async () => body };
  };
  return { impl, calls };
}

const candidates = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });

test("with no credential, voice and image both fail closed — nothing is invented", async () => {
  const interpreter = new UnconfiguredMediaInterpreter();
  const ledger = new Ledger();
  const deps = { interpreter, attempts: ledger };

  const voice = await transcribeAndRecord(deps, { userId: "user-1", audio: Buffer.from("fake"), mimeType: "audio/ogg", languageHint: "fa-IR", feature: "transcribe" });
  assert.deepEqual(voice, { ok: false, code: "PROVIDER_NOT_CONFIGURED" });

  const image = await interpretImageAndRecord(deps, { userId: "user-1", image: Buffer.from("fake"), mimeType: "image/png" });
  assert.deepEqual(image, { ok: false, code: "PROVIDER_NOT_CONFIGURED" });

  // Both attempts are on the SAME ledger as coaching attempts, marked `refused`
  // rather than failed: an unconfigured provider is a deployment fact, not an error.
  assert.equal(ledger.rows.length, 2);
  assert.ok(ledger.rows.every((r) => r.outcome === "refused" && r.errorCode === "PROVIDER_NOT_CONFIGURED"));
  assert.ok(ledger.rows.every((r) => r.promptVersion === "media-v1" && r.costMicroUsd === null));
  assert.deepEqual(ledger.rows.map((r) => r.feature), ["transcribe", "vision_extract"]);
  // The provider field names the provider that WOULD have been used, so the
  // ledger does not read as if a call to "unconfigured" ever happened.
  assert.ok(ledger.rows.every((r) => r.provider === "gemini"));
});

test("a ledger outage never turns a successful transcription into a user-visible failure", async () => {
  const interpreter = { name: "gemini" as const, model: "gemini-2.0-flash", async transcribe() { return { text: "خرید طلا", model: "gemini-2.0-flash" }; }, async interpretImage() { throw new Error("unused"); } };
  const result = await transcribeAndRecord({ interpreter, attempts: new ExplodingLedger() }, { userId: "user-1", audio: Buffer.from("a"), mimeType: "audio/ogg", languageHint: "fa-IR", feature: "transcribe" });
  assert.deepEqual(result, { ok: true, text: "خرید طلا", model: "gemini-2.0-flash" });
});

test("a transcript is stored as CHARACTER COUNT ONLY — never the text itself", async () => {
  const SPOKEN = "من طلا خریدم در ۲۶۵۰";
  const interpreter = { name: "gemini" as const, model: "gemini-2.0-flash", async transcribe() { return { text: SPOKEN, model: "gemini-2.0-flash" }; }, async interpretImage() { throw new Error("unused"); } };
  const ledger = new Ledger();
  await transcribeAndRecord({ interpreter, attempts: ledger }, { userId: "user-1", audio: Buffer.from("a"), mimeType: "audio/ogg", languageHint: "fa-IR", feature: "transcribe" });

  const row = ledger.rows[0]!;
  assert.deepEqual(row.insight, { chars: SPOKEN.length });
  assert.ok(!JSON.stringify(row).includes("طلا"), "the transcript is not an insight and must not be retained as one");
  assert.equal(row.outcome, "success");
});

test("the model reads only what is visible; absent fields stay null instead of being guessed", async () => {
  const t = gemini(candidates('```json\n{"symbol":"xauusd","direction":"buy","entryPrice":"2,650.50","stopLoss":null,"takeProfit":"not-a-number"}\n```'));
  const interpreter = new GeminiMediaInterpreter({ apiKey: "k", fetchImpl: t.impl as never });

  const result = await interpreter.interpretImage({ userId: "user-1", image: Buffer.from("png"), mimeType: "image/png" });
  assert.deepEqual(result.fields, { symbol: "XAUUSD", direction: "buy", entryPrice: "2650.50", stopLoss: null, takeProfit: null });

  // The prompt itself must ask for nulls and forbid guessing — a model told to
  // "fill in the fields" invents prices, which is the failure this guards.
  const sent = JSON.parse(t.calls[0]!.body) as { contents: { parts: { text?: string }[] }[] };
  const prompt = sent.contents[0]!.parts[0]!.text ?? "";
  assert.match(prompt, /Do not guess/);
  assert.match(prompt, /null/);
});

test("prose or an array answer is EMPTY_RESULT, never stored as fields", async () => {
  for (const text of ["I could not read the chart clearly.", '["XAUUSD", "buy"]', ""]) {
    const t = gemini(candidates(text));
    const interpreter = new GeminiMediaInterpreter({ apiKey: "k", fetchImpl: t.impl as never });
    await assert.rejects(
      () => interpreter.interpretImage({ userId: "user-1", image: Buffer.from("png"), mimeType: "image/png" }),
      (err: MediaInterpreterError) => err.code === "EMPTY_RESULT",
      `answer ${JSON.stringify(text)} must not become fields`,
    );
  }
});

test("the API key travels in a header only, and appears in no error", async () => {
  const KEY = "NOT-A-REAL-PROVIDER-KEY-0000000000"; // deliberately not shaped like a real key
  const ok = gemini(candidates("hello"));
  await new GeminiMediaInterpreter({ apiKey: KEY, fetchImpl: ok.impl as never }).transcribe({ userId: "u", audio: Buffer.from("a"), mimeType: "audio/ogg", languageHint: "fa-IR" });
  assert.equal(ok.calls[0]!.headers["x-goog-api-key"], KEY);
  assert.ok(!ok.calls[0]!.url.includes(KEY), "a key in a URL ends up in every proxy log");
  assert.ok(!ok.calls[0]!.body.includes(KEY));

  const failing = gemini({ error: { message: `API key not valid: ${KEY}` } }, { ok: false, status: 400 });
  await assert.rejects(
    () => new GeminiMediaInterpreter({ apiKey: KEY, fetchImpl: failing.impl as never }).transcribe({ userId: "u", audio: Buffer.from("a"), mimeType: "audio/ogg", languageHint: "fa-IR" }),
    (err: MediaInterpreterError) => {
      assert.equal(err.code, "PROVIDER_ERROR");
      assert.ok(!err.message.includes(KEY), "the provider's own error text quotes the key; it must not be propagated");
      assert.ok(!JSON.stringify(err).includes(KEY));
      return true;
    },
  );
});

test("media above the cap is refused before any request is made", async () => {
  const t = gemini(candidates("x"));
  const interpreter = new GeminiMediaInterpreter({ apiKey: "k", fetchImpl: t.impl as never });
  await assert.rejects(
    () => interpreter.transcribe({ userId: "u", audio: Buffer.alloc(MAX_MEDIA_BYTES + 1), mimeType: "audio/ogg", languageHint: "fa-IR" }),
    (err: MediaInterpreterError) => err.code === "TOO_LARGE",
  );
  assert.equal(t.calls.length, 0, "an oversized payload must not be uploaded and then rejected");
});

test("a provider timeout is classified as TIMEOUT and recorded as a failure", async () => {
  const t = gemini(candidates("x"), { throwAbort: true });
  const interpreter = new GeminiMediaInterpreter({ apiKey: "k", fetchImpl: t.impl as never });
  const ledger = new Ledger();

  const result = await transcribeAndRecord({ interpreter, attempts: ledger }, { userId: "u", audio: Buffer.from("a"), mimeType: "audio/ogg", languageHint: "fa-IR", feature: "transcribe" });
  assert.deepEqual(result, { ok: false, code: "TIMEOUT" });
  assert.equal(ledger.rows[0]!.outcome, "error");
  assert.equal(ledger.rows[0]!.errorCode, "TIMEOUT");
  assert.deepEqual(ledger.rows[0]!.insight, {}, "a failed attempt stores an empty object, never invented content");
});
