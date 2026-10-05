// MetaAPI position assembly — the MG-METAAPI-ASSEMBLY port of Legacy
// `MetaApiDealAssembler` (api/src/Trades/MetaApiDealAssembler.php @ edede31,
// source-read 2026-10-05, VERIFIED line by line).
//
// CAPABILITY (Legacy defines WHAT): MetaAPI history-deals are individual
// FILLS. A position is opened by one or more DEAL_ENTRY_IN fills and closed by
// one or more DEAL_ENTRY_OUT fills sharing a positionId. Velora's trade model
// is one CLOSED round-trip. This assembler reconstructs that model from a
// durable fill ledger WITHOUT fabricating timestamps or prices:
//
//   - open instant  = EARLIEST resolved IN fill  (when the position began)
//   - close instant = LATEST  resolved OUT fill  (when it finished — anchored
//                     by Velora's own invariant close_time >= MAX(exits))
//   - entry/exit    = volume-weighted average over IN / OUT fill prices
//   - volume        = Σ IN volume (the opened position size)
//   - profit/commission/swap = sums across ALL the position's fills (IN+OUT)
//   - direction     = first buy/sell among the IN fills
//
// NOTHING IS EVER FABRICATED: a position with a missing half, unresolved
// boundary instants, out-of-order boundaries, an unusable direction, or
// non-positive prices/volume is SKIPPED with a machine-readable reason — the
// caller decides which skips are terminal and which stay repairable.
//
// ARITHMETIC (ADR-001): the domain decimal module in `bcmath-truncate` mode
// mirrors the PHP bcmath calls scale-for-scale (bcmul/bcadd/bcdiv/bccomp at
// scale 8), so a scaled-in partial close produces byte-identical strings to
// the Legacy assembler for identical inputs.
//
// Pure: no DB, no I/O, no clock, no timezone database (rule 3, AGENTS.md).

import * as D from "./decimal.js";

/** One ledgered trade fill, shaped for assembly (worker maps the DB row). */
export interface AssemblyFill {
  /** Provider deal id; used for fill-level dedup within one assembly. */
  readonly externalDealId: string | null;
  /** Raw provider positionId (the group key is derived from it). */
  readonly positionId: string | null;
  /** Pre-normalized side. Balance/credit/INOUT/OUT_BY never reach here. */
  readonly entryType: "in" | "out" | null;
  readonly direction: "buy" | "sell" | null;
  readonly symbol: string | null;
  /** Decimal strings (ADR-001 — never numbers). */
  readonly volume: string | null;
  readonly price: string | null;
  readonly profit: string | null;
  readonly commission: string | null;
  readonly swap: string | null;
  /** Resolved absolute UTC instant (offset-explicit provider `time`), or null. */
  readonly occurredAtUtc: string | null;
  /** Raw provider `time` text of the boundary fill (evidence). */
  readonly rawTimeText: string | null;
}

/** A fully-resolved closed position, ready to become one `trades` row. */
export interface AssembledPosition {
  /** `pos-<positionId>` — the trade's identity is the POSITION, not a fill. */
  readonly positionKey: string;
  readonly symbol: string;
  readonly direction: "buy" | "sell";
  /** Volume-weighted averages, scale 8 (bcmath-truncate, like Legacy). */
  readonly entryPrice: string;
  readonly exitPrice: string;
  /** Σ IN volume, scale 8. */
  readonly volume: string;
  /** Sums across ALL fills (IN+OUT), scale 8; "0" when no fill carried one. */
  readonly profitLoss: string;
  readonly commission: string;
  readonly swap: string;
  readonly openInstantUtc: string;
  readonly closeInstantUtc: string;
  readonly rawOpenText: string | null;
  readonly rawCloseText: string | null;
}

/** Machine-readable skip reasons — Legacy vocabulary, verbatim. */
export type AssemblySkipReason =
  | "unpaired_deal_no_position_id"
  | "missing_open_fill"
  | "position_still_open"
  | "position_partially_open"
  | "open_instant_unresolved"
  | "close_instant_unresolved"
  | "close_before_open"
  | "unknown_direction"
  | "invalid_prices_or_volume"
  | "missing_symbol";

export interface AssemblySkip {
  readonly key: string;
  readonly reason: AssemblySkipReason;
}

export interface AssemblyResult {
  readonly trades: readonly AssembledPosition[];
  readonly skipped: readonly AssemblySkip[];
}

/** Legacy groupKey: `pos-<positionId>` for a valid id, else null (unpairable). */
const POSITION_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export function positionGroupKey(positionId: string | null): string | null {
  if (typeof positionId !== "string") return null;
  const pid = positionId.trim();
  if (pid === "" || !POSITION_ID_RE.test(pid)) return null;
  return `pos-${pid}`;
}

/** The scale every bcmath call in the Legacy assembler used. */
const SCALE = 8;

/**
 * bcadd(x, y, 8) parity: exact addition after truncating any surplus decimals
 * to scale 8 (bcmath truncates operand precision to the requested scale).
 */
function sumDecimal(fills: readonly AssemblyFill[], field: "volume" | "price" | "profit" | "commission" | "swap"): string | null {
  let acc: D.Fixed | null = null;
  for (const f of fills) {
    const v = f[field];
    if (typeof v !== "string" || v === "") continue;
    const term = D.rescale(D.fromString(v), SCALE, "bcmath-truncate");
    acc = acc === null ? term : D.add(acc, term);
  }
  return acc === null ? null : D.toString(D.rescale(acc, SCALE, "bcmath-truncate"));
}

/** Legacy weightedAverage: Σ(price×vol) / Σvol, both at scale 8, truncated. */
function weightedAverage(fills: readonly AssemblyFill[]): string | null {
  let num = D.fromScaled(0n, SCALE);
  let den = D.fromScaled(0n, SCALE);
  for (const f of fills) {
    if (f.price === null || f.volume === null || f.volume === "0") continue;
    // bcmul(price, vol, 8): multiply, then truncate the product to scale 8.
    const product = D.rescale(D.mul(D.fromString(f.price), D.fromString(f.volume)), SCALE, "bcmath-truncate");
    num = D.add(num, product);
    den = D.add(den, D.rescale(D.fromString(f.volume), SCALE, "bcmath-truncate"));
  }
  if (D.isZero(den)) return null;
  return D.toString(D.div(num, den, SCALE, "bcmath-truncate"));
}

/** bccomp(v, "0", 8) > 0 — compares AT scale 8 (surplus decimals truncate). */
function isPositive(decimal: string): boolean {
  const at8 = D.rescale(D.fromString(decimal), SCALE, "bcmath-truncate");
  return D.cmp(at8, D.fromScaled(0n, SCALE)) > 0;
}

/** Legacy boundaryFill: the fill carrying the earliest (or latest) resolved instant. */
function boundaryFill(
  fills: readonly AssemblyFill[],
  latest: boolean,
): AssemblyFill | null {
  let best: AssemblyFill | null = null;
  for (const f of fills) {
    const instant = f.occurredAtUtc;
    if (typeof instant !== "string" || instant === "") continue;
    if (
      best === null
      || best.occurredAtUtc === null
      || (latest && instant > best.occurredAtUtc)
      || (!latest && instant < best.occurredAtUtc)
    ) {
      best = f;
    }
  }
  return best;
}

function openDirection(ins: readonly AssemblyFill[]): "buy" | "sell" | null {
  for (const f of ins) {
    if (f.direction === "buy" || f.direction === "sell") return f.direction;
  }
  return null;
}

function firstString(fills: readonly AssemblyFill[], field: "symbol"): string | null {
  for (const f of fills) {
    const v = f[field];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

/**
 * Assemble ledgered fills into closed-position trades.
 *
 * Fill-level idempotency: within one assembly, a repeated deal id is collapsed
 * so a repeated fill can never double-count volume/PnL. Position-level
 * idempotency across batches is the caller's (database UNIQUE) responsibility.
 */
export function assemblePositions(fills: readonly AssemblyFill[]): AssemblyResult {
  const groups = new Map<string, { in: AssemblyFill[]; out: AssemblyFill[] }>();
  const keyless: AssemblyFill[] = [];
  const seenDeals = new Set<string>();

  for (const deal of fills) {
    if (deal.entryType !== "in" && deal.entryType !== "out") {
      // Balance/credit/inout/other non-trade deal types: neither open nor
      // close, and they carry no position PnL. Ignored (Legacy rule).
      continue;
    }
    const dealId = deal.externalDealId ?? "";
    if (dealId !== "") {
      if (seenDeals.has(dealId)) continue;
      seenDeals.add(dealId);
    }
    const key = positionGroupKey(deal.positionId);
    if (key === null) {
      // A real trade fill with no positionId cannot be paired.
      keyless.push(deal);
      continue;
    }
    const group = groups.get(key) ?? { in: [], out: [] };
    group[deal.entryType].push(deal);
    groups.set(key, group);
  }

  const trades: AssembledPosition[] = [];
  const skipped: AssemblySkip[] = [];

  for (const deal of keyless) {
    skipped.push({ key: deal.externalDealId ?? "deal", reason: "unpaired_deal_no_position_id" });
  }

  for (const [key, sides] of groups) {
    const ins = sides.in;
    const outs = sides.out;

    if (ins.length === 0 || outs.length === 0) {
      skipped.push({
        key,
        reason: ins.length === 0 ? "missing_open_fill" : "position_still_open",
      });
      continue;
    }

    const inVol = sumDecimal(ins, "volume");
    const outVol = sumDecimal(outs, "volume");
    if (
      inVol === null || outVol === null
      || D.cmp(D.fromString(outVol), D.fromString(inVol)) < 0
    ) {
      skipped.push({ key, reason: "position_partially_open" });
      continue;
    }

    const openBoundary = boundaryFill(ins, false);
    const closeBoundary = boundaryFill(outs, true);
    const openInstant = openBoundary?.occurredAtUtc ?? null;
    const closeInstant = closeBoundary?.occurredAtUtc ?? null;

    if (openInstant === null) {
      skipped.push({ key, reason: "open_instant_unresolved" });
      continue;
    }
    if (closeInstant === null) {
      skipped.push({ key, reason: "close_instant_unresolved" });
      continue;
    }
    if (closeInstant < openInstant) {
      skipped.push({ key, reason: "close_before_open" });
      continue;
    }

    const direction = openDirection(ins);
    if (direction === null) {
      skipped.push({ key, reason: "unknown_direction" });
      continue;
    }

    const entry = weightedAverage(ins);
    const exit = weightedAverage(outs);
    const volume = sumDecimal(ins, "volume");
    const profit = sumDecimal([...ins, ...outs], "profit");
    const commission = sumDecimal([...ins, ...outs], "commission");
    const swap = sumDecimal([...ins, ...outs], "swap");

    if (
      entry === null || exit === null || volume === null
      || !isPositive(entry) || !isPositive(exit) || !isPositive(volume)
    ) {
      skipped.push({ key, reason: "invalid_prices_or_volume" });
      continue;
    }

    const symbol = firstString(ins, "symbol") ?? firstString(outs, "symbol");
    if (symbol === null) {
      skipped.push({ key, reason: "missing_symbol" });
      continue;
    }

    trades.push({
      positionKey: key,
      symbol,
      direction,
      entryPrice: entry,
      exitPrice: exit,
      volume,
      profitLoss: profit ?? "0",
      commission: commission ?? "0",
      swap: swap ?? "0",
      openInstantUtc: openInstant,
      closeInstantUtc: closeInstant,
      rawOpenText: openBoundary?.rawTimeText ?? null,
      rawCloseText: closeBoundary?.rawTimeText ?? null,
    });
  }

  return { trades, skipped };
}
