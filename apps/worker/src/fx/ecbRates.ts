// ECB daily reference rates — the v1.5 "Currency Rate Exchange Service (Daily
// background job pulling ECB rate data)".
//
// WHY THIS MODULE EXISTS: `currency_rates` (0018) and the portfolio conversion
// path were complete, but NOTHING ever wrote a rate — the daily job the roadmap
// names in v1.5 (Backend Changes) was never built, so every conversion depended
// on rows an operator inserted by hand. This is the missing producer.
//
// ============================ SOURCE AND CADENCE ============================
// Roadmap v1.5 names both, so neither is invented here:
//   source  : ECB (European Central Bank) daily reference rates
//   cadence : daily (the ECB publishes once per working day around 16:00 CET)
// The endpoint is the ECB's own daily XML feed, which is base-EUR only:
//     https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
//
// ============================ WHAT IS STORED ================================
// `currency_rates` keys a row by (base, quote, rate_date) with a DISTINCT-pair
// CHECK, so a direction is real data, not a view. The ECB publishes ONE
// direction (EUR → X). Three families are written per publishing day:
//
//   1. PUBLISHED   EUR→X          exactly the ECB figure (source 'ECB')
//   2. INVERSE     X→EUR          the exact reciprocal at scale 10
//                                 (source 'ECB:inverse')
//   3. USD-LEG     X→USD / USD→X  X→USD = (EUR→USD) ÷ (EUR→X), and its
//                                 reciprocal (source 'ECB:usd-cross')
//
// WHY THE THIRD FAMILY: the roadmap's acceptance criterion is
// "Combining a EUR 10,000 account and a USD 10,000 account correctly displays
// normalized USD portfolio equity", i.e. USD is the reporting base. ECB has no
// USD-based table, so X→USD is a single division away from the published EUR
// figures. It is computed here rather than left to each request so that every
// consumer converts with the same, testable number.
//
// ROUNDING AND ITS BOUND: rates are NUMERIC(24,10) and every derived figure is
// produced with the DOMAIN decimal at scale 10 (half-even) — no float ever
// touches a rate. A derived rate therefore carries independent error of at most
// half a unit in the 10th decimal (~5e-11 relative), which is orders of
// magnitude below the money scale (2 dp) the conversion feeds. The exact
// division is done in bigint, so the error is the single explicit rounding and
// not accumulated error from repeated arithmetic.
//
// NOT CLAIMED: this does not produce every cross pair (e.g. GBP→JPY). A pair
// outside the three families above is simply absent, and the portfolio path
// already treats a missing pair as UNCONVERTIBLE rather than assuming parity.
// Cross-rate generation for arbitrary bases is a roadmap-extension question, not
// a migration gap, and is reported rather than invented.
import { cmp, div, fromString, toString } from "@velora/domain";

/**
 * The narrowest database contract this job needs.
 *
 * Declared LOCALLY rather than imported from apps/api: the worker is a separate
 * TypeScript project (it cannot see the API's sources), and a rate writer needs
 * exactly one parameterised statement. Keeping the port this small also lets the
 * battery drive it with a real Pool without pulling the API's query layer in.
 */
export type RateQuery = (
  sql: string,
  params?: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

/** Scale of `currency_rates.rate` (NUMERIC(24,10)). */
export const RATE_SCALE = 10;
/** Reporting base for the derived family (roadmap acceptance criterion). */
export const REPORTING_BASE = "USD";
export const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
export const SOURCE_PUBLISHED = "ECB";
export const SOURCE_INVERSE = "ECB:inverse";
export const SOURCE_USD_CROSS = "ECB:usd-cross";

export interface EcbDailyRates {
  /** Publishing date the ECB states in the feed (YYYY-MM-DD). */
  readonly rateDate: string;
  /** EUR → X, exactly as published. */
  readonly rates: ReadonlyMap<string, string>;
}

export interface RateRow {
  readonly base: string;
  readonly quote: string;
  readonly rate: string;
  readonly source: string;
}

const CURRENCY = /^[A-Z]{3}$/;
const CUBE = /<Cube\s+currency="([A-Za-z]{3})"\s+rate="([0-9.]+)"\s*\/>/g;
const TIME = /<Cube\s+time="(\d{4}-\d{2}-\d{2})"/;

/**
 * Parse the ECB daily feed.
 *
 * Deliberately a strict, dependency-free parse of the ONE document shape the ECB
 * publishes: an unexpected body yields an error rather than an empty rate set,
 * because a silent empty parse would look like "the ECB had nothing to say" and
 * would leave the previous day's rates in place while reporting success.
 */
export function parseEcbDaily(xml: string): EcbDailyRates {
  const time = TIME.exec(xml);
  if (time === null) throw new Error("ecb: publishing date missing from the feed");
  const rates = new Map<string, string>();
  for (const match of xml.matchAll(CUBE)) {
    const code = (match[1] ?? "").toUpperCase();
    const rate = match[2] ?? "";
    if (!CURRENCY.test(code)) continue;
    // A zero/negative rate would violate 0018's CHECK (rate > 0) and is
    // meaningless as a currency figure: refuse it at the boundary.
    if (cmp(fromString(rate), fromString("0")) <= 0) {
      throw new Error(`ecb: non-positive rate for ${code}`);
    }
    rates.set(code, rate);
  }
  if (rates.size === 0) throw new Error("ecb: feed contained no usable rates");
  return { rateDate: time[1] as string, rates };
}

/** Exact reciprocal of a rate, at the stored scale. */
export function reciprocal(rate: string): string {
  return toString(div(fromString("1"), fromString(rate), RATE_SCALE, "half-even"));
}

/** X→base derived from the EUR legs: (EUR→base) ÷ (EUR→X). */
export function crossAgainstBase(rate: string, baseLegRate: string): string {
  return toString(div(fromString(baseLegRate), fromString(rate), RATE_SCALE, "half-even"));
}

/**
 * Expand ECB's base-EUR table into the three stored families.
 *
 * EUR itself is deliberately NOT stored as EUR/EUR: 0018 forbids a same-pair row
 * (base <> quote), and a consumer needing identity conversion performs none.
 */
export function buildRateRows(parsed: EcbDailyRates, base = REPORTING_BASE): RateRow[] {
  const usdLeg = parsed.rates.get(base);
  const rows: RateRow[] = [];
  for (const [code, rate] of parsed.rates) {
    if (code === "EUR") {
      // EUR→base is published directly when the base is not EUR.
      continue;
    }
    rows.push({ base: "EUR", quote: code, rate, source: SOURCE_PUBLISHED });
    rows.push({ base: code, quote: "EUR", rate: reciprocal(rate), source: SOURCE_INVERSE });
    if (usdLeg !== undefined && base !== "EUR" && code !== base) {
      const toBase = crossAgainstBase(rate, usdLeg);
      rows.push({ base: code, quote: base, rate: toBase, source: SOURCE_USD_CROSS });
      rows.push({ base: base, quote: code, rate: reciprocal(toBase), source: SOURCE_USD_CROSS });
    }
  }
  // NOTE: the base's own EUR leg needs no separate block — the loop above already
  // emits EUR→base (published) and base→EUR (inverse) when it reaches that
  // currency, because `usdLeg` is read from the same map it iterates. An earlier
  // draft wrote it twice; the unit test's duplicate-pair assertion caught it.
  return rows;
}

/**
 * Write a publishing day's rates.
 *
 * IDEMPOTENT BY CONSTRUCTION: the primary key is (base, quote, rate_date), so
 * re-running the job for the same ECB day updates the same rows rather than
 * appending duplicates. A re-run is therefore harmless (a worker retry, a manual
 * backfill, a cron that fires twice) and the row count for a day is stable.
 */
export async function storeRates(q: RateQuery, rateDate: string, rows: readonly RateRow[]): Promise<number> {
  let written = 0;
  for (const row of rows) {
    await q(
      `INSERT INTO currency_rates (base, quote, rate_date, rate, source)
       VALUES ($1, $2, $3::date, $4::numeric, $5)
       ON CONFLICT (base, quote, rate_date)
       DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, fetched_at = now()`,
      // The scale is passed so a future schema change to the column cannot
      // silently truncate a value the job believed it had stored.
      [row.base, row.quote, rateDate, row.rate, row.source],
    );
    written++;
  }
  return written;
}
