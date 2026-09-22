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
    };

const S_CUR = SCALES.currency;
const S_R = SCALES.rMultiple;

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
  return {
    kind: "ok",
    grossPnl: D.toString(gross),
    netPnl: D.toString(net),
    risk: D.toString(risk),
    rMultiple: D.toString(r),
  };
}
