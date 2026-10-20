// The callback vocabulary is a CLOSED contract, so it is tested as one.
//
// A button whose data does not parse is a dead button, and a button that parses but names an action
// the bot does not implement is a dead button wearing a real label. Both halves are asserted here:
// every declared action round-trips through build -> parse, the subject grammar refuses anything
// else, and the two sets are cross-checked against the subjects the bot actually emits for the
// journal maintenance surfaces added with migration 0036.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CALLBACK_ACTIONS,
  MENU_TARGETS,
  buildCallbackData,
  parseCallbackData,
} from "./telegram.js";

test("every declared action round-trips, including a trade id with hyphens", () => {
  const subjects: Record<string, string> = {
    confirm: "d-1",
    cancel: "d-1",
    edit: "symbol",
    menu: "journal",
    unlink: "yes",
    history_more: "2",
    channel_test: "1",
    connect: "1",
    trade: "9f2c7a41-5b6e-4a10-8b1f-3c0d5e6a7b89",
    trade_arm: "9f2c7a41-5b6e-4a10-8b1f-3c0d5e6a7b89",
    trade_edit: "9f2c7a41-5b6e-4a10-8b1f-3c0d5e6a7b89-notes",
    trade_delete: "9f2c7a41-5b6e-4a10-8b1f-3c0d5e6a7b89-v3",
    // A prepared post is addressed by ITS OWN ID and nothing else. Not the chat id (the destination
    // lives on the row, so a button can never re-aim a post), not the template name (a Persian name
    // cannot survive this grammar, and a name would also select whatever the CURRENT version is).
    post_pub: "post-7",
    post_no: "post-7",
  };
  for (const action of CALLBACK_ACTIONS) {
    const subject = subjects[action];
    assert.ok(subject !== undefined, `the test must know a subject for '${action}'`);
    assert.deepEqual(parseCallbackData(buildCallbackData(action, subject)), { action, subject });
  }
});

test("the menu targets the bot can render are exactly the ones the keyboard can ask for", () => {
  // 0036 round added `stats` and `checklist`; if a target is declared but not handled, the button
  // answers with the generic failure, which is exactly the "button without an action" this contract
  // exists to prevent. The bot's own tests cover the handlers; this covers the vocabulary.
  // "post" joins the list WITH its handler: the bot-level test that walks every minted keyboard
  // refuses a button whose target has no case, so an entry here and no `case "post"` fails that one.
  assert.deepEqual([...MENU_TARGETS], ["journal", "last", "history", "analyze", "settings", "stats", "checklist", "post"]);
});

test("an unknown action or a malformed subject is not parsed at all", () => {
  for (const raw of [
    "drop_table:1",
    "trade:../../etc/passwd",
    "trade:",
    "trade:" + "x".repeat(49),
    "trade_delete:" + "x".repeat(48) + "-v1",
    "menu:journal;extra",
    "confirm yes",
    "",
  ]) {
    assert.equal(parseCallbackData(raw), null, `must refuse: ${raw.slice(0, 24)}`);
  }
});
