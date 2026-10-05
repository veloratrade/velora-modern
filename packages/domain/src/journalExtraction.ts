// Journal extraction — deterministic, framework-free, I/O-free (ADR-018).
//
// WHAT THIS IS, AND WHAT IT REFUSES TO BE.
//   This module turns a human sentence — Persian or English — into CANDIDATE
//   journal fields. It is a deterministic parser, not a model: every value it
//   returns can be traced to a token in the input, and a value it cannot find is
//   returned as `null` and reported as MISSING rather than guessed, defaulted or
//   inferred. That property is the point. A journal entry is a financial record;
//   an invented stop-loss is worse than an absent one, and "the AI probably meant
//   2650" is not evidence.
//
//   The parser therefore never produces: a price it did not read, a direction it
//   did not match, a volume it did not see, or a note that is not the user's own
//   words. Free text becomes `notes` verbatim (trimmed) because that is exactly
//   what the field is for.
//
// WHY IT LIVES IN packages/domain
//   AGENTS.md rule 3/4: domain logic does not live in `apps/*`. The Telegram bot
//   is a delivery shell for this function, and so is any future web/mobile/voice
//   client — the extraction rule is one implementation with one test suite.
//
// NUMBERS ARE STRINGS (ADR-001)
//   Prices and volumes are returned as decimal STRINGS, never JS numbers: the
//   whole pipeline (decimal → numeric(20,8)) must never touch a binary float.
//   Parsing only validates the shape and normalizes separators.
import { wallClockIn } from "./time.js";

/** Fields the ADR-002 manual-create path requires before a trade can exist. */
export const JOURNAL_REQUIRED_FIELDS = ["symbol", "direction", "entryPrice", "exitPrice", "volume"] as const;
export type JournalField = (typeof JOURNAL_REQUIRED_FIELDS)[number];

/** Optional journaling metadata the existing trades contract accepts. */
export interface JournalDraftFields {
  readonly symbol: string | null;
  readonly direction: "buy" | "sell" | null;
  /** ADR-001 scale matrix: prices/volume at 8 decimal places. */
  readonly entryPrice: string | null;
  readonly exitPrice: string | null;
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
  readonly volume: string | null;
  /** `strategy` column, ≤64 chars (both lineages). Only if explicitly stated. */
  readonly strategyTag: string | null;
  /** 1–5 (0001 `emotion`), the only emotional value either lineage accepts. */
  readonly emotionalScore: string | null;
  /** The user's own words. Never a summary, never a paraphrase. */
  readonly notes: string | null;
  /** NAIVE wall clock — interpreted in the USER's profile timezone (ADR-004 D-11). */
  readonly openTime: string;
  readonly closeTime: string;
}

export interface JournalDraft {
  readonly fields: JournalDraftFields;
  /** Required fields the parser could NOT find. Drives progressive enrichment. */
  readonly missingRequired: readonly JournalField[];
  /** Optional fields the parser found, for the confirmation card. */
  readonly detectedOptional: readonly string[];
  /** Confidence is about the PARSE, never about the trade. See `parserNotes`. */
  readonly parserNotes: readonly string[];
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Persian (۰-۹) and Arabic-Indic (٠-٩) digits → ASCII. */
const DIGIT_MAP: Readonly<Record<string, string>> = {
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

/**
 * Normalize for PARSING ONLY — never for storage.
 *
 * ZWNJ (U+200C) is removed because it appears inside ordinary Persian words
 * ("میشود") and would otherwise split a keyword in half; Arabic commas and
 * Arabic decimal separators are unified so one number grammar covers both scripts.
 * The ORIGINAL text is what becomes `notes`, so nothing here can corrupt what the
 * user wrote.
 */
export function normalizeForParsing(input: string): string {
  let out = "";
  for (const ch of input) {
    out += DIGIT_MAP[ch] ?? ch;
  }
  return out
    .replace(/[\u200c\u200f\u200e]/g, "") // ZWNJ + bidi marks
    .replace(/[،؛]/g, ",")
    .replace(/[٫]/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse one numeric token into a decimal string, or null.
 *
 * Separator rules are explicit because they change the value:
 *   1,234.5 → thousands grouping; 1,234 → grouping; 12,5 → comma is the decimal
 *   separator; 1234.56 → ordinary decimal. A token that matches NONE of these is
 *   not a number and is ignored (so "@3x" or a date fragment cannot become a price).
 */
export function parseNumberToken(token: string): string | null {
  // Sentence punctuation clings to the end of a value far more often than not
  // ("تارگت 2665." / "tp 2665,"), so trailing non-digit characters are stripped
  // before the grammar is applied. A user should not have to avoid writing a
  // full stop to record a target.
  const t = token.trim().replace(/^[+]+/, "").replace(/[^0-9]+$/, "");
  if (t === "") return null;
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t)) {
    // Thousands grouping. The comma is a separator, so it is removed; a decimal
    // part is preserved and normalized (1,200.50 → 1200.5, never 1200).
    return normalizeDecimal(t.replace(/,/g, ""));
  }
  if (/^\d+,\d+$/.test(t)) return t.replace(",", ".");
  if (/^\d+(?:\.\d+)?$/.test(t)) return t;
  return null;
}

/** Normalize a parsed decimal to a stable string (strip trailing zeros). */
export function normalizeDecimal(value: string): string {
  if (!value.includes(".")) return value.replace(/^0+(?=\d)/, "");
  const trimmed = value.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed.replace(/^0+(?=\d)/, "");
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Multi-word phrases are folded to one token before matching. */
const PHRASE_FOLDS: readonly (readonly [RegExp, string])[] = [
  [/حد\s*ضرر/g, "استاپ"],
  [/حد\s*سود/g, "تارگت"],
  [/stop\s*loss/gi, "sl"],
  [/stop-?loss/gi, "sl"],
  [/take\s*profit/gi, "tp"],
  [/take-?profit/gi, "tp"],
];

const FIELD_KEYWORDS: Readonly<Record<"entry" | "exit" | "stop" | "target" | "volume" | "emotion" | "strategy", readonly string[]>> = {
  entry: ["ورود", "ورودی", "انتری", "entry", "enter", "entered", "ورودم"],
  exit: ["خروج", "خروجی", "اکزیت", "exit", "exited", "بستم", "closed"],
  stop: ["استاپ", "استاپلاس", "اسال", "sl", "stop", "stoploss", "استاپلا"],
  target: ["تارگت", "هدف", "تیپی", "tp", "target", "take", "تارگتم"],
  volume: ["حجم", "لات", "لاتاژ", "سایز", "مقدار", "volume", "lot", "lots", "size", "vol"],
  emotion: ["احساس", "حس", "emotion", "emotionscore", "حالم"],
  strategy: ["استراتژی", "setup", "ستاپ", "strategy", "پلن"],
};

const SIDE_BUY = ["خرید", "خریدم", "بای", "لانگ", "buy", "long", "bought", "خریداری"];
const SIDE_SELL = ["فروش", "فروختم", "سل", "شورت", "sell", "short", "sold", "فروشم"];

/**
 * Instrument aliases — a CLOSED, explicit table, not fuzzy matching.
 * An alias is a rename of a symbol, never an interpretation of a sentence, and
 * every entry has to be justified by the market it names.
 */
const SYMBOL_ALIASES: readonly (readonly [string, string])[] = [
  ["طلا", "XAUUSD"],
  ["نقره", "XAGUSD"],
  ["بیتکوین", "BTCUSD"],
  ["بیت کوین", "BTCUSD"],
  ["اتریوم", "ETHUSD"],
  ["نفت", "USOIL"],
  ["یورو دلار", "EURUSD"],
  ["پوند دلار", "GBPUSD"],
  ["دلار ین", "USDJPY"],
];

/** Timeframes are recognized so they are NOT mistaken for a symbol. */
const TIMEFRAMES = new Set(["m1", "m5", "m15", "m30", "h1", "h2", "h4", "h8", "h12", "d1", "w1", "mn1", "daily", "weekly", "4h", "1h", "15m"]);

/** Words that look like a ticker but are never one. */
const SYMBOL_STOPWORDS = new Set([
  ...Object.values(FIELD_KEYWORDS).flat(),
  ...SIDE_BUY, ...SIDE_SELL,
  "and", "the", "today", "yesterday", "now", "trade", "trades", "am", "pm",
  "ok", "yes", "no", "ts", "utc", "gmt", "fa", "en", "id", "tg", "sl", "tp",
]);

// ---------------------------------------------------------------------------
// Token model
// ---------------------------------------------------------------------------

interface Token {
  readonly index: number;
  readonly raw: string;
  /** Lowercased, punctuation-stripped form used for keyword matching. */
  readonly key: string;
  /** Decimal string when the token is numeric, else null. */
  readonly number: string | null;
}

const SPLIT_RE = /[\s,;:()\[\]{}|"']+/;
/** A token like `sl=2644`, `tp:2665` or `ورود-2650` is split into key + value. */
const GLUED_RE = /^([^\d]+?)\s*[=:\-–]\s*(\d[\d.,]*)$/;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  for (const piece of text.split(SPLIT_RE)) {
    if (piece === "") continue;
    const glued = GLUED_RE.exec(piece);
    if (glued !== null) {
      const key = (glued[1] ?? "").trim();
      const value = parseNumberToken(glued[2] ?? "");
      if (key !== "") tokens.push({ index: index++, raw: key, key: key.toLowerCase(), number: null });
      if (value !== null) tokens.push({ index: index++, raw: glued[2] ?? "", key: "", number: value });
      continue;
    }
    tokens.push({ index: index++, raw: piece, key: piece.toLowerCase(), number: parseNumberToken(piece) });
  }
  return tokens;
}

/** The next numeric token within `window` positions (a value follows its label). */
function numberAfter(tokens: readonly Token[], from: number, window = 2): string | null {
  for (let i = from + 1; i < tokens.length && i <= from + window; i++) {
    const token = tokens[i];
    if (token === undefined) break;
    if (token.number !== null) return normalizeDecimal(token.number);
    // A keyword between label and value ("ورود قیمت 2650") is tolerated; a
    // DIFFERENT label is not ("ورود ... تارگت 2665" must not set entry).
    if (token.key !== "" && isAnyFieldKeyword(token.key)) return null;
  }
  return null;
}

function isAnyFieldKeyword(key: string): boolean {
  for (const words of Object.values(FIELD_KEYWORDS)) {
    if (words.includes(key)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /\b(\d{4})[-/](\d{2})[-/](\d{2})\b/;
const CLOCK_RE = /\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b/;

/**
 * Resolve the two instants the manual-create path requires.
 *
 * BOTH ARE ALWAYS RETURNED, and when the message carries no time information the
 * value is "the wall clock of the moment the journal was written" in the USER's
 * profile timezone. That is a stated convention, not a hidden guess: the
 * confirmation card prints the exact timestamps that will be stored, and the user
 * cancels or confirms with them visible. A date with no clock time uses 00:00,
 * and no separate exit time is ever invented — `closeTime` equals `openTime`
 * unless the user supplied something else.
 */
export function resolveTradeTime(
  text: string,
  now: Date,
  timeZone: string,
): { openTime: string; closeTime: string; timeNote: string | null } {
  const nowWall = wallClockIn(timeZone, now);
  let date = nowWall.slice(0, 10);
  let note: string | null = null;

  const iso = ISO_DATE_RE.exec(text);
  if (iso !== null) {
    const [, y, m, d] = iso;
    const candidate = `${y}-${m}-${d}`;
    if (isRealDate(candidate)) {
      date = candidate;
      note = "date-from-message";
    }
  } else if (/(^|\s)(دیروز|yesterday)(\s|$)/i.test(text)) {
    date = wallClockIn(timeZone, new Date(now.getTime() - 86_400_000)).slice(0, 10);
    note = "date-yesterday";
  }

  const clock = CLOCK_RE.exec(text);
  const time = clock === null
    ? (date === nowWall.slice(0, 10) ? nowWall.slice(11, 19) : "00:00:00")
    : `${(clock[1] ?? "00").padStart(2, "0")}:${clock[2] ?? "00"}:${clock[3] ?? "00"}`;

  const stamp = `${date} ${time}`;
  return { openTime: stamp, closeTime: stamp, timeNote: note };
}

function isRealDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Extract candidate journal fields from one human message.
 *
 * Deterministic and side-effect free: same input + same clock ⇒ same output. The
 * function's contract with its caller is `missingRequired` — a caller must not
 * write a journal entry while that list is non-empty.
 */
export function extractJournalDraft(input: {
  readonly text: string;
  readonly now: Date;
  readonly timeZone: string;
}): JournalDraft {
  const notesCandidate = input.text.trim().replace(/\s+/g, " ");
  const normalized = normalizeForParsing(input.text);
  let folded = normalized;
  for (const [pattern, replacement] of PHRASE_FOLDS) folded = folded.replace(pattern, replacement);

  const tokens = tokenize(folded);
  const parserNotes: string[] = [];

  const find = (field: keyof typeof FIELD_KEYWORDS): string | null => {
    for (const token of tokens) {
      if (token.key === "" || !FIELD_KEYWORDS[field].includes(token.key)) continue;
      const value = numberAfter(tokens, token.index);
      if (value !== null) return value;
    }
    return null;
  };

  const entryPrice = find("entry");
  const exitPrice = find("exit");
  const stopLoss = find("stop");
  const takeProfit = find("target");
  const volume = find("volume");

  // DIRECTION: exactly one vocabulary may match. Both matching is AMBIGUITY, and
  // ambiguity is reported — never resolved by picking the first or the most
  // common one, because a journal entry's direction is a financial fact.
  // (Note: the Persian "سل" is SELL, while the Latin "sl" is STOP LOSS. They are
  // different characters and deliberately live in different vocabularies.)
  const hasBuy = tokens.some((t) => SIDE_BUY.includes(t.key));
  const hasSell = tokens.some((t) => SIDE_SELL.includes(t.key));
  let direction: "buy" | "sell" | null = null;
  if (hasBuy && !hasSell) direction = "buy";
  else if (hasSell && !hasBuy) direction = "sell";
  else if (hasBuy && hasSell) parserNotes.push("ambiguous-direction");

  const symbol = detectSymbol(normalized);

  const emotionalScore = detectEmotion(tokens);
  const strategyTag = detectStrategy(tokens);

  const time = resolveTradeTime(normalized, input.now, input.timeZone);

  const fields: JournalDraftFields = {
    symbol,
    direction,
    entryPrice,
    exitPrice,
    stopLoss,
    takeProfit,
    volume,
    strategyTag,
    emotionalScore,
    notes: notesCandidate === "" ? null : notesCandidate.slice(0, 5000),
    openTime: time.openTime,
    closeTime: time.closeTime,
  };
  if (time.timeNote !== null) parserNotes.push(time.timeNote);

  const missingRequired = missingJournalFields(fields);
  const detectedOptional = (["stopLoss", "takeProfit", "strategyTag", "emotionalScore", "notes"] as const)
    .filter((f) => fields[f] !== null);

  return { fields, missingRequired, detectedOptional, parserNotes };
}

/** ISO-style currency codes used to recognize a lowercase FX pair ("eurusd"). */
const FX_CODES = ["USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF", "CNY", "TRY", "SEK", "NOK", "MXN", "ZAR", "SGD", "HKD", "PLN", "DKK"];

/** Instrument bases used to recognize a lowercase quoted symbol ("xauusd"). */
const INSTRUMENT_BASES = [
  "XAU", "XAG", "XPT", "XPD", "BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "LTC", "DOT", "LINK",
  "WTI", "BRENT", "USO", "NG", "US30", "US500", "NAS100", "GER40", "UK100", "JP225",
];

const FX_PAIR_RE = /^([A-Za-z]{3})([A-Za-z]{3})$/;
const QUOTED_SYMBOL_RE = /^([A-Za-z]{2,6})(USD|USDT|EUR|JPY|GBP|CHF|AUD|CAD)$/i;

/**
 * Is this single token a plausible instrument symbol?
 *
 * THE RULE IS "LOOKS LIKE ONE", NOT "COULD POSSIBLY BE ONE". A parser that maps
 * an ordinary word onto a ticker writes a wrong symbol into a financial record,
 * which is the worst outcome available — so three positive shapes are accepted,
 * each of which ordinary prose does not satisfy:
 *   (a) an ALL-CAPS token — how traders write tickers, and not how anyone writes
 *       a sentence mid-paragraph;
 *   (b) a six-letter FX pair built from real ISO currency codes, in any case
 *       ("eurusd" is unambiguous because both halves are currencies);
 *   (c) a known instrument base with a quote suffix ("xauusd", "btcusdt").
 * Everything else — including a lowercase English word — is rejected. A missed
 * lowercase ticker costs one follow-up question; a false positive costs a wrong
 * record, so the asymmetry decides the rule.
 */
export function isSymbolToken(token: string): boolean {
  const t = token.trim();
  if (t.length < 3 || t.length > 16) return false;
  if (!/^[A-Za-z][A-Za-z0-9._/]{2,15}$/.test(t)) return false;
  const lower = t.toLowerCase();
  if (SYMBOL_STOPWORDS.has(lower) || TIMEFRAMES.has(lower)) return false;
  if (ISO_DATE_RE.test(t)) return false;
  if (t === t.toUpperCase() && /[A-Z]/.test(t)) return true; // (a)
  const pair = FX_PAIR_RE.exec(t);
  if (pair !== null) {
    const base = (pair[1] ?? "").toUpperCase();
    const quote = (pair[2] ?? "").toUpperCase();
    if (FX_CODES.includes(base) && FX_CODES.includes(quote)) return true; // (b)
  }
  const quoted = QUOTED_SYMBOL_RE.exec(t);
  if (quoted !== null && INSTRUMENT_BASES.includes((quoted[1] ?? "").toUpperCase())) return true; // (c)
  return false;
}

/**
 * Symbol detection. An explicit alias wins (Persian prose names gold "طلا", and
 * that is a rename, not an inference); otherwise the token rules above apply.
 */
export function detectSymbol(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [alias, symbol] of SYMBOL_ALIASES) {
    if (lower.includes(alias)) return symbol;
  }
  const candidates = text
    .split(/[\s,;:()\[\]{}|"'=+\-–]+/)
    .map((t) => t.trim())
    .filter((t) => isSymbolToken(t));
  if (candidates.length === 0) return null;
  // An ALL-CAPS candidate outranks a case-insensitive match: it is the stronger
  // signal, and this ordering is deterministic rather than "first seen".
  const upper = candidates.find((c) => c === c.toUpperCase());
  return (upper ?? candidates[0] ?? "").toUpperCase();
}

function detectEmotion(tokens: readonly Token[]): string | null {
  for (const token of tokens) {
    if (token.key === "" || !FIELD_KEYWORDS.emotion.includes(token.key)) continue;
    for (let i = token.index + 1; i <= token.index + 2 && i < tokens.length; i++) {
      const next = tokens[i];
      if (next === undefined) break;
      const candidate = next.number ?? parsePlainScore(next.raw);
      if (candidate !== null) {
        const n = Number(candidate);
        if (Number.isInteger(n) && n >= 1 && n <= 5) return String(n);
      }
    }
  }
  return null;
}

function parsePlainScore(raw: string): string | null {
  return /^[1-5]$/.test(raw.trim()) ? raw.trim() : null;
}

function detectStrategy(tokens: readonly Token[]): string | null {
  for (const token of tokens) {
    if (token.key === "" || !FIELD_KEYWORDS.strategy.includes(token.key)) continue;
    // A strategy name is a WORD, not a number: take the following word token.
    for (let i = token.index + 1; i <= token.index + 2 && i < tokens.length; i++) {
      const next = tokens[i];
      if (next === undefined) break;
      if (next.number !== null) continue;
      const clean = next.raw.replace(/[^\p{L}\p{N}_-]/gu, "");
      if (clean.length >= 2 && clean.length <= 64) return clean;
    }
  }
  return null;
}

/** Required fields still unknown. Never empty-and-written-around: it is a gate. */
export function missingJournalFields(fields: JournalDraftFields): readonly JournalField[] {
  const missing: JournalField[] = [];
  for (const field of JOURNAL_REQUIRED_FIELDS) {
    const value = fields[field];
    if (value === null || value === undefined || value === "") missing.push(field);
  }
  return missing;
}

/**
 * The exact payload the API's own create path accepts.
 *
 * Deliberately mirrors the wire shape of `TradeService.createTrade`, so Telegram
 * input travels through the SAME validation, the SAME domain fold and the SAME
 * ledger — no Telegram-specific write path exists, and none may be added.
 * Absent optional values are OMITTED rather than null-filled, which is how the
 * existing route distinguishes "not provided" from "cleared".
 */
export function draftToTradePayload(fields: JournalDraftFields): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    symbol: fields.symbol,
    direction: fields.direction,
    entryPrice: fields.entryPrice,
    exitPrice: fields.exitPrice,
    volume: fields.volume,
    openTime: fields.openTime,
    closeTime: fields.closeTime,
  };
  if (fields.stopLoss !== null) payload.stopLoss = fields.stopLoss;
  if (fields.takeProfit !== null) payload.takeProfit = fields.takeProfit;
  if (fields.strategyTag !== null) payload.strategyTag = fields.strategyTag;
  if (fields.emotionalScore !== null) payload.emotionalScore = fields.emotionalScore;
  if (fields.notes !== null) payload.notes = fields.notes;
  return payload;
}

/** True when every required field is known — the confirmation pre-condition. */
export function isDraftComplete(fields: JournalDraftFields): boolean {
  return missingJournalFields(fields).length === 0;
}

/**
 * Did this message carry anything worth journaling?
 *
 * Used to distinguish "a trade description that is missing details" (open a
 * draft and ask) from ordinary conversation ("سلام", "مرسی") which must NOT
 * create a draft row. `notes` and the two timestamps are deliberately excluded —
 * every message has them, so counting them would make every message a draft.
 */
export function hasAnyJournalValue(fields: JournalDraftFields): boolean {
  return (
    fields.symbol !== null ||
    fields.direction !== null ||
    fields.entryPrice !== null ||
    fields.exitPrice !== null ||
    fields.stopLoss !== null ||
    fields.takeProfit !== null ||
    fields.volume !== null ||
    fields.strategyTag !== null ||
    fields.emotionalScore !== null
  );
}

/**
 * Merge a follow-up answer into an existing draft (progressive enrichment).
 *
 * Only the field the bot asked about is read, and only from the same parser — a
 * follow-up is not a second, looser parsing mode. Symbol/direction answers are
 * matched by their own vocabularies because "XAUUSD" alone carries no keyword.
 */
export function applyFollowUp(fields: JournalDraftFields, field: JournalField, answer: string): JournalDraftFields {
  const text = normalizeForParsing(answer);
  const next: { -readonly [K in keyof JournalDraftFields]: JournalDraftFields[K] } = { ...fields };
  if (field === "symbol") {
    next.symbol = detectSymbol(text);
  } else if (field === "direction") {
    const lower = text.toLowerCase();
    if (SIDE_BUY.some((w) => lower.includes(w))) next.direction = "buy";
    else if (SIDE_SELL.some((w) => lower.includes(w))) next.direction = "sell";
  } else {
    const value = parseNumberToken(text.split(/\s+/)[0] ?? "");
    if (value !== null) next[field] = normalizeDecimal(value);
  }
  return next;
}
