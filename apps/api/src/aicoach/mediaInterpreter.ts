// Media interpretation — voice transcription and chart-image reading (ADR-018).
//
// THIS IS THE SAME AI BOUNDARY, NOT A SECOND ONE.
//   `mediaInterpreter.ts` sits beside `aiProvider.ts` and obeys its rules:
//   the port is injected, the default implementation FAILS CLOSED, every attempt
//   (success, refusal, error) is recorded in the SAME `ai_coaching_logs` ledger
//   (now discriminated by `feature`), and nothing here fabricates content. A
//   transcript a user is shown came from a configured provider, or it does not
//   exist — there is no local speech heuristic and no "best guess" OCR.
//
// WHAT IS ACTUALLY VERIFIED
//   The DEFAULT is `UnconfiguredMediaInterpreter`, which throws a typed error:
//   with no provider credential, voice and screenshots produce a clear message to
//   the user and no data. `GeminiMediaInterpreter` is implemented against the
//   documented REST shape and exercised with an INJECTED transport; a live call
//   is NOT VERIFIED in this repository's evidence (no provider credential is in
//   scope), and the docs say exactly that.
//
// WHY GEMINI AND NOT n8n
//   `docs/capability-registry.md` records the Remote/PHP era's
//   `GeminiTransportInterface` with a direct and an `n8n_relay` variant. That
//   relay does not exist in Modern: there is no relay URL, no relay contract and
//   no relay deployment, so building one here would be inventing an integration
//   rather than reusing one. The direct transport is implemented, the relay is
//   recorded as an open gap in the ADR, and the seam (`MediaInterpreter`) is the
//   single place a relay would be added later.
import type { AiAttemptFeature, AiAttemptRecord, AiAttemptStore, AiProviderName } from "./aiProvider.js";

export class MediaInterpreterNotConfiguredError extends Error {
  constructor() {
    super("no media interpreter is configured");
    this.name = "MediaInterpreterNotConfiguredError";
  }
}

/** Raised when a configured provider failed. Fixed text; never a provider body. */
export class MediaInterpreterError extends Error {
  constructor(
    readonly code: "PROVIDER_ERROR" | "TIMEOUT" | "EMPTY_RESULT" | "UNSUPPORTED_MEDIA" | "TOO_LARGE",
  ) {
    super(`media interpreter: ${code}`);
    this.name = "MediaInterpreterError";
  }
}

export interface TranscriptionRequest {
  readonly userId: string;
  readonly audio: Buffer;
  readonly mimeType: string;
  /** BCP-47 hint for the provider. The product's primary locale is fa-IR. */
  readonly languageHint: string;
}

export interface TranscriptionResult {
  readonly text: string;
  readonly model: string;
}

export interface ImageInterpretationRequest {
  readonly userId: string;
  readonly image: Buffer;
  readonly mimeType: string;
}

/**
 * A structured reading of a chart screenshot.
 *
 * EVERY FIELD IS OPTIONAL AND NULLABLE BY DESIGN. An image may show a stop loss
 * and not a volume; the interpreter reports what it read and leaves the rest
 * absent. The caller merges these into a draft WITHOUT overwriting anything the
 * user already typed, and the confirmation card shows the merged result — so a
 * misread screenshot is visible to the user before anything is written.
 */
export interface ImageInterpretationResult {
  readonly model: string;
  readonly fields: {
    readonly symbol: string | null;
    readonly direction: "buy" | "sell" | null;
    readonly entryPrice: string | null;
    readonly stopLoss: string | null;
    readonly takeProfit: string | null;
  };
}

export interface MediaInterpreter {
  readonly name: AiProviderName | "unconfigured";
  readonly model: string;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
  interpretImage(request: ImageInterpretationRequest): Promise<ImageInterpretationResult>;
}

/** The default: configured, uncredentialed, and honest about it. */
export class UnconfiguredMediaInterpreter implements MediaInterpreter {
  readonly name = "unconfigured" as const;
  readonly model = "unconfigured";

  async transcribe(): Promise<TranscriptionResult> {
    throw new MediaInterpreterNotConfiguredError();
  }

  async interpretImage(): Promise<ImageInterpretationResult> {
    throw new MediaInterpreterNotConfiguredError();
  }
}

/** Upper bound on media sent to a provider, matching the Telegram download cap. */
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
export const MEDIA_REQUEST_TIMEOUT_MS = 30_000;

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface GeminiInterpreterOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
}

const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";
const DEFAULT_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Direct Gemini transport.
 *
 * TWO PROPERTIES ARE NON-NEGOTIABLE AND ARE ENFORCED HERE RATHER THAN BY CALLERS:
 *   * the response is parsed into a STRUCTURED result — a provider that answers
 *     with prose produces `EMPTY_RESULT`, not content that gets stored;
 *   * the API key never appears in an error, a log line or a URL that anything
 *     other than the fetch call can see (`revealKey()` is private and used once).
 */
export class GeminiMediaInterpreter implements MediaInterpreter {
  readonly name: AiProviderName = "gemini";
  readonly model: string;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #baseUrl: string;

  constructor(options: GeminiInterpreterOptions) {
    this.#apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_GEMINI_MODEL;
    this.#fetch = options.fetchImpl ?? (fetch as unknown as FetchLike);
    this.#timeoutMs = options.timeoutMs ?? MEDIA_REQUEST_TIMEOUT_MS;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_GEMINI_BASE).replace(/\/+$/, "");
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    if (request.audio.length > MAX_MEDIA_BYTES) throw new MediaInterpreterError("TOO_LARGE");
    const prompt =
      "Transcribe this voice message verbatim. It is a trader describing a trade in Persian or English. " +
      "Reply with the transcript text only — no commentary, no translation, no formatting.";
    const text = await this.generateText([
      { text: prompt },
      { inlineData: { mimeType: request.mimeType, data: request.audio.toString("base64") } },
    ]);
    if (text === null || text.trim() === "") throw new MediaInterpreterError("EMPTY_RESULT");
    return { text: text.trim().slice(0, 5000), model: this.model };
  }

  async interpretImage(request: ImageInterpretationRequest): Promise<ImageInterpretationResult> {
    if (request.image.length > MAX_MEDIA_BYTES) throw new MediaInterpreterError("TOO_LARGE");
    const prompt = [
      "This is a trading chart screenshot. Read only what is VISIBLE.",
      "Reply with a single JSON object with exactly these keys:",
      '{"symbol": string|null, "direction": "buy"|"sell"|null, "entryPrice": string|null, "stopLoss": string|null, "takeProfit": string|null}',
      "Use null for anything not clearly visible. Do not guess. Numbers must be plain decimal strings.",
    ].join("\n");
    const text = await this.generateText([
      { text: prompt },
      { inlineData: { mimeType: request.mimeType, data: request.image.toString("base64") } },
    ]);
    if (text === null) throw new MediaInterpreterError("EMPTY_RESULT");
    const parsed = parseLooseJson(text);
    if (parsed === null) throw new MediaInterpreterError("EMPTY_RESULT");
    return {
      model: this.model,
      fields: {
        symbol: stringOrNull(parsed["symbol"]),
        direction: parsed["direction"] === "buy" || parsed["direction"] === "sell" ? parsed["direction"] : null,
        entryPrice: decimalOrNull(parsed["entryPrice"]),
        stopLoss: decimalOrNull(parsed["stopLoss"]),
        takeProfit: decimalOrNull(parsed["takeProfit"]),
      },
    };
  }

  private async generateText(parts: readonly Record<string, unknown>[]): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}/models/${this.model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.#apiKey },
        body: JSON.stringify({ contents: [{ parts }] }),
        signal: controller.signal,
      });
      if (!response.ok) throw new MediaInterpreterError("PROVIDER_ERROR");
      const body = (await response.json()) as Record<string, unknown>;
      const candidates = Array.isArray(body["candidates"]) ? (body["candidates"] as Record<string, unknown>[]) : [];
      const content = candidates[0]?.["content"] as Record<string, unknown> | undefined;
      const outParts = Array.isArray(content?.["parts"]) ? (content?.["parts"] as Record<string, unknown>[]) : [];
      const text = outParts.map((p) => (typeof p["text"] === "string" ? p["text"] : "")).join("");
      return text === "" ? null : text;
    } catch (err) {
      if (err instanceof MediaInterpreterError) throw err;
      const aborted = typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError";
      throw new MediaInterpreterError(aborted ? "TIMEOUT" : "PROVIDER_ERROR");
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Extract a JSON object from a fenced or prose-wrapped provider answer. */
function parseLooseJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z0-9._/]{3,16}$/.test(trimmed) ? trimmed : null;
}

function decimalOrNull(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/,/g, "");
  return /^\d+(?:\.\d+)?$/.test(trimmed) ? trimmed : null;
}

/**
 * Record the ATTEMPT, whatever its outcome.
 *
 * Mirrors `AiCoachService`'s governance order (attempt → call → validate →
 * record) so "the provider is not configured" and "the provider failed" stay
 * distinguishable afterwards instead of both looking like silence.
 */
export async function transcribeAndRecord(
  deps: { readonly interpreter: MediaInterpreter; readonly attempts: AiAttemptStore },
  request: TranscriptionRequest & { readonly feature: AiAttemptFeature },
): Promise<{ readonly ok: true; readonly text: string; readonly model: string } | { readonly ok: false; readonly code: string }> {
  const base = {
    userId: request.userId,
    feature: request.feature,
    provider: (deps.interpreter.name === "unconfigured" ? "gemini" : deps.interpreter.name) as AiProviderName,
    model: deps.interpreter.model,
    promptVersion: "media-v1",
    windowFrom: null,
    windowTo: null,
    tradesAnalyzed: null,
  };
  try {
    const result = await deps.interpreter.transcribe(request);
    await recordAttempt(deps.attempts, { ...base, model: result.model, insight: { chars: result.text.length }, tokensIn: null, tokensOut: null, costMicroUsd: null, outcome: "success", errorCode: null });
    return { ok: true, text: result.text, model: result.model };
  } catch (err) {
    const code = err instanceof MediaInterpreterNotConfiguredError ? "PROVIDER_NOT_CONFIGURED" : err instanceof MediaInterpreterError ? err.code : "PROVIDER_ERROR";
    await recordAttempt(deps.attempts, {
      ...base,
      insight: {},
      tokensIn: null,
      tokensOut: null,
      costMicroUsd: null,
      outcome: code === "PROVIDER_NOT_CONFIGURED" ? "refused" : "error",
      errorCode: code,
    });
    return { ok: false, code };
  }
}

/** Image counterpart of `transcribeAndRecord`. Same ordering, same ledger. */
export async function interpretImageAndRecord(
  deps: { readonly interpreter: MediaInterpreter; readonly attempts: AiAttemptStore },
  request: ImageInterpretationRequest,
): Promise<{ readonly ok: true; readonly fields: ImageInterpretationResult["fields"]; readonly model: string } | { readonly ok: false; readonly code: string }> {
  const base = {
    userId: request.userId,
    feature: "vision_extract" as const,
    provider: (deps.interpreter.name === "unconfigured" ? "gemini" : deps.interpreter.name) as AiProviderName,
    model: deps.interpreter.model,
    promptVersion: "media-v1",
    windowFrom: null,
    windowTo: null,
    tradesAnalyzed: null,
  };
  try {
    const result = await deps.interpreter.interpretImage(request);
    // Only the STRUCTURED fields are retained — never the image, never the raw
    // provider answer (0017's prohibition, applied to media).
    await recordAttempt(deps.attempts, { ...base, model: result.model, insight: { ...result.fields }, tokensIn: null, tokensOut: null, costMicroUsd: null, outcome: "success", errorCode: null });
    return { ok: true, fields: result.fields, model: result.model };
  } catch (err) {
    const code = err instanceof MediaInterpreterNotConfiguredError ? "PROVIDER_NOT_CONFIGURED" : err instanceof MediaInterpreterError ? err.code : "PROVIDER_ERROR";
    await recordAttempt(deps.attempts, {
      ...base,
      insight: {},
      tokensIn: null,
      tokensOut: null,
      costMicroUsd: null,
      outcome: code === "PROVIDER_NOT_CONFIGURED" ? "refused" : "error",
      errorCode: code,
    });
    return { ok: false, code };
  }
}

/** The ledger write must never mask the provider outcome with its own failure. */
async function recordAttempt(attempts: AiAttemptStore, record: AiAttemptRecord): Promise<void> {
  try {
    await attempts.record(record);
  } catch {
    // Deliberately swallowed: the ledger is an accountability record, and losing
    // one must not turn a successful transcription into a user-visible failure.
  }
}
