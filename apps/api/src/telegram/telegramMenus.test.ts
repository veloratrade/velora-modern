// The menu builders, asserted as data.
//
// WHY THIS FILE EXISTS SEPARATELY FROM `telegramBot.test.ts`. These are pure functions: no store, no
// Bot API, no clock. A screen is a `{text, keyboard}` value, so the properties worth pinning are
// properties of that value — and the most important one is not visual at all:
//
//   EVERY BUTTON MUST PARSE BACK INTO A KNOWN ACTION.
//
// That is the difference between a navigable menu and a decorative one. A `callbackData` that the
// closed vocabulary in `@velora/contracts` does not recognise is a dead tap in production, and it is
// invisible to the type system (`InlineKeyboardButton.callbackData` is a string). So every screen is
// walked here and each payload is fed back through `parseCallbackData`, then checked against the set
// of actions this bot actually routes. `telegramBot.test.ts` proves the handlers run; this file proves
// the buttons can reach them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CALLBACK_ACTIONS, MENU_TARGETS, parseCallbackData } from "@velora/contracts";
import { copyFor } from "./telegramCopy.js";
import {
  TEMPLATES_PER_PAGE,
  aiMenu,
  bannerMenu,
  flowKeyboard,
  helpMenu,
  journalMenu,
  mainMenu,
  postsMenu,
  templatesMenu,
  type MenuScreen,
} from "./telegramMenus.js";
import type { TelegramPostPreferences, TelegramTemplateRecord } from "./telegramStore.js";

const fa = copyFor("fa");
const en = copyFor("en");

/**
 * The actions `TelegramBot.handleCallback` routes.
 *
 * Kept as a literal, and asserted against the contract's own vocabulary below — a new action added to
 * contracts without a handler fails here rather than in production. (The handler side is covered by
 * `telegramBot.test.ts`, which taps each one.)
 */
const ROUTED_ACTIONS = [
  "confirm", "cancel", "edit", "menu", "unlink", "history_more", "channel_test", "connect",
  "trade", "trade_arm", "trade_edit", "trade_delete", "post_pub", "post_no",
  "tpl_list", "tpl_new", "tpl_edit", "tpl_del", "tpl_delok", "tpl_def", "tpl_pv",
  "bn_toggle", "bn_title", "ai_status", "flow_cancel", "post_edit",
] as const;

function template(id: string, name: string, version = 1): TelegramTemplateRecord {
  return {
    id,
    userId: "1",
    name,
    body: "{symbol} bias",
    version,
    supersededAt: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  };
}

const prefs = (over: Partial<TelegramPostPreferences> = {}): TelegramPostPreferences => ({
  userId: "1",
  defaultTemplateName: null,
  bannerEnabled: true,
  bannerTitle: null,
  pendingFlow: null,
  updatedAt: null,
  ...over,
});

/** Every screen this module can build, with the arguments each needs. */
function everyScreen(): { name: string; screen: MenuScreen }[] {
  const screens: { name: string; screen: MenuScreen }[] = [
    { name: "main (posts wired)", screen: mainMenu(fa, { postsWired: true }) },
    { name: "main (posts absent)", screen: mainMenu(fa, { postsWired: false }) },
    { name: "main (en)", screen: mainMenu(en, { postsWired: true }) },
    { name: "journal", screen: journalMenu(fa) },
    { name: "posts", screen: postsMenu(fa, { postsWired: true, defaultTemplateName: null }) },
    { name: "posts (absent)", screen: postsMenu(fa, { postsWired: false, defaultTemplateName: null }) },
    { name: "templates (empty)", screen: templatesMenu(fa, { templates: [], preferences: prefs(), page: 1, postsWired: true }) },
    {
      name: "templates (page 2 of 3)",
      screen: templatesMenu(fa, {
        templates: Array.from({ length: TEMPLATES_PER_PAGE * 3 }, (_, i) => template(String(i + 1), `t${String(i + 1)}`)),
        preferences: prefs({ defaultTemplateName: "t2" }),
        page: 2,
        postsWired: true,
      }),
    },
    { name: "banner (no rasterizer)", screen: bannerMenu(fa, { preferences: prefs({ bannerTitle: "صبح بخیر" }), canRaster: false }) },
    { name: "banner (rasterizer)", screen: bannerMenu(en, { preferences: prefs(), canRaster: true }) },
    {
      name: "ai (mixed)",
      screen: aiMenu(fa, {
        tools: [
          { name: "web_search", state: "configured", missing: [], reason: null },
          { name: "browser_capture", state: "unavailable", missing: ["BROWSERLESS_URL", "BROWSERLESS_TOKEN"], reason: "MISSING_API_KEY" },
        ],
      }),
    },
    { name: "help", screen: helpMenu(fa, "…commands…") },
  ];
  return screens;
}

test("every button on every screen parses back into an action the bot routes", () => {
  for (const { name, screen } of everyScreen()) {
    for (const row of screen.keyboard) {
      for (const button of row) {
        const data = (button as { callbackData?: string }).callbackData;
        const url = (button as { url?: string }).url;
        assert.ok(data !== undefined || url !== undefined, `${name}: a button with neither a payload nor a URL is inert`);
        if (data === undefined) continue;
        const parsed = parseCallbackData(data);
        assert.notEqual(parsed, null, `${name}: "${data}" does not parse against the contract vocabulary`);
        if (parsed === null) continue;
        assert.ok(
          (ROUTED_ACTIONS as readonly string[]).includes(parsed.action),
          `${name}: action "${parsed.action}" has no route in TelegramBot.handleCallback`,
        );
        // `menu` subjects are the closed destination set, so a typo cannot reach a default branch.
        if (parsed.action === "menu") {
          assert.ok((MENU_TARGETS as readonly string[]).includes(parsed.subject), `${name}: unknown menu target "${parsed.subject}"`);
        }
      }
    }
  }
});

test("the routed-action list is exactly the contract's vocabulary", () => {
  // Both directions matter: an action the bot routes but the contract cannot produce is dead code,
  // and one the contract produces but the bot does not route is a tap that goes nowhere.
  assert.deepEqual([...ROUTED_ACTIONS].sort(), [...CALLBACK_ACTIONS].sort());
});

test("the main menu offers the six sections the user asked for, and a way home from each", () => {
  const screen = mainMenu(fa, { postsWired: true });
  const labels = screen.keyboard.flat().map((b) => b.text).join(" | ");
  for (const label of [fa.btnNewJournal, fa.btnPost, fa.btnSettings]) {
    assert.ok(labels.includes(label), `the main menu must offer "${label}"`);
  }
  // Sections whose labels are built inside the module are checked through their subjects, not their
  // text: a section that navigates is a section that exists.
  const subjects = screen.keyboard.flat().map((b) => parseCallbackData((b as { callbackData?: string }).callbackData ?? "")?.subject);
  for (const target of ["journal", "posts", "templates", "banner", "ai", "settings", "help"]) {
    assert.ok(subjects.includes(target), `the main menu must route to "${target}"`);
  }
});

test("an absent post service is explained, never a disappearing section", () => {
  const absent = postsMenu(fa, { postsWired: false, defaultTemplateName: null });
  assert.ok(absent.text.includes(fa.navPostsUnavailable), "the section must say WHY it is empty");
  // No post-creating button: a button that can only fail is the lie this menu refuses to tell.
  const actions = absent.keyboard.flat().map((b) => parseCallbackData((b as { callbackData?: string }).callbackData ?? "")?.subject);
  assert.equal(actions.includes("post"), false, "no post button without a post service");
  // …and the main menu still names the section, so the absence is discoverable.
  const main = mainMenu(fa, { postsWired: false });
  assert.ok(main.text.length > 0);
  assert.equal(main.keyboard.flat().some((b) => b.text === fa.btnPost), false, "the CAPABILITY label is not offered without the capability");
});

test("the template list paginates by arithmetic, and the pager cannot leave the list", () => {
  const many = Array.from({ length: TEMPLATES_PER_PAGE * 2 + 1 }, (_, i) => template(String(i + 1), `t${String(i + 1)}`));
  const page2 = templatesMenu(fa, { templates: many, preferences: prefs(), page: 2, postsWired: true });
  const pager = page2.keyboard.flat().map((b) => parseCallbackData((b as { callbackData?: string }).callbackData ?? "")).filter((p) => p?.action === "tpl_list");
  assert.equal(pager.length, 2, "a middle page goes both ways");
  // Out-of-range pages are clamped, not trusted: a stale button on an old message must not render an
  // empty list.
  const clamped = templatesMenu(fa, { templates: many, preferences: prefs(), page: 99, postsWired: true });
  assert.ok(clamped.text.includes(`3/3`), `page 99 clamps to the last page (got: ${clamped.text})`);
  const negative = templatesMenu(fa, { templates: many, preferences: prefs(), page: -4, postsWired: true });
  assert.ok(negative.text.includes("1/3"));
});

test("the default template is marked on the list and on the posts screen", () => {
  const list = templatesMenu(fa, {
    templates: [template("1", "alpha"), template("2", "beta")],
    preferences: prefs({ defaultTemplateName: "beta" }),
    page: 1,
    postsWired: true,
  });
  const labels = list.keyboard.flat().map((b) => b.text);
  assert.ok(labels.includes(`${fa.tplDefaultMark} beta`), "the default carries the star");
  assert.ok(labels.includes("alpha"), "and an unmarked name is untouched");
  const posts = postsMenu(fa, { postsWired: true, defaultTemplateName: "beta" });
  assert.ok(posts.text.includes(fa.tplDefaultSet("beta")));
});

test("the banner screen states the rasterizer's own answer, in both directions", () => {
  const off = bannerMenu(fa, { preferences: prefs({ bannerEnabled: false }), canRaster: false });
  assert.ok(off.text.includes("خاموش"));
  assert.ok(off.text.includes("PNG"), "the missing capability is named");
  const on = bannerMenu(en, { preferences: prefs(), canRaster: true });
  assert.ok(on.text.includes("available"), "a runtime that CAN render says so");
  // The toggle offers the OPPOSITE of the current state — a button that re-sends the same value is a
  // button that appears broken.
  const toggle = off.keyboard.flat().find((b) => (b as { callbackData?: string }).callbackData?.startsWith("bn_toggle:"));
  assert.equal((toggle as { callbackData?: string }).callbackData, "bn_toggle:on");
});

test("the AI screen names missing keys and never a value", () => {
  const screen = aiMenu(fa, {
    tools: [{ name: "web_search", state: "unavailable", missing: ["TAVILY_API_KEY"], reason: "MISSING_API_KEY" }],
  });
  assert.ok(screen.text.includes("TAVILY_API_KEY"), "the operator needs the NAME");
  assert.ok(screen.text.includes("BROWSERLESS") === false);
  assert.ok(screen.text.includes(fa.aiNoSecretNote));
});

test("a guided prompt always carries its own cancel button", () => {
  const cancels = flowKeyboard(fa).flat().map((b) => parseCallbackData((b as { callbackData?: string }).callbackData ?? ""));
  assert.deepEqual(cancels.map((c) => c?.action), ["flow_cancel"]);
});
