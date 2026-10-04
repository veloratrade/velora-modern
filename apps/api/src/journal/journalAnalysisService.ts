// Journal analysis — AI capability on top of the journal domain (ADR-018).
//
// THIS IS A THIN APPLICATION LAYER, NOT A PARALLEL AI STACK.
//   The consent gate, the payload bound, the provider port, the output
//   validation and the durable attempt ledger are ALL the existing
//   `AiCoachService`. This file's only jobs are:
//     1. build FACTS from the caller's own journal entries (aggregates, plus a
//        bounded sample — never free-text notes, never another user's rows);
//     2. tag the attempt with `feature: "coach"` — the honest discriminator,
//        because this IS the coaching pipeline and the insight belongs in the
//        same feed the web app shows. `journal_extract` tags PARSING attempts,
//        which cost nothing and must never render as an insight;
//     3. return a structure the bot can render, or a typed refusal.
//
// AI OUTPUT IS NEVER AUTHORITATIVE. Nothing here writes to `trades` or
// `trade_events`; the provider's answer is stored as an insight (0017) and shown
// as analysis. A model cannot change a financial record — only TradeService can,
// and only through the domain fold.
import type { AiCoachService } from "../aicoach/aiCoachService.js";
import type { JournalApplicationService } from "./journalApplicationService.js";

export type AnalysisOutcome =
  | { readonly status: "ok"; readonly insight: Record<string, unknown>; readonly model: string }
  | { readonly status: "refused"; readonly code: "CONSENT_REQUIRED" | "PROVIDER_NOT_CONFIGURED" | "PAYLOAD_TOO_LARGE" | "NO_DATA" }
  | { readonly status: "error"; readonly code: string };

/**
 * Bounded sample size: a model call must not ship an entire trade history.
 *
 * It is 20 and not an arbitrary larger number because that is the ACTUAL ceiling
 * of the read path — `JournalApplicationService.history` clamps `limit` to 20, so
 * a larger constant here would be a bound that documents itself as weaker than it
 * is (confirmed by test). The slice in `buildFacts` applies it again, so the bound
 * holds even if the journal port ever returned more rows than asked for.
 */
export const MAX_SAMPLE_TRADES = 20;

export interface JournalAnalysisServiceDeps {
  readonly coach: AiCoachService;
  readonly journal: JournalApplicationService;
}

export class JournalAnalysisService {
  constructor(private readonly deps: JournalAnalysisServiceDeps) {}

  /**
   * Aggregate the caller's own entries into a bounded fact payload.
   *
   * Deliberately EXCLUDES `notes`: the notes of a journal entry are the trader's
   * private prose about their own behaviour, and shipping them to a third party
   * is a much larger disclosure than the numbers an analysis needs. A user who
   * wants an analysis of their written reasoning can ask for that explicitly and
   * a future version can consent to it; the default does not.
   */
  async buildFacts(userId: string): Promise<{ facts: Record<string, unknown>; tradeIds: readonly string[] } | null> {
    const history = await this.deps.journal.history(userId, { page: 1, limit: MAX_SAMPLE_TRADES });
    if (history.items.length === 0) return null;

    // Re-applied, not trusted: the caller's page size is a request, and a port
    // that returned more rows than asked for would otherwise widen the payload
    // sent to a third party.
    const closed = history.items.slice(0, MAX_SAMPLE_TRADES).map((trade) => ({
      id: String(trade["id"] ?? ""),
      symbol: String(trade["symbol"] ?? ""),
      direction: String(trade["direction"] ?? ""),
      entryPrice: String(trade["entryPrice"] ?? ""),
      exitPrice: String(trade["exitPrice"] ?? ""),
      stopLoss: trade["stopLoss"] === null || trade["stopLoss"] === undefined ? null : String(trade["stopLoss"]),
      takeProfit: trade["takeProfit"] === null || trade["takeProfit"] === undefined ? null : String(trade["takeProfit"]),
      volume: String(trade["volume"] ?? ""),
      profitLoss: String(trade["profitLoss"] ?? "0"),
      rMultiple: trade["rMultiple"] === null || trade["rMultiple"] === undefined ? null : String(trade["rMultiple"]),
      strategyTag: trade["strategyTag"] === null || trade["strategyTag"] === undefined ? null : String(trade["strategyTag"]),
      emotionalScore: trade["emotionalScore"] === null || trade["emotionalScore"] === undefined ? null : String(trade["emotionalScore"]),
      openTime: String(trade["openTime"] ?? ""),
    }));

    const wins = closed.filter((t) => Number(t.profitLoss) > 0).length;
    const losses = closed.filter((t) => Number(t.profitLoss) < 0).length;
    return {
      tradeIds: closed.map((t) => t.id),
      facts: {
        tradeCount: closed.length,
        wins,
        losses,
        winRate: closed.length === 0 ? "0" : (wins / closed.length).toFixed(4),
        totalProfitLoss: closed.reduce((sum, t) => sum + Number(t.profitLoss), 0).toFixed(2),
        symbols: [...new Set(closed.map((t) => t.symbol))].slice(0, 20),
        sample: closed,
      },
    };
  }

  /**
   * Ask for an analysis of the caller's own journal.
   *
   * The consent check, the size bound and the output validation all happen
   * inside `AiCoachService` — in that order, before any egress — so a missing
   * credential produces `PROVIDER_NOT_CONFIGURED` and a user who has not granted
   * consent produces `CONSENT_REQUIRED`, both recorded in the ledger.
   */
  async analyze(userId: string, window?: { readonly from?: string | null; readonly to?: string | null }): Promise<AnalysisOutcome> {
    const built = await this.buildFacts(userId);
    if (built === null) return { status: "refused", code: "NO_DATA" };

    const result = await this.deps.coach.generate({
      userId,
      // `coach` is deliberate: the coach's own read path shows these rows as
      // insights (analyses belong in that feed); `journal_extract` is reserved
      // for parsing attempts, which are not insights and must stay out of it.
      feature: "coach",
      facts: built.facts,
      windowFrom: window?.from ?? null,
      windowTo: window?.to ?? null,
      tradesAnalyzed: built.tradeIds.length,
    });

    if (result.status === "generated") {
      return { status: "ok", insight: result.insight, model: result.model };
    }
    if (result.status === "refused") {
      return { status: "refused", code: result.code };
    }
    return { status: "error", code: result.code };
  }
}
