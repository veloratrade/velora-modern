// Journal statistics — every figure derived from persisted trade rows, none from examples.
//
// WHAT THIS IS FOR.
//   A chat surface has to answer "how am I doing" in one message. The product already computes
//   the dashboard metrics (`metrics.ts`, Legacy-parity, golden-vector tested), so this module does
//   NOT reimplement them: it re-exports `computeSummary` for the shared figures and adds only the
//   two things the journal needs that the dashboard does not carry — recorded fees, and an
//   explicit statement of what could not be computed.
//
// WHAT IT REFUSES TO DO.
//   It never combines fees with PnL. `trades.net_pnl` is written by the ledger, and whether the
//   broker's commission/swap is already inside that number is a business rule this repository has
//   not decided for the manual-journal path (ADR-002 covers mutability, not fee inclusion). A
//   `netAfterFees` figure would therefore be arithmetic performed on an assumption, so it does
//   not exist here: fees are reported as recorded, next to PnL, and `feesCombinedWithPnl:false`
//   states the relation is undefined rather than leaving a reader to infer one.
//
// ZERO DENOMINATORS ARE VALUES, NOT ERRORS.
//   A ratio with nothing behind it is emitted at its contract scale ("0.0000"), and profit factor
//   keeps `metrics.ts`'s three-way semantics (number / null for infinite / "0" for no trades at
//   all). Callers render "not enough data" from `flags`, never from a NaN check.
import * as D from "./decimal.js";
import { SCALES, type RoundingMode } from "@velora/contracts";
import {
  CHECKLIST_ITEMS,
  type ChecklistCoverage,
  type ChecklistItem,
  type ChecklistReviewState,
} from "./journalChecklist.js";
import { computeSummary, type SummaryMetrics } from "./metrics.js";
import { toIsoUtc } from "./time.js";

const ZERO = "0";

export interface JournalStatTrade {
  /** Exact decimal string; null means the trade is still open. */
  readonly netPnl: string | null;
  readonly rMultiple: string | null;
  readonly strategy?: string | null;
  /** Both fee fields are optional in the source row; absent is not zero. */
  readonly commission?: string | null;
  readonly swap?: string | null;
}

export interface JournalStats extends SummaryMetrics {
  readonly closedCount: number;
  readonly openCount: number;
  /** sum(commission + swap) over rows that recorded either. 2 dp, currency scale. */
  readonly totalFees: string;
  /** totalFees / (closed + open), 2 dp. "0.00" when there are no trades. */
  readonly averageFee: string;
  /** Currency scale. "0.00" when there were no wins — the figure is absent, not tiny. */
  readonly averageWin: string;
  readonly averageLoss: string;
  /** Fees are never netted into PnL here; see the header. */
  readonly feesCombinedWithPnl: false;
  /** Machine-readable statement of what could not be computed, e.g. "NO_CLOSED_TRADES". */
  readonly flags: readonly string[];
}

/** Read one serialized trade record into the shape the metrics need. Never throws, never guesses. */
export function asStatTrade(record: Record<string, unknown>): JournalStatTrade {
  const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const numberAsText = (v: unknown): string | null => {
    if (typeof v === "number" && Number.isFinite(v)) return String(v); // emotion-style numeric fields
    return text(v);
  };
  return {
    netPnl: numberAsText(record["profitLoss"] ?? record["netPnl"] ?? null),
    rMultiple: numberAsText(record["rMultiple"] ?? null),
    strategy: text(record["strategyTag"] ?? record["strategy"] ?? null),
    commission: numberAsText(record["commission"] ?? null),
    swap: numberAsText(record["swap"] ?? null),
  };
}

function decimalOr(value: string | null | undefined): D.Fixed | null {
  if (value === null || value === undefined) return null;
  try {
    return D.fromString(value);
  } catch {
    return null; // a malformed stored value contributes nothing, and says so via a flag
  }
}

export function computeJournalStats(
  trades: readonly JournalStatTrade[],
  mode: RoundingMode = "half-even",
): JournalStats {
  const summary = computeSummary(
    trades.map((t) => ({ netPnl: t.netPnl, rMultiple: t.rMultiple, strategy: t.strategy ?? null })),
    mode,
  );
  const S_CUR = SCALES.currency;

  let fees = D.fromString(ZERO);
  let feeRows = 0;
  let closedCount = 0;
  let openCount = 0;
  let malformed = 0;
  let winSum = D.fromString(ZERO);
  let winCount = 0;
  let lossSum = D.fromString(ZERO);
  let lossCount = 0;

  for (const t of trades) {
    for (const fee of [t.commission, t.swap]) {
      if (fee === null || fee === undefined) continue;
      const parsed = decimalOr(fee);
      if (parsed === null) {
        malformed += 1;
        continue;
      }
      fees = D.add(fees, parsed);
      feeRows += 1;
    }
    if (t.netPnl === null) {
      openCount += 1;
      continue;
    }
    closedCount += 1;
    const net = decimalOr(t.netPnl);
    if (net === null) {
      malformed += 1;
      continue;
    }
    const sign = D.cmp(net, D.fromString(ZERO));
    if (sign > 0) {
      winSum = D.add(winSum, net);
      winCount += 1;
    } else if (sign < 0) {
      lossSum = D.add(lossSum, D.abs(net));
      lossCount += 1;
    }
  }

  const avg = (sum: D.Fixed, count: number): string =>
    count > 0 ? D.toString(D.rescale(D.div(sum, D.fromString(String(count)), 8, mode), S_CUR, mode)) : "0.00";

  const flags: string[] = [];
  if (trades.length === 0) flags.push("NO_TRADES");
  if (closedCount === 0 && trades.length > 0) flags.push("NO_CLOSED_TRADES");
  if (openCount > 0) flags.push("OPEN_TRADES_EXCLUDED_FROM_PNL");
  if (feeRows === 0) flags.push("NO_FEES_RECORDED");
  if (malformed > 0) flags.push(`MALFORMED_VALUES_SKIPPED:${malformed}`);

  return {
    ...summary,
    closedCount,
    openCount,
    totalFees: D.toString(D.rescale(fees, S_CUR, mode)),
    averageFee: avg(fees, closedCount + openCount),
    averageWin: avg(winSum, winCount),
    averageLoss: avg(lossSum, lossCount),
    feesCombinedWithPnl: false,
    flags,
  };
}


// ── Local-day windows ───────────────────────────────────────────────────────
//
// SHAPE CONTRACT: the strings returned here are fed straight into `TradeService.searchTrades`, whose
// `DATETIME_RE` (tradeService.ts) accepts `YYYY-MM-DD[T ]HH:mm[:ss]` with an optional offset and
// REJECTS fractional seconds. `toIsoUtc` strips the `.000`, which is why this returns `toIsoUtc`
// output and never `Date.toISOString()`; returning the latter would make every windowed query fail
// with a 400 `VALIDATION_FAILED`.
//
// A chat surface answers "how did today go" and "how did this week go", and both questions are
// asked in the USER's timezone while the rows are stored in UTC. The rule that resolves the
// difference is already ADR-004's: a naive wall time belongs to the profile timezone. This does
// the INVERSE of `interpretDatetime` (wall → instant rather than instant → wall) because the bound
// has to be an instant before it reaches the store, and it uses the same two-pass construction
// so a DST day is right rather than approximately right.
//
// `to` is the NEXT day's midnight and the relation is inclusive (`close_time <= to`), so a trade
// stamped at exactly 00:00:00 of the following local day appears in BOTH windows. A half-open
// bound would need `<`, and that operator belongs to the store, not to this function — so the
// overlap is documented instead of silently traded for a filter change. A closed trade is stamped
// to the second; the duplicate is one row on a boundary second, and the alternative is losing one.

/** Minutes ahead of UTC that `timeZone` reports at `at` (same two-pass shape as the API's parser). */
function zoneOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (type: string): number => Number(parts.find((x) => x.type === type)?.value ?? "0");
  const hour = get("hour") === 24 ? 0 : get("hour"); // some ICU builds emit 24 for midnight
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

const isoDate = (y: number, m: number, d: number): string =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * A `YYYY-MM-DD` in `timeZone` as the UTC interval it covers, both bounds second-precision.
 *
 * Null for a malformed or impossible date (2026-02-30), so the caller refuses rather than
 * silently widening to the whole month — the same round-trip rule `normalizeReportDate` uses.
 */
export function dayWindowInZone(
  dateIso: string,
  timeZone: string,
): { readonly from: string; readonly to: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso.trim());
  if (m === null) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;

  // The next CALENDAR day via `Date.UTC`, which normalises a 31st in a 30-day month and the 29th
  // of February; a hand-rolled day +1 would need to know month lengths to be correct.
  const nextDay = new Date(Date.UTC(y, mo - 1, d + 1));
  const nextIso = `${String(nextDay.getUTCFullYear()).padStart(4, "0")}-`
    + `${String(nextDay.getUTCMonth() + 1).padStart(2, "0")}-`
    + `${String(nextDay.getUTCDate()).padStart(2, "0")}`;

  try {
    return { from: localMidnightToUtc(day, timeZone), to: localMidnightToUtc(nextDay, timeZone) };
  } catch {
    // An unresolvable zone name must not cost the user their answer. UTC is also 0002's column
    // default, and `safeTimezone` has normally collapsed a broken profile zone before we get here.
    return { from: `${dateIso}T00:00:00Z`, to: `${nextIso}T00:00:00Z` };
  }
}

/**
 * Naive UTC ms for a local calendar midnight -> the real instant.
 *
 * The offset is re-read at the corrected instant and applied once more if it moved. For a midnight
 * bound I could NOT construct a zone where that second pass changes the answer — the start and end
 * of a local day straddle a transition's UTC instant only if the transition falls at 00:00 local —
 * so this is kept to mirror the API's own `interpretDatetime` (tradeService.ts) rather than to fix
 * a demonstrated bug. Cheap, and the alternative is two functions that disagree in principle.
 */
function localMidnightToUtc(naive: Date, timeZone: string): string {
  let offset = zoneOffsetMinutes(timeZone, naive);
  let utc = naive.getTime() - offset * 60_000;
  const again = zoneOffsetMinutes(timeZone, new Date(utc));
  if (again !== offset) utc = naive.getTime() - again * 60_000;
  return toIsoUtc(new Date(utc));
}


// ── Checklist coverage over a period ────────────────────────────────────────
//
// WHAT THIS IS, AND WHAT IT REFUSES TO BE.
//   `journalChecklist.ts` records three states per item — CONFIRMED, UNKNOWN (the user said, in
//   words, that they do not know) and UNREVIEWED (nothing was said). This adds up those states over
//   a set of days and nothing else. It is NOT a discipline score, NOT a mistake counter and NOT a
//   rule-violation detector: an item left UNREVIEWED means the record does not mention it, which is
//   a statement about the record. Turning it into "you broke your stop-loss rule" would be inventing
//   a classifier, and no such rule is written down in this repository (audited 2026-10-19: no
//   mistake/`recurring` model, column or vocabulary exists anywhere).
//
//   `noRecordDays` is passed in rather than derived because only the caller knows the PERIOD — the
//   store returns rows that exist, so "seven days back" and "the seven most recent rows" are
//   different questions. Days without a row are counted, never silently dropped, and never rendered
//   as if they had been reviewed and failed.

export interface ChecklistCoverageDay {
  readonly coverage: ChecklistCoverage;
  /**
   * The item states exactly as stored. Required, not optional: the aggregate that names WHICH items
   * are missing can only come from the rows, and a defaulted empty state would silently report
   * "nothing was left unreviewed" for a day whose values were simply not passed in.
   */
  readonly itemStates: Readonly<Record<ChecklistItem, ChecklistReviewState>>;
}

export interface ChecklistItemStateCounts {
  readonly confirmed: number;
  readonly unknown: number;
  readonly unreviewed: number;
}

export interface ChecklistCoverageSummary {
  /** Days in the period that have a checklist row at all. */
  readonly daysWithRecord: number;
  /** Of those, how many have every item CONFIRMED (`coverage.complete`, 11/11). */
  readonly completeDays: number;
  /** Rows that exist but are not complete. `completeDays + partialDays = daysWithRecord`. */
  readonly partialDays: number;
  /** Calendar days in the period for which no row exists — supplied by the caller. */
  readonly noRecordDays: number;
  /** Always `CHECKLIST_ITEMS.length`; kept so a presenter cannot print a denominator of its own. */
  readonly itemsPerDay: number;
  /** Per item, how many of `daysWithRecord` days left it in each state. */
  readonly perItem: Record<ChecklistItem, ChecklistItemStateCounts>;
  /** Per item, how many days recorded it as UNKNOWN ("I don't know"), which is not the same as unreviewed. */
  readonly unknownByItem: Record<ChecklistItem, number>;
}

/**
 * Add up persisted checklist states for a set of days. Empty input returns all-zero counts rather
 * than null: "nothing in this period" is itself the answer, and the caller still has to say it.
 */
export function summarizeChecklistCoverage(
  days: Iterable<ChecklistCoverageDay>,
  noRecordDays = 0,
): ChecklistCoverageSummary {
  const perItem = {} as Record<ChecklistItem, { confirmed: number; unknown: number; unreviewed: number }>;
  const unknownByItem = {} as Record<ChecklistItem, number>;
  for (const item of CHECKLIST_ITEMS) {
    perItem[item] = { confirmed: 0, unknown: 0, unreviewed: 0 };
    unknownByItem[item] = 0;
  }

  let daysWithRecord = 0, completeDays = 0, partialDays = 0;
  for (const day of days) {
    const { coverage } = day;
    if (coverage.total === 0) continue; // defensive: an empty checklist is not a reviewed day
    daysWithRecord += 1;
    if (coverage.complete) completeDays += 1;
    else partialDays += 1;
    // `checklistCoverage` guarantees confirmed + unknown + unreviewed = total, so these three counters
    // are enough to reproduce every row's arithmetic; the per-item breakdown comes from the states
    // themselves, which the caller passes through unmodified.
    for (const item of CHECKLIST_ITEMS) {
      const state = day.itemStates[item];
      if (state === "CONFIRMED") perItem[item].confirmed += 1;
      else if (state === "UNKNOWN") {
        perItem[item].unknown += 1;
        unknownByItem[item] += 1;
      } else perItem[item].unreviewed += 1;
    }
  }

  return {
    daysWithRecord,
    completeDays,
    partialDays,
    noRecordDays,
    itemsPerDay: CHECKLIST_ITEMS.length,
    perItem: perItem as Record<ChecklistItem, ChecklistItemStateCounts>,
    unknownByItem,
  };
}
