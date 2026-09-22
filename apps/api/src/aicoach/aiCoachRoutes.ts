// AI Coach — v1.0 (roadmap `/ai-coach/latest-insights`).
//
//   GET  /api/v1/ai-coach/latest-insights   stored insights (read-only)
//   GET  /api/v1/ai-coach/consent           consent state
//   POST /api/v1/ai-coach/consent           grant/withdraw AI processing consent
//
// ============================================================
// WHAT IS GENUINELY IMPLEMENTABLE HERE, AND WHAT IS NOT
// ============================================================
// GENERATION is not implemented and is not faked. Producing a coaching insight
// requires a live model provider (`ai_coaching_logs.provider` admits openai |
// gemini — 0017's vocabulary, not mine) plus a key, and the roadmap's async
// design puts generation behind a worker anyway. A route that returned invented
// "insights" would be exactly the fabrication the migration brief prohibits, so
// the read surface is implemented and generation is reported as NOT VERIFIED /
// BLOCKED (no provider credential in scope), with the integration point named.
//
// CONSENT is implemented because the Foundation models it: `users.ai_consent_at`.
// A user's trading data must not be processed by a third-party model without it,
// so the read path reports the consent state and the write path can grant or
// withdraw it at any time. Withdrawal clears the timestamp (it does not keep a
// "was consented" record) — the stored insights already produced remain, which
// matches the retention model in 0017.
import { fail, ok } from "@velora/contracts";
import type { QueryFn } from "../persistence/pg.js";
import { capabilityAbsent, unauthenticated } from "../routes/responses.js";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";

export const LATEST_INSIGHTS = "/api/v1/ai-coach/latest-insights";
export const CONSENT = "/api/v1/ai-coach/consent";

export interface CoachingInsight {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly tradesAnalyzed: number | null;
  readonly insight: Record<string, unknown>;
  readonly outcome: string;
  readonly createdAt: string;
}

export interface AiCoachStore {
  latest(userId: string, limit: number): Promise<CoachingInsight[]>;
  consentState(userId: string): Promise<{ consented: boolean; consentedAt: string | null }>;
  setConsent(userId: string, granted: boolean): Promise<void>;
}

type Row = Record<string, unknown>;

export class PgAiCoachStore implements AiCoachStore {
  constructor(private readonly q: QueryFn) {}

  async latest(userId: string, limit: number): Promise<CoachingInsight[]> {
    const rows = await this.q(
      `SELECT id, provider, model, prompt_version, trades_analyzed, insight, outcome, created_at
         FROM ai_coaching_logs
        WHERE user_id = $1 AND outcome = 'success'
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [userId, limit],
    );
    return rows.map((row: Row) => ({
      id: String(row["id"]),
      provider: String(row["provider"]),
      model: String(row["model"]),
      promptVersion: String(row["prompt_version"]),
      tradesAnalyzed: row["trades_analyzed"] === null ? null : Number(row["trades_analyzed"]),
      insight:
        row["insight"] !== null && typeof row["insight"] === "object"
          ? (row["insight"] as Record<string, unknown>)
          : {},
      outcome: String(row["outcome"]),
      createdAt: row["created_at"] instanceof Date ? (row["created_at"] as Date).toISOString() : String(row["created_at"]),
    }));
  }

  async consentState(userId: string): Promise<{ consented: boolean; consentedAt: string | null }> {
    const rows = await this.q("SELECT ai_consent_at FROM users WHERE id = $1", [userId]);
    const row = rows[0];
    const at = row?.["ai_consent_at"];
    return {
      consented: at !== null && at !== undefined,
      consentedAt: at instanceof Date ? at.toISOString() : at === null || at === undefined ? null : String(at),
    };
  }

  async setConsent(userId: string, granted: boolean): Promise<void> {
    await this.q("UPDATE users SET ai_consent_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now() WHERE id = $1", [
      userId,
      granted,
    ]);
  }
}

/** In-memory double (contract-identical; not database evidence). */
export class MemoryAiCoachStore implements AiCoachStore {
  readonly #insights = new Map<string, CoachingInsight[]>();
  readonly #consent = new Map<string, string | null>();

  add(userId: string, insight: CoachingInsight): void {
    const list = this.#insights.get(userId);
    if (list === undefined) this.#insights.set(userId, [insight]);
    else list.push(insight);
  }

  async latest(userId: string, limit: number): Promise<CoachingInsight[]> {
    return (this.#insights.get(userId) ?? []).slice(0, limit);
  }

  async consentState(userId: string): Promise<{ consented: boolean; consentedAt: string | null }> {
    const at = this.#consent.get(userId) ?? null;
    return { consented: at !== null, consentedAt: at };
  }

  async setConsent(userId: string, granted: boolean): Promise<void> {
    this.#consent.set(userId, granted ? new Date().toISOString() : null);
  }
}

const MAX_LIMIT = 20;

export async function handleAiCoachRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  if (ctx.path !== LATEST_INSIGHTS && ctx.path !== CONSENT) return null;
  const store: AiCoachStore | null = ctx.config.aiCoach ?? null;
  if (store === null) return capabilityAbsent(ctx, "AI coach");
  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);

  if (ctx.path === LATEST_INSIGHTS) {
    if (ctx.method !== "GET") {
      return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
    }
    const rawLimit = ctx.url.searchParams.get("limit");
    const limit = rawLimit === null ? 5 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return { status: 400, body: fail("VALIDATION_FAILED", "Validation failed.", ctx.requestId, { limit: `1..${MAX_LIMIT}` }) };
    }
    const consent = await store.consentState(claims.sub);
    const insights = consent.consented ? await store.latest(claims.sub, limit) : [];
    return { status: 200, body: ok({ consent, insights }) };
  }

  if (ctx.method === "GET") {
    return { status: 200, body: ok(await store.consentState(claims.sub)) };
  }
  if (ctx.method === "POST") {
    const body = await ctx.readBody(ctx.req);
    if (typeof body["granted"] !== "boolean") {
      return { status: 400, body: fail("VALIDATION_FAILED", "Validation failed.", ctx.requestId, { granted: "must be a boolean" }) };
    }
    await store.setConsent(claims.sub, body["granted"]);
    return { status: 200, body: ok(await store.consentState(claims.sub)) };
  }
  return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
}
