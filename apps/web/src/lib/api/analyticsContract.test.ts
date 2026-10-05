/*
 * Analytics wire-contract guard.
 *
 * THE DEFECT THIS EXISTS FOR. `AnalyticsSummary` in the web client used to
 * declare `totalTrades`, `winningTrades`, `losingTrades`, `totalPnL`, `period`
 * and an equity point of `{date, equity, balance}`. The API answers `tradeCount`,
 * `wins`, `losses`, `totalPnl` and `{day, cumulativePnl}`. Nothing failed: the
 * dashboard's `??` fallbacks turned every mismatch into a plausible zero, and the
 * equity chart drew a flat line at zero. A type nobody compares to the server is
 * a comment, not a contract — this test compares it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSummary, computePerStrategy, computeEquityCurve } from "@velora/domain";
import { ANALYTICS_SUMMARY_FIELDS } from "./resources.js";

test("the client's summary fields are exactly the domain's summary keys", () => {
  const actual = Object.keys(computeSummary([])).sort();
  assert.deepEqual([...ANALYTICS_SUMMARY_FIELDS].sort(), actual);
});

test("the client's declared key set covers what the API adds to a summary", () => {
  // `/analytics/summary` spreads the metrics and adds the strategy breakdown.
  const strategyKeys = Object.keys(computePerStrategy([{ netPnl: "1.00", rMultiple: null, strategy: "x" }])[0]!);
  for (const key of ANALYTICS_SUMMARY_FIELDS) {
    assert.ok(strategyKeys.includes(key), `by-strategy rows no longer carry ${key}`);
  }
});

test("curve points are {day, cumulativePnl} — the shape the page plots", () => {
  const points = computeEquityCurve([
    { day: "2026-09-01", netPnl: "10.00" },
    { day: "2026-09-02", netPnl: "-4.00" },
  ]);
  assert.deepEqual(points, [
    { day: "2026-09-01", cumulativePnl: "10.00" },
    { day: "2026-09-02", cumulativePnl: "6.00" },
  ]);
  for (const p of points) {
    assert.deepEqual(Object.keys(p).sort(), ["cumulativePnl", "day"]);
  }
});

test("ratios are STRINGS at 4 dp and money at 2 dp — the scale is part of the contract", () => {
  const summary = computeSummary([{ netPnl: "10.00", rMultiple: "2.00000000" }, { netPnl: "-5.00", rMultiple: null }]);
  assert.equal(typeof summary.winRate, "string");
  assert.match(summary.winRate, /^\d+\.\d{4}$/);
  assert.match(summary.totalPnl, /^-?\d+\.\d{2}$/);
  assert.match(summary.averageR, /^\d+\.\d{4}$/);
});
