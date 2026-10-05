// Typed AI failures — the vocabulary every AI refusal and error travels in.
//
// WHY A SEPARATE ERROR MODEL. Legacy has six AI exception classes
// (`AIException`, `AIProviderException`, `AIQuotaExhaustedException`,
// `AITimeoutException`, `AIValidationException`, `AIConsentRequiredException`,
// `AIProviderException`) each carrying an HTTP status, an error code and a
// message key. That is a contract, not PHP decoration: it is what lets a chain
// walk distinguish "try the next provider" from "stop and tell the user why",
// and what lets the ledger record a REFUSAL as data instead of silence.
//
// Modern already has two typed AI errors (`AiProviderNotConfiguredError`,
// `MediaInterpreterError`). This file does not replace them — it classifies
// them, plus the failures the phase-7 chain introduces (feature off, quota
// spent, deadline passed, consent missing, image not anonymizable), into the
// codes the HTTP surface and the ledger agree on.
//
// NO PROVIDER BODY EVER BECOMES A MESSAGE. A provider's error text can contain
// a key fragment, a request id or an internal hostname. Every message here is a
// fixed string chosen by us; the only variable part is a normalized code.

/** Refusals: nothing was produced and nothing was wrong with the caller's data. */
export const AI_REFUSAL_CODES = [
  "FEATURE_DISABLED",
  "CONSENT_REQUIRED",
  "PROVIDER_NOT_CONFIGURED",
  "QUOTA_EXHAUSTED",
  "PAYLOAD_TOO_LARGE",
  "NO_PROVIDER_AVAILABLE",
  "IMAGE_NOT_ANONYMIZED",
  "UNSUPPORTED_CAPABILITY",
] as const;
export type AiRefusalCode = (typeof AI_REFUSAL_CODES)[number];

/** Errors: something was attempted and failed. */
export const AI_ERROR_CODES = [
  "PROVIDER_ERROR",
  "PROVIDER_TIMEOUT",
  "DEADLINE_EXCEEDED",
  "INVALID_PROVIDER_OUTPUT",
  "RELAY_REJECTED_CREDENTIALS",
  "RELAY_NOT_FOUND",
  "RELAY_HTTP_ERROR",
  "UPSTREAM_AUTH",
  "UPSTREAM_QUOTA_EXHAUSTED",
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_MALFORMED",
  "UPSTREAM_INVALID_JSON",
  "OCR_UNAVAILABLE",
  "OCR_FAILED",
] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

/**
 * One error type, carrying the classification.
 *
 * `retryNextProvider` is the property the chain walk actually needs: a timeout or
 * an upstream 5xx means "ask somebody else", while a consent refusal or an
 * oversized payload means "stop — asking another provider would be wrong".
 */
export class AiFailure extends Error {
  constructor(
    readonly code: AiRefusalCode | AiErrorCode,
    readonly kind: "refused" | "error",
    /** Which provider produced it, when one did. */
    readonly provider: string | null,
    readonly retryNextProvider: boolean,
    message?: string,
  ) {
    super(message ?? `ai: ${code}`);
    this.name = "AiFailure";
  }

  /** The HTTP status this failure answers with (Legacy's `httpStatus()`). */
  get status(): number {
    switch (this.code) {
      case "FEATURE_DISABLED":
      case "CONSENT_REQUIRED":
        return 403;
      case "PAYLOAD_TOO_LARGE":
      case "INVALID_PROVIDER_OUTPUT":
      case "UNSUPPORTED_CAPABILITY":
        return 422;
      case "QUOTA_EXHAUSTED":
      case "UPSTREAM_QUOTA_EXHAUSTED":
        return 429;
      case "PROVIDER_TIMEOUT":
      case "DEADLINE_EXCEEDED":
      case "UPSTREAM_TIMEOUT":
        return 504;
      case "PROVIDER_NOT_CONFIGURED":
      case "NO_PROVIDER_AVAILABLE":
      case "OCR_UNAVAILABLE":
      case "IMAGE_NOT_ANONYMIZED":
        // 503, not 500: the platform is fine, the capability is not wired. This
        // is the same distinction the admin console uses for an absent module.
        return 503;
      default:
        return 502;
    }
  }
}

export function refused(code: AiRefusalCode, provider: string | null = null): AiFailure {
  return new AiFailure(code, "refused", provider, false);
}

export function failed(code: AiErrorCode, provider: string | null, retryNextProvider: boolean): AiFailure {
  return new AiFailure(code, "error", provider, retryNextProvider);
}

/**
 * Legacy's `AIFailureClassifier` in one function: map a transport-level symptom
 * onto the vocabulary above, and say whether the chain should move on.
 *
 * The relay's own normalized codes (`UPSTREAM_*`) arrive already classified; a
 * raw fetch failure has to be classified here.
 */
export function classifyTransportFailure(
  symptom: "timeout" | "network" | "http-401" | "http-403" | "http-404" | "http-429" | "http-5xx" | "http-other" | "malformed-json" | "empty",
  provider: string,
): AiFailure {
  switch (symptom) {
    case "timeout":
      return failed("PROVIDER_TIMEOUT", provider, true);
    case "network":
      return failed("UPSTREAM_UNAVAILABLE", provider, true);
    case "http-401":
    case "http-403":
      // A rejected credential is NOT worth retrying on another provider of the
      // same kind, but the chain may hold a different provider, so it moves on.
      return failed("RELAY_REJECTED_CREDENTIALS", provider, true);
    case "http-404":
      return failed("RELAY_NOT_FOUND", provider, false);
    case "http-429":
      return failed("UPSTREAM_QUOTA_EXHAUSTED", provider, true);
    case "http-5xx":
      return failed("UPSTREAM_UNAVAILABLE", provider, true);
    case "http-other":
      return failed("RELAY_HTTP_ERROR", provider, false);
    case "malformed-json":
      return failed("UPSTREAM_INVALID_JSON", provider, false);
    case "empty":
      return failed("INVALID_PROVIDER_OUTPUT", provider, false);
  }
}

/** The relay's normalized error codes → this vocabulary (Legacy `mapRelayError`). */
export function classifyRelayErrorCode(code: string, provider = "gemini"): AiFailure {
  switch (code) {
    case "INVALID_INPUT":
    case "UPSTREAM_BAD_REQUEST":
      return failed("INVALID_PROVIDER_OUTPUT", provider, false);
    case "UPSTREAM_AUTH":
      return failed("UPSTREAM_AUTH", provider, true);
    case "UPSTREAM_MODEL_NOT_FOUND":
    case "MODEL_NOT_FOUND":
      return failed("PROVIDER_ERROR", provider, false);
    case "UPSTREAM_QUOTA_EXHAUSTED":
    case "QUOTA_EXHAUSTED":
      return failed("UPSTREAM_QUOTA_EXHAUSTED", provider, true);
    case "UPSTREAM_UNAVAILABLE":
    case "UNAVAILABLE":
      return failed("UPSTREAM_UNAVAILABLE", provider, true);
    case "UPSTREAM_NETWORK_TIMEOUT":
    case "NETWORK_TIMEOUT":
      return failed("UPSTREAM_TIMEOUT", provider, true);
    case "UPSTREAM_MALFORMED_RESPONSE":
    case "MALFORMED":
      return failed("UPSTREAM_MALFORMED", provider, false);
    case "UPSTREAM_INVALID_JSON":
    case "INVALID_JSON":
      return failed("UPSTREAM_INVALID_JSON", provider, false);
    default:
      // Only the normalized code travels — never the upstream message body.
      return failed("PROVIDER_ERROR", provider, true);
  }
}
