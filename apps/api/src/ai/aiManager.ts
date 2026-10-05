// The AI manager — one place where a request becomes a chain walk.
//
// Legacy's `AIManager::generate` is the orchestrator: resolve the chain, then for
// each entry check the deadline, the capability, consent, quota and image
// anonymization, call, log, and fall through on failure. This file is that
// orchestrator in Modern's shape, and the ORDER is the security property:
//
//   1. feature flag + rollout   — a switched-off feature never reaches a provider
//   2. chain resolution         — an empty chain is a refusal, not an exception
//   3. per entry, in order:
//        deadline               — the caller's budget, not the provider's
//        consent                — external providers only; local OCR is exempt
//        quota reservation      — ONE atomic statement, before any egress
//        image anonymization    — FAIL CLOSED: no redaction, no external egress
//        call                   — through the injected executor
//        validate + record      — success, refusal and error all reach the ledger
//   4. exhausted                — the last classification is the answer
//
// WHY EVERY ATTEMPT IS RECORDED. 0017's `outcome ∈ (success|refused|error)` means
// a refusal is data, not silence: "the quota was gone" and "the user never
// consented" and "the relay rejected us" must be distinguishable afterwards, and
// `route` + `fallback_index` (0028) make "the first provider was down and the
// second answered" readable from one table.
//
// NO FABRICATION. A provider that answers prose where a JSON object was asked for
// is recorded as INVALID_PROVIDER_OUTPUT and the walk moves on; nothing here
// synthesises content, and there is no heuristic local fallback for text
// features. Legacy wraps unparseable prose into `{summary: <prose>}`; Modern does
// not, because storing unvalidated model text as a structured insight is how a
// hallucination acquires a database row. Recorded as a divergence in the phase-7
// capability map §3.

import { validateInsight, type AiAttemptRecord, type AiAttemptStore } from "../aicoach/aiProvider.js";
import {
  FEATURE_FLAG, PROVIDERS, type AiCatalogProvider, type AiFeature, type AiLedgerFeature, type AiRoute,
} from "./aiCatalog.js";
import { AiFailure, type AiErrorCode, type AiRefusalCode } from "./aiErrors.js";
import { AiFeatureGuard } from "./aiFeatureGuard.js";
import type { AiFeatureRouter, ChainEntry } from "./aiFeatureRouter.js";
import type { ImageAnonymizer } from "./imageAnonymizer.js";
import type { AiConfigStore } from "./aiConfigStore.js";
import type { AiExecutor, AiExecutorRequest, AiExecutorResult } from "./aiExecutors.js";

/** Legacy's per-call budget for the two synchronous routes (20 s / 25 s). */
export const AI_DEADLINE_ANALYSIS_MS = 20_000;
export const AI_DEADLINE_REPORT_MS = 25_000;
export const AI_ATTEMPT_TIMEOUT_MS = 20_000;

export interface AiCallRequest {
  readonly userId: string;
  /** Which routing feature this is (decides the chain and the flag). */
  readonly feature: AiFeature;
  /** What the attempt is recorded as in the ledger. */
  readonly ledgerFeature: AiLedgerFeature;
  readonly promptVersion: string;
  readonly prompt: string;
  readonly facts?: Readonly<Record<string, unknown>> | undefined;
  readonly image?: { readonly bytes: Buffer; readonly mimeType: string } | undefined;
  readonly audio?: { readonly bytes: Buffer; readonly mimeType: string; readonly languageHint: string } | undefined;
  /** Absolute epoch ms. The caller owns the budget; the manager only enforces it. */
  readonly deadlineMs: number;
  readonly attemptTimeoutMs?: number | undefined;
  readonly windowFrom?: string | null | undefined;
  readonly windowTo?: string | null | undefined;
  readonly tradesAnalyzed?: number | null | undefined;
  /** sha256 of the INPUT, never the input (0028's `input_hash`). */
  readonly inputHash?: string | null | undefined;
  /**
   * True when a structured JSON object is required. Text features set it; the OCR
   * path does not, because its honest answer is text plus a low-confidence parse.
   */
  readonly requiresStructuredOutput?: boolean | undefined;
}

export interface AttemptSummary {
  readonly provider: AiCatalogProvider;
  readonly route: AiRoute | null;
  readonly fallbackIndex: number;
  readonly outcome: "success" | "refused" | "error";
  readonly code: string | null;
  readonly latencyMs: number;
  readonly attemptId: string | null;
}

export type AiCallOutcome =
  | {
      readonly status: "generated";
      readonly attemptId: string;
      readonly provider: AiCatalogProvider;
      readonly model: string;
      readonly route: AiRoute | null;
      readonly fallbackIndex: number;
      readonly latencyMs: number;
      readonly insight: Record<string, unknown> | null;
      readonly text: string | null;
      readonly tokensIn: number | null;
      readonly tokensOut: number | null;
      readonly costMicroUsd: number | null;
      readonly attempts: readonly AttemptSummary[];
    }
  | {
      readonly status: "refused";
      readonly code: AiRefusalCode;
      readonly attempts: readonly AttemptSummary[];
    }
  | {
      readonly status: "error";
      readonly code: AiErrorCode;
      readonly attempts: readonly AttemptSummary[];
    };

export interface ConsentReader {
  consentState(userId: string): Promise<{ consented: boolean; consentedAt: string | null }>;
}

export interface AiManagerDeps {
  readonly router: AiFeatureRouter;
  readonly guard: AiFeatureGuard;
  readonly store: AiConfigStore;
  readonly consent: ConsentReader;
  readonly attempts: AiAttemptStore;
  readonly anonymizer: ImageAnonymizer;
  /** Injected so a test can supply a provider Modern has no transport for. */
  readonly executors: Readonly<Partial<Record<AiCatalogProvider, AiExecutor>>>;
  readonly now?: () => number;
}

export class AiManager {
  constructor(private readonly deps: AiManagerDeps) {}

  private get now(): () => number {
    return this.deps.now ?? (() => Date.now());
  }

  async call(request: AiCallRequest): Promise<AiCallOutcome> {
    const attempts: AttemptSummary[] = [];

    // 1. THE FLAG GATE. Before any chain work: a feature an operator switched off
    //    must not cost a quota unit, a consent read or a network call.
    const flag = FEATURE_FLAG[request.feature];
    if (flag !== undefined && !(await this.deps.guard.isEnabled(flag, request.userId))) {
      return { status: "refused", code: "FEATURE_DISABLED", attempts };
    }

    // 2. THE CHAIN.
    const chain = await this.deps.router.resolveChain(request.feature);
    if (chain.entries.length === 0) {
      // No provider can serve this feature: either none is configured, or every
      // configured one was skipped for a recorded reason. This is a 503-shaped
      // refusal ("the capability is not wired"), never an empty success.
      return { status: "refused", code: "NO_PROVIDER_AVAILABLE", attempts };
    }

    let last: AiFailure | null = null;

    for (const entry of chain.entries) {
      // 3a. THE CALLER'S DEADLINE. Checked per entry, because a chain that has
      //     already spent the budget must not start another call.
      if (this.now() >= request.deadlineMs) {
        last = new AiFailure("DEADLINE_EXCEEDED", "error", entry.provider, false);
        attempts.push(await this.record(request, entry, "error", "DEADLINE_EXCEEDED", null, 0, null));
        break;
      }

      const external = !PROVIDERS[entry.provider].local;

      // 3b. CONSENT, before any egress. Legacy exempts the local provider: OCR on
      //     this machine is not a third-party disclosure. For an external provider
      //     a missing consent STOPS the walk — trying the next external provider
      //     would be the same disclosure with a different logo.
      if (external) {
        const consent = await this.deps.consent.consentState(request.userId);
        if (!consent.consented) {
          const summary = await this.record(request, entry, "refused", "CONSENT_REQUIRED", null, 0, null);
          attempts.push(summary);
          return { status: "refused", code: "CONSENT_REQUIRED", attempts };
        }
      }

      // 3c. QUOTA — one atomic statement, BEFORE the call. A provider whose budget
      //     is gone is skipped, and the skip is recorded: "quota_exhausted" is an
      //     answer an operator needs to see, not a silent fallback.
      const reserved = await this.deps.store.reserveQuota(entry.provider);
      if (reserved === null) {
        attempts.push(await this.record(request, entry, "refused", "QUOTA_EXHAUSTED", null, 0, null));
        last = new AiFailure("QUOTA_EXHAUSTED", "refused", entry.provider, true);
        continue;
      }

      // 3d. ANONYMIZATION, fail closed. No redaction ⇒ the image does not leave.
      let image = request.image;
      if (external && image !== undefined && this.deps.anonymizer.shouldAnonymize(image.bytes)) {
        const redacted = this.deps.anonymizer.anonymize(image.bytes);
        if (redacted === null) {
          attempts.push(await this.record(request, entry, "refused", "IMAGE_NOT_ANONYMIZED", null, 0, null));
          last = new AiFailure("IMAGE_NOT_ANONYMIZED", "refused", entry.provider, true);
          continue;
        }
        image = { bytes: redacted, mimeType: image.mimeType };
      }

      // 3e. THE CALL.
      const executor = this.deps.executors[entry.provider] ?? null;
      if (executor === null) {
        attempts.push(await this.record(request, entry, "refused", "PROVIDER_NOT_CONFIGURED", null, 0, null));
        last = new AiFailure("PROVIDER_NOT_CONFIGURED", "refused", entry.provider, true);
        continue;
      }

      const executorRequest: AiExecutorRequest = {
        userId: request.userId,
        prompt: request.prompt,
        promptVersion: request.promptVersion,
        facts: request.facts,
        image,
        audio: request.audio,
        timeoutMs: request.attemptTimeoutMs ?? AI_ATTEMPT_TIMEOUT_MS,
      };

      let result: AiExecutorResult;
      try {
        result = await executor.execute(executorRequest, { model: entry.model, route: entry.route });
      } catch (err) {
        const failure = err instanceof AiFailure
          ? err
          : new AiFailure("PROVIDER_ERROR", "error", entry.provider, true);
        const outcome = failure.kind === "refused" ? "refused" : "error";
        attempts.push(await this.record(request, entry, outcome, failure.code, null, 0, null));
        last = failure;
        // A refusal that is not worth retrying (an oversized payload, a malformed
        // answer) ends the walk: the next provider would be given the same input.
        if (!failure.retryNextProvider) break;
        continue;
      }

      // 3f. VALIDATE BEFORE PERSISTING. Shape, not quality: this layer must not
      //     judge the coaching, but it must refuse an answer the ledger cannot
      //     store or the caller cannot trust.
      if (request.requiresStructuredOutput === true) {
        if (result.insight === null) {
          attempts.push(await this.record(request, entry, "error", "INVALID_PROVIDER_OUTPUT", result, result.latencyMs, null));
          last = new AiFailure("INVALID_PROVIDER_OUTPUT", "error", entry.provider, false);
          break;
        }
        const validation = validateInsight(result.insight);
        if (!validation.ok) {
          attempts.push(await this.record(request, entry, "error", "INVALID_PROVIDER_OUTPUT", result, result.latencyMs, null));
          last = new AiFailure("INVALID_PROVIDER_OUTPUT", "error", entry.provider, false);
          break;
        }
      }

      const summary = await this.record(request, entry, "success", null, result, result.latencyMs, null);
      attempts.push(summary);
      return {
        status: "generated",
        attemptId: summary.attemptId ?? "",
        provider: entry.provider,
        model: result.model,
        route: entry.route,
        fallbackIndex: entry.fallbackIndex,
        latencyMs: result.latencyMs,
        insight: result.insight,
        text: result.text,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costMicroUsd: result.costMicroUsd,
        attempts,
      };
    }

    if (last !== null && last.kind === "refused") {
      return { status: "refused", code: last.code as AiRefusalCode, attempts };
    }
    return { status: "error", code: (last?.code ?? "PROVIDER_ERROR") as AiErrorCode, attempts };
  }

  /**
   * One ledger row per attempt. The insight column is NOT NULL and must be a JSON
   * object (0017), so a refusal or an error stores `{}` — the honest
   * representation of "nothing was generated". Inventing a placeholder object
   * would put content in a column that a reader renders.
   */
  private async record(
    request: AiCallRequest,
    entry: ChainEntry,
    outcome: "success" | "refused" | "error",
    code: string | null,
    result: AiExecutorResult | null,
    latencyMs: number,
    _attemptId: string | null,
  ): Promise<AttemptSummary> {
    const record: AiAttemptRecord = {
      userId: request.userId,
      feature: request.ledgerFeature,
      provider: entry.provider,
      model: result?.model ?? entry.model ?? "unresolved",
      promptVersion: request.promptVersion,
      windowFrom: request.windowFrom ?? null,
      windowTo: request.windowTo ?? null,
      tradesAnalyzed: request.tradesAnalyzed ?? null,
      insight: result?.insight ?? {},
      tokensIn: result?.tokensIn ?? null,
      tokensOut: result?.tokensOut ?? null,
      costMicroUsd: result?.costMicroUsd ?? null,
      outcome,
      errorCode: code === null ? null : safeCode(code),
      route: entry.route ?? null,
      fallbackIndex: entry.fallbackIndex,
      latencyMs,
      inputHash: request.inputHash ?? null,
    };
    try {
      const stored = await this.deps.attempts.record(record);
      return {
        provider: entry.provider,
        route: entry.route,
        fallbackIndex: entry.fallbackIndex,
        outcome,
        code,
        latencyMs,
        attemptId: stored.id,
      };
    } catch {
      // A ledger write must not turn a successful generation into a failure the
      // user sees; the attempt summary still reports what happened. The write
      // failure is the operator's problem, surfaced by the health panel's
      // database component rather than by hiding the answer.
      return {
        provider: entry.provider,
        route: entry.route,
        fallbackIndex: entry.fallbackIndex,
        outcome,
        code,
        latencyMs,
        attemptId: null,
      };
    }
  }
}

/** 0017's error_code shape: ^[A-Z0-9_]{1,48}$. */
function safeCode(code: string): string {
  const cleaned = code.toUpperCase().replace(/[^A-Z0-9_]/gu, "_").slice(0, 48);
  return cleaned === "" ? "UNKNOWN" : cleaned;
}
