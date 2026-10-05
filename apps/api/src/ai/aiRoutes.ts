// The user-facing AI HTTP surface.
//
//   POST /api/v1/ai/analyze-trades   analyse the caller's OWN trades (10/hour)
//   POST /api/v1/ai/weekly-report    a report over a period of the caller's OWN
//                                    trades (5/hour)
//   POST /api/v1/ai/feedback         a correction of an AI answer (20/hour)
//   GET  /api/v1/ai/attempts         the caller's own analyses/reports
//   GET  /api/v1/ai/status           what this deployment can actually do
//
// THE TRUST BOUNDARY IS THE POINT (Legacy `AIController`'s own words): "the
// controller NEVER trusts client-supplied trade objects. Clients send trade_ids[];
// the controller resolves them server-side through TradeResolver (ownership
// enforced)". Modern keeps that exactly — a body carrying `trades` without
// `trade_ids` is refused with its own code, because accepting it would let a
// client have a third-party model analyse trades it does not own, and would put
// invented numbers into a stored insight.
//
// EVERY REFUSAL IS HONEST. A deployment with no provider credential answers 503
// `PROVIDER_NOT_CONFIGURED`; a feature an operator switched off answers 403
// `FEATURE_DISABLED`; a user who has not consented answers 403 `CONSENT_REQUIRED`.
// None of them returns an empty list that could be read as "the model found
// nothing", and none of them invents content.

import { fail, ok } from "@velora/contracts";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";
import { capabilityAbsent, unauthenticated } from "../routes/responses.js";
import type { AiConfigStore } from "./aiConfigStore.js";
import type { AiAnalysisService, AiOperationOutcome } from "./aiAnalysisService.js";
import { MAX_TRADES_ANALYSIS, MAX_TRADES_REPORT } from "./aiAnalysisService.js";
import { AI_FLAGS, FEATURE_FLAG, type AiFeature } from "./aiCatalog.js";
import type { AiFailure } from "./aiErrors.js";

export const AI_ANALYZE_TRADES = "/api/v1/ai/analyze-trades";
export const AI_WEEKLY_REPORT = "/api/v1/ai/weekly-report";
export const AI_FEEDBACK = "/api/v1/ai/feedback";
export const AI_ATTEMPTS = "/api/v1/ai/attempts";
export const AI_STATUS = "/api/v1/ai/status";

const OWNED_PATHS = new Set([AI_ANALYZE_TRADES, AI_WEEKLY_REPORT, AI_FEEDBACK, AI_ATTEMPTS, AI_STATUS]);

/** One row of the caller's own ledger, shaped for a list. */
export interface AttemptView {
  readonly id: string;
  readonly feature: string;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly insight: Record<string, unknown>;
  readonly outcome: string;
  readonly errorCode: string | null;
  readonly route: string | null;
  readonly latencyMs: number | null;
  readonly tradesAnalyzed: number | null;
  readonly windowFrom: string | null;
  readonly windowTo: string | null;
  readonly createdAt: string;
}

/** The reader over the ONE ledger (0017 + 0023 + 0028). Not a second table. */
export interface AiLedgerReader {
  forUser(userId: string, features: readonly string[], limit: number): Promise<AttemptView[]>;
}

export interface AiCapability {
  readonly analysis: AiAnalysisService;
  readonly config: AiConfigStore;
  readonly ledger: AiLedgerReader;
  readonly consent: { consentState(userId: string): Promise<{ consented: boolean; consentedAt: string | null }> };
  /** True when at least one provider can actually be called right now. */
  readonly providerConfigured: () => Promise<boolean>;
  readonly guard: {
    isEnabled(flag: string, userId: string | null): Promise<boolean>;
    checkMultiple(flags: readonly string[], userId: string | null): Promise<Record<string, boolean>>;
  };
}

const MAX_ATTEMPT_LIMIT = 20;

export async function handleAiRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  if (!OWNED_PATHS.has(ctx.path)) return null;

  const capability: AiCapability | null = ctx.config.ai ?? null;
  // Fail closed: no AI capability wired means 503 with the reason, never an empty
  // success that would look like "no insights yet".
  if (capability === null) return capabilityAbsent(ctx, "ai");

  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);
  const userId = claims.sub;

  if (ctx.path === AI_STATUS) {
    if (ctx.method !== "GET") return methodNotAllowed(ctx);
    const consent = await capability.consent.consentState(userId);
    const flags = await capability.guard.checkMultiple(AI_FLAGS, userId);
    return {
      status: 200,
      body: ok({
        consent,
        providerConfigured: await capability.providerConfigured(),
        flags,
        // The features a caller can actually use, so a UI can say "switched off"
        // instead of rendering a button that can only fail.
        features: Object.entries(FEATURE_FLAG).map(([feature, flag]) => ({ feature, flag, enabled: flags[flag] === true })),
      }),
    };
  }

  if (ctx.path === AI_ATTEMPTS) {
    if (ctx.method !== "GET") return methodNotAllowed(ctx);
    const rawLimit = ctx.url.searchParams.get("limit");
    const limit = rawLimit === null ? 10 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ATTEMPT_LIMIT) {
      return validation(ctx, { limit: `1..${MAX_ATTEMPT_LIMIT}` });
    }
    const featureParam = ctx.url.searchParams.get("feature");
    const features = featureParam === null || featureParam === ""
      ? ["analysis", "report"]
      : [featureParam];
    // A caller may only read the features the ledger vocabulary admits; an unknown
    // value yields an empty list rather than a query built from user text.
    const allowed = features.filter((f) => ["analysis", "report", "assistant", "ocr", "coach"].includes(f));
    return { status: 200, body: ok({ attempts: await capability.ledger.forUser(userId, allowed, limit) }) };
  }

  if (ctx.method !== "POST") return methodNotAllowed(ctx);
  const body = await ctx.readBody(ctx.req);

  if (ctx.path === AI_ANALYZE_TRADES) {
    const ids = readTradeIds(body, ctx);
    if (!Array.isArray(ids)) return ids as RouteResult;
    const timeframe = typeof body["timeframe"] === "string" ? body["timeframe"] : null;
    const outcome = await capability.analysis.analyzeTrades(
      timeframe === null
        ? { userId, tradeIds: ids, bodyLocale: body["locale"] }
        : { userId, tradeIds: ids, bodyLocale: body["locale"], timeframe },
    );
    return respond(ctx, outcome, { maxIds: MAX_TRADES_ANALYSIS });
  }

  if (ctx.path === AI_WEEKLY_REPORT) {
    const ids = readTradeIds(body, ctx);
    if (!Array.isArray(ids)) return ids as RouteResult;
    const periodStart = typeof body["period_start"] === "string" ? body["period_start"] : "";
    if (periodStart.trim() === "") return validation(ctx, { period_start: "required, YYYY-MM-DD" });
    const outcome = await capability.analysis.weeklyReport({
      userId,
      tradeIds: ids,
      periodStart,
      periodEnd: typeof body["period_end"] === "string" ? body["period_end"] : null,
      bodyLocale: body["locale"],
    });
    return respond(ctx, outcome, { maxIds: MAX_TRADES_REPORT });
  }

  // AI_FEEDBACK
  const attemptId = body["attempt_id"] ?? body["extraction_id"];
  const original = body["original"];
  const corrected = body["corrected"];
  const feature = typeof body["feature"] === "string" ? body["feature"] : "screenshot_extraction";
  if (original === null || typeof original !== "object" || Array.isArray(original) ||
      corrected === null || typeof corrected !== "object" || Array.isArray(corrected)) {
    return validation(ctx, { original: "must be an object", corrected: "must be an object" });
  }
  const stored = await capability.analysis.submitFeedback({
    userId,
    attemptId: attemptId === null || attemptId === undefined ? null : String(attemptId),
    feature,
    original: original as Record<string, unknown>,
    corrected: corrected as Record<string, unknown>,
  });
  if (stored.status === "invalid") {
    // 422 with its own code: a correction that changes nothing is not feedback,
    // and 0028 has a constraint that would otherwise surface as a database error.
    return { status: 422, body: fail("AI_NO_CHANGES", "The correction changes nothing.", ctx.requestId, { changed_fields: "at least one field must differ" }) };
  }
  return {
    status: 201,
    body: ok({
      feedback_id: stored.row.id,
      stored: true,
      changed_fields: stored.row.changedFields,
      // Legacy answered with `messageKey: 'ai.feedbackStored'`; Modern returns the
      // code and lets the client's catalog own the sentence.
      messageCode: "ai.feedbackStored",
    }),
  };
}

/**
 * `trade_ids[]` or nothing. A body that carries `trades` without `trade_ids` is
 * refused with its own code — Legacy's explicit rejection of the insecure
 * contract, kept because the reason it exists has not changed.
 */
function readTradeIds(body: Record<string, unknown>, ctx: ExtendedRouteContext): string[] | RouteResult {
  if (Object.prototype.hasOwnProperty.call(body, "trades") && !Object.prototype.hasOwnProperty.call(body, "trade_ids")) {
    return {
      status: 422,
      body: fail("AI_TRADE_IDS_REQUIRED", "Client-supplied trades are not accepted; send trade_ids[] instead.", ctx.requestId, {
        trade_ids: "required",
      }),
    };
  }
  const raw = body["trade_ids"];
  if (!Array.isArray(raw) || raw.length === 0) return validation(ctx, { trade_ids: "required, non-empty array" });
  const ids = raw.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
  if (ids.length === 0) return validation(ctx, { trade_ids: "required, non-empty array" });
  return ids;
}

function respond(ctx: ExtendedRouteContext, outcome: AiOperationOutcome, bounds: { maxIds: number }): RouteResult {
  if (outcome.status === "ok") {
    return {
      status: 200,
      body: ok({
        ...outcome.payload,
        provider: outcome.provider,
        model: outcome.model,
        confidence: outcome.confidence,
        latency_ms: outcome.latencyMs,
        attempt_id: outcome.attemptId,
      }),
    };
  }
  if (outcome.status === "invalid") {
    const details: Record<string, string> =
      outcome.code === "TOO_MANY_TRADES" ? { trade_ids: `at most ${bounds.maxIds}` }
      : outcome.code === "NO_OWNED_TRADES" ? { trade_ids: "no owned trades found for the provided ids" }
      : outcome.code === "INVALID_PERIOD" ? { period_start: "YYYY-MM-DD" }
      : outcome.code === "PAYLOAD_TOO_LARGE" ? { trade_ids: "the resolved payload exceeds the provider bound" }
      : {};
    return { status: 422, body: fail(`AI_${outcome.code}`, "Validation failed.", ctx.requestId, details) };
  }
  // A refusal or an error carries the classification the client localizes. The
  // status follows the same mapping the manager uses, so 403 means "you or the
  // operator said no", 429 means "the budget is gone", 503 means "not wired" and
  // 502 means "the provider failed".
  const status = outcome.status === "refused" ? refusalStatus(outcome.code) : errorStatus(outcome.code);
  return { status, body: fail(outcome.code, aiMessage(outcome.code), ctx.requestId, { outcome: outcome.status }) };
}

function refusalStatus(code: string): number {
  switch (code) {
    case "FEATURE_DISABLED":
    case "CONSENT_REQUIRED":
    case "IMAGE_NOT_ANONYMIZED":
      return 403;
    case "QUOTA_EXHAUSTED":
      return 429;
    case "PAYLOAD_TOO_LARGE":
    case "UNSUPPORTED_CAPABILITY":
      return 422;
    default:
      return 503;
  }
}

function errorStatus(code: string): number {
  switch (code) {
    case "PROVIDER_TIMEOUT":
    case "DEADLINE_EXCEEDED":
    case "UPSTREAM_TIMEOUT":
      return 504;
    case "INVALID_PROVIDER_OUTPUT":
      return 422;
    case "UPSTREAM_QUOTA_EXHAUSTED":
      return 429;
    default:
      return 502;
  }
}

/** Fixed strings only: a provider's own message never reaches a client. */
function aiMessage(code: string): string {
  switch (code) {
    case "FEATURE_DISABLED": return "This AI feature is not enabled.";
    case "CONSENT_REQUIRED": return "AI processing consent is required.";
    case "PROVIDER_NOT_CONFIGURED": return "No AI provider is configured.";
    case "NO_PROVIDER_AVAILABLE": return "No AI provider is available for this feature.";
    case "QUOTA_EXHAUSTED": return "The AI provider's daily budget is exhausted.";
    case "UPSTREAM_QUOTA_EXHAUSTED": return "The AI provider reported its quota is exhausted.";
    case "IMAGE_NOT_ANONYMIZED": return "The image could not be redacted, so it was not sent to an external provider.";
    case "PAYLOAD_TOO_LARGE": return "The payload exceeds the provider bound.";
    case "UNSUPPORTED_CAPABILITY": return "The selected provider cannot serve this request.";
    case "DEADLINE_EXCEEDED":
    case "PROVIDER_TIMEOUT":
    case "UPSTREAM_TIMEOUT": return "The AI provider timed out.";
    case "INVALID_PROVIDER_OUTPUT": return "The AI provider returned an unusable answer.";
    case "OCR_UNAVAILABLE": return "The local OCR engine is not available.";
    default: return "The AI request failed.";
  }
}

function validation(ctx: ExtendedRouteContext, details: Record<string, string>): RouteResult {
  return { status: 422, body: fail("VALIDATION_FAILED", "Validation failed.", ctx.requestId, details) };
}

function methodNotAllowed(ctx: ExtendedRouteContext): RouteResult {
  return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
}

export type { AiFailure, AiFeature };
