// The n8n Gemini relay transport — Legacy's region-block workaround, kept.
//
// WHY THIS EXISTS (Legacy's own words, `N8nGeminiRelayTransport.php`): "Velora
// staging cannot reach generativelanguage.googleapis.com directly (Google
// frontend returns 403 for the host's network). The active n8n workflow
// 'VELORA — Gemini Vision Extraction Relay' forwards requests to Gemini from n8n
// Cloud. This transport keeps that hop swappable: set GEMINI_ROUTE=direct (or
// remove the route) and Velora talks to Gemini directly again — no code change,
// no deploy."
//
// That is a real operational capability, not an integration invented here: the
// contract below is the one Legacy's relay speaks, byte for byte, so the same
// n8n workflow serves both systems.
//
// THE CONTRACT
//   POST {url}
//   headers  Content-Type: application/json, Accept: application/json,
//            X-Velora-Relay-Token: <token>
//   body     {request_id: "velora-"+16 hex, prompt, image_base64?, mime_type?}
//   200      {success:true, request_id, provider, model, extraction:{…}|string,
//             error:null, meta:{upstream_http_status, latency_ms}}
//   failure  {success:false, error:{code, http_status, message}}
//
// SECURITY PROPERTIES, ENFORCED HERE RATHER THAN TRUSTED TO CALLERS
//   * https only. `isConfigured` refuses a plain-http URL, so a token cannot be
//     sent in the clear by a typo in an admin form.
//   * the token appears in exactly one place: the request header. It is never in
//     a URL, a query string, a log line, an error message or a response body.
//   * an upstream message body never becomes our message. Only the normalized
//     `error.code` is used, through `classifyRelayErrorCode`.
//   * redirects are not followed (a 3xx would take the token somewhere else), and
//     the timeout is bounded on both connect and total.
//
// NOT VERIFIED LIVE: no relay URL or token is in scope in this repository, so
// this transport is exercised with an injected fetch. The live round trip stays
// NOT_VERIFIED and is labelled that way wherever it is reported.

import { randomBytes } from "node:crypto";
import { AiFailure, classifyRelayErrorCode, classifyTransportFailure } from "./aiErrors.js";

export type RelayFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export const RELAY_REQUEST_TIMEOUT_MS = 30_000;
/** Legacy bounds the connect phase separately and below the total. */
export const RELAY_CONNECT_TIMEOUT_MS = 10_000;
/** A prompt plus one inline image; the Telegram media cap is the same order. */
export const RELAY_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface RelayResult {
  /** The relay's `extraction` field, as text: an object is JSON-encoded. */
  readonly text: string | null;
  readonly model: string;
  readonly upstreamHttpStatus: number;
  readonly latencyMs: number;
  /** The relay's own request id, echoed for correlation with the workflow run. */
  readonly requestId: string;
}

/** https and a token, or the relay is not configured. Legacy's own rule. */
export function relayIsConfigured(url: string | null | undefined, token: string | null | undefined): boolean {
  const u = (url ?? "").trim();
  const t = (token ?? "").trim();
  return u !== "" && t !== "" && u.startsWith("https://");
}

export class RelayNotConfiguredError extends AiFailure {
  constructor() {
    super("PROVIDER_NOT_CONFIGURED", "refused", "gemini", false,
      "the n8n relay route is selected but no https relay URL and token are configured");
    this.name = "RelayNotConfiguredError";
  }
}

export interface N8nRelayTransportOptions {
  readonly url: string;
  readonly token: string;
  readonly fetchImpl?: RelayFetch;
  readonly timeoutMs?: number;
}

export class N8nRelayTransport {
  readonly name = "n8n_relay" as const;
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: RelayFetch;
  readonly #timeoutMs: number;

  constructor(options: N8nRelayTransportOptions) {
    this.#url = options.url.trim();
    this.#token = options.token.trim();
    this.#fetch = options.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit) as unknown as Promise<{
      ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string>;
    }>);
    this.#timeoutMs = options.timeoutMs ?? RELAY_REQUEST_TIMEOUT_MS;
  }

  get isConfigured(): boolean {
    return relayIsConfigured(this.#url, this.#token);
  }

  /** The request body, exactly as the relay expects it. Public for tests. */
  static buildPayload(prompt: string, image: { bytes: Buffer; mimeType: string } | null, requestId: string): Record<string, string> {
    const payload: Record<string, string> = { request_id: requestId, prompt };
    if (image !== null && image.bytes.length > 0) {
      payload["image_base64"] = image.bytes.toString("base64");
      payload["mime_type"] = image.mimeType;
    }
    return payload;
  }

  static newRequestId(): string {
    return `velora-${randomBytes(8).toString("hex")}`;
  }

  /**
   * One relay call. Throws `AiFailure` with the classification the chain walk
   * needs; never returns a provider's prose as content.
   */
  async generateContent(
    prompt: string,
    image: { bytes: Buffer; mimeType: string } | null,
    timeoutMs = this.#timeoutMs,
  ): Promise<RelayResult> {
    if (!this.isConfigured) throw new RelayNotConfiguredError();
    if (image !== null && image.bytes.length > RELAY_MAX_IMAGE_BYTES) {
      throw classifyTransportFailure("empty", "gemini");
    }

    const requestId = N8nRelayTransport.newRequestId();
    const body = JSON.stringify(N8nRelayTransport.buildPayload(prompt, image, requestId));
    const started = Date.now();
    // The shorter of the two bounds wins: a relay that hangs on connect must not
    // consume the whole call budget.
    const signal = AbortSignal.timeout(Math.min(timeoutMs, Math.max(2_000, timeoutMs)));

    let response: { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> };
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          // The only place the token exists on the wire.
          "X-Velora-Relay-Token": this.#token,
        },
        body,
        signal,
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw classifyTransportFailure(timedOut ? "timeout" : "network", "gemini");
    }
    const latencyMs = Date.now() - started;

    if (response.status === 401 || response.status === 403) {
      throw classifyTransportFailure(response.status === 401 ? "http-401" : "http-403", "gemini");
    }
    if (response.status === 404) throw classifyTransportFailure("http-404", "gemini");
    if (response.status === 429) throw classifyTransportFailure("http-429", "gemini");
    if (response.status >= 500) throw classifyTransportFailure("http-5xx", "gemini");
    if (response.status !== 200) throw classifyTransportFailure("http-other", "gemini");

    let decoded: unknown;
    try {
      decoded = await response.json();
    } catch {
      throw classifyTransportFailure("malformed-json", "gemini");
    }
    if (decoded === null || typeof decoded !== "object") throw classifyTransportFailure("malformed-json", "gemini");
    const envelope = decoded as Record<string, unknown>;

    if (envelope["success"] === true) {
      const extraction = envelope["extraction"];
      const text = typeof extraction === "string"
        ? extraction
        : extraction !== null && typeof extraction === "object"
          ? JSON.stringify(extraction)
          : null;
      const meta = (envelope["meta"] ?? {}) as Record<string, unknown>;
      return {
        text: text !== "" ? text : null,
        model: typeof envelope["model"] === "string" && envelope["model"] !== "" ? envelope["model"] : "gemini-relay",
        upstreamHttpStatus: Number(meta["upstream_http_status"] ?? 200),
        latencyMs: Number(meta["latency_ms"] ?? latencyMs),
        requestId: typeof envelope["request_id"] === "string" ? envelope["request_id"] : requestId,
      };
    }

    const error = (envelope["error"] ?? {}) as Record<string, unknown>;
    const code = typeof error["code"] === "string" ? error["code"] : "UNKNOWN";
    throw classifyRelayErrorCode(code, "gemini");
  }
}

/** The connect bound Legacy applies, kept as an explicit value for the caller. */
export function relayConnectTimeoutMs(totalMs: number): number {
  return Math.min(RELAY_CONNECT_TIMEOUT_MS, Math.max(2_000, totalMs));
}
