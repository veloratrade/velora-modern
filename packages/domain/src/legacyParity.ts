// Legacy ↔ Modern scale parity (MG-RMULTIPLE-SCALE, MG-SCHEMA-MAPPING).
//
// THE DIFFERENCE AND WHY IT IS NOT A BUG
// ======================================
// Legacy stored `r_multiple` as `decimal(10,4)` and computed it with
// `bcdiv($net, $risk, 8)` followed by `bcadd($r, "0", 4)` — bcmath, which
// TRUNCATES toward zero. Modern stores `numeric(20,8)` (ADR-001 §3 scale matrix:
// "avoid truncation loss on re-spec") and computes at scale 8. For one input the
// two therefore hold different STRINGS for the same value range:
//
//   exact 1.6456789  →  Legacy "1.6456"        Modern "1.64567890"
//
// ADR-001 §3 already decided the storage side and said why: "Storing at higher
// precision than display never loses parity." What was missing is the RULE, in
// one place, for the two things that actually compare the two systems:
//
//   1. MIGRATION — an imported row keeps Legacy's VALUE verbatim; the numeric
//      column normalises the representation and loses nothing, so no transform
//      may round it (rounding again is how a migration invents data).
//   2. VALIDATION (migration-strategy §6 gate 6, "PnL golden recomputation") —
//      recomputing a historical trade must reproduce the STORED Legacy value.
//      That comparison happens at the LEGACY scale, with the LEGACY rounding
//      mode (`bcmath-truncate`), because that is what produced the stored value.
//
// THE MODE IS NOT COSMETIC. Half-even at scale 8 can carry into the 4th decimal
// where bcmath truncation cannot:
//
//   exact 1.000099999  →  truncate-8 "1.00009999" → legacy "1.0000"
//                      →  half-even-8 "1.00010000" → legacy "1.0001"
//
// A historical recomputation run with the modern default mode would therefore
// fail this gate on roughly one non-terminating quotient in ten thousand, and
// "flaky parity check" is how a real divergence gets ignored. So the historical
// path passes `bcmath-truncate` explicitly, and this module is where the two
// scales meet.
//
// Truncation toward zero is sign-symmetric (-1.6456, never -1.6457), and
// truncating twice equals truncating once — the property the migration's
// idempotence rests on (pinned by tests).
import { cmp, div, fromString, isNeg, isZero, rescale, toString, type Fixed, type RoundingMode } from "./decimal.js";

/** The scale Legacy physically stored each quantity at. */
export const LEGACY_SCALES = {
  /** commission / swap / profit_loss — `decimal(15,2)` and friends. */
  currency: 2,
  /** r_multiple — `decimal(10,4)`. */
  rMultiple: 4,
} as const;

/** The rounding mode that produced every Legacy-stored value (bcmath). */
export const LEGACY_ROUNDING_MODE: RoundingMode = "bcmath-truncate";

/**
 * Render a Modern value at a LEGACY scale, with Legacy's rounding semantics.
 *
 * This is the only legal way to compare a Modern-computed value against a
 * Legacy-stored one. It is a CONVERSION, never a normalisation of stored data:
 * imported rows are written verbatim and must not be passed through here.
 */
export function toLegacyScale(value: string, scale: number): string {
  return toString(rescale(fromString(value), scale, LEGACY_ROUNDING_MODE));
}

/**
 * Does a Modern value reproduce a Legacy-stored value at the Legacy scale?
 *
 * Numeric comparison (not string equality): "1.6450" and "1.645" are the same
 * value, and a migration that preserved the number must not be reported as a
 * mismatch because the stored string carries a different number of zeros.
 */
export function legacyParityEqual(modernValue: string, legacyValue: string, scale: number): boolean {
  return cmp(fromString(toLegacyScale(modernValue, scale)), fromString(legacyValue)) === 0;
}

/** R-multiple parity: the two ways Legacy and Modern can be compared (MG-RMULTIPLE-SCALE). */
export function rMultipleParity(modernR: string, legacyR: string): boolean {
  return legacyParityEqual(modernR, legacyR, LEGACY_SCALES.rMultiple);
}

/** Currency parity (commission / swap / net PnL). */
export function currencyParity(modernValue: string, legacyValue: string): boolean {
  return legacyParityEqual(modernValue, legacyValue, LEGACY_SCALES.currency);
}

/**
 * An exact ratio at a given scale under an explicit mode — the shape both the
 * Modern write path (`half-even`, ADR-001 §4) and the historical recomputation
 * path (`bcmath-truncate` + legacy scale) need from one call site.
 */
export function ratio(numerator: string, denominator: string, scale: number, mode: RoundingMode): Fixed {
  const d = fromString(denominator);
  if (isZero(d)) throw new Error("ratio: zero denominator");
  return div(fromString(numerator), d, scale, mode);
}

/** Legacy's r_multiple exactly as the PHP engine would have stored it. */
export function legacyRMultiple(netPnl: string, risk: string): string {
  const quotient = ratio(netPnl, risk, 8, LEGACY_ROUNDING_MODE);
  return toString(rescale(quotient, LEGACY_SCALES.rMultiple, LEGACY_ROUNDING_MODE));
}

/** True when a value is negative — re-exported so callers do not reach past this module. */
export const isNegative = isNeg;
