// PnL golden-vector reconciliation — Phase C increment 2 (wave 2).
//
// Ports the Remote financialParity vectors A–F against the LOCAL engine and
// classifies every value: VERIFIED (both implementations agree), DOCUMENTED
// DIFFERENCE (Local follows PHP/ADR-001 where Remote diverges), or FIXTURE
// PENDING (PHP evidence required before a golden value can be frozen).
//
// Architecture rule applied: the Local calculator (packages/domain/pnl.ts)
// is KEPT — it implements the PHP-verified formulas under ADR-001 dual
// rounding (parity mode = bcmath-equivalent truncation). The Remote
// calculator's stepwise scale-8 truncation and null-risk semantics are NOT
// copied into the engine; divergences are recorded per vector below.
//
// Vector sources: Remote tests/unit/financialParity.test.ts @
// remote-snapshot-99e024c829db (expected values cross-checked by independent
// arithmetic in the comments of this file).
import { test } from "node:test";
import assert from "node:assert/strict";
import { computePnl } from "./pnl.js";
import type { PnlInput } from "./pnl.js";

const PARITY = "bcmath-truncate" as const; // bcmath-equivalent truncation (historical parity)

function run(input: PnlInput) {
  const r = computePnl(input, PARITY);
  assert.equal(r.kind, "ok", `expected a defined-risk result for ${JSON.stringify(input)}`);
  if (r.kind === "ok") return r;
  throw new Error("unreachable");
}

test("VECTOR A (Remote A — EURUSD buy winner): VERIFIED — identical across implementations", () => {
  // gross = (1.1050−1.1000)×1×100000 = 500.00 (exact)
  // net   = 500.00−5.00−1.50 = 493.50 (exact)
  // risk  = |1.1000−1.0970|×1×100000 = 300.00 (exact) → r = 493.50/300 = 1.645
  const r = run({
    direction: "buy", entryPrice: "1.1000", exitPrice: "1.1050", volume: "1.0",
    contractSize: "100000", commission: "5.00", swap: "1.50", stopLoss: "1.0970",
  });
  assert.equal(r.grossPnl, "500.00"); // Remote expected '500.00' — VERIFIED
  assert.equal(r.netPnl, "493.50");   // Remote expected '493.50' — VERIFIED
  assert.equal(r.rMultiple, "1.64500000"); // Remote '1.6450' — same value, Local scale 8
});

test("VECTOR B (Remote B — micro volume): gross/net VERIFIED; risk branch DOCUMENTED DIFFERENCE", () => {
  // gross = 0.1000 × 0.00000001 × 100000 = 0.00001 → scale-2 truncate = 0.00
  const r = computePnl({
    direction: "buy", entryPrice: "1.1000", exitPrice: "1.2000", volume: "0.00000001",
    contractSize: "100000", commission: "0.00", swap: "0.00", stopLoss: "1.0000",
  }, PARITY);
  // DOCUMENTED DIFFERENCE: gross/net agree (0.00), but the ADR-001 scale-2
  // risk (0.0001 → 0.00) hits the explicit undefined-risk branch, while
  // Remote keeps scale-8 risk (0.0001 > 0) and returns a defined result.
  // Local's explicit-branch behavior is pinned by VECTOR-5 (never NaN).
  assert.equal(r.kind, "undefined-risk");
  assert.equal(r.reason, "risk-is-zero");
  assert.equal(r.grossPnl, "0.00"); // Remote expected '0.00' — VERIFIED
  assert.equal(r.netPnl, "0.00");   // Remote expected '0.00' — VERIFIED
});

test("VECTOR C (Remote C — fractional contract size): gross/net VERIFIED; rMultiple DOCUMENTED DIFFERENCE", () => {
  // gross = 5.00×2×33.33333333 = 333.3333333 → truncate-2 = 333.33 (Remote same)
  // net   = 333.33−1.25−0.50 = 331.58 (Remote: 331.58333330 scale-8 → 331.58 — same)
  const r = run({
    direction: "buy", entryPrice: "10.00", exitPrice: "15.00", volume: "2.0",
    contractSize: "33.33333333", commission: "1.25", swap: "0.50", stopLoss: "8.00",
  });
  assert.equal(r.grossPnl, "333.33"); // VERIFIED
  assert.equal(r.netPnl, "331.58");   // VERIFIED
  // rMultiple DIFFERS BY DESIGN: Local divides the ADR-001 scale-2 money values
  // (331.58 / 133.33 = 2.48691217), Remote divides scale-8 intermediates
  // (331.58333330 / 133.33333332 = 2.48687500). Local behavior is pinned by
  // VECTOR-4 (rounding-mode divergence) and ADR-001; the PHP-observable
  // serialization is FIXTURE PENDING (OD-3 fixture capture).
  assert.equal(r.rMultiple, "2.48691217"); // Local: scale-2 money ÷ scale-2 risk
  assert.notEqual(r.rMultiple, "2.48687500"); // Remote scale-8 ÷ scale-8 — explicit divergence record
});

test("VECTOR D (Remote D — fractional commission/swap): DOCUMENTED DIFFERENCE on net (Remote half-up output vs PHP-parity truncation)", () => {
  // gross = 5.00×1.5 = 7.50 (both)
  // net   = 7.50−2.34567891−1.23456789 = 3.91975320 exactly
  //   Local parity mode truncates to 3.91 (bcmath semantics — ADR-001)
  //   Remote emits toFixed(2) → 3.92 (half-up at output)
  // PHP bcmath truncates → Local is the PHP-faithful value. FIXTURE PENDING
  // on the PHP endpoint serialization before freezing the external contract.
  const r = run({
    direction: "buy", entryPrice: "100.00", exitPrice: "105.00", volume: "1.5",
    contractSize: "1", commission: "2.34567891", swap: "1.23456789", stopLoss: "90.00",
  });
  assert.equal(r.grossPnl, "7.50");  // VERIFIED
  assert.equal(r.netPnl, "3.91");    // DOCUMENTED DIFFERENCE (Remote: 3.92)
});

test("VECTOR E (Remote E — repeating r-multiple 10/3): VERIFIED — same value at Local scale 8", () => {
  // gross = 0.0010×1×100000 = 100.00; risk = 0.0003×100000 = 30.00
  // r = 100/30 = 3.3̄ → truncate-8 = 3.33333333 (Remote prints 3.3333)
  const r = run({
    direction: "buy", entryPrice: "1.1000", exitPrice: "1.1010", volume: "1.0",
    contractSize: "100000", commission: "0.00", swap: "0.00", stopLoss: "1.0997",
  });
  assert.equal(r.grossPnl, "100.00"); // VERIFIED
  assert.equal(r.netPnl, "100.00");   // VERIFIED
  assert.equal(r.rMultiple, "3.33333333"); // VERIFIED (Remote '3.3333', same value)
});

test("VECTOR F (Remote F — partial-exit cost allocation, ratio 0.5): VERIFIED", () => {
  // Allocated commission 5.00 / swap 1.00 on volume 0.5:
  // gross = 0.0050×0.5×100000 = 250.00; net = 250.00−5.00−1.00 = 244.00
  const r = run({
    direction: "buy", entryPrice: "1.1000", exitPrice: "1.1050", volume: "0.5",
    contractSize: "100000", commission: "5.00", swap: "1.00", stopLoss: "1.0900",
  });
  assert.equal(r.grossPnl, "250.00"); // Remote expected '250.00' — VERIFIED
  assert.equal(r.netPnl, "244.00");   // Remote expected '244.00' — VERIFIED
});

test("NULL-RISK SEMANTICS (Remote): DOCUMENTED DIFFERENCE — Local keeps the PHP-verified fallback, records the wrong-side gap", () => {
  // Remote: no SL → rMultiple null. Local/PHP: no SL → risk falls back to the
  // initial |exit−entry| delta (verified PHP behavior; pinned by VECTOR-2).
  const noSl = computePnl(
    { direction: "buy", entryPrice: "100.00", exitPrice: "110.00", volume: "1.0",
      contractSize: "1", commission: "0.00", swap: "0.00", stopLoss: null },
    PARITY,
  );
  assert.equal(noSl.kind, "ok");
  if (noSl.kind === "ok") {
    assert.equal(noSl.risk, "10.00"); // fallback risk — PHP-verified, Remote returns null
  }

  // Remote: SL on the wrong side (above entry for a buy) → null risk.
  // Local currently computes risk = |entry−SL| regardless of side. The PHP
  // behavior for a wrong-side SL is UNKNOWN → FIXTURE PENDING; no Local
  // golden value is frozen for this case until PHP evidence exists.
  const wrongSide = computePnl(
    { direction: "buy", entryPrice: "100.00", exitPrice: "110.00", volume: "1.0",
      contractSize: "1", commission: "0.00", swap: "0.00", stopLoss: "105.00" },
    PARITY,
  );
  assert.equal(wrongSide.kind, "ok"); // current Local behavior — NOT a frozen contract value
});
