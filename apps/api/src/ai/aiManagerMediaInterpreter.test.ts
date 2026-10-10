import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AiAttemptRecord, AiAttemptStore } from "../aicoach/aiProvider.js";
import { interpretImageAndRecord, transcribeAndRecord } from "../aicoach/mediaInterpreter.js";
import { AiManagerMediaInterpreter } from "./aiManagerMediaInterpreter.js";
import type { AiCallOutcome, AiCallRequest, AiManager } from "./aiManager.js";

class Ledger implements AiAttemptStore {
  readonly rows: AiAttemptRecord[] = [];
  async record(entry: AiAttemptRecord): Promise<{ id: string }> {
    this.rows.push(entry);
    return { id: `attempt-${this.rows.length}` };
  }
}

class FakeManager {
  readonly calls: AiCallRequest[] = [];
  outcomes: AiCallOutcome[] = [];

  async call(request: AiCallRequest): Promise<AiCallOutcome> {
    this.calls.push(request);
    const outcome = this.outcomes.shift();
    if (outcome === undefined) throw new Error("test outcome missing");
    return outcome;
  }
}

const generated = (over: Partial<Extract<AiCallOutcome, { status: "generated" }>> = {}): AiCallOutcome => ({
  status: "generated", attemptId: "42", provider: "tesseract", model: "tesseract",
  route: null, fallbackIndex: 0, latencyMs: 8,
  insight: { fields: { symbol: "xauusd", direction: "buy", entryPrice: "2010.50", stopLoss: "2000", takeProfit: "bad" } },
  text: "BUY XAUUSD entry 2010.50", tokensIn: null, tokensOut: null, costMicroUsd: null,
  attempts: [{ provider: "tesseract", route: null, fallbackIndex: 0, outcome: "success", code: null, latencyMs: 8, attemptId: "42" }],
  ...over,
});

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("Telegram voice and image use AiManager, hash raw media, and never double-write attempts", async () => {
  const manager = new FakeManager();
  manager.outcomes.push(
    generated({ text: "I bought gold at 2010.50" }),
    generated({ insight: { fields: { symbol: "xauusd", direction: "buy", entryPrice: "2010.50", stopLoss: "2000", takeProfit: "invalid" } }, text: null }),
  );
  const interpreter = new AiManagerMediaInterpreter(manager as unknown as AiManager, () => 1_000);
  const ledger = new Ledger();

  const audio = Buffer.from("private audio bytes");
  const voice = await transcribeAndRecord({ interpreter, attempts: ledger }, {
    userId: "user-7", audio, mimeType: "audio/ogg", languageHint: "fa-IR", feature: "transcribe",
  });
  assert.deepEqual(voice, { ok: true, text: "I bought gold at 2010.50", model: "tesseract" });

  const image = Buffer.from("validated image bytes");
  const picture = await interpretImageAndRecord({ interpreter, attempts: ledger }, {
    userId: "user-7", image, mimeType: "image/png",
  });
  assert.deepEqual(picture, {
    ok: true,
    fields: { symbol: "XAUUSD", direction: "buy", entryPrice: "2010.50", stopLoss: "2000", takeProfit: null },
    model: "tesseract",
  });

  assert.equal(manager.calls.length, 2);
  assert.deepEqual(manager.calls.map((call) => [call.feature, call.ledgerFeature]), [["transcribe", "transcribe"], ["screenshot_extraction", "ocr"]]);
  assert.equal(manager.calls[0]!.audio?.bytes, audio);
  assert.equal(manager.calls[0]!.inputHash, hash(audio));
  assert.equal(manager.calls[1]!.image?.bytes, image);
  assert.equal(manager.calls[1]!.inputHash, hash(image));
  assert.equal(manager.calls[0]!.requiresStructuredOutput, false);
  assert.ok(manager.calls.every((call) => call.deadlineMs === 31_000));
  assert.equal(ledger.rows.length, 0, "AiManager owns the canonical attempt ledger; Telegram must not create duplicate rows");
});

test("Telegram media consent refusals are passed through without any provider-specific retry or duplicate ledger write", async () => {
  const manager = new FakeManager();
  manager.outcomes.push({ status: "refused", code: "CONSENT_REQUIRED", attempts: [] });
  const interpreter = new AiManagerMediaInterpreter(manager as unknown as AiManager, () => 10_000);
  const ledger = new Ledger();
  const result = await transcribeAndRecord({ interpreter, attempts: ledger }, {
    userId: "user-7", audio: Buffer.from("voice"), mimeType: "audio/ogg", languageHint: "fa-IR", feature: "transcribe",
  });
  assert.deepEqual(result, { ok: false, code: "CONSENT_REQUIRED" });
  assert.equal(ledger.rows.length, 0);
  assert.equal(manager.calls.length, 1);
});
