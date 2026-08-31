// GOLDEN VECTORS — Phase 1 exit requirement (ADR-001).
// Vectors hand-derived from the verified PHP formula set; the engine must
// reproduce them in BOTH modes except where the modes intentionally differ.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computePnl } from "./pnl.js";

const EURUSD = { contractSize: "100000.00000000" };

test("VECTOR-1: EURUSD buy 1 lot, 50 pips, with SL → r-multiple 1.972", () => {
  const r = computePnl({
    direction: "buy",
    entryPrice: "1.08500000",
    exitPrice: "1.09000000",
    volume: "1.00000000",
    ...EURUSD,
    commission: "7.00",
    swap: "0.00",
    stopLoss: "1.08250000",
  }, "half-even");
  assert.deepEqual(r, {
    kind: "ok",
    grossPnl: "500.00",
    netPnl: "493.00",
    risk: "250.00",
    rMultiple: "1.97200000",
  });
});

test("VECTOR-2: XAUUSD sell 1 lot, negative swap, NO stop-loss → fallback risk = initial delta", () => {
  const r = computePnl({
    direction: "sell",
    entryPrice: "2350.50000000",
    exitPrice: "2340.50000000",
    volume: "1.00000000",
    contractSize: "100.00000000",
    commission: "12.50",
    swap: "-3.20",
    stopLoss: null,
  }, "half-even");
  assert.deepEqual(r, {
    kind: "ok",
    grossPnl: "1000.00",
    netPnl: "990.70", // 1000 − 12.50 − (−3.20)
    risk: "1000.00",
    rMultiple: "0.99070000",
  });
});

test("VECTOR-3: losing buy (negative net, negative r)", () => {
  const r = computePnl({
    direction: "buy",
    entryPrice: "1.10000000",
    exitPrice: "1.09000000",
    volume: "0.50000000",
    ...EURUSD,
    commission: "3.50",
    swap: "0.00",
    stopLoss: "1.09500000",
  }, "half-even");
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  assert.equal(r.grossPnl, "-500.00");
  assert.equal(r.netPnl, "-503.50");
  assert.equal(r.risk, "250.00");
  assert.equal(r.rMultiple, "-2.01400000"); // −503.50 / 250
});

test("VECTOR-4: rounding modes diverge exactly on repeating quotients (net/risk = 1/6)", () => {
  const base = {
    direction: "buy" as const,
    entryPrice: "2.00000000",
    exitPrice: "3.00000000", // gross = 1*1*1 = 1.00
    volume: "1.00000000",
    contractSize: "1.00000000",
    commission: "0.00",
    swap: "0.00",
    stopLoss: "12.00000000", // risk = |2−12| = 10.00 → hmm need 6.00
  };
  // build explicit case: gross 1.00 (delta 1 × vol 1 × cs 1), risk 6.00 (SL 8)
  const input = {
    direction: "buy" as const,
    entryPrice: "2.00000000",
    exitPrice: "3.00000000",
    volume: "1.00000000",
    contractSize: "1.00000000",
    commission: "0.00",
    swap: "0.00",
    stopLoss: "8.00000000", // |2−8| = 6.00
  };
  void base;
  const parity = computePnl(input, "bcmath-truncate");
  const fresh = computePnl(input, "half-even");
  assert.equal(parity.kind, "ok");
  assert.equal(fresh.kind, "ok");
  if (parity.kind === "ok" && fresh.kind === "ok") {
    assert.equal(parity.netPnl, "1.00");
    assert.equal(parity.risk, "6.00");
    assert.equal(parity.rMultiple, "0.16666666"); // bcmath-equivalent truncation
    assert.equal(fresh.rMultiple, "0.16666667"); // half-even
  }
});

test("VECTOR-5: zero risk (entry == exit, no SL) → explicit undefined-risk branch, never NaN", () => {
  const r = computePnl({
    direction: "buy",
    entryPrice: "1.10000000",
    exitPrice: "1.10000000",
    volume: "1.00000000",
    ...EURUSD,
    commission: "0.00",
    swap: "0.00",
    stopLoss: null,
  }, "half-even");
  assert.deepEqual(r, { kind: "undefined-risk", grossPnl: "0.00", netPnl: "0.00", reason: "risk-is-zero" });
});

test("VECTOR-6: zero volume → explicit undefined-risk branch", () => {
  const r = computePnl({
    direction: "buy",
    entryPrice: "1.10000000",
    exitPrice: "1.20000000",
    volume: "0.00000000",
    ...EURUSD,
    commission: "0.00",
    swap: "0.00",
    stopLoss: null,
  }, "half-even");
  assert.equal(r.kind, "undefined-risk");
  if (r.kind === "undefined-risk") assert.equal(r.reason, "volume-is-zero");
});

test("VECTOR-7: partial-exit scale discipline — fractional crypto volume", () => {
  const r = computePnl({
    direction: "buy",
    entryPrice: "50000.12345678",
    exitPrice: "50100.87654321",
    volume: "0.12345678",
    contractSize: "1.00000000",
    commission: "1.99",
    swap: "0.00",
    stopLoss: "49900.00000000",
  }, "half-even");
  assert.equal(r.kind, "ok");
  if (r.kind === "ok") {
    assert.equal(r.grossPnl, "12.44"); // 100.75308643 × 0.12345678 = 12.43865155… → 12.44
    assert.equal(r.netPnl, "10.45"); // 12.44 − 1.99
  }
});
