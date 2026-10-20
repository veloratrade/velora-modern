// The checklist form must parse back.
//
// WHY A TEST AND NOT A CAREFUL LOOK. The prompt is the only place where a user is TOLD a key, and
// the keys live in an alias table in another package. A hand-written example rots the moment an alias
// is renamed, and the failure is silent: the user copies the template, sends it, and gets "I did not
// understand these keys" for text the bot itself invented. So the example is asserted against the
// parser and against the domain's own canonical line list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECKLIST_ITEMS, CHECKLIST_KEY_FOR_ITEM, CHECKLIST_PROMPT_LINES, parseChecklistText } from "@velora/domain";
import { COPY, CHECKLIST_EXAMPLE_VALUES, renderChecklistPrompt } from "./telegramCopy.js";

for (const locale of ["fa", "en"] as const) {
  test(`the ${locale} checklist example round-trips through the parser item for item`, () => {
    const copy = COPY[locale];
    const text = renderChecklistPrompt(copy, CHECKLIST_PROMPT_LINES);
    // What a user would actually send: the block they copied, filled in. The prose around it is the
    // bot's, so it is not part of the contract — the block below the label is.
    const block = text.split("\n").slice(2).join("\n");
    const parsed = parseChecklistText(block);
    assert.deepEqual(parsed.unparsed, [], `the bot must not print a key it cannot read back: ${JSON.stringify(parsed.unparsed)}`);
    assert.equal(parsed.unknowns.length, 0, "the example answers every line it shows");
    assert.deepEqual(
      CHECKLIST_ITEMS.map((item) => parsed.values[item]).filter((v) => v === undefined),
      [],
      "every item of the checklist is present in the example",
    );
  });

  test(`the ${locale} example is one line per item and the keys are the canonical ones`, () => {
    const text = renderChecklistPrompt(COPY[locale], CHECKLIST_PROMPT_LINES);
    const body = text.split("\n").slice(2).join("\n");
    const lines = body.split("\n").filter((line) => line.includes(": "));
    assert.equal(lines.length, CHECKLIST_ITEMS.length, "the form and the record have the same length");
    for (const item of CHECKLIST_ITEMS) {
      const key = CHECKLIST_KEY_FOR_ITEM[item];
      assert.ok(lines.some((line) => line.startsWith(`${key}: `)), `missing the canonical key '${key}'`);
      assert.ok(
        Object.prototype.hasOwnProperty.call(CHECKLIST_EXAMPLE_VALUES, key),
        `the sample map must name '${key}' or the example loses a line`,
      );
    }
  });
}

test("the two locales show the same keys, so a Persian user and an English user file the same record", () => {
  const keys = (text: string): string[] =>
    text
      .split("\n")
      .filter((line) => /^[a-z0-9 ]+: \S/.test(line))
      .map((line) => line.split(":")[0] ?? "");
  assert.deepEqual(keys(renderChecklistPrompt(COPY.fa, CHECKLIST_PROMPT_LINES)), keys(renderChecklistPrompt(COPY.en, CHECKLIST_PROMPT_LINES)));
});
