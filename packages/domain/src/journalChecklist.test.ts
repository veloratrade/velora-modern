// The checklist keeps what the trader reviewed, and keeps the absence of a review visible.
//
// Every case pins a rule a "just store the form" implementation gets wrong: the three-state
// distinction, the refusal to map an unknown word, the refusal to invent a risk unit, and the
// refusal to let a partial report clear an earlier answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECKLIST_ITEMS,
  CHECKLIST_KEY_FOR_ITEM,
  CHECKLIST_PROMPT_LINES,
  ChecklistFormatError,
  checklistCoverage,
  deserializeChecklist,
  emptyChecklist,
  interpretItemValue,
  interpretRisk,
  mergeChecklist,
  normalizeReportDate,
  parseChecklistText,
  serializeChecklist,
} from "./journalChecklist.js";

test("an empty checklist is UNREVIEWED everywhere and is never complete", () => {
  const list = emptyChecklist("2026-10-18");
  assert.equal(CHECKLIST_ITEMS.length, 11);
  for (const item of CHECKLIST_ITEMS) assert.equal(list.values[item].state, "UNREVIEWED");
  const coverage = checklistCoverage(list);
  assert.deepEqual([coverage.confirmed, coverage.unknown, coverage.unreviewed, coverage.complete], [0, 0, 11, false]);
});

test("normalizeReportDate: digits only, and a bad date is a refusal rather than today", () => {
  assert.equal(normalizeReportDate("2026-10-18"), "2026-10-18");
  assert.equal(normalizeReportDate("2026/10/8"), "2026-10-08");
  assert.equal(normalizeReportDate("2026.10.08"), "2026-10-08");
  assert.equal(normalizeReportDate("2024-02-29"), "2024-02-29", "a real leap day stays valid");
  assert.equal(normalizeReportDate("2026-13-01"), null);
  assert.equal(normalizeReportDate("2026-02-30"), null, "Date.parse rolls this over; a journal may not");
  assert.equal(normalizeReportDate("دیروز"), null);
  assert.equal(normalizeReportDate(""), null);
});

test("parse: key:value lines resolve in Persian and English, free text becomes the note", () => {
  const parsed = parseChecklistText(
    ["bias: صعودی", "h1: fvg", "cisd: yes", "risk: ۰.۵٪", "یک ستاپ تمیز روی طلای جهانی"].join("\n"),
  );
  assert.equal(parsed.values["dailyBias"], "صعودی");
  assert.equal(parsed.values["pdArrayH1"], "fvg");
  assert.equal(parsed.values["m1Cisd"], "yes");
  assert.equal(parsed.values["risk"], "۰.۵٪");
  assert.match(parsed.notes ?? "", /طلای جهانی/);
});

test("parse: an item with no value is UNKNOWN, not an empty confirmation", () => {
  const parsed = parseChecklistText("smt:\nmacro: ?\nsl: نمی‌دانم");
  assert.deepEqual(parsed.unknowns.slice().sort(), ["macroTiming", "smt", "stopLoss"]);
  assert.equal(parsed.values["smt"], undefined);
});

test("parse: an unrecognised key is reported, never silently dropped", () => {
  const parsed = parseChecklistText("liquidity sweep: m1 high\nbias: bearish");
  assert.deepEqual(parsed.unparsed, [{ key: "liquidity sweep" }]);
  assert.equal(parsed.values["dailyBias"], "bearish");
});

test("every prompt key parses back to its own item, so the template cannot lie", () => {
  assert.equal(CHECKLIST_PROMPT_LINES.length, CHECKLIST_ITEMS.length);
  for (const item of CHECKLIST_ITEMS) {
    const key = CHECKLIST_KEY_FOR_ITEM[item];
    const parsed = parseChecklistText(`${key}: probe`);
    assert.equal(parsed.values[item], "probe", `${key} must resolve to ${item}`);
    assert.deepEqual(parsed.unparsed, [], `${key} must not be reported as unknown`);
  }
});

test("values normalise only on an exact vocabulary hit, otherwise the user's words survive", () => {
  assert.deepEqual(interpretItemValue("dailyBias", "Bullish"), { value: "BULLISH", normalised: true });
  assert.deepEqual(interpretItemValue("priceLocation", "premium"), { value: "PREMIUM", normalised: true });
  assert.deepEqual(interpretItemValue("priceLocation", "the third one"), { value: "the third one", normalised: false });
  assert.deepEqual(interpretItemValue("dailyBias", "maybe bullish"), { value: "maybe bullish", normalised: false });
  assert.equal(interpretItemValue("stopLoss", "2655.").value, "2655");
  assert.equal(interpretItemValue("stopLoss", "1,265.50").value, "1265.5");
  assert.equal(interpretItemValue("stopLoss", "۲۶۵۵").value, "2655", "Persian digits fold like the trade parser");
});

test("risk carries the unit the user gave, and says UNSPECIFIED when they did not", () => {
  assert.deepEqual(interpretRisk("0.5%"), { value: "0.5", unit: "PERCENT" });
  assert.deepEqual(interpretRisk("۰.۵٪"), { value: "0.5", unit: "PERCENT" });
  assert.deepEqual(interpretRisk("150 USD"), { value: "150", unit: "AMOUNT" });
  assert.deepEqual(interpretRisk("0.5"), { value: "0.5", unit: "UNSPECIFIED" });
  assert.deepEqual(interpretRisk("سنگین"), { value: null, unit: "UNSPECIFIED" });
});

test("merge: a partial report never clears an item it does not mention", () => {
  const first = mergeChecklist(emptyChecklist("2026-10-18"), parseChecklistText("bias: bullish\nh4: ifc"));
  assert.equal(first.values["dailyBias"].state, "CONFIRMED");
  assert.equal(first.values["dailyBias"].value, "BULLISH");
  assert.equal(first.values["pdArrayH4"].value, "ifc");
  const second = mergeChecklist(first, parseChecklistText("smt: none"));
  assert.equal(second.values["dailyBias"].value, "BULLISH", "untouched items survive a later report");
  assert.equal(second.values["smt"].state, "CONFIRMED");
  assert.equal(second.values["pdArrayH4"].state, "CONFIRMED");
});

test("merge: UNKNOWN is a distinct, remembered answer", () => {
  const list = mergeChecklist(emptyChecklist("2026-10-18"), parseChecklistText("cisd: ?"));
  assert.equal(list.values["m1Cisd"].state, "UNKNOWN");
  assert.equal(list.values["m1Cisd"].value, null);
  assert.equal(list.values["pdArrayM15"].state, "UNREVIEWED", "UNKNOWN must not bleed into a sibling item");
});

test("coverage counts three states separately and is complete only when nothing is missing", () => {
  let list = mergeChecklist(emptyChecklist("2026-10-18"), parseChecklistText("bias: bullish\nrisk: 0.5%"));
  assert.deepEqual([checklistCoverage(list).confirmed, checklistCoverage(list).unreviewed, false], [2, 9, false]);
  const all = CHECKLIST_ITEMS.map((item) => `${CHECKLIST_KEY_FOR_ITEM[item]}: x`).join("\n");
  const full = mergeChecklist(list, parseChecklistText(all));
  assert.equal(checklistCoverage(full).confirmed, CHECKLIST_ITEMS.length);
  assert.equal(checklistCoverage(full).complete, true);
});

test("round-trip through the persisted shape preserves states, units and verbatim text", () => {
  const list = mergeChecklist(
    emptyChecklist("2026-10-18", "Asia/Tehran"),
    parseChecklistText(
      ["bias: صعودی", "location: the odd one", "risk: 0.5%", "smt:", "یادداشت: امروز فقط observe"].join("\n"),
    ),
  );
  const back = deserializeChecklist("2026-10-18", JSON.parse(JSON.stringify(serializeChecklist(list))));
  assert.equal(back.timezone, "Asia/Tehran");
  assert.equal(back.values["dailyBias"].value, "BULLISH");
  assert.equal(back.values["priceLocation"].value, "the odd one");
  assert.equal(back.values["priceLocation"].normalised, false);
  assert.equal(back.values["risk"].value, "0.5");
  assert.equal(back.riskUnit, "PERCENT");
  assert.equal(back.values["smt"].state, "UNKNOWN");
  assert.match(back.notes ?? "", /observe/);
  assert.deepEqual(checklistCoverage(back), checklistCoverage(list));
});

test("a malformed persisted payload is refused, not coerced into defaults", () => {
  assert.throws(() => deserializeChecklist("2026-10-18", "nope"), ChecklistFormatError);
  assert.throws(() => deserializeChecklist("2026-10-18", { items: [] }), ChecklistFormatError);
  assert.throws(() => deserializeChecklist("2026-10-18", { items: { bogus: {} } }), ChecklistFormatError);
  assert.throws(() => deserializeChecklist("2026-10-18", { items: { dailyBias: { state: "SORT_OF" } } }), ChecklistFormatError);
  assert.throws(
    // A JS number in a value slot would mean a float got into the record: caught at the door.
    () => deserializeChecklist("2026-10-18", { items: { stopLoss: { state: "CONFIRMED", value: 2655.5 } } }),
    ChecklistFormatError,
  );
  assert.deepEqual(deserializeChecklist("2026-10-18", {}), emptyChecklist("2026-10-18"));
});

test("a note key is collected as the note; an unrelated key is still reported as unparsed", () => {
  const parsed = parseChecklistText(["bias: bullish", "note: only took the London retest", "یادداشت: فردا مرور می‌کنم", "sweep: nothing"].join("\n"));
  assert.equal(parsed.values["dailyBias"], "bullish");
  assert.match(parsed.notes ?? "", /London retest/);
  assert.match(parsed.notes ?? "", /مرور می‌کنم/);
  assert.deepEqual(parsed.unparsed, [{ key: "sweep" }]);
  const list = mergeChecklist(emptyChecklist("2026-10-18"), parsed);
  assert.equal(checklistCoverage(list).confirmed, 1, "a note never marks anything reviewed");
});
