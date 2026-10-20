// Journal statistics: exact decimals, honest zeros, and no arithmetic on undecided business rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { asStatTrade, computeJournalStats, dayWindowInZone, type JournalStatTrade } from "./journalStats.js";

const t = (over: Partial<JournalStatTrade>): JournalStatTrade => ({
  netPnl: null,
  rMultiple: null,
  strategy: null,
  commission: null,
  swap: null,
  ...over,
});

test("no trades at all: every figure is a stated zero, never NaN and never an exception", () => {
  const s = computeJournalStats([]);
  assert.equal(s.tradeCount, 0);
  assert.equal(s.winRate, "0.0000");
  assert.equal(s.totalPnl, "0.00");
  assert.equal(s.totalFees, "0.00");
  assert.equal(s.averageFee, "0.00");
  assert.equal(s.profitFactor, "0");
  assert.deepEqual(s.flags.slice().sort(), ["NO_FEES_RECORDED", "NO_TRADES"]);
});

test("only open trades: counts exist, PnL figures stay zero, and the reason is flagged", () => {
  const s = computeJournalStats([t({ netPnl: null, commission: "0.07" })]);
  assert.equal(s.tradeCount, 1);
  assert.equal(s.closedCount, 0);
  assert.equal(s.openCount, 1);
  assert.equal(s.totalPnl, "0.00");
  assert.ok(s.flags.includes("NO_CLOSED_TRADES"));
  assert.ok(s.flags.includes("OPEN_TRADES_EXCLUDED_FROM_PNL"));
  assert.equal(s.totalFees, "0.07"); // fees ARE recorded even while the trade is open
});

test("win rate excludes breakeven from the denominator, exactly as the dashboard computes it", () => {
  const s = computeJournalStats([
    t({ netPnl: "100.00" }),
    t({ netPnl: "-50.00" }),
    t({ netPnl: "0.00" }),
  ]);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
  assert.equal(s.breakeven, 1);
  assert.equal(s.winRate, "0.5000", "1/(1+1), not 1/3");
  assert.equal(s.profitFactor, "2.0000");
  assert.equal(s.averageWin, "100.00");
  assert.equal(s.averageLoss, "50.00", "losses are a positive magnitude");
});

test("profit factor keeps the three Legacy semantics", () => {
  assert.equal(computeJournalStats([t({ netPnl: "0.00" })]).profitFactor, "0", "no profit and no loss");
  assert.equal(computeJournalStats([t({ netPnl: "10.00" })]).profitFactor, null, "profit, no losses = infinite");
  assert.equal(computeJournalStats([t({ netPnl: "-10.00" })]).profitFactor, "0.0000");
});

test("fees sum commission and swap as recorded, and are never netted into PnL", () => {
  const s = computeJournalStats([
    t({ netPnl: "100.00", commission: "1.50", swap: "-0.25" }),
    t({ netPnl: "-40.00", commission: "1.50", swap: "0.00" }),
  ]);
  assert.equal(s.totalFees, "2.75");
  assert.equal(s.averageFee, "1.38", "2.75 / 2 at currency scale, half-even");
  assert.equal(s.totalPnl, "60.00", "unchanged by the fee total");
  assert.equal(s.feesCombinedWithPnl, false);
});

test("a row that recorded no fees is not a zero fee: the flag says the data is absent", () => {
  const s = computeJournalStats([t({ netPnl: "5.00" }), t({ netPnl: "6.00", commission: "0.10" })]);
  assert.equal(s.totalFees, "0.10");
  assert.ok(!s.flags.includes("NO_FEES_RECORDED"));
  const none = computeJournalStats([t({ netPnl: "5.00" })]);
  assert.ok(none.flags.includes("NO_FEES_RECORDED"));
});

test("a malformed stored value is skipped and counted, never repaired by guessing", () => {
  const s = computeJournalStats([t({ netPnl: "10.00", commission: "NaN-ish" })]);
  assert.equal(s.totalFees, "0.00");
  assert.ok(s.flags.some((f) => f.startsWith("MALFORMED_VALUES_SKIPPED")));
});

test("asStatTrade reads the serialized API record, including the profitLoss alias", () => {
  const row = asStatTrade({
    profitLoss: "12.34",
    commission: "0.09",
    swap: null,
    rMultiple: "1.5",
    strategyTag: "xau",
    emotionalScore: 4, // a numeric field in the contract, not money
  });
  assert.equal(row.netPnl, "12.34");
  assert.equal(row.commission, "0.09");
  assert.equal(row.swap, null);
  assert.equal(row.strategy, "xau");
  const s = computeJournalStats([row]);
  assert.equal(s.totalPnl, "12.34");
  assert.equal(s.averageR, "1.5000");
  assert.equal(s.totalFees, "0.09");
});

// ── dayWindowInZone: a local day → the UTC interval it covers ───────────────
//
// Asia/Tehran is +03:30 all year (Iran abolished DST in 2022), which gives an offset no test can
// get right by accident. America/New_York on 2026-03-08 is the US spring-forward day, which is
// exactly where a single-pass wall-to-instant conversion lands an hour off.

test("day window in UTC is the calendar day itself", () => {
  assert.deepEqual(dayWindowInZone("2026-10-19", "UTC"), { from: "2026-10-19T00:00:00Z", to: "2026-10-20T00:00:00Z" });
});

test("day window honours a half-hour zone (Asia/Tehran, +03:30 year-round)", () => {
  const w = dayWindowInZone("2026-10-19", "Asia/Tehran")!;
  assert.equal(w.from, "2026-10-18T20:30:00Z");
  assert.equal(w.to, "2026-10-19T20:30:00Z");
  assert.equal((Date.parse(w.to) - Date.parse(w.from)) / 3_600_000, 24);
});

test("day window is right on a spring-forward day", () => {
  // 2026-03-08 is the US transition: 02:00 EST becomes 03:00 EDT. Local midnight on that day is
  // still EST (-05:00) so the window opens at 05:00Z, and the day is 23 hours long. Treating the
  // bound as UTC (04:00Z) or shifting it by the post-transition offset (04:00Z open) both fail here.
  const w = dayWindowInZone("2026-03-08", "America/New_York")!;
  assert.equal(w.from, "2026-03-08T05:00:00Z");
  assert.equal(w.to, "2026-03-09T04:00:00Z"); // 23 hours long
  assert.equal((Date.parse(w.to) - Date.parse(w.from)) / 3_600_000, 23);
  // The neighbouring days are full 24s; only the transition day is short.
  for (const d of ["2026-03-07", "2026-03-09"]) {
    const n = dayWindowInZone(d, "America/New_York")!;
    assert.equal((Date.parse(n.to) - Date.parse(n.from)) / 3_600_000, 24, d);
  }
});

test("day window on a fall-back day is 25 hours, not a doubled-up 24", () => {
  const w = dayWindowInZone("2026-11-01", "America/New_York")!;
  assert.equal(w.from, "2026-11-01T04:00:00Z"); // EDT
  assert.equal(w.to, "2026-11-02T05:00:00Z");   // EST
  assert.equal((Date.parse(w.to) - Date.parse(w.from)) / 3_600_000, 25);
});

test("day window normalises month ends and February, including a leap year", () => {
  assert.equal(dayWindowInZone("2026-04-30", "UTC")!.to, "2026-05-01T00:00:00Z");
  assert.equal(dayWindowInZone("2026-02-28", "UTC")!.to, "2026-03-01T00:00:00Z");
  assert.equal(dayWindowInZone("2024-02-28", "UTC")!.to, "2024-02-29T00:00:00Z");
  assert.equal(dayWindowInZone("2024-02-29", "UTC")!.to, "2024-03-01T00:00:00Z");
});

test("day window refuses an impossible or malformed date instead of widening", () => {
  assert.equal(dayWindowInZone("2026-02-30", "UTC"), null);   // does not exist — no silent March 2nd
  assert.equal(dayWindowInZone("2026-13-01", "UTC"), null);
  assert.equal(dayWindowInZone("2026-1-9", "UTC"), null);     // unpadded is not accepted here; the
  assert.equal(dayWindowInZone("2026-01-09", "UTC") !== null, true); // caller normalises via normalizeReportDate
  assert.equal(dayWindowInZone("", "UTC"), null);
});

test("day window survives an unresolvable zone name by falling back to UTC, not throwing", () => {
  const w = dayWindowInZone("2026-10-19", "Not/AZone")!;
  assert.deepEqual(w, { from: "2026-10-19T00:00:00Z", to: "2026-10-20T00:00:00Z" });
});

test("day windows never overlap the next day's trades except on the boundary second", () => {
  const a = dayWindowInZone("2026-10-18", "Asia/Tehran")!;
  const b = dayWindowInZone("2026-10-19", "Asia/Tehran")!;
  assert.equal(a.to, b.from); // inclusive on both sides is the documented store relation
});
