// Daily journal checklist — a record of what the trader reviewed, and of what they did not.
//
// WHY THIS MODULE REFUSES TO JUDGE ANYTHING.
//   The checklist the trader works with (bias, market leg, price location, PD arrays per
//   timeframe, M1 CISD, SMT, macro timing, stop loss, risk) is a REVIEW ARTIFACT, not a
//   signal engine. This module therefore stores and replays what the user said and nothing
//   else. It does not evaluate whether a bias is "valid", whether a level "counts" as a PD
//   array, or whether a missing item should be inferred from another timeframe. There is no
//   rule here that turns an unreviewed item into a confirmed one, because inventing a
//   trading rule inside a persistence layer is exactly how a journal starts lying.
//
// THREE STATES, AND WHY THEY ARE NOT TWO.
//   CONFIRMED  — the user wrote a value for this item in this report.
//   UNKNOWN    — the user said, in words, that they do not know ("نمی‌دانم", `?`, `tbd`).
//   UNREVIEWED — the item was never mentioned. This is the default, and it is deliberately
//                distinguishable from UNKNOWN: "I checked and there is nothing" and "I have
//                not checked" are different facts, and a journal that flattens them loses the
//                only thing a checklist is for.
//
// VALUES ARE THE USER'S OWN WORDS.
//   Where a word matches a known vocabulary (`صعودی` → BULLISH) it is normalised to the
//   uppercase code so it can be aggregated. Where it does not, the text is kept verbatim and
//   `normalised:false` records that no mapping happened. Nothing is mapped "close enough":
//   a third of an ICT ladder is not the same claim as a premium discount, and guessing which
//   one the user meant would fabricate the review.
//
// NUMBERS ARE STRINGS (ADR-001), parsed with the SAME grammar the trade pipeline uses.
import { normalizeDecimal, normalizeForParsing, parseNumberToken } from "./journalExtraction.js";

export const CHECKLIST_REVIEW_STATES = ["CONFIRMED", "UNREVIEWED", "UNKNOWN"] as const;
export type ChecklistReviewState = (typeof CHECKLIST_REVIEW_STATES)[number];

/** The items this checklist carries. A closed set — never free-text keys. */
export const CHECKLIST_ITEMS = [
  "dailyBias", "marketLeg", "priceLocation", "pdArrayH4", "pdArrayH1", "pdArrayM15",
  "m1Cisd", "smt", "macroTiming", "stopLoss", "risk",
] as const;
export type ChecklistItem = (typeof CHECKLIST_ITEMS)[number];

/** Items whose value is a decimal, and at which scale. Everything else is text. */
export const CHECKLIST_DECIMAL_ITEMS = { stopLoss: "price", risk: "ratio" } as const;
export type ChecklistDecimalItem = keyof typeof CHECKLIST_DECIMAL_ITEMS;

/**
 * Risk is deliberately unit-bearing. `0.5` means half a percent to one trader and half a lot
 * to another; the ADR set has no rule that decides, so the unit is recorded when the user
 * gave one and `UNSPECIFIED` when they did not — never defaulted (AGENTS.md rule 12).
 */
export const CHECKLIST_RISK_UNITS = ["PERCENT", "AMOUNT", "UNSPECIFIED"] as const;
export type ChecklistRiskUnit = (typeof CHECKLIST_RISK_UNITS)[number];

export interface ChecklistItemValue {
  readonly state: ChecklistReviewState;
  /** The normalised code, or the user's verbatim text when no vocabulary matched. */
  readonly value: string | null;
  /** False when `value` is the user's own words rather than a mapped code. */
  readonly normalised: boolean;
}

export interface DailyChecklist {
  readonly reportDate: string;
  readonly timezone: string;
  readonly values: Readonly<Record<ChecklistItem, ChecklistItemValue>>;
  readonly notes: string | null;
  readonly riskUnit: ChecklistRiskUnit;
}

/** A parse attempt. `unparsed` keys are reported, never dropped silently. */
export interface ChecklistParseResult {
  readonly values: Partial<Record<ChecklistItem, string>>;
  /** Items the user explicitly marked as unknown. */
  readonly unknowns: readonly ChecklistItem[];
  readonly notes: string | null;
  readonly unparsed: readonly { readonly key: string }[];
}

export class ChecklistFormatError extends Error {
  constructor(readonly code: string) {
    super(`journal checklist: ${code}`);
    this.name = "ChecklistFormatError";
  }
}

// ── Vocabulary ─────────────────────────────────────────────────────────────

/** Line keys. Persian and English spellings both resolve; matching is on the folded token. */
const KEY_ALIASES: Readonly<Record<string, ChecklistItem>> = {
  bias: "dailyBias", رویکرد: "dailyBias", جهت: "dailyBias", "bias روز": "dailyBias",
  leg: "marketLeg", مارکت‌لج: "marketLeg", مارکت: "marketLeg", پایه: "marketLeg",
  location: "priceLocation", لوکیشن: "priceLocation", محدوده: "priceLocation",
  h4: "pdArrayH4", "pd h4": "pdArrayH4",
  h1: "pdArrayH1", "pd h1": "pdArrayH1",
  m15: "pdArrayM15", "pd m15": "pdArrayM15",
  cisd: "m1Cisd", "m1 cisd": "m1Cisd", "m1": "m1Cisd",
  smt: "smt", "smt divergence": "smt",
  macro: "macroTiming", تایمینگ: "macroTiming", ماکرو: "macroTiming",
  sl: "stopLoss", استاپ: "stopLoss", "stop": "stopLoss",
  risk: "risk", ریسک: "risk",
};

/**
 * `note` / `notes` / `یادداشت` lines append to the free-text note instead of becoming items, and
 * are never reported as unparsed: a trader's own words have exactly one home in this record, and a
 * strict key list must not swallow them.
 */
const NOTE_KEYS = new Set(["note", "notes", "یادداشت", "توضیح", "توضیحات"]);

/** Codes a value may normalise to. Anything else is kept verbatim, unmapped. */
const VALUE_VOCAB: Readonly<Partial<Record<ChecklistItem, Readonly<Record<string, string>>>>> = {
  dailyBias: { bullish: "BULLISH", صعودی: "BULLISH", buy: "BULLISH", long: "BULLISH",
    bearish: "BEARISH", نزولی: "BEARISH", sell: "BEARISH", short: "BEARISH",
    neutral: "NEUTRAL", خنثی: "NEUTRAL", range: "NEUTRAL" },
  // Prices and locations are described by the trader, never computed here.
  priceLocation: { premium: "PREMIUM", discount: "DISCOUNT", equilibrium: "EQUILIBRIUM",
    balance: "EQUILIBRIUM", تعادل: "EQUILIBRIUM", ارزان: "DISCOUNT", پرفروش: "PREMIUM" },
  m1Cisd: { yes: "YES", نه: "NO", no: "NO", بله: "YES" },
  smt: { divergence: "DIVERGENCE", واگرایی: "DIVERGENCE", none: "NONE", ندارد: "NONE" },
};

/**
 * The canonical key per item — the spelling the bot prints in its template and the one
 * `parseChecklistText` always accepts. Every entry must exist in `KEY_ALIASES`; the test asserts
 * that, because a prompt line that does not parse back is a form that lies to the user.
 */
export const CHECKLIST_KEY_FOR_ITEM: Readonly<Record<ChecklistItem, string>> = {
  dailyBias: "bias",
  marketLeg: "leg",
  priceLocation: "location",
  pdArrayH4: "h4",
  pdArrayH1: "h1",
  pdArrayM15: "m15",
  m1Cisd: "cisd",
  smt: "smt",
  macroTiming: "macro",
  stopLoss: "sl",
  risk: "risk",
} as const;

/** The skeleton shown to the user: one `key: ` line per item, in checklist order. */
export const CHECKLIST_PROMPT_LINES: readonly string[] = CHECKLIST_ITEMS.map(
  (item) => `${CHECKLIST_KEY_FOR_ITEM[item]}: `,
);

const UNKNOWN_WORDS = new Set(["?", "؟", "unknown", "tbd", "nidk", "نمی‌دانم", "نمیدانم", "بلدم", "هیچ‌فکر", "none yet"]);

// ── Construction ───────────────────────────────────────────────────────────

const UNREVIEWED: ChecklistItemValue = { state: "UNREVIEWED", value: null, normalised: false };

/** Every item starts UNREVIEWED. There is no "empty means confirmed" path anywhere. */
export function emptyChecklist(reportDate: string, timezone = "UTC"): DailyChecklist {
  const values = {} as Record<ChecklistItem, ChecklistItemValue>;
  for (const item of CHECKLIST_ITEMS) values[item] = UNREVIEWED;
  return { reportDate, timezone, values, notes: null, riskUnit: "UNSPECIFIED" };
}

/** `YYYY-MM-DD` only, digits normalised from `/` and `.`. A bad date is a refusal, not a default. */
export function normalizeReportDate(input: string): string | null {
  const t = input.trim().replace(/[./]/g, "-");
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m === null) return null;
  const [, y, mo, d] = m;
  const month = Number(mo), day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // Round-trip the parts instead of trusting Date.parse: it rolls `2026-02-30` over to March
  // rather than rejecting it, and a date that silently becomes another day would overwrite a
  // different day's checklist through the UNIQUE key.
  const probe = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(probe.getTime())) return null;
  if (probe.getUTCFullYear() !== Number(y) || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) {
    return null;
  }
  return iso;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function foldKey(raw: string): string {
  // Persian words are written with a ZWNJ (`مارکت‌لج`); the alias table is keyed on the
  // spaced form, so the joiner is folded to a space rather than stripped — `مارکتلج` and
  // `مارکت لج` are the same key here, and neither is a fuzzy match to anything else.
  return raw.trim().replace(/\u200c/g, " ").replace(/\s+/g, " ").toLowerCase();
}

const LINE_RE = /^\s*(?:[-*•]\s*)?([^:：]{1,28}?)\s*[:：]\s*(.*)$/;

/**
 * Parse `key: value` lines. Lines the parser cannot attribute to an item are returned in
 * `unparsed` so the caller can say so — an ignored line is a lost review note.
 */
export function parseChecklistText(input: string): ChecklistParseResult {
  const values: Partial<Record<ChecklistItem, string>> = {};
  const unknowns: ChecklistItem[] = [];
  const unparsed: { key: string }[] = [];
  const noteParts: string[] = [];

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const m = LINE_RE.exec(line);
    if (m === null) {
      noteParts.push(line); // free text is a note, which is what the field is for
      continue;
    }
    const key = foldKey(m[1]!);
    const rest = m[2]!.trim();
    const item = KEY_ALIASES[key] ?? KEY_ALIASES[key.replace(/\s+/g, "")];
    if (item === undefined) {
      if (NOTE_KEYS.has(key)) {
        if (rest !== "") noteParts.push(rest);
        continue;
      }
      unparsed.push({ key });
      continue;
    }
    if (rest === "" || UNKNOWN_WORDS.has(rest.toLowerCase())) {
      unknowns.push(item); // an empty value is an explicit "not known", never a guess
      continue;
    }
    values[item] = rest;
  }
  return {
    values,
    unknowns,
    notes: noteParts.length > 0 ? noteParts.join("\n").slice(0, 2000) : null,
    unparsed,
  };
}

/** The normalised code for a written value, or the verbatim text with `normalised:false`. */
export function interpretItemValue(item: ChecklistItem, written: string): { value: string; normalised: boolean } {
  const trimmed = written.trim();
  if (trimmed === "") return { value: "", normalised: false };
  const vocab = VALUE_VOCAB[item];
  if (vocab !== undefined) {
    const code = vocab[trimmed.toLowerCase().replace(/\s+/g, " ")];
    if (code !== undefined) return { value: code, normalised: true };
  }
  if (item === "stopLoss") {
    const n = parseNumberToken(normalizeForParsing(trimmed));
    if (n !== null) return { value: normalizeDecimal(n), normalised: true };
  }
  return { value: trimmed, normalised: false }; // kept as the user wrote it
}

export interface RiskReading { readonly value: string | null; readonly unit: ChecklistRiskUnit }

/** `%`/`٪` means PERCENT, a currency suffix means AMOUNT, anything else stays UNSPECIFIED. */
export function interpretRisk(written: string): RiskReading {
  const t = written.trim();
  if (t === "") return { value: null, unit: "UNSPECIFIED" };
  // Persian/Arabic-Indic digits and the Arabic decimal separator are folded with the SAME
  // helper the trade parser uses, so `۰.۵٪` and `0.5%` cannot mean two different things.
  const folded = normalizeForParsing(t);
  // `%` and the Arabic percent sign `٪` (U+066A) both mean percent; the digit folder leaves the
  // sign alone, so it is matched explicitly here rather than silently losing the unit.
  const percent = /(?:%|٪)/.test(folded);
  const amount = /(?:usd|\$|€|تومان|دلار|ریال)/i.test(folded);
  const num = parseNumberToken(folded.replace(/(?:%|٪|usd|\$|€|تومان|دلار|ریال)/gi, " "));
  if (num === null) return { value: null, unit: "UNSPECIFIED" };
  const unit: ChecklistRiskUnit = percent ? "PERCENT" : amount ? "AMOUNT" : "UNSPECIFIED";
  return { value: normalizeDecimal(num), unit };
}

/**
 * Apply a parse to a base checklist. CONFIRMED is only ever produced by a value the user
 * wrote; an explicitly unknown item becomes UNKNOWN; an item that appears in neither list is
 * left exactly as it was, so a partial report never silently clears last week's review.
 */
export function mergeChecklist(base: DailyChecklist, parsed: ChecklistParseResult): DailyChecklist {
  const values = { ...base.values };
  let riskUnit = base.riskUnit;
  for (const item of CHECKLIST_ITEMS) {
    const written = parsed.values[item];
    if (written !== undefined) {
      if (item === "risk") {
        const risk = interpretRisk(written);
        values[item] = { state: "CONFIRMED", value: risk.value, normalised: true };
        riskUnit = risk.unit;
        continue;
      }
      const read = interpretItemValue(item, written);
      values[item] = { state: "CONFIRMED", value: read.value, normalised: read.normalised };
    } else if (parsed.unknowns.includes(item)) {
      values[item] = { state: "UNKNOWN", value: null, normalised: false };
    }
  }
  return {
    ...base,
    values,
    riskUnit,
    notes: parsed.notes === null ? base.notes : parsed.notes,
  };
}

export interface ChecklistCoverage {
  readonly confirmed: number;
  readonly unknown: number;
  readonly unreviewed: number;
  readonly total: number;
  /** True only when every item is CONFIRMED. An empty checklist is never "done". */
  readonly complete: boolean;
}

export function checklistCoverage(list: DailyChecklist): ChecklistCoverage {
  let confirmed = 0, unknown = 0, unreviewed = 0;
  for (const item of CHECKLIST_ITEMS) {
    const state = list.values[item].state;
    if (state === "CONFIRMED") confirmed += 1;
    else if (state === "UNKNOWN") unknown += 1;
    else unreviewed += 1;
  }
  return { confirmed, unknown, unreviewed, total: CHECKLIST_ITEMS.length, complete: confirmed === CHECKLIST_ITEMS.length };
}

// ── Persistence shape ────────────────────────────────────────────────────────

export interface SerializedChecklist {
  readonly items: Record<string, { state: string; value: string | null; normalised: boolean }>;
  readonly notes: string | null;
  readonly riskUnit: string;
  readonly timezone: string;
}

export function serializeChecklist(list: DailyChecklist): SerializedChecklist {
  const items: SerializedChecklist["items"] = {};
  for (const item of CHECKLIST_ITEMS) {
    const v = list.values[item];
    items[item] = { state: v.state, value: v.value, normalised: v.normalised };
  }
  return { items, notes: list.notes, riskUnit: list.riskUnit, timezone: list.timezone };
}

/** Strict on read: an item outside the vocabulary or a bad state is a refusal, not a coercion. */
export function deserializeChecklist(reportDate: string, raw: unknown): DailyChecklist {
  // Built mutably and frozen on return: `DailyChecklist.values` is readonly by contract, so the
  // assembly loop needs its own writable record rather than a cast around the type.
  const assembled: Record<ChecklistItem, ChecklistItemValue> = { ...emptyChecklist(reportDate).values };
  const list = emptyChecklist(reportDate);
  if (raw === null || raw === undefined) return list;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ChecklistFormatError("PAYLOAD_NOT_OBJECT");
  const obj = raw as Record<string, unknown>;
  const items = obj["items"];
  if (items !== undefined) {
    if (typeof items !== "object" || items === null || Array.isArray(items)) {
      throw new ChecklistFormatError("ITEMS_NOT_OBJECT");
    }
    for (const [key, entry] of Object.entries(items as Record<string, unknown>)) {
      const item = key as ChecklistItem;
      if (!CHECKLIST_ITEMS.includes(item)) throw new ChecklistFormatError("UNKNOWN_ITEM");
      if (typeof entry !== "object" || entry === null) throw new ChecklistFormatError("ITEM_SHAPE");
      const e = entry as Record<string, unknown>;
      const state = e["state"];
      if (typeof state !== "string" || !CHECKLIST_REVIEW_STATES.includes(state as ChecklistReviewState)) {
        throw new ChecklistFormatError("STATE_VOCABULARY");
      }
      const value = e["value"];
      if (!(value === null || value === undefined || typeof value === "string")) {
        throw new ChecklistFormatError("VALUE_NOT_TEXT"); // a number here would mean a float got in
      }
      assembled[item] = {
        state: state as ChecklistReviewState,
        value: typeof value === "string" && value !== "" ? value : null,
        normalised: e["normalised"] === true,
      };
    }
  }
  const notes = obj["notes"];
  const tz = obj["timezone"];
  const ru = obj["riskUnit"];
  return {
    ...list,
    values: assembled,
    notes: typeof notes === "string" && notes !== "" ? notes.slice(0, 2000) : null,
    timezone: typeof tz === "string" && tz !== "" ? tz : "UTC",
    riskUnit: typeof ru === "string" && CHECKLIST_RISK_UNITS.includes(ru as ChecklistRiskUnit)
      ? (ru as ChecklistRiskUnit)
      : "UNSPECIFIED",
  };
}
