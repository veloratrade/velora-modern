import { test } from "node:test";
import assert from "node:assert/strict";
import * as D from "./decimal.js";

test("string round-trip preserves exact scale", () => {
  assert.equal(D.toString(D.fromString("1.08500000")), "1.08500000");
  assert.equal(D.toString(D.fromString("-12.34")), "-12.34");
  assert.equal(D.toString(D.fromString("0.00")), "0.00");
});

test("add/sub exact at max scale", () => {
  assert.equal(D.toString(D.add(D.fromString("1.085"), D.fromString("0.005"))), "1.090");
  assert.equal(D.toString(D.sub(D.fromString("1000.00"), D.fromString("12.50"))), "987.50");
});

test("mul is exact (no rounding at multiply time)", () => {
  const a = D.mul(D.fromString("0.00500"), D.fromString("1.00000000"));
  const b = D.mul(a, D.fromString("100000"));
  assert.equal(D.toString(b), "500.0000000000000"); // exact at scale 13, unrounded
  assert.equal(D.toString(D.rescale(b, 2, "half-even")), "500.00");
});

test("rescale truncate vs half-even differ exactly where expected", () => {
  // 1/6 at scale 8: 0.16666666|6…  truncate → …66 ; half-even → …67
  const one = D.fromString("1.00");
  const six = D.fromString("6.00");
  assert.equal(D.toString(D.div(one, six, 8, "bcmath-truncate")), "0.16666666");
  assert.equal(D.toString(D.div(one, six, 8, "half-even")), "0.16666667");
});

test("truncate is toward zero for negatives (bcmath semantics)", () => {
  const r = D.div(D.fromString("-1.00"), D.fromString("6.00"), 8, "bcmath-truncate");
  assert.equal(D.toString(r), "-0.16666666");
  const r2 = D.div(D.fromString("-1.00"), D.fromString("6.00"), 8, "half-even");
  assert.equal(D.toString(r2), "-0.16666667");
});

test("half-even ties round to even", () => {
  // 2.5 → scale 0 → 2 (even); 3.5 → 4 (even)
  assert.equal(D.toString(D.rescale(D.fromString("2.5"), 0, "half-even")), "2");
  assert.equal(D.toString(D.rescale(D.fromString("3.5"), 0, "half-even")), "4");
  // truncate drops regardless
  assert.equal(D.toString(D.rescale(D.fromString("2.5"), 0, "bcmath-truncate")), "2");
  assert.equal(D.toString(D.rescale(D.fromString("3.5"), 0, "bcmath-truncate")), "3");
});

test("division by zero throws", () => {
  assert.throws(() => D.div(D.fromString("1.00"), D.fromString("0.00"), 2, "half-even"), D.ZeroDivisionError);
});

test("fromNumber is forbidden (ADR-001: no IEEE-754 for financial values)", () => {
  assert.throws(() => D.fromNumber(1.1), D.FloatForbiddenError);
});

test("invalid strings rejected", () => {
  assert.throws(() => D.fromString("1e5"), D.DecimalError);
  assert.throws(() => D.fromString("abc"), D.DecimalError);
  assert.throws(() => D.fromString("1.2.3"), D.DecimalError);
});

test("cmp aligns scales", () => {
  assert.equal(D.cmp(D.fromString("1.5"), D.fromString("1.50000")), 0);
  assert.equal(D.cmp(D.fromString("2.0"), D.fromString("1.99999999")), 1);
});
