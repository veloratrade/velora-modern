/*
 * Presentation formatters — semantics of Legacy `velora-localization.js`
 * (number/currency/percent/time/unit): Intl with numberingSystem "latn",
 * a Latin-digit pass, and "—" for non-finite input. Isomorphic.
 */
import type { Locale } from "../contracts";
import { toLatin } from "./latinDigits";
import { localeMeta } from "./registry";

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

function cacheKey(kind: string, locale: string, options: object): string {
  const ordered = Object.keys(options)
    .sort()
    .map((k) => `${k}:${String((options as Record<string, unknown>)[k])}`)
    .join("|");
  return `${kind}|${locale}|${ordered}`;
}

function numberFormatter(locale: Locale, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const intl = localeMeta(locale).intlLocale;
  const opts: Intl.NumberFormatOptions = { ...options, numberingSystem: "latn" };
  const k = cacheKey("n", intl, opts);
  let f = cache.get(k) as Intl.NumberFormat | undefined;
  if (!f) {
    f = new Intl.NumberFormat(intl, opts);
    cache.set(k, f);
  }
  return f;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function fmtNumber(locale: Locale, value: unknown, options: Intl.NumberFormatOptions = {}): string {
  const n = finite(value);
  return n === null ? "—" : toLatin(numberFormatter(locale, options).format(n));
}

export function fmtCurrency(locale: Locale, value: unknown, currency = "USD", options: Intl.NumberFormatOptions = {}): string {
  const n = finite(value);
  if (n === null) return "—";
  return toLatin(
    numberFormatter(locale, {
      style: "currency",
      currency: currency.toUpperCase(),
      currencyDisplay: "narrowSymbol",
      ...options,
    }).format(n),
  );
}

export function fmtPercent(locale: Locale, value: unknown, options: Intl.NumberFormatOptions = {}): string {
  const n = finite(value);
  return n === null ? "—" : toLatin(numberFormatter(locale, { style: "percent", maximumFractionDigits: 1, ...options }).format(n));
}

/**
 * A decimal string rendered for display: `Intl` grouping, LATIN digits, a fixed
 * number of fraction digits, and "—" when there is no value.
 *
 * Money and ratios arrive from the API as exact decimal STRINGS (scale is part
 * of the contract: money 2 dp, ratios 4 dp, R 8 dp). Rounding them through
 * `Number` for display is fine — the stored value is never the display value —
 * but the digits are trimmed to what a human reads: an R of "1.64500000" is
 * shown as "1.65", not as eight decimals.
 */
export function fmtDecimal(
  locale: Locale,
  value: unknown,
  fractionDigits = 2,
  options: Intl.NumberFormatOptions = {},
): string {
  const n = finite(value);
  if (n === null) return "—";
  return toLatin(
    numberFormatter(locale, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
      ...options,
    }).format(n),
  );
}

/**
 * Money as Legacy displays it: 2 dp with an EXPLICIT sign (`+493.50`, `-252.50`).
 *
 * Legacy used `VeloraLocale.currency(v, 'USD', { minimumFractionDigits: 2,
 * maximumFractionDigits: 2, signDisplay: 'always' })`. The one deliberate
 * difference: no currency SYMBOL. Modern aggregates across accounts that may hold
 * different currencies (`accounts.currency` is per account), and printing "USD"
 * over a mixed total would be a claim the data does not support — Legacy's
 * hard-coded default was a display shortcut, not information.
 */
export function fmtMoney(locale: Locale, value: unknown): string {
  return fmtDecimal(locale, value, 2, { signDisplay: "always" });
}

/** Wall-clock "HH:mm" (no timezone semantics — Legacy `time()` with UTC fields). */
export function fmtTime(locale: Locale, value: string, options: Intl.DateTimeFormatOptions = {}): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return "—";
  const d = new Date(Date.UTC(2000, 0, 1, Number(match[1]), Number(match[2])));
  const intl = localeMeta(locale).intlLocale;
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", timeZone: "UTC", ...options, numberingSystem: "latn" };
  const k = cacheKey("t", intl, opts);
  let f = cache.get(k) as Intl.DateTimeFormat | undefined;
  if (!f) {
    f = new Intl.DateTimeFormat(intl, opts);
    cache.set(k, f);
  }
  return toLatin(f.format(d));
}

/**
 * Long CALENDAR date — Phase 1 account surface ("member since" on `/profile`).
 *
 * Distinct from `fmtTime`, which formats a wall-clock "HH:mm": this one formats an
 * ISO instant as a date and is the ONE place the account pages get that from, so
 * `/profile` and `/settings` cannot drift on locale, calendar or digits.
 * `fa-IR` renders the Jalali calendar a Persian reader expects (Legacy showed the
 * same), the Latin-digit product rule is applied by the same `toLatin` pass the
 * other formatters use, and non-finite input answers "—" rather than echoing it.
 */
export function fmtDateLong(locale: Locale, value: string, options: Intl.DateTimeFormatOptions = {}): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  const intl = localeMeta(locale).intlLocale;
  // `dateStyle`/`timeStyle` are MUTUALLY EXCLUSIVE with explicit components in
  // Intl — mixing them throws `TypeError: Invalid option : option`, which in a
  // React render takes the whole page down (the trade journal did exactly that
  // the first time a component formatter asked for year/month/day/hour/minute).
  // So the long-date default applies ONLY when the caller asked for no
  // components of its own.
  const COMPONENT_KEYS = ["weekday", "era", "year", "month", "day", "hour", "minute", "second", "timeZoneName", "dateStyle", "timeStyle"];
  const explicit = COMPONENT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(options, k));
  const opts: Intl.DateTimeFormatOptions = {
    ...(explicit ? {} : { dateStyle: "long" }),
    ...options,
    numberingSystem: "latn",
  };
  const k = cacheKey("d", intl, opts);
  let f = cache.get(k) as Intl.DateTimeFormat | undefined;
  if (!f) {
    f = new Intl.DateTimeFormat(intl, opts);
    cache.set(k, f);
  }
  return toLatin(f.format(new Date(ms)));
}

export type FormatKind = "number" | "currency" | "percent" | "time";


/** Declarative formatting used by markup that Legacy tagged with data-format. */
export function formatValue(
  locale: Locale,
  kind: FormatKind,
  value: string,
  options: Intl.NumberFormatOptions = {},
  currency = "USD",
): string {
  switch (kind) {
    case "number":
      return fmtNumber(locale, value, options);
    case "currency":
      return fmtCurrency(locale, value, currency, options);
    case "percent":
      return fmtPercent(locale, value, options);
    case "time":
      return fmtTime(locale, value);
  }
}
