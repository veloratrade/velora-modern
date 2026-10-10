// Telegram media adapter over the one governed AI chain (ADR-018 / ADR-019).
//
// The old direct Gemini adapter bypassed consent, image anonymization and the
// feature route's attempt ledger. This adapter makes Telegram call AiManager for
// both voice and image; that manager is the only place allowed to perform egress.
// Its local Tesseract entry remains usable without third-party consent.
import { createHash } from "node:crypto";
import type {
  ImageInterpretationRequest,
  ImageInterpretationResult,
  MediaInterpreter,
  TranscriptionRequest,
  TranscriptionResult,
} from "../aicoach/mediaInterpreter.js";
import { MediaInterpreterError } from "../aicoach/mediaInterpreter.js";
import type { AiManager, AiCallOutcome } from "./aiManager.js";
import { SCREENSHOT_DEADLINE_MS } from "./screenshotExtraction.js";

const MEDIA_DEADLINE_MS = 30_000;
const MEDIA_ATTEMPT_TIMEOUT_MS = 20_000;

export class AiManagerMediaInterpreter implements MediaInterpreter {
  readonly name = "managed" as const;
  readonly model = "ai-manager";
  readonly managesAttempts = true;

  constructor(private readonly manager: AiManager, private readonly now: () => number = () => Date.now()) {}

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const call = await this.manager.call({
      userId: request.userId,
      feature: "transcribe",
      ledgerFeature: "transcribe",
      promptVersion: "telegram_transcription_v1",
      prompt: "Transcribe the voice message verbatim. It may be Persian or English. Do not translate or add commentary.",
      audio: { bytes: request.audio, mimeType: request.mimeType, languageHint: request.languageHint },
      deadlineMs: this.now() + MEDIA_DEADLINE_MS,
      attemptTimeoutMs: MEDIA_ATTEMPT_TIMEOUT_MS,
      inputHash: sha256(request.audio),
      requiresStructuredOutput: false,
    });
    if (call.status !== "generated") throw new MediaInterpreterError(outcomeCode(call));
    if (call.text === null || call.text.trim() === "") throw new MediaInterpreterError("EMPTY_RESULT");
    return { text: call.text.slice(0, 5000), model: call.model };
  }

  async interpretImage(request: ImageInterpretationRequest): Promise<ImageInterpretationResult> {
    const call = await this.manager.call({
      userId: request.userId,
      feature: "screenshot_extraction",
      ledgerFeature: "ocr",
      promptVersion: "screenshot_extraction_v1",
      prompt: "Read only clearly visible trade fields in the image. Do not guess; leave missing values null.",
      image: { bytes: request.image, mimeType: request.mimeType },
      deadlineMs: this.now() + SCREENSHOT_DEADLINE_MS,
      attemptTimeoutMs: MEDIA_ATTEMPT_TIMEOUT_MS,
      inputHash: sha256(request.image),
      requiresStructuredOutput: false,
    });
    if (call.status !== "generated") throw new MediaInterpreterError(outcomeCode(call));

    const raw = call.insight ?? {};
    const nested = raw["fields"];
    const fields = nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? nested as Record<string, unknown>
      : raw;
    return { model: call.model, fields: safeImageFields(fields) };
  }
}

function outcomeCode(call: Exclude<AiCallOutcome, { status: "generated" }>): string {
  return call.code;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeImageFields(fields: Readonly<Record<string, unknown>>): ImageInterpretationResult["fields"] {
  const rawSymbol = fields["symbol"];
  const symbol = typeof rawSymbol === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/u.test(rawSymbol.trim())
    ? rawSymbol.trim().toUpperCase()
    : null;
  const direction = fields["direction"] === "buy" || fields["direction"] === "sell" ? fields["direction"] : null;
  return {
    symbol,
    direction,
    entryPrice: decimalOrNull(fields["entryPrice"] ?? fields["entry_price"] ?? fields["entry"]),
    stopLoss: decimalOrNull(fields["stopLoss"] ?? fields["stop_loss"] ?? fields["sl"]),
    takeProfit: decimalOrNull(fields["takeProfit"] ?? fields["take_profit"] ?? fields["tp"]),
  };
}

function decimalOrNull(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (text.length > 32 || !/^-?\d{1,18}(?:\.\d{1,12})?$/u.test(text)) return null;
  return text;
}
