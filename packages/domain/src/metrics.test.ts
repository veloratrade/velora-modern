// Golden vectors for the migrated performance metrics.
//
// Each case pins a rule a naive reimplementation gets WRONG. They are written
// as exact decimal STRINGS because every value is money or a ratio: a float
// assertion would hide the rounding behaviour the Legacy aggregates had.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeEquityCurve, computePerStrategy, computeSummary, type MetricTrade } from "./metrics.js";

const t = (netPnl: string | null, rMultiple: string | null = null, strategy: string | null = null): MetricTrade => ({
  netPnl,
  rMultiple,
  strategy,
});

test("win rate EXCLUDES breakeven trades from the denominator (Legacy rule 2)", () => {
  // 1 win, 1 loss, 1 breakeven → 1/2, NOT 1/3.
  const m = computeSummary([t("10.00"), t("-5.00"), t("0.00")]);
  assert.equal(m.wins, 1);
  assert.equal(m.losses, 1);
  assert.equal(m.breakeven, 1);
  assert.equal(m.winRate, "0.5000");
  assert.equal(m.tradeCount, 3);
});

test("all-breakeven book yields win rate 0, not a division by zero", () => {
  const m = computeSummary([t("0.00"), t("0.00")]);
  assert.equal(m.winRate, "0.0000");
  assert.equal(m.profitFactor, "0");
  assert.equal(m.totalPnl, "0.00");
});

test("profit factor is NULL when there are profits and no losses (infinite)", () => {
  const m = computeSummary([t("10.00"), t("2.50")]);
  assert.equal(m.profitFactor, null);
  assert.equal(m.totalPnl, "12.50");
});

test("profit factor is exactly '0' when there is neither profit nor loss", () => {
  assert.equal(computeSummary([t("0.00")]).profitFactor, "0");
  assert.equal(computeSummary([]).profitFactor, "0");
});

test("profit factor divides gross profit by ABSOLUTE gross loss", () => {
  const m = computeSummary([t("30.00"), t("-10.00"), t("-5.00")]);
  assert.equal(m.profitFactor, "2.0000");
});

test("average R skips trades with no R multiple instead of counting them as 0", () => {
  // Two trades have R (2 and -1); the third has none. Average = 0.5, not 0.3333.
  const m = computeSummary([t("10.00", "2.00000000"), t("-5.00", "-1.00000000"), t("3.00", null)]);
  assert.equal(m.averageR, "0.5000");
});

test("average R is 0 when NO trade has an R multiple", () => {
  assert.equal(computeSummary([t("10.00"), t("-5.00")]).averageR, "0.0000");
});

test("open trades count toward tradeCount but contribute to no PnL figure", () => {
  // The Legacy query aggregates trades.profit_loss, which is NULL for an open
  // trade: SUM/AVG/MAX/MIN skip NULLs while COUNT(*) does not. Preserved.
  const m = computeSummary([t("10.00"), t(null), t(null)]);
  assert.equal(m.tradeCount, 3);
  assert.equal(m.totalPnl, "10.00");
  assert.equal(m.wins, 1);
  assert.equal(m.bestTrade, "10.00");
});

test("best/worst default to 0 when there are no closed trades", () => {
  const m = computeSummary([t(null)]);
  assert.equal(m.bestTrade, "0.00");
  assert.equal(m.worstTrade, "0.00");
  assert.equal(m.totalPnl, "0.00");
});

test("money is summed exactly, at currency scale (no float drift)", () => {
  const m = computeSummary([t("0.10"), t("0.20")]);
  assert.equal(m.totalPnl, "0.30");
});

test("equity curve accumulates the running total from zero", () => {
  const points = computeEquityCurve([
    { day: "2026-01-01", netPnl: "10.00" },
    { day: "2026-01-02", netPnl: "-4.50" },
    { day: "2026-01-03", netPnl: "0.75" },
  ]);
  assert.deepEqual(points, [
    { day: "2026-01-01", cumulativePnl: "10.00" },
    { day: "2026-01-02", cumulativePnl: "5.50" },
    { day: "2026-01-03", cumulativePnl: "6.25" },
  ]);
});

test("per-strategy grouping uses the same rules and marks untagged trades", () => {
  const rows = computePerStrategy([t("10.00", null, "breakout"), t("-5.00", null, "breakout"), t("1.00", null, null)]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.strategy, "(untagged)");
  assert.equal(rows[0]?.totalPnl, "1.00");
  assert.equal(rows[1]?.strategy, "breakout");
  assert.equal(rows[1]?.winRate, "0.5000");
});
