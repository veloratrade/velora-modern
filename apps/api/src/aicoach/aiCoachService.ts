// AI Coach generation service — governance in ONE place.
//
// ORDER OF OPERATIONS IS THE SECURITY PROPERTY:
//   1. consent          — no consent ⇒ the provider is NEVER called;
//   2. payload bound    — oversized facts ⇒ refused before any egress;
//   3. provider call    — the only network step, behind the port;
//   4. output validation— shape/size, so 0017 can store it and the UI can trust it;
//   5. durable record   — SUCCESS, REFUSAL and ERROR are all recorded.
//
// WHY EVERY ATTEMPT IS RECORDED. 0017's `outcome ∈ (success|refused|error)` means a
// refusal is data, not silence: "the user has not consented" and "the provider is
// not configured" must be distinguishable afterwards. Returning null and writing
// nothing would make an outage look like an empty history.
//
// NO FABRICATION: the service never synthesises coaching content. With no provider
// it refuses (PROVIDER_NOT_CONFIGURED); with a malformed provider response it
// records an error and returns nothing. There is no local heuristic fallback.
import {
  AiProviderNotConfiguredError,
  checkPayloadSize,
  validateInsight,
  type AiAttemptRecord,
  type AiAttemptStore,
  type AiGenerationRequest,
  type AiProvider,
} from "./aiProvider.js";

export const INSIGHT_PROMPT_VERSION = "v1";

/** Consent is the caller's own record; the service only reads it. */
export interface ConsentPort {
  consentState(userId: string): Promise<{ consented: boolean; consentedAt: string | null }>;
}

export type GenerationOutcome =
  | { readonly status: "generated"; readonly id: string; readonly model: string; readonly insight: Record<string, unknown> }
  | { readonly status: "refused"; readonly code: "CONSENT_REQUIRED" | "PROVIDER_NOT_CONFIGURED" | "PAYLOAD_TOO_LARGE" }
  | { readonly status: "error"; readonly code: "PROVIDER_ERROR" | "INVALID_PROVIDER_OUTPUT" | "PROVIDER_NAME_INVALID" };

export interface GenerationInput {
  readonly userId: string;
  readonly facts: Readonly<Record<string, unknown>>;
  readonly windowFrom?: string | null;
  readonly windowTo?: string | null;
  readonly tradesAnalyzed?: number | null;
}

/** 0017's error_code shape: ^[A-Z0-9_]{1,48}$. */
function safeErrorCode(code: string): string {
  const cleaned = code.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 48);
  return cleaned === "" ? "UNKNOWN" : cleaned;
}

export class AiCoachService {
  constructor(
    private readonly deps: {
      readonly provider: AiProvider;
      readonly consent: ConsentPort;
      readonly attempts: AiAttemptStore;
      /** Provider names 0017 admits; injected so the check is not a hidden constant. */
      readonly allowedProviders: readonly string[];
    },
  ) {}

  async generate(input: GenerationInput): Promise<GenerationOutcome> {
    const base = {
      userId: input.userId,
      provider: this.deps.provider.name,
      model: this.deps.provider.model,
      promptVersion: INSIGHT_PROMPT_VERSION,
      windowFrom: input.windowFrom ?? null,
      windowTo: input.windowTo ?? null,
      tradesAnalyzed: input.tradesAnalyzed ?? null,
    };

    // 1. CONSENT — checked BEFORE the payload bound and before any egress, because
    //    an unconsented user's data must not be assembled for a third party at all.
    const consent = await this.deps.consent.consentState(input.userId);
    if (!consent.consented) {
      return this.refuse(base, "CONSENT_REQUIRED");
    }

    // 2. PAYLOAD BOUND
    if (!checkPayloadSize(input.facts).ok) {
      return this.refuse(base, "PAYLOAD_TOO_LARGE");
    }

    // 3. THE PROVIDER NAME MUST SATISFY 0017's CHECK. A provider that cannot be
    //    recorded must not be called: an unrecordable call is an unaccountable one.
    if (!this.deps.allowedProviders.includes(this.deps.provider.name)) {
      return this.error(base, "PROVIDER_NAME_INVALID");
    }

    // 4. CALL
    let result;
    try {
      const request: AiGenerationRequest = {
        userId: input.userId,
        promptVersion: INSIGHT_PROMPT_VERSION,
        facts: input.facts,
      };
      result = await this.deps.provider.generate(request);
    } catch (err) {
      if (err instanceof AiProviderNotConfiguredError) {
        return this.refuse(base, "PROVIDER_NOT_CONFIGURED");
      }
      // The provider's message may quote user content; it is never stored or
      // returned — only a fixed, shape-valid code.
      return this.error(base, "PROVIDER_ERROR");
    }

    // 5. VALIDATE BEFORE PERSISTING
    const validation = validateInsight(result.insight);
    if (!validation.ok) {
      return this.error(base, "INVALID_PROVIDER_OUTPUT");
    }

    const record: AiAttemptRecord = {
      ...base,
      model: result.model,
      insight: result.insight,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costMicroUsd: result.costMicroUsd,
      outcome: "success",
      errorCode: null,
    };
    const stored = await this.deps.attempts.record(record);
    return { status: "generated", id: stored.id, model: result.model, insight: result.insight };
  }

  private async refuse(
    base: Omit<AiAttemptRecord, "insight" | "tokensIn" | "tokensOut" | "costMicroUsd" | "outcome" | "errorCode">,
    code: "CONSENT_REQUIRED" | "PROVIDER_NOT_CONFIGURED" | "PAYLOAD_TOO_LARGE",
  ): Promise<GenerationOutcome> {
    // Refusals carry an EMPTY insight object: 0017 requires `insight` to be a JSON
    // object, and an empty one is the honest representation of "nothing was
    // generated" (a null would violate the column; invented text would be a lie).
    await this.deps.attempts.record({
      ...base,
      insight: {},
      tokensIn: null,
      tokensOut: null,
      costMicroUsd: null,
      outcome: "refused",
      errorCode: safeErrorCode(code),
    });
    return { status: "refused", code };
  }

  private async error(
    base: Omit<AiAttemptRecord, "insight" | "tokensIn" | "tokensOut" | "costMicroUsd" | "outcome" | "errorCode">,
    code: "PROVIDER_ERROR" | "INVALID_PROVIDER_OUTPUT" | "PROVIDER_NAME_INVALID",
  ): Promise<GenerationOutcome> {
    await this.deps.attempts.record({
      ...base,
      insight: {},
      tokensIn: null,
      tokensOut: null,
      costMicroUsd: null,
      outcome: "error",
      errorCode: safeErrorCode(code),
    });
    return { status: "error", code };
  }
}
