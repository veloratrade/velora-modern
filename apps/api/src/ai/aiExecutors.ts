// Provider executors — how a chain entry is actually carried out.
//
// ONE PORT, THREE IMPLEMENTATIONS. The manager walks a chain of
// (provider, model, route) entries and needs exactly one thing from each: "run
// this request, or fail with a classification". That is `AiExecutor`.
//
//   * `GeminiExecutor`  — direct HTTP through the EXISTING `GeminiAiProvider` /
//     `GeminiMediaInterpreter` (aicoach), or through the n8n relay when the
//     resolved route says so. There is no second Gemini HTTP client here.
//   * `TesseractExecutor` — the local OCR fallback.
//   * `UnavailableExecutor` — what Modern says about a provider it declares but
//     cannot call (openai: in the ledger vocabulary since 0017, no transport in
//     this repository). It refuses with a typed code instead of pretending.
//
// SECRETS ARE RESOLVED PER CALL, NOT AT BOOT. That is the property that makes an
// admin-saved key or relay config effective without a redeploy — the reason
// Legacy built `SecureCredentialStore` + `RelayConfigResolver` in the first place.
// The factories below are called on every attempt with the value resolved at that
// moment, so a rotated key takes effect on the next call.
//
// NOTHING HERE FABRICATES. A provider that answers prose where JSON was asked
// for produces an error, not content; an OCR engine asked to write a report
// refuses; a missing binary is `OCR_UNAVAILABLE`, never an empty string that
// could be mistaken for "the image had no text".

import {
  GeminiMediaInterpreter,
  type MediaInterpreter,
  type ImageInterpretationResult,
  type TranscriptionResult,
} from "../aicoach/mediaInterpreter.js";
import { GeminiAiProvider } from "../aicoach/geminiProvider.js";
import { AiProviderNotConfiguredError, type AiGenerationResult } from "../aicoach/aiProvider.js";
import type { AiCatalogProvider, AiRoute } from "./aiCatalog.js";
import { AiFailure, classifyTransportFailure, failed, refused } from "./aiErrors.js";
import { N8nRelayTransport, relayIsConfigured } from "./n8nRelayTransport.js";
import { TesseractProvider, parseOcrTradeFields } from "./tesseractProvider.js";

export interface AiExecutorRequest {
  readonly userId: string;
  /** The assembled prompt (a versioned template + the caller's bounded facts). Never stored. */
  readonly prompt: string;
  readonly promptVersion: string;
  readonly facts?: Readonly<Record<string, unknown>> | undefined;
  readonly image?: { readonly bytes: Buffer; readonly mimeType: string } | undefined;
  readonly audio?: { readonly bytes: Buffer; readonly mimeType: string; readonly languageHint: string } | undefined;
  readonly timeoutMs: number;
}

export interface AiExecutorResult {
  readonly model: string;
  /** Structured JSON, when the provider answered with JSON. Validated by the caller. */
  readonly insight: Record<string, unknown> | null;
  /** Raw text: an OCR reading, a transcript, or the relay's extraction payload. */
  readonly text: string | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly costMicroUsd: number | null;
  readonly latencyMs: number;
}

export interface AiExecutor {
  readonly provider: AiCatalogProvider;
  execute(request: AiExecutorRequest, options: { model: string | null; route: AiRoute | null }): Promise<AiExecutorResult>;
}

/** The Gemini transport error the aicoach provider throws, classified here. */
export class AiProviderTransportError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(`gemini transport: ${code}`);
    this.name = "AiProviderTransportError";
  }
}

function classifyGeminiError(err: unknown): AiFailure {
  if (err instanceof AiProviderNotConfiguredError) return refused("PROVIDER_NOT_CONFIGURED", "gemini");
  const code = (err as { code?: unknown })?.code;
  const status = (err as { status?: unknown })?.status;
  if (typeof code === "string") {
    switch (code) {
      case "TIMEOUT":
        return failed("PROVIDER_TIMEOUT", "gemini", true);
      case "NETWORK":
        return failed("UPSTREAM_UNAVAILABLE", "gemini", true);
      case "RATE_LIMITED":
        return failed("UPSTREAM_QUOTA_EXHAUSTED", "gemini", true);
      case "MALFORMED_RESPONSE":
        return failed("UPSTREAM_MALFORMED", "gemini", false);
      case "EMPTY_CONTENT":
      case "INVALID_JSON":
        return failed("INVALID_PROVIDER_OUTPUT", "gemini", false);
      default:
        break;
    }
  }
  if (typeof status === "number") {
    if (status === 401 || status === 403) return failed("UPSTREAM_AUTH", "gemini", true);
    if (status === 429) return failed("UPSTREAM_QUOTA_EXHAUSTED", "gemini", true);
    if (status >= 500) return failed("UPSTREAM_UNAVAILABLE", "gemini", true);
  }
  return failed("PROVIDER_ERROR", "gemini", true);
}

export interface GeminiExecutorDeps {
  /** Resolved per call: the admin-managed secret, else the environment. */
  readonly apiKey: () => Promise<string | null>;
  readonly relayConfig: () => Promise<{ url: string | null; token: string | null }>;
  /** Injected in tests so no network is touched; defaults to the real classes. */
  readonly makeProvider?: (apiKey: string, model: string | null, timeoutMs: number) => { generate(r: { userId: string; promptVersion: string; facts: Readonly<Record<string, unknown>>; prompt?: string }): Promise<AiGenerationResult>; model: string };
  readonly makeInterpreter?: (apiKey: string, model: string | null, timeoutMs: number) => MediaInterpreter;
  readonly makeRelay?: (url: string, token: string, timeoutMs: number) => N8nRelayTransport;
}

export class GeminiExecutor implements AiExecutor {
  readonly provider: AiCatalogProvider = "gemini";

  constructor(private readonly deps: GeminiExecutorDeps) {}

  async execute(
    request: AiExecutorRequest,
    options: { model: string | null; route: AiRoute | null },
  ): Promise<AiExecutorResult> {
    const started = Date.now();

    if (options.route === "n8n_relay") return this.viaRelay(request, started);

    const apiKey = await this.deps.apiKey();
    if (apiKey === null || apiKey === "") throw refused("PROVIDER_NOT_CONFIGURED", "gemini");

    // A media request goes through the interpreter (the port that already knows
    // how to ask for a transcript or a structured chart reading); a facts request
    // goes through the generation provider. One Gemini HTTP client each, both
    // pre-existing — this executor only chooses between them.
    if (request.audio !== undefined) {
      const interpreter = this.interpreter(apiKey, options.model, request.timeoutMs);
      let result: TranscriptionResult;
      try {
        result = await interpreter.transcribe({
          userId: request.userId,
          audio: request.audio.bytes,
          mimeType: request.audio.mimeType,
          languageHint: request.audio.languageHint,
        });
      } catch (err) {
        throw this.classifyInterpreterError(err);
      }
      return {
        model: result.model,
        insight: null,
        text: result.text,
        tokensIn: null,
        tokensOut: null,
        costMicroUsd: null,
        latencyMs: Date.now() - started,
      };
    }

    if (request.image !== undefined) {
      const interpreter = this.interpreter(apiKey, options.model, request.timeoutMs);
      let result: ImageInterpretationResult;
      try {
        result = await interpreter.interpretImage({
          userId: request.userId,
          image: request.image.bytes,
          mimeType: request.image.mimeType,
        });
      } catch (err) {
        throw this.classifyInterpreterError(err);
      }
      return {
        model: result.model,
        // The interpreter already returns a STRUCTURED reading; wrapping it keeps
        // the ledger's insight an object, as 0017 requires.
        insight: { fields: result.fields },
        text: null,
        tokensIn: null,
        tokensOut: null,
        costMicroUsd: null,
        latencyMs: Date.now() - started,
      };
    }

    const provider = this.deps.makeProvider
      ?? ((key: string, model: string | null, timeoutMs: number) => new GeminiAiProvider(
        model === null ? { apiKey: key, timeoutMs } : { apiKey: key, model, timeoutMs },
      ));
    let result: AiGenerationResult;
    try {
      result = await provider(apiKey, options.model, request.timeoutMs).generate({
        userId: request.userId,
        promptVersion: request.promptVersion,
        facts: request.facts ?? { prompt: request.prompt },
      });
    } catch (err) {
      throw classifyGeminiError(err);
    }
    return {
      model: result.model,
      insight: result.insight,
      text: null,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costMicroUsd: result.costMicroUsd,
      latencyMs: Date.now() - started,
    };
  }

  /**
   * The relay path. The relay contract carries a prompt and an optional image —
   * it has NO audio field, so a transcription request over the relay is refused
   * rather than silently sent as something else.
   */
  private async viaRelay(request: AiExecutorRequest, started: number): Promise<AiExecutorResult> {
    if (request.audio !== undefined) throw refused("UNSUPPORTED_CAPABILITY", "gemini");
    const config = await this.deps.relayConfig();
    if (!relayIsConfigured(config.url, config.token)) throw refused("PROVIDER_NOT_CONFIGURED", "gemini");
    const make = this.deps.makeRelay ?? ((url: string, token: string, timeoutMs: number) => new N8nRelayTransport({ url, token, timeoutMs }));
    const relay = make(config.url!, config.token!, request.timeoutMs);
    const result = await relay.generateContent(
      request.prompt,
      request.image === undefined ? null : { bytes: request.image.bytes, mimeType: request.image.mimeType },
      request.timeoutMs,
    );
    // The relay answers with an `extraction` payload. When it is JSON it becomes
    // the insight; when it is prose it stays text and the caller decides whether
    // prose is acceptable for that feature (for analysis it is not).
    let insight: Record<string, unknown> | null = null;
    if (result.text !== null) {
      try {
        const parsed: unknown = JSON.parse(result.text);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          insight = parsed as Record<string, unknown>;
        }
      } catch {
        insight = null;
      }
    }
    return {
      model: result.model,
      insight,
      text: result.text,
      tokensIn: null,
      tokensOut: null,
      costMicroUsd: null,
      latencyMs: result.latencyMs > 0 ? result.latencyMs : Date.now() - started,
    };
  }

  private interpreter(apiKey: string, model: string | null, timeoutMs: number): MediaInterpreter {
    const make = this.deps.makeInterpreter
      ?? ((key: string, m: string | null, t: number) => new GeminiMediaInterpreter(
        m === null ? { apiKey: key, timeoutMs: t } : { apiKey: key, model: m, timeoutMs: t },
      ));
    return make(apiKey, model, timeoutMs);
  }

  private classifyInterpreterError(err: unknown): AiFailure {
    const code = (err as { code?: unknown })?.code;
    if (typeof code === "string") {
      switch (code) {
        case "TIMEOUT":
          return failed("PROVIDER_TIMEOUT", "gemini", true);
        case "TOO_LARGE":
        case "UNSUPPORTED_MEDIA":
          return refused("PAYLOAD_TOO_LARGE", "gemini");
        case "EMPTY_RESULT":
          return failed("INVALID_PROVIDER_OUTPUT", "gemini", false);
        default:
          return failed("PROVIDER_ERROR", "gemini", true);
      }
    }
    if (err instanceof AiFailure) return err;
    return failed("PROVIDER_ERROR", "gemini", true);
  }
}

export interface TesseractExecutorDeps {
  readonly provider?: TesseractProvider;
}

export class TesseractExecutor implements AiExecutor {
  readonly provider: AiCatalogProvider = "tesseract";
  readonly #impl: TesseractProvider;

  constructor(deps: TesseractExecutorDeps = {}) {
    this.#impl = deps.provider ?? new TesseractProvider();
  }

  get available(): boolean {
    return this.#impl.isAvailable();
  }

  async execute(request: AiExecutorRequest): Promise<AiExecutorResult> {
    // An OCR engine asked for prose must refuse. Legacy returns
    // UNSUPPORTED_CAPABILITY here rather than emitting the prompt back.
    if (request.image === undefined) throw refused("UNSUPPORTED_CAPABILITY", "tesseract");
    if (!this.#impl.isAvailable()) throw failed("OCR_UNAVAILABLE", "tesseract", false);
    const result = await this.#impl.ocr(request.image.bytes, request.timeoutMs);
    const fields = parseOcrTradeFields(result.text);
    return {
      model: result.model,
      // The structured reading is the insight; the raw text travels alongside so
      // a caller can show what was actually read. Confidence stays low (0.4) —
      // Legacy's own constant — because OCR is a reading, not a fact.
      insight: { fields, confidence: result.confidence, language: result.language },
      text: result.text,
      tokensIn: null,
      tokensOut: null,
      costMicroUsd: null,
      latencyMs: result.latencyMs,
    };
  }
}

/**
 * A provider Modern declares but cannot call. It refuses with a typed code, so
 * the ledger records the truth ("we could not call openai") instead of either
 * silently skipping it or inventing a transport nobody wrote.
 */
export class UnavailableExecutor implements AiExecutor {
  constructor(readonly provider: AiCatalogProvider) {}

  async execute(): Promise<AiExecutorResult> {
    throw new AiFailure("PROVIDER_NOT_CONFIGURED", "refused", this.provider, false,
      `${this.provider} is declared in the vocabulary but has no transport in Modern`);
  }
}

export { classifyTransportFailure };
