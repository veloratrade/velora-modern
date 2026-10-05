// Gemini implementation of the existing `AiProvider` port (ADR-018 §AI).
//
// WHY THIS FILE EXISTS AT ALL, GIVEN THE REPO'S PROVISIONAL POSITION.
// `aiProvider.ts` defines the port and ships `UnconfiguredAiProvider`; there has
// never been an HTTP implementation, and `aiCoachRoutes.ts` states plainly that
// generation "is not implemented and is not faked". That position is honest but
// it also means the journal assistant's "Analyze" button can only ever report
// PROVIDER_NOT_CONFIGURED.
//
// This file closes that gap WITHOUT touching the architecture: it is one more
// implementation of a port that already exists, it names itself `gemini` (one of
// the two providers 0017 admits), and every governance step stays where it is —
// consent, payload bounds, output validation and the attempt ledger all remain
// `AiCoachService`'s job. There is no second prompt pipeline, no retry policy, no
// caching layer hiding between the service and the model.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   * No streaming. The coach's contract is a structured insight, not a chat.
//   * No retries. A retry inside a provider makes "how many attempts did this
//     cost" unanswerable and doubles the user-visible latency of a failure; the
//     caller decides whether a second attempt is wanted.
//   * No free-text passthrough. The model is asked for ONE JSON object and its
//     answer is parsed as one; prose becomes an error, never stored content.
//   * No key in a log, an error, or a URL that anything but the fetch sees.
//
// EVIDENCE LABEL: this implementation has never been executed against the live
// API (no credential is in scope). Its parsing, timeout, error classification and
// key-redaction paths are covered by tests with an injected transport; the live
// round trip is NOT VERIFIED and is recorded as such in the phase report.
import {
  AiProviderNotConfiguredError,
  type AiGenerationRequest,
  type AiGenerationResult,
  type AiProvider,
} from "./aiProvider.js";

/** Bounded: an analysis runs inside a user-visible request, not a batch job. */
export const GEMINI_GENERATION_TIMEOUT_MS = 20_000;

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface GeminiProviderOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
}

const DEFAULT_MODEL = "gemini-2.0-flash";
const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * The instruction the model is given.
 *
 * The schema is stated in the prompt AND enforced afterwards, because a prompt
 * is a request, not a guarantee. `validateInsight` is the guarantee.
 */
const SYSTEM_PROMPT = [
  "You are the analysis component of a trading journal. You receive AGGREGATED FACTS about one trader's own closed trades.",
  "Reply with ONE JSON object and nothing else. No prose, no markdown, no code fences.",
  "Use exactly these keys:",
  '{"summary": string, "strengths": string[], "weaknesses": string[], "patterns": string[], "risk_notes": string[], "suggestions": string[]}',
  "Rules:",
  "- Refer only to the numbers you were given. If a conclusion is not supported by them, omit it.",
  "- Never invent trades, prices, instruments or account values.",
  "- Never state or imply a profit guarantee, an expected return, or advice to take a specific position.",
  "- Write in the language of the facts' `locale` field when present, otherwise in English.",
].join("\n");

export class GeminiAiProvider implements AiProvider {
  readonly name = "gemini" as const;
  readonly model: string;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #baseUrl: string;

  constructor(options: GeminiProviderOptions) {
    if (options.apiKey.trim() === "") throw new AiProviderNotConfiguredError();
    this.#apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.#fetch = options.fetchImpl ?? (fetch as unknown as FetchLike);
    this.#timeoutMs = options.timeoutMs ?? GEMINI_GENERATION_TIMEOUT_MS;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  }

  async generate(request: AiGenerationRequest): Promise<AiGenerationResult> {
    // The facts arrive already aggregated and already bounded by the service;
    // serializing them here is the ONLY place they leave this process.
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          role: "user",
          parts: [{ text: `prompt_version: ${request.promptVersion}\n\nFACTS:\n${JSON.stringify(request.facts)}` }],
        },
      ],
      generationConfig: {
        // Determinism where it is cheap: the same journal should not produce a
        // different shape on every press of the button.
        temperature: 0.4,
        responseMimeType: "application/json",
      },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.#fetch(`${this.#baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.#apiKey },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      // The message of a fetch failure can embed the URL; the URL carries no key
      // (the key travels in a header), but the classification is what callers
      // need, so nothing from the original error is propagated.
      throw new AiProviderTransportError((err as Error)?.name === "AbortError" ? "TIMEOUT" : "NETWORK");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Status only. A provider's error body can echo the request, and the
      // request contains the user's aggregated journal facts.
      throw new AiProviderTransportError(response.status === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR", response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AiProviderTransportError("MALFORMED_RESPONSE", response.status);
    }
    const text = extractText(payload);
    if (text === null || text.trim() === "") throw new AiProviderTransportError("EMPTY_RESULT", response.status);

    let insight: unknown;
    try {
      insight = JSON.parse(stripCodeFence(text));
    } catch {
      // `responseMimeType: application/json` should make this impossible; the
      // contract still does not trust it, because a provider that answers with
      // prose must never end up stored as an insight.
      throw new AiProviderTransportError("UNPARSEABLE_OUTPUT", response.status);
    }
    if (insight === null || typeof insight !== "object" || Array.isArray(insight)) {
      throw new AiProviderTransportError("UNPARSEABLE_OUTPUT", response.status);
    }

    const usage = (payload as { usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown } }).usageMetadata;
    return {
      model: this.model,
      insight: insight as Record<string, unknown>,
      tokensIn: numberOrNull(usage?.promptTokenCount),
      tokensOut: numberOrNull(usage?.candidatesTokenCount),
      // Cost is NOT estimated here. A guessed price per token would put a
      // fabricated number into the ledger; 0017 admits NULL for exactly this.
      costMicroUsd: null,
    };
  }
}

/** A typed, loggable provider failure. Never carries a body, a key or a URL. */
export class AiProviderTransportError extends Error {
  constructor(
    readonly code: "TIMEOUT" | "NETWORK" | "RATE_LIMITED" | "PROVIDER_ERROR" | "MALFORMED_RESPONSE" | "EMPTY_RESULT" | "UNPARSEABLE_OUTPUT",
    readonly status?: number,
  ) {
    super(`ai provider: ${code}`);
    this.name = "AiProviderTransportError";
  }
}

/** Pull the first candidate's text out of the provider envelope, or null. */
function extractText(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const parts = (candidates[0] as { content?: { parts?: unknown } })?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const texts = parts
    .map((part) => (part !== null && typeof part === "object" ? (part as { text?: unknown }).text : null))
    .filter((text): text is string => typeof text === "string");
  return texts.length === 0 ? null : texts.join("");
}

/** Tolerate a fenced answer; never tolerate non-JSON. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "").trim();
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
