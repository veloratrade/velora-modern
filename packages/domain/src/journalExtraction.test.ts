// Journal extraction — deterministic parser behaviour (ADR-018).
//
// The assertions that matter most here are the NEGATIVE ones. A parser that
// finds a value which is not in the text is worse than a parser that finds
// nothing: the first silently corrupts a financial record, the second asks the
// user one more question. Most of this file exists to pin the second behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyFollowUp,
  detectSymbol,
  draftToTradePayload,
  extractJournalDraft,
  isDraftComplete,
  missingJournalFields,
  normalizeDecimal,
  normalizeForParsing,
  parseNumberToken,
  resolveTradeTime,
} from "./journalExtraction.js";

const NOW = new Date("2026-10-03T09:30:00Z");
const TZ = "Asia/Tehran"; // the product's primary locale timezone
const extract = (text: string) => extractJournalDraft({ text, now: NOW, timeZone: TZ });

test("extraction: the documented Persian example yields exactly the expected fields", () => {
  const draft = extract("امروز XAUUSD خرید گرفتم، ورود 2650، استاپ 2644 و تارگت 2665.");
  assert.equal(draft.fields.symbol, "XAUUSD");
  assert.equal(draft.fields.direction, "buy");
  assert.equal(draft.fields.entryPrice, "2650");
  assert.equal(draft.fields.stopLoss, "2644");
  assert.equal(draft.fields.takeProfit, "2665");
  // exitPrice and volume were NOT in the sentence: they stay unknown, and the
  // draft is therefore incomplete and not writable.
  assert.equal(draft.fields.exitPrice, null);
  assert.equal(draft.fields.volume, null);
  assert.deepEqual([...draft.missingRequired], ["exitPrice", "volume"]);
  assert.equal(isDraftComplete(draft.fields), false);
});

test("extraction: a complete English sentence satisfies every required field", () => {
  const draft = extract("EURUSD sell entry 1.0850, exit 1.0800, stop 1.0870, target 1.0790, volume 0.5");
  assert.equal(draft.fields.symbol, "EURUSD");
  assert.equal(draft.fields.direction, "sell");
  // Values are canonicalized to their shortest exact decimal form; the ADR-001
  // scale (8 places) is applied by the ledger, not here. 1.0850 ≡ 1.085.
  assert.equal(draft.fields.entryPrice, "1.085");
  assert.equal(draft.fields.exitPrice, "1.08");
  assert.equal(draft.fields.stopLoss, "1.087");
  assert.equal(draft.fields.takeProfit, "1.079");
  assert.equal(draft.fields.volume, "0.5");
  assert.deepEqual([...draft.missingRequired], []);
  assert.equal(isDraftComplete(draft.fields), true);
});

test("extraction: NEVER invents a value that is not in the message", () => {
  const draft = extract("امروز معامله خوبی بود");
  assert.equal(draft.fields.symbol, null);
  assert.equal(draft.fields.direction, null);
  assert.equal(draft.fields.entryPrice, null);
  assert.equal(draft.fields.exitPrice, null);
  assert.equal(draft.fields.volume, null);
  assert.equal(draft.fields.stopLoss, null);
  assert.deepEqual([...draft.missingRequired], ["symbol", "direction", "entryPrice", "exitPrice", "volume"]);
  // The user's words are still captured — as notes, verbatim.
  assert.equal(draft.fields.notes, "امروز معامله خوبی بود");
});

test("extraction: a value is attached to its own label, not to the neighbouring one", () => {
  const draft = extract("XAUUSD buy ورود 2650 تارگت 2665");
  assert.equal(draft.fields.entryPrice, "2650");
  assert.equal(draft.fields.takeProfit, "2665");
  // "stop" is absent, so it stays absent — it must not inherit 2665 or 2650.
  assert.equal(draft.fields.stopLoss, null);
});

test("extraction: ambiguous direction is reported, not guessed", () => {
  const draft = extract("XAUUSD buy and sell at 2650");
  assert.equal(draft.fields.direction, null);
  assert.ok(draft.parserNotes.includes("ambiguous-direction"));
});

test("extraction: Persian and Latin digit forms are equivalent", () => {
  const persian = extract("XAUUSD خرید ورود ۲۶۵۰ استاپ ۲۶۴۴ حجم ۰.۵");
  const latin = extract("XAUUSD خرید ورود 2650 استاپ 2644 حجم 0.5");
  assert.equal(persian.fields.entryPrice, "2650");
  assert.equal(persian.fields.entryPrice, latin.fields.entryPrice);
  assert.equal(persian.fields.stopLoss, latin.fields.stopLoss);
  assert.equal(persian.fields.volume, latin.fields.volume);
});

test("extraction: instrument aliases are an explicit table, not fuzzy matching", () => {
  assert.equal(detectSymbol("طلا خریدم"), "XAUUSD");
  assert.equal(detectSymbol("نقره فروختم"), "XAGUSD");
  assert.equal(detectSymbol("BTCUSDT long"), "BTCUSDT");
  // Lowercase is accepted only for shapes that are unambiguous by construction.
  assert.equal(detectSymbol("eurusd long"), "EURUSD");
  assert.equal(detectSymbol("xauusd buy"), "XAUUSD");
  // Prose must NEVER become a ticker: a false positive writes a wrong symbol
  // into a financial record, a false negative costs one clarifying question.
  assert.equal(detectSymbol("این یک جمله فارسی است"), null);
  assert.equal(detectSymbol("a normal sentence about nothing"), null);
  assert.equal(detectSymbol("I opened a trade today"), null);
  assert.equal(detectSymbol("maybe later"), null);
  assert.equal(detectSymbol("normal"), null);
});

test("extraction: Stop loss vocabulary never collides with the sell direction", () => {
  const draft = extract("EURUSD sell ورود 1.10 استاپ 1.11");
  assert.equal(draft.fields.direction, "sell");
  assert.equal(draft.fields.stopLoss, "1.11");
  // Latin "sl" means stop loss, and must NOT be read as the Persian "سل" (sell).
  const latinSl = extract("EURUSD buy ورود 1.10 sl 1.09");
  assert.equal(latinSl.fields.direction, "buy");
  assert.equal(latinSl.fields.stopLoss, "1.09");
});

test("extraction: a timeframe is not mistaken for a symbol", () => {
  const draft = extract("XAUUSD buy m15 ورود 2650 خروج 2660 حجم 1");
  assert.equal(draft.fields.symbol, "XAUUSD");
});

test("extraction: glued label=value forms are supported", () => {
  const draft = extract("XAUUSD buy entry=2650 exit=2660 sl=2644 tp=2665 volume=1");
  assert.equal(draft.fields.entryPrice, "2650");
  assert.equal(draft.fields.exitPrice, "2660");
  assert.equal(draft.fields.stopLoss, "2644");
  assert.equal(draft.fields.takeProfit, "2665");
  assert.equal(draft.fields.volume, "1");
});

test("extraction: thousands separators are grouping, not decimals", () => {
  assert.equal(parseNumberToken("2,650"), "2650");
  assert.equal(parseNumberToken("1,200.50"), "1200.5");
  assert.equal(parseNumberToken("12,5"), "12.5"); // comma as decimal separator
  assert.equal(parseNumberToken("2650"), "2650");
  assert.equal(parseNumberToken("notanumber"), null);
  // A date fragment must never become a price.
  assert.equal(parseNumberToken("2026-10-01"), null);
});

test("extraction: emotional score is bounded to the domain's 1–5 vocabulary", () => {
  assert.equal(extract("XAUUSD buy ورود 2650 احساس 4").fields.emotionalScore, "4");
  assert.equal(extract("XAUUSD buy ورود 2650 احساس ۹").fields.emotionalScore, null);
  assert.equal(extract("XAUUSD buy ورود 2650 احساس 0").fields.emotionalScore, null);
});

test("extraction: notes are the user's own words, never a summary", () => {
  const text = "XAUUSD buy ورود 2650 خروج 2660 حجم 1 — ستاپ شکست مقاومت بود و خوب اجرا کردم";
  const draft = extract(text);
  assert.equal(draft.fields.notes, text);
});

test("time: no time information means the moment of writing, and it is stated", () => {
  const time = resolveTradeTime("امروز XAUUSD خریدم", NOW, TZ);
  // 09:30Z is 13:00 in Asia/Tehran (+03:30) — the WALL CLOCK of the user, which
  // is the input ADR-004 (D-11) expects a manual entry to carry.
  assert.equal(time.openTime, "2026-10-03 13:00:00");
  assert.equal(time.closeTime, time.openTime);
});

test("time: an explicit date is honoured, and a bare date uses 00:00 with no invented clock", () => {
  const time = resolveTradeTime("XAUUSD buy 2026-09-30 ورود 2650", NOW, TZ);
  assert.equal(time.openTime, "2026-09-30 00:00:00");
  assert.equal(time.timeNote, "date-from-message");
});

test("time: an explicit clock time is honoured", () => {
  const time = resolveTradeTime("XAUUSD buy ساعت 14:30 ورود 2650", NOW, TZ);
  assert.equal(time.openTime, "2026-10-03 14:30:00");
});

test("draft: the payload mirrors the existing create path and omits absent optionals", () => {
  const draft = extract("XAUUSD buy ورود 2650 خروج 2660 حجم 1");
  const payload = draftToTradePayload(draft.fields);
  assert.deepEqual(Object.keys(payload).sort(), ["closeTime", "direction", "entryPrice", "exitPrice", "openTime", "notes", "symbol", "volume"].sort());
  // Absent optionals are OMITTED, not null-filled — the same contract the HTTP
  // route uses to distinguish "not provided" from "cleared".
  assert.equal("stopLoss" in payload, false);
  assert.equal(payload["symbol"], "XAUUSD");
  assert.equal(payload["direction"], "buy");
});

test("follow-up: a single answer fills exactly the asked field", () => {
  const draft = extract("امروز XAUUSD خرید گرفتم، ورود 2650، استاپ 2644 و تارگت 2665.");
  const withExit = applyFollowUp(draft.fields, "exitPrice", "2668");
  assert.equal(withExit.exitPrice, "2668");
  assert.equal(withExit.entryPrice, "2650");
  const withVolume = applyFollowUp(withExit, "volume", "0.1");
  assert.equal(withVolume.volume, "0.1");
  assert.deepEqual([...missingJournalFields(withVolume)], []);
  // A follow-up that is not a number does not fabricate one.
  assert.equal(applyFollowUp(withVolume, "exitPrice", "بعدا میگویم").exitPrice, "2668");
});

test("follow-up: symbol and direction answers use their own vocabularies", () => {
  const empty = extract("معامله کردم").fields;
  assert.equal(applyFollowUp(empty, "symbol", "eurusd").symbol, "EURUSD");
  assert.equal(applyFollowUp(empty, "direction", "فروش").direction, "sell");
  assert.equal(applyFollowUp(empty, "direction", "sell").direction, "sell");
  assert.equal(applyFollowUp(empty, "direction", "maybe").direction, null);
});

test("normalization: Persian digits, ZWNJ and Arabic punctuation are handled", () => {
  assert.equal(normalizeForParsing("۲۶۵۰"), "2650");
  assert.equal(normalizeForParsing("می\u200cخواهم ۱"), "میخواهم 1");
  assert.equal(normalizeForParsing("ورود ۲۶۵۰، استاپ ۲۶۴۴"), "ورود 2650, استاپ 2644");
  assert.equal(normalizeDecimal("1200.500"), "1200.5");
  assert.equal(normalizeDecimal("0.500"), "0.5");
});

test("extraction: malformed and hostile input cannot produce a value", () => {
  for (const text of ["", "   ", "%%%%%", "ورود", "2650", "استاپ تارگت خروج"]) {
    const draft = extract(text);
    assert.deepEqual([...draft.missingRequired], ["symbol", "direction", "entryPrice", "exitPrice", "volume"], `input: ${JSON.stringify(text)}`);
  }
});

test("extraction: is pure — repeated runs on the same input agree", () => {
  const text = "XAUUSD buy entry 2650 exit 2660 volume 1 sl 2644 tp 2665";
  assert.deepEqual(extract(text), extract(text));
});
