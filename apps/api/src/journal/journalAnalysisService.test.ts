// Journal analysis — the AI boundary over the journal domain (ADR-018).
//
// WHAT THIS PINS, AND WHY EACH ONE IS A REAL RISK RATHER THAN A SHAPE CHECK.
//   1. NOTES NEVER LEAVE. A journal entry's `notes` column is the trader's own
//      prose about their own behaviour. Shipping it to a third-party model is a
//      much larger disclosure than the numbers an analysis needs, and it is the
//      kind of leak that no test would notice unless it is written down. The
//      assertion below inspects the payload that actually reaches the coach.
//   2. THE SAMPLE IS BOUNDED TWICE. The page size is a request; the slice is the
//      guarantee. A bounded payload is the difference between an analysis and an
//      egress of a full trade history.
//   3. AI CANNOT MUTATE MONEY. This service has no writer — the only thing it may
//      do is ask the coach for an insight. The fake journal records every call it
//      receives, so "nothing else was touched" is asserted rather than asserted
//      by comment.
//   4. REFUSALS STAY REFUSALS. Consent and provider availability are decided
//      inside `AiCoachService` (before any egress); this layer must forward the
//      code unchanged instead of turning a refusal into an "ok" with empty text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JournalAnalysisService, MAX_SAMPLE_TRADES } from "./journalAnalysisService.js";
import type { AiCoachService, GenerationInput, GenerationOutcome } from "../aicoach/aiCoachService.js";
import type { JournalApplicationService } from "./journalApplicationService.js";

type Row = Record<string, unknown>;

/** A journal double that answers a fixed page and records what it was asked. */
class FakeJournal {
  readonly calls: { method: string; userId: string; input?: unknown }[] = [];
  constructor(private readonly rows: readonly Row[], private readonly total = 0) {}
  async history(userId: string, input?: { page?: number; limit?: number }) {
    this.calls.push({ method: "history", userId, input });
    return { items: this.rows, page: input?.page ?? 1, totalPages: 1, total: this.total };
  }
}

class FakeCoach {
  readonly calls: GenerationInput[] = [];
  constructor(private readonly outcome: GenerationOutcome) {}
  async generate(input: GenerationInput): Promise<GenerationOutcome> {
    this.calls.push(input);
    return this.outcome;
  }
}

const trade = (n: number, extra: Row = {}): Row => ({
  id: String(n),
  symbol: "XAUUSD",
  direction: "buy",
  entryPrice: "2650",
  exitPrice: "2660",
  volume: "0.50",
  profitLoss: n % 2 === 0 ? "120.5" : "-40",
  stopLoss: "2640",
  takeProfit: "2680",
  rMultiple: "2.00",
  strategyTag: null,
  emotionalScore: null,
  openTime: "2026-09-30T10:00:00.000Z",
  // The field that must never be forwarded:
  notes: `private reasoning ${n}`,
  ...extra,
});

function build(rows: readonly Row[], outcome: GenerationOutcome = { status: "generated", id: "insight-1", model: "gemini-2.0-flash", insight: { summary: "ok" } }) {
  const journal = new FakeJournal(rows, rows.length);
  const coach = new FakeCoach(outcome);
  const service = new JournalAnalysisService({
    coach: coach as unknown as AiCoachService,
    journal: journal as unknown as JournalApplicationService,
  });
  return { service, journal, coach };
}

test("no journal data means a refusal, not an empty analysis", async () => {
  const { service, coach } = build([]);
  assert.deepEqual(await service.analyze("user-1"), { status: "refused", code: "NO_DATA" });
  assert.equal(coach.calls.length, 0, "an empty journal must not reach the provider at all");
  assert.equal(await service.buildFacts("user-1"), null);
});

test("the facts payload never contains the trader's private notes", async () => {
  const { service, coach } = build([trade(1), trade(2, { notes: "I revenge-traded after a loss" })]);
  const built = await service.buildFacts("user-1");
  assert.ok(built !== null);

  const serialized = JSON.stringify(built.facts);
  assert.ok(!serialized.includes("notes"), "the `notes` key must not exist in the payload");
  assert.ok(!serialized.includes("private reasoning"), "no note TEXT may appear anywhere in the payload");
  assert.ok(!serialized.includes("revenge-traded"), "a note's prose must not leak through any nested field");

  // …and the same holds for what actually crosses to the provider.
  await service.analyze("user-1");
  const sent = JSON.stringify(coach.calls[0]!.facts);
  assert.ok(!sent.includes("notes") && !sent.includes("private reasoning"));
});

test("the payload is bounded even when the journal port over-returns", async () => {
  const rows = Array.from({ length: 60 }, (_, i) => trade(i + 1));
  const { service, coach } = build(rows);

  // The page size is requested at the documented cap…
  const observed: { journal: FakeJournal; service: JournalAnalysisService } = { journal: (service as unknown as { deps: { journal: FakeJournal } }).deps.journal, service };
  const built = await service.buildFacts("user-1");
  assert.ok(built !== null);
  assert.equal((observed.journal.calls[0]!.input as { limit: number }).limit, MAX_SAMPLE_TRADES);
  // …and the effect is bounded regardless: 60 rows in, at most the cap out.
  assert.equal(built.facts["sample"] instanceof Array ? (built.facts["sample"] as Row[]).length : -1, MAX_SAMPLE_TRADES);
  assert.equal(built.tradeIds.length, MAX_SAMPLE_TRADES);

  await service.analyze("user-1");
  assert.equal(coach.calls[0]!.tradesAnalyzed, MAX_SAMPLE_TRADES, "the ledger's trade count must match what was sent");
});

test("the attempt is tagged `coach` and windowed, and the fact summary is arithmetic on the caller's rows", async () => {
  const { service, coach } = build([trade(2), trade(3), trade(4)]);
  const result = await service.analyze("user-1", { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });

  assert.deepEqual(result, { status: "ok", insight: { summary: "ok" }, model: "gemini-2.0-flash" });
  const sent = coach.calls[0]!;
  assert.equal(sent.userId, "user-1");
  assert.equal(sent.feature, "coach", "analyses belong in the coach feed; `journal_extract` is for parsing");
  assert.equal(sent.windowFrom, "2026-09-01T00:00:00.000Z");
  assert.equal(sent.windowTo, "2026-10-01T00:00:00.000Z");
  assert.equal(sent.facts["tradeCount"], 3);
  // trades 2 and 4 are wins (+120.5), trade 3 is a loss (-40): 2/3 and +201.00.
  assert.equal(sent.facts["wins"], 2);
  assert.equal(sent.facts["losses"], 1);
  assert.equal(sent.facts["winRate"], "0.6667");
  assert.equal(sent.facts["totalProfitLoss"], "201.00");
  assert.deepEqual(sent.facts["symbols"], ["XAUUSD"]);
});

test("an AI refusal is forwarded unchanged, never dressed up as an answer", async () => {
  const consent = build([trade(1)], { status: "refused", code: "CONSENT_REQUIRED" });
  assert.deepEqual(await consent.service.analyze("user-1"), { status: "refused", code: "CONSENT_REQUIRED" });

  const noProvider = build([trade(1)], { status: "refused", code: "PROVIDER_NOT_CONFIGURED" });
  assert.deepEqual(await noProvider.service.analyze("user-1"), { status: "refused", code: "PROVIDER_NOT_CONFIGURED" });

  const failed = build([trade(1)], { status: "error", code: "PROVIDER_ERROR" });
  assert.deepEqual(await failed.service.analyze("user-1"), { status: "error", code: "PROVIDER_ERROR" });
});

test("analysis reads the journal and writes nothing — no mutation path exists", async () => {
  const { service, journal } = build([trade(1), trade(2)]);
  await service.analyze("user-1");
  // Every call the journal received is a read. There is no write method on the
  // double to call: the service is handed the journal's READ side only.
  assert.deepEqual([...new Set(journal.calls.map((c) => c.method))], ["history"]);
  assert.ok(journal.calls.every((c) => c.userId === "user-1"), "analysis is scoped to the caller's own rows");
});
