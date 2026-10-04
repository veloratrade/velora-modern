// Legacy ↔ Modern scale parity — MG-RMULTIPLE-SCALE.
//
// The gap as recorded: "r_multiple scale 4 (legacy) vs 8 (modern) — different
// stored strings for identical inputs; affects every row at migration". These
// assertions are the executable form of the resolution:
//
//   * an imported Legacy value is preserved BY VALUE, not by string shape;
//   * comparison happens at the Legacy scale with the Legacy mode;
//   * the mode matters (proved with a value where half-even crosses the 4th dp);
//   * truncation is toward zero and idempotent — the migration's idempotence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computePnl } from "./pnl.js";
import {
  LEGACY_ROUNDING_MODE,
  LEGACY_SCALES,
  currencyParity,
  legacyParityEqual,
  legacyRMultiple,
  rMultipleParity,
  toLegacyScale,
} from "./legacyParity.js";

test("an imported Legacy r_multiple is preserved by value, not by string shape", () => {
  // Legacy decimal(10,4) → Modern numeric(20,8): the column normalises the
  // representation ("1.6450" → 1.64500000) and changes nothing.
  assert.ok(rMultipleParity("1.64500000", "1.6450"));
  assert.ok(rMultipleParity("1.6450", "1.645"));
  assert.ok(!rMultipleParity("1.6451", "1.6450"));
});

test("money parity uses the same rule at the currency scale", () => {
  assert.ok(currencyParity("493.50", "493.50"));
  assert.ok(currencyParity("493.50000000", "493.50"));
  assert.ok(currencyParity("-252.50", "-252.500"));
  assert.ok(!currencyParity("493.51", "493.50"));
});

test("Modern-computed values compare at the Legacy scale with the Legacy mode", () => {
  // Golden Vector A: 1 lot, net 493.50, risk 300 → R 1.64500000 modern.
  const a = computePnl(
    {
      direction: "buy",
      entryPrice: "1.10000",
      exitPrice: "1.10500",
      volume: "1.0",
      contractSize: "100000",
      commission: "5.00",
      swap: "1.50",
      stopLoss: "1.09700",
    },
    LEGACY_ROUNDING_MODE,
  );
  assert.equal(a.kind, "ok");
  if (a.kind !== "ok") return;
  assert.equal(a.netPnl, "493.50");
  assert.equal(a.rMultiple, "1.64500000");
  assert.ok(rMultipleParity(a.rMultiple, "1.6450"), "a historical recomputation must reproduce the stored Legacy string");

  // A non-terminating quotient: 241.00 / 300 = 0.803333… → Legacy "0.8033".
  assert.equal(legacyRMultiple("241.00", "300.00"), "0.8033");
  assert.ok(rMultipleParity("0.80333333", "0.8033"));
});

test("truncation is toward ZERO, so a losing trade keeps its sign's magnitude", () => {
  // -252.50 / 300 = -0.841666… → bcmath gives -0.8416 (not -0.8417, which is
  // what floor-based rounding would produce for a negative value).
  assert.equal(legacyRMultiple("-252.50", "300.00"), "-0.8416");
  assert.equal(toLegacyScale("-1.6456789", 4), "-1.6456");
  assert.equal(toLegacyScale("1.6456789", 4), "1.6456");
});

test("the MODE matters: half-even at scale 8 can carry into the 4th decimal", () => {
  // exact 1.000099999:
  //   truncate-8 → 1.00009999 → legacy 1.0000
  //   half-even-8 → 1.00010000 → legacy 1.0001
  // This is why the historical recomputation path passes `bcmath-truncate`
  // explicitly instead of taking the Modern default.
  assert.equal(toLegacyScale("1.00009999", 4), "1.0000");
  assert.equal(toLegacyScale("1.00010000", 4), "1.0001");
  assert.ok(!legacyParityEqual("1.00010000", "1.0000", LEGACY_SCALES.rMultiple));
  assert.ok(legacyParityEqual("1.00009999", "1.0000", LEGACY_SCALES.rMultiple));
});

test("truncating twice equals truncating once (migration idempotence)", () => {
  for (const v of ["1.6456789", "-0.84166666", "0.80333333", "493.509", "0.00009"]) {
    const once = toLegacyScale(v, 4);
    assert.equal(toLegacyScale(once, 4), once, `${v} must be stable`);
    // And re-importing a legacy value through the Modern column changes nothing.
    assert.equal(toLegacyScale(`${once}0000`, 4), once);
  }
});

test("currency truncates at 2 dp and never rounds a sub-cent up", () => {
  assert.equal(toLegacyScale("1.239", 2), "1.23");
  assert.equal(toLegacyScale("-1.239", 2), "-1.23");
  assert.equal(toLegacyScale("1.999", 2), "1.99");
  // The Modern money path computes at scale 2 already; the conversion is a
  // no-op there, which the gate relies on (B7: no money beyond 2 dp).
  assert.equal(toLegacyScale("493.50", 2), "493.50");
});

test("a zero denominator is refused, never an infinity", () => {
  assert.throws(() => legacyRMultiple("100.00", "0.00"), /zero denominator/);
});
