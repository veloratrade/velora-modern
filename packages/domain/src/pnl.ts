// PnL engine — verified PHP formulas (PnlCalculator, read-verified 2026-08-29):
//   gross(buy)  = (exit − entry) × volume × contract_size
//   gross(sell) = (entry − exit) × volume × contract_size
//   net         = gross − commission − swap
//   risk        = |entry − stop_loss| × volume × contract_size
//                 (falls back to initial price delta |exit − entry| when no SL)
//   r_multiple  = net / risk
// Scales & rounding per ADR-001 (Accepted, D-03):
//   parity mode  = bcmath-equivalent truncation (historical recomputation)
//   new mode     = half-even for new currency computations.
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
      reason: "risk-is-zero" | "volume-is-zero";
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

  if (D.isZero(volume)) {
    return { kind: "undefined-risk", grossPnl: "0.00", netPnl: "0.00", reason: "volume-is-zero" };
  }

  const delta = input.direction === "buy" ? D.sub(exit, entry) : D.sub(entry, exit);
  const grossExact = D.mul(D.mul(delta, volume), cs); // exact at scale 24
  const gross = money(grossExact, mode);
  const net = money(D.sub(D.sub(gross, commission), swap), mode);

  const riskSrc =
    input.stopLoss !== null && input.stopLoss.length > 0
      ? D.abs(D.sub(entry, D.fromString(input.stopLoss)))
      : D.abs(delta); // documented no-SL fallback (verified PHP behavior)
  const risk = money(D.mul(D.mul(riskSrc, volume), cs), mode);

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
