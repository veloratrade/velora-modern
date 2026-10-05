// PnL engine — verified PHP formulas (PnlCalculator.php, source-read
// 2026-09-13, inc 8; formulas cross-verified against Remote
// src/modules/trades/pnlCalculator.ts):
//   gross(buy)  = (exit − entry) × volume × contract_size
//   gross(sell) = (entry − exit) × volume × contract_size
//   net         = gross − commission − swap        (always computed)
//   risk        = (buy: entry − SL; sell: SL − entry) × volume × contract_size
//                 — DIRECTIONAL (lineage-verified); undefined when no SL,
//                 SL = 0, or SL on the wrong side of entry (PHP
//                 riskAmount → null; Remote riskAmount → null). The earlier
//                 |entry − SL| + no-SL fallback to |exit − entry| traced to a
//                 PHP docblock (roadmap v0.5 aspiration) that the PHP code
//                 never implemented — corrected inc 8 with source evidence.
//   r_multiple  = net / risk                       (undefined risk → null)
// Scales & rounding per ADR-001 (Accepted, D-03):
//   parity mode  = bcmath-equivalent truncation (historical recomputation)
//   new mode     = half-even for new currency computations.
// Intentional Local divergences (ADR-001, pinned — see pnlGoldenVectors.test.ts):
//   money fields (gross/net/risk) are scaled to currency precision BEFORE the
//   r-multiple division (lineages divide scale-8 intermediates); sub-cent
//   risk is undefined (risk-is-zero) rather than a scale-8-defined quotient.
import { SCALES, type RoundingMode } from "@velora/contracts";
import * as D from "./decimal.js";

export interface PnlInput {
  direction: "buy" | "sell";
  entryPrice: string;
  exitPrice: string;
  volume: string;
  contractSize: string;
  commission: string;
  swap: string;
  stopLoss: string | null;
}

export type PnlResult =
  | {
      kind: "ok";
      grossPnl: string; // scale 2
      netPnl: string; // scale 2
      risk: string; // scale 2
      rMultiple: string; // scale 8
    }
  | {
      kind: "undefined-risk"; // explicit branch — never NaN/Infinity (ADR-001 §5)
      grossPnl: string;
      netPnl: string;
      reason: "no-stop-loss" | "stop-loss-wrong-side" | "risk-is-zero";
    }
  | {
      // MG-RANGE-GUARD (audit §9.1): the calculated value cannot be represented
      // inside the supported range — the port of legacy PnlCalculator::assertFits
      // (ValidationException OUT_OF_RANGE). A result kind instead of a throw,
      // for the same reason undefined-risk is a kind: the type system forces
      // every caller to handle the branch (ADR-001 §5 house style).
      kind: "out-of-range";
      /** Legacy called netPnl 'profitLoss'; the API layer maps it back. */
      field: "netPnl" | "rMultiple";
    };

// MG-RANGE-GUARD — runtime range guard, the port of legacy
// PnlCalculator::assertFits (READ-ONLY legacy source-read 2026-10-04):
// legacy validates every calculated financial value against
// /\A-?\d{1,integerDigits}(?:\.\d{1,fractionDigits})?\z/D and throws
// ValidationException OUT_OF_RANGE — profitLoss 16,8 / rMultiple 10,8 —
// "to keep calculated values inside the production schema instead of relying
// on driver-specific truncation or overflow behaviour". The same limits are
// used here: they are STRICTER than the modern storage columns
// (trades.net_pnl NUMERIC(20,2) = 18 integer digits, trades.r_multiple
// NUMERIC(20,8) = 12 integer digits), so a value that passes the guard always
// fits the schema and the legacy rejection envelope is preserved exactly.
//
// CHECK TIMING: the guard runs on the FINAL rescaled strings (what callers
// store). In parity mode (truncation) this is equivalent to legacy's
// pre-rescale check — truncation never changes the integer digit count; in
// half-even mode a boundary value that rounds UP across a digit limit is
// rejected, which is correct because the stored value is what must fit.
const NET_RANGE = { integerDigits: 16, fractionDigits: 8 } as const; // legacy 'profitLoss'
const R_MULTIPLE_RANGE = { integerDigits: 10, fractionDigits: 8 } as const;

const S_CUR = SCALES.currency;
const S_R = SCALES.rMultiple;

/** Legacy assertFits regex semantics: optional '-', 1..N integer digits, optional '.' + 1..F fraction digits. */
function fitsRange(value: string, limit: { integerDigits: number; fractionDigits: number }): boolean {
  return new RegExp(`^-?\\d{1,${limit.integerDigits}}(?:\\.\\d{1,${limit.fractionDigits}})?$`).test(value);
}

function money(f: D.Fixed, mode: RoundingMode): D.Fixed {
  return D.rescale(f, S_CUR, mode);
}

export function computePnl(input: PnlInput, mode: RoundingMode): PnlResult {
  const entry = D.fromString(input.entryPrice);
  const exit = D.fromString(input.exitPrice);
  const volume = D.fromString(input.volume);
  const cs = D.fromString(input.contractSize);
  const commission = D.fromString(input.commission);
  const swap = D.fromString(input.swap);

  // gross/net are always computed (PHP calculate(): no volume special case —
  // volume 0 → gross 0, net = −commission−swap).
  const delta = input.direction === "buy" ? D.sub(exit, entry) : D.sub(entry, exit);
  const grossExact = D.mul(D.mul(delta, volume), cs); // exact at scale 24
  const gross = money(grossExact, mode);
  const net = money(D.sub(D.sub(gross, commission), swap), mode);

  // MG-RANGE-GUARD: net is checked FIRST (legacy asserts profitLoss before
  // rMultiple), so an out-of-range net shadows any undefined-risk branch —
  // exactly the legacy throw order.
  if (!fitsRange(D.toString(net), NET_RANGE)) {
    return { kind: "out-of-range", field: "netPnl" };
  }

  // Risk — PHP PnlCalculator::riskAmount port (inc 8):
  //   no SL or SL == 0 → null; DIRECTIONAL delta; delta <= 0 (wrong side) → null.
  const stopLoss = input.stopLoss;
  const hasStopLoss = stopLoss !== null && stopLoss.length > 0 && !D.isZero(D.fromString(stopLoss));
  if (!hasStopLoss) {
    return { kind: "undefined-risk", grossPnl: D.toString(gross), netPnl: D.toString(net), reason: "no-stop-loss" };
  }
  const sl = D.fromString(stopLoss);
  const riskDelta = input.direction === "buy" ? D.sub(entry, sl) : D.sub(sl, entry);
  if (D.cmp(riskDelta, D.fromString("0")) <= 0) {
    return { kind: "undefined-risk", grossPnl: D.toString(gross), netPnl: D.toString(net), reason: "stop-loss-wrong-side" };
  }
  const risk = money(D.mul(D.mul(riskDelta, volume), cs), mode);

  if (D.isZero(risk)) {
    return { kind: "undefined-risk", grossPnl: D.toString(gross), netPnl: D.toString(net), reason: "risk-is-zero" };
  }

  const r = D.div(net, risk, S_R, mode);
  if (!fitsRange(D.toString(r), R_MULTIPLE_RANGE)) {
    return { kind: "out-of-range", field: "rMultiple" };
  }
  return {
    kind: "ok",
    grossPnl: D.toString(gross),
    netPnl: D.toString(net),
    risk: D.toString(risk),
    rMultiple: D.toString(r),
  };
}
