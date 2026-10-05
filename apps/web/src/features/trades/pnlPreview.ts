// Live P&L / R preview for the manual trade form (TRD-02).
//
// CAPABILITY: Legacy's /trades/new showed "سود/زیان تخمینی" + an R value while
// the trader typed (pnlPreview / rPreview elements). Modern had no preview, so a
// trader saw the numbers only AFTER saving — and could not tell that a fee or a
// contract size made the trade a loser.
//
// WHY IT IMPORTS THE DOMAIN PACKAGE. The preview must not be a second, "close
// enough" implementation of the P&L rules: two formulas in one product drift,
// and the number a trader sees before saving must be the number the server
// stores. So the preview calls the SAME `computePnl` the API uses, in the SAME
// mode the API uses for a new trade (`half-even`, ADR-001), after applying the
// SAME storage scaling the service applies (prices/volume/contract at scale 8,
// commission/swap at scale 2). If those ever diverge, this is the place to fix —
// the API's tradeService is the other side of the same contract.
import { computePnl, fromString, rescale, toString, type PnlResult } from "@velora/domain";

export interface PreviewInput {
  readonly direction: "buy" | "sell";
  readonly entryPrice: string;
  readonly exitPrice: string;
  readonly volume: string;
  readonly contractSize: string;
  readonly commission: string;
  readonly swap: string;
  readonly stopLoss: string | null;
}

export type PreviewResult =
  | { readonly status: "empty" } // not enough input yet — render "—", never 0
  | { readonly status: "invalid" } // unparseable while typing — render "—"
  | { readonly status: "ok"; readonly result: PnlResult };

/** A decimal literal, optionally signed. Mirrors the API's decimal contract closely enough for a preview. */
const DECIMAL_LITERAL = /^-?\d+(?:\.\d+)?$/;

function decimalOrNull(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "" || !DECIMAL_LITERAL.test(trimmed)) return null;
  return trimmed;
}

function scale(value: string, digits: number): string {
  return toString(rescale(fromString(value), digits, "half-even"));
}

export function previewPnl(input: PreviewInput): PreviewResult {
  const entry = decimalOrNull(input.entryPrice);
  const exit = decimalOrNull(input.exitPrice);
  const volume = decimalOrNull(input.volume);
  const contract = decimalOrNull(input.contractSize);
  const commission = input.commission.trim() === "" ? "0" : decimalOrNull(input.commission);
  const swap = input.swap.trim() === "" ? "0" : decimalOrNull(input.swap);
  const stopLoss = input.stopLoss === null || input.stopLoss.trim() === "" ? null : decimalOrNull(input.stopLoss);

  // Any field still unfinished or malformed: no number, no guess.
  if (entry === null || exit === null || volume === null || contract === null || commission === null || swap === null) {
    return { status: "empty" };
  }
  if (input.stopLoss !== null && input.stopLoss.trim() !== "" && stopLoss === null) return { status: "empty" };

  try {
    const result = computePnl(
      {
        direction: input.direction,
        entryPrice: scale(entry, 8),
        exitPrice: scale(exit, 8),
        volume: scale(volume, 8),
        contractSize: scale(contract, 8),
        commission: scale(commission, 2),
        swap: scale(swap, 2),
        stopLoss: stopLoss === null ? null : scale(stopLoss, 8),
      },
      "half-even",
    );
    return { status: "ok", result };
  } catch {
    // A decimal the domain refuses (e.g. absurd magnitude) is not a crash — the
    // preview simply stays blank and the user keeps typing.
    return { status: "invalid" };
  }
}
