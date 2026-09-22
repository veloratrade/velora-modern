// AI provider boundary — the seam directive (t)/pass 2 requires the AI Coach to
// have SEPARATED: local logic · consent · persistence · governance · provider
// abstraction · live calls.
//
// WHY THIS FILE EXISTS. Before pass 2 the module could READ stored insights and
// manage consent, but there was no provider boundary at all: nothing described
// what a generation call is, what it may return, or what must be recorded when it
// goes wrong. Without that seam the first real integration would end up putting
// provider HTTP calls inside a route handler, with the governance rules (consent,
// durable outcome record, no raw prompt/response retention) spread across call
// sites.
//
// THE PROVIDER IS NEVER IMPLEMENTED HERE. `UnconfiguredAiProvider` is the default
// and it FAILS CLOSED: no credential means NO insight is produced and the attempt
// is still recorded. Nothing in this file fabricates coaching content, and there is
// no heuristic "local" fallback — an insight a user sees must come from a model, or
// it must not exist.
//
// LIVE CALLS ARE NOT PROVEN. With no provider credential in this environment, every
// real provider path is NOT_PROVEN; the battery exercises the boundary with a stub.
import type { QueryFn } from "../persistence/pg.js";

/** The providers 0017's CHECK admits. A boundary value, not an open string. */
export const AI_PROVIDERS = ["openai", "gemini"] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

/**
 * What a generation call may return.
 *
 * `insight` is a STRUCTURED object, because 0017 requires the stored insight to be
 * a JSON object (`jsonb_typeof(insight) = 'object'`) and because the roadmap's
 * feature speaks of "structured JSON recommendations". Raw provider prose is not a
 * valid result: it cannot be validated, and storing it would put unvalidated model
 * text into the user's view.
 */
export interface AiGenerationResult {
  readonly model: string;
  readonly insight: Record<string, unknown>;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly costMicroUsd: number | null;
}

/** What the provider is asked. Bounded on purpose — see `MAX_PAYLOAD_BYTES`. */
export interface AiGenerationRequest {
  readonly userId: string;
  readonly promptVersion: string;
  /** Already-aggregated, already-owned data. Never raw rows for another user. */
  readonly facts: Readonly<Record<string, unknown>>;
}

export interface AiProvider {
  readonly name: AiProviderName;
  readonly model: string;
  generate(request: AiGenerationRequest): Promise<AiGenerationResult>;
}

/** Raised when no provider credential is configured. Never a user-visible detail. */
export class AiProviderNotConfiguredError extends Error {
  constructor() {
    super("no AI provider is configured");
    this.name = "AiProviderNotConfiguredError";
  }
}

/**
 * The default provider: configured, but uncredentialed.
 *
 * It throws a TYPED error rather than returning empty content, so a caller cannot
 * mistake "we never called a model" for "the model had nothing to say".
 */
export class UnconfiguredAiProvider implements AiProvider {
  readonly name: AiProviderName = "openai";
  readonly model = "unconfigured";

  async generate(): Promise<AiGenerationResult> {
    throw new AiProviderNotConfiguredError();
  }
}

/**
 * Upper bound on the serialized fact payload.
 *
 * A generation call must not become a data-exfiltration path: the facts come from
 * the caller's own aggregates, and a bounded payload keeps a future call site from
 * quietly shipping an entire trade history (with free-text notes) to a third party.
 */
export const MAX_PAYLOAD_BYTES = 16 * 1024;

/** Upper bound on the stored insight payload, for the same reason in reverse. */
export const MAX_INSIGHT_BYTES = 32 * 1024;

export type FactPayloadCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "payload-too-large" };

/** Reject an oversized fact payload BEFORE any network call is attempted. */
export function checkPayloadSize(facts: Readonly<Record<string, unknown>>): FactPayloadCheck {
  const bytes = Buffer.byteLength(JSON.stringify(facts), "utf8");
  return bytes <= MAX_PAYLOAD_BYTES ? { ok: true } : { ok: false, reason: "payload-too-large" };
}

export type InsightValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not-an-object" | "insight-too-large" | "empty-insight" };

/**
 * Validate provider output before anything is stored or shown.
 *
 * Deliberately shape-based, not content-based: this layer must not try to judge
 * coaching quality (that is not a contract), but it MUST refuse a result that 0017
 * cannot store or that carries no content at all.
 */
export function validateInsight(insight: unknown): InsightValidation {
  if (insight === null || typeof insight !== "object" || Array.isArray(insight)) {
    return { ok: false, reason: "not-an-object" };
  }
  if (Object.keys(insight as Record<string, unknown>).length === 0) {
    return { ok: false, reason: "empty-insight" };
  }
  const bytes = Buffer.byteLength(JSON.stringify(insight), "utf8");
  if (bytes > MAX_INSIGHT_BYTES) return { ok: false, reason: "insight-too-large" };
  return { ok: true };
}

/** A durable record's shape, matching 0017's ai_coaching_logs contract. */
export interface AiAttemptRecord {
  readonly userId: string;
  readonly provider: AiProviderName;
  readonly model: string;
  readonly promptVersion: string;
  readonly windowFrom: string | null;
  readonly windowTo: string | null;
  readonly tradesAnalyzed: number | null;
  readonly insight: Record<string, unknown>;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly costMicroUsd: number | null;
  readonly outcome: "success" | "refused" | "error";
  readonly errorCode: string | null;
}

/** Persistence port for the attempt ledger. */
export interface AiAttemptStore {
  record(entry: AiAttemptRecord): Promise<{ id: string }>;
}

/** PostgreSQL: one INSERT, no raw prompt and no raw response (0017's contract). */
export class PgAiAttemptStore implements AiAttemptStore {
  constructor(private readonly q: QueryFn) {}

  async record(entry: AiAttemptRecord): Promise<{ id: string }> {
    const rows = await this.q(
      `INSERT INTO ai_coaching_logs
         (user_id, provider, model, prompt_version, window_from, window_to, trades_analyzed,
          insight, tokens_in, tokens_out, cost_micro_usd, outcome, error_code)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7,
               $8::jsonb, $9, $10, $11, $12, $13)
       RETURNING id::text AS id`,
      [
        entry.userId, entry.provider, entry.model, entry.promptVersion, entry.windowFrom, entry.windowTo,
        entry.tradesAnalyzed, JSON.stringify(entry.insight), entry.tokensIn, entry.tokensOut,
        entry.costMicroUsd, entry.outcome, entry.errorCode,
      ],
    );
    return { id: String(rows[0]?.["id"]) };
  }
}

/** In-memory double (contract-identical; not database evidence). */
export class MemoryAiAttemptStore implements AiAttemptStore {
  readonly entries: AiAttemptRecord[] = [];
  #seq = 0;

  async record(entry: AiAttemptRecord): Promise<{ id: string }> {
    this.#seq += 1;
    this.entries.push(entry);
    return { id: String(this.#seq) };
  }
}
