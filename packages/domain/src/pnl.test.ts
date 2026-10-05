// GOLDEN VECTORS — Phase 1 exit requirement (ADR-001).
// Vectors hand-derived from the verified PHP formula set; the engine must
// reproduce them in BOTH modes except where the modes intentionally differ.
// Inc 8: risk semantics re-verified against the PHP SOURCE (PnlCalculator.php
// riskAmount) and Remote (pnlCalculator.ts riskAmount) — both lineages: no SL
// or SL == 0 → null risk; DIRECTIONAL delta; wrong side → null. The former
// no-SL fallback traced to an unimplemented PHP docblock (inc-8 inventory §3).
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

test("VECTOR-2: XAUUSD sell 1 lot, negative swap, NO stop-loss → gross/net defined, r-multiple UNDEFINED (lineage parity)", () => {
  // Inc-8 conflict resolution (inventory §3): the former pin (fallback risk
  // 1000.00, r 0.99070000) traced to a PHP docblock the PHP code never
  // implemented. PHP riskAmount + Remote riskAmount: no SL → null risk →
  // r_multiple null; gross/net still computed and serialized.
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
    kind: "undefined-risk",
    grossPnl: "1000.00",
    netPnl: "990.70", // 1000 − 12.50 − (−3.20) — still computed (PHP calculate())
    reason: "no-stop-loss",
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

test("VECTOR-4: rounding modes diverge exactly on repeating quotients (net/risk = 2/3)", () => {
  // Inc 8: the vector was rebuilt with a VALID below-entry SL — the former
  // SL 8.00 for a buy at entry 2.00 relied on the removed abs() semantics
  // (directional delta 2−8 ≤ 0 → stop-loss-wrong-side under PHP rules).
  // gross 1.00 (delta 1 × vol 1 × cs 1), risk 1.50 (entry 3 − SL 1.5) → r = 2/3.
  const input = {
    direction: "buy" as const,
    entryPrice: "3.00000000",
    exitPrice: "4.00000000",
    volume: "1.00000000",
    contractSize: "1.00000000",
    commission: "0.00",
    swap: "0.00",
    stopLoss: "1.50000000", // 3 − 1.5 = 1.50 (valid: below entry)
  };
  const parity = computePnl(input, "bcmath-truncate");
  const fresh = computePnl(input, "half-even");
  assert.equal(parity.kind, "ok");
  assert.equal(fresh.kind, "ok");
  if (parity.kind === "ok" && fresh.kind === "ok") {
    assert.equal(parity.netPnl, "1.00");
    assert.equal(parity.risk, "1.50");
    assert.equal(parity.rMultiple, "0.66666666"); // bcmath-equivalent truncation
    assert.equal(fresh.rMultiple, "0.66666667"); // half-even
  }
});

test("VECTOR-5: zero gross (entry == exit, no SL) → explicit undefined-risk branch, never NaN", () => {
  // Inc 8: primary reason is the missing SL (PHP: no SL → null risk);
  // an SL exactly at entry is stop-loss-wrong-side (PHP delta <= 0 → null).
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
  assert.deepEqual(r, { kind: "undefined-risk", grossPnl: "0.00", netPnl: "0.00", reason: "no-stop-loss" });
});

test("VECTOR-5b: SL exactly at entry → stop-loss-wrong-side (PHP delta <= 0 → null risk)", () => {
  const r = computePnl({
    direction: "buy",
    entryPrice: "1.10000000",
    exitPrice: "1.10500000",
    volume: "1.00000000",
    ...EURUSD,
    commission: "0.00",
    swap: "0.00",
    stopLoss: "1.10000000",
  }, "half-even");
  assert.deepEqual(r, { kind: "undefined-risk", grossPnl: "500.00", netPnl: "500.00", reason: "stop-loss-wrong-side" });
});

test("VECTOR-6: zero volume → PHP shape: gross 0, net = −costs, undefined risk (no special case)", () => {
  // Inc 8: the volume-is-zero short-circuit (net forced to "0.00") is removed —
  // PHP calculate() has no volume branch: gross 0, net = 0 − commission − swap,
  // risk 0 → r null. Volume 0 is unreachable through trades validation
  // (positive volume enforced); this pins the engine-level PHP shape.
  const r = computePnl({
    direction: "buy",
    entryPrice: "1.10000000",
    exitPrice: "1.20000000",
    volume: "0.00000000",
    ...EURUSD,
    commission: "2.50",
    swap: "0.50",
    stopLoss: "1.09000000",
  }, "half-even");
  assert.deepEqual(r, { kind: "undefined-risk", grossPnl: "0.00", netPnl: "-3.00", reason: "risk-is-zero" });
});

test("VECTOR-8a: wrong-side SL (buy with SL above entry) → undefined risk (PHP delta <= 0 → null)", () => {
  const r = computePnl({
    direction: "buy",
    entryPrice: "100.00000000",
    exitPrice: "110.00000000",
    volume: "1.00000000",
    contractSize: "1.00000000",
    commission: "0.00",
    swap: "0.00",
    stopLoss: "105.00000000",
  }, "half-even");
  assert.deepEqual(r, { kind: "undefined-risk", grossPnl: "10.00", netPnl: "10.00", reason: "stop-loss-wrong-side" });
});

test("VECTOR-8b: wrong-side SL (sell with SL below entry) → undefined risk", () => {
  const r = computePnl({
    direction: "sell",
    entryPrice: "100.00000000",
    exitPrice: "90.00000000",
    volume: "1.00000000",
    contractSize: "1.00000000",
    commission: "0.00",
    swap: "0.00",
    stopLoss: "95.00000000",
  }, "half-even");
  assert.deepEqual(r, { kind: "undefined-risk", grossPnl: "10.00", netPnl: "10.00", reason: "stop-loss-wrong-side" });
});

test("VECTOR-8c: SL = \"0\" string → treated as no stop-loss (PHP bccomp === 0 → null)", () => {
  const r = computePnl({
    direction: "buy",
    entryPrice: "100.00000000",
    exitPrice: "110.00000000",
    volume: "1.00000000",
    contractSize: "1.00000000",
    commission: "0.00",
    swap: "0.00",
    stopLoss: "0",
  }, "half-even");
  assert.deepEqual(r, { kind: "undefined-risk", grossPnl: "10.00", netPnl: "10.00", reason: "no-stop-loss" });
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

// MG-RANGE-GUARD (audit §9.1) — legacy PnlCalculator::assertFits port:
// profitLoss (netPnl) 16 integer / 8 fraction digits, rMultiple 10 / 8, regex
// /\A-?\d{1,N}(?:\.\d{1,F})?\z/. The engine returns an explicit out-of-range
// result kind instead of throwing (ADR-001 §5 house style; tradeService maps
// it to the legacy 422 VALIDATION_FAILED / OUT_OF_RANGE vocabulary).
// Boundary arithmetic note: risk is scale-2 before the zero check, so these
// vectors keep risk >= 0.01 (riskDelta 1e-8 x volume 1e6 = 0.01) while
// r = net/risk crosses the 10-integer-digit limit via the price delta.

test("MG-RANGE-GUARD: net PnL with 17 integer digits is out of range (legacy profitLoss 16,8)", () => {
  const r = computePnl({
    direction: "buy", entryPrice: "1.00000000", exitPrice: "2.00000000",
    volume: "10000000000000000.00000000", contractSize: "1.00000000",
    commission: "0.00", swap: "0.00", stopLoss: "0.50000000",
  }, "bcmath-truncate");
  assert.deepEqual(r, { kind: "out-of-range", field: "netPnl" });
});

test("MG-RANGE-GUARD: net PnL at exactly 16 integer digits passes the guard", () => {
  const r = computePnl({
    direction: "buy", entryPrice: "1.00000000", exitPrice: "2.00000000",
    volume: "9999999999999999.00000000", contractSize: "1.00000000",
    commission: "0.00", swap: "0.00", stopLoss: "0.50000000",
  }, "bcmath-truncate");
  assert.equal(r.kind, "ok");
  assert.equal(r.netPnl, "9999999999999999.00"); // 16 integer digits — the legacy boundary
});

test("MG-RANGE-GUARD: negative net PnL beyond the limit is out of range (the minus sign is not a digit)", () => {
  const r = computePnl({
    direction: "sell", entryPrice: "2.00000000", exitPrice: "1.00000000",
    volume: "10000000000000000.00000000", contractSize: "1.00000000",
    commission: "0.00", swap: "0.00", stopLoss: "2.50000000",
  }, "bcmath-truncate");
  assert.deepEqual(r, { kind: "out-of-range", field: "netPnl" });
});

test("MG-RANGE-GUARD: net out-of-range shadows undefined-risk (legacy assertFits order)", () => {
  // No stop-loss AND an out-of-range net: legacy throws on profitLoss before
  // rMultiple is ever considered; the guard must return out-of-range, not
  // undefined-risk.
  const r = computePnl({
    direction: "buy", entryPrice: "1.00000000", exitPrice: "2.00000000",
    volume: "10000000000000000.00000000", contractSize: "1.00000000",
    commission: "0.00", swap: "0.00", stopLoss: null,
  }, "bcmath-truncate");
  assert.deepEqual(r, { kind: "out-of-range", field: "netPnl" });
});

test("MG-RANGE-GUARD: r-multiple with 11 integer digits is out of range (legacy rMultiple 10,8)", () => {
  // risk = (1 - 0.99999999) x 1_000_000 = 0.01; net = 100 x 1_000_000 = 1e8;
  // r = 1e8 / 0.01 = 1e10 -> 11 integer digits.
  const r = computePnl({
    direction: "buy", entryPrice: "1.00000000", exitPrice: "101.00000000",
    volume: "1000000.00000000", contractSize: "1.00000000",
    commission: "0.00", swap: "0.00", stopLoss: "0.99999999",
  }, "bcmath-truncate");
  assert.deepEqual(r, { kind: "out-of-range", field: "rMultiple" });
});

test("MG-RANGE-GUARD: r-multiple at exactly 10 integer digits passes the guard", () => {
  // Same shape, delta 99 instead of 100: r = 9.9e9 -> 10 integer digits.
  const r = computePnl({
    direction: "buy", entryPrice: "1.00000000", exitPrice: "100.00000000",
    volume: "1000000.00000000", contractSize: "1.00000000",
    commission: "0.00", swap: "0.00", stopLoss: "0.99999999",
  }, "bcmath-truncate");
  assert.equal(r.kind, "ok");
  assert.equal(r.rMultiple, "9900000000.00000000");
});
