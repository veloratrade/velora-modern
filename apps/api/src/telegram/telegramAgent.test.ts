// The agent's contract is a refusal contract. Every test here asks either "did it pick the tool that
// exists?" or, more often, "did it refuse the thing it must not do?" — because the failure mode this
// layer can actually have is a confident answer built on a capability the runtime does not have.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_REGISTRY,
  approvalRequest,
  availableToolNames,
  findTool,
  resolveIntent,
  toolNames,
  validateArgs,
} from "./telegramAgent.js";
import { RATE_LIMIT_DEFAULTS } from "@velora/contracts";

const plan = (text: string, locale: "fa" | "en" = "en") => resolveIntent(text, locale);

test("every declared tool is shaped for enforcement, not just for display", () => {
  assert.ok(TOOL_REGISTRY.length >= 10);
  for (const tool of TOOL_REGISTRY) {
    assert.equal(tool.description.fa.length > 0, true, tool.name);
    assert.equal(tool.description.en.length > 0, true, tool.name);
    assert.ok(typeof tool.available === "boolean");
    // The rule that matters: anything that leaves the system needs approval, and anything blocked
    // must name why. Both are checked structurally so a future row cannot forget them.
    if (tool.effect === "external") assert.equal(tool.requiresApproval, true, `${tool.name} is external and needs approval`);
    if (!tool.available) assert.equal(typeof tool.blockedReason, "string", `${tool.name} is blocked and must say why`);
    else assert.equal(tool.blockedReason, null, `${tool.name} is available and must not carry a reason`);
    // A `limitKey` is only a ceiling if some limiter is configured for it, so the set of legal values is
    // READ FROM the contract that configures them. It used to be a list of four names typed into this
    // assertion, and it broke the day `web.search` and `chart.capture` stopped sharing `telegram:analyze`
    // with everything else — which is the right symptom for a row that had begun spending an enforced key
    // the guard had never heard of, but the wrong guard to keep: a list that has to be edited every time a
    // key is added is a list that will be edited until it checks nothing. What stays pinned here is the
    // FAMILY: a Telegram tool must spend a `telegram:*` key, so it can never be metered behind a login or
    // registration bucket it has nothing to do with.
    assert.ok(
      tool.limitKey in RATE_LIMIT_DEFAULTS && tool.limitKey.startsWith("telegram:"),
      `${tool.name} spends ${tool.limitKey}, which no configured limiter enforces`,
    );
  }
});

test("the blocked capabilities are declared, not hidden — and never appear in what help may advertise", () => {
  const blocked = TOOL_REGISTRY.filter((t) => !t.available).map((t) => `${t.name}:${t.blockedReason}`);
  assert.deepEqual(blocked, ["web.search:NO_WEB_PROVIDER", "chart.capture:NO_BROWSER_AUTOMATION"]);
  assert.equal(availableToolNames().includes("web.search"), false);
  assert.equal(availableToolNames().includes("chart.capture"), false);
  assert.equal(availableToolNames().includes("stats.read"), true);
  assert.equal(toolNames().includes("web.search"), true, "the registry still names it, so the answer can explain it");
});

test("a request for a blocked capability is refused with the dependency, not attempted", () => {
  for (const text of ["search the web for DXY today", "گوگل را بگرد", "take a tradingview screenshot", "اسکرین‌شات چارت بگیر"]) {
    const out = plan(text);
    assert.equal(out.plan, null, text);
    assert.equal(out.rejection?.kind, "unsupported", text);
    assert.ok(out.rejection !== null && out.rejection.kind === "unsupported");
    assert.ok(["NO_WEB_PROVIDER", "NO_BROWSER_AUTOMATION"].includes(out.rejection.reason), out.rejection.reason);
  }
});

test("read-only intents route to the right tool, in both languages", () => {
  const cases: readonly [string, string, "fa" | "en"][] = [
    ["show me the stats for this week", "stats.read", "en"],
    ["آمار عملکردم چطوره", "stats.read", "fa"],
    ["چه چیزی در چک‌لیست باقی مانده", "checklist.gaps", "fa"],
    ["which checklist items are still unknown", "checklist.gaps", "en"],
    ["چک‌لیست دیروز", "checklist.read", "fa"],
    ["what templates do I have", "template.list", "en"],
    ["کانال من الان کدومه", "channel.status", "fa"],
  ];
  for (const [text, tool, locale] of cases) {
    const out = plan(text, locale);
    assert.equal(out.rejection, null, text);
    assert.equal(out.plan?.tool, tool, text);
    assert.equal(out.plan?.matchedBy, "patterns", text);
  }
});

test("precedence is the decision it claims to be: an explicit publish beats every earlier keyword", () => {
  // The sentence ALSO mentions stats and the checklist. A first-match router would answer the noun
  // and silently ignore the verb, i.e. print a summary while the user waits for a post.
  const out = plan("publish it now — the checklist stats look good, post-7");
  assert.equal(out.plan?.tool, "post.publish");
  assert.equal(out.plan?.args["postId"], "post-7");
  // Without a post to publish, the higher-priority verb still wins the DECISION — and what comes
  // back is the question for its one missing argument, not a stats read dressed up as an answer.
  const noId = plan("publish it now — the checklist stats look good");
  assert.equal(noId.plan, null);
  assert.ok(noId.rejection !== null && noId.rejection.kind === "ambiguous");
  assert.deepEqual(noId.rejection.candidates, ["postId"]);
});

test("a side-effect tool asks for approval naming the content AND the destination", () => {
  const publish = findTool("post.publish")!;
  assert.equal(publish.effect, "external");
  assert.equal(publish.requiresApproval, true);
  const ask = approvalRequest(publish, { summary: "XAUUSD bias card", destination: "-100123" });
  assert.match(ask.question, /-100123/u);
  assert.equal(ask.summary, "XAUUSD bias card");
  const nowhere = approvalRequest(publish, { summary: "s", destination: null });
  assert.match(nowhere.question, /active channel/u, "no destination means it must say which one it will use");
});

test("prose the router does not recognise is not an error: the caller's journal fallback owns it", () => {
  const out = plan("bought XAUUSD at 2650 yesterday, nice premium rejection");
  assert.equal(out.plan, null);
  assert.equal(out.rejection, null);
  assert.equal(plan("").plan, null);
  assert.equal(plan("   \n  ").rejection, null);
});

test("arguments are validated against the schema, and the bounds are real", () => {
  const gaps = findTool("checklist.gaps")!;
  assert.deepEqual(validateArgs(gaps, { days: "14" }), { ok: true, args: { days: 14 } });
  for (const bad of ["0", "-3", "367", "1e9", "abc", "1.5"]) {
    const res = validateArgs(gaps, { days: bad });
    assert.equal(res.ok, false, `days=${bad} must be refused`);
  }
  const stats = findTool("stats.read")!;
  assert.equal(validateArgs(stats, { window: "week" }).ok, true);
  assert.equal(validateArgs(stats, { window: "last_century" }).ok, false, "an enum is an enum");
  // A missing optional is fine; a missing required is not.
  const missing = validateArgs(findTool("post.publish")!, {});
  assert.equal(missing.ok, false);
  assert.ok(!missing.ok);
  assert.deepEqual(missing.errors, ["postId: required"]);
  // Oversized strings are refused before a store call, not silently truncated.
  assert.equal(validateArgs(findTool("journal.draft")!, { text: "x".repeat(501) }).ok, false);
  // Unknown keys are DROPPED: a plan cannot smuggle a destination or an owner into a tool call.
  const withExtra = validateArgs(stats, { window: "today", userId: "1", chatId: "-100999", token: "secret" });
  assert.deepEqual(withExtra, { ok: true, args: { window: "today" } });
});

test("the agent extracts a symbol only where a symbol belongs, and dates only by shape", () => {
  const prep = plan("prepare a bias card for XAUUSD on H4");
  assert.equal(prep.plan?.args["symbol"], "XAUUSD");
  assert.equal(prep.plan?.args["timeframe"], "H4");
  // "buy 2650" is a price, not a symbol: inventing one here would put the wrong trade on a card.
  const draft = plan("prepare a banner about my trade at 2650");
  assert.equal(draft.plan?.args["symbol"], undefined);
  // The date argument is only shape-checked: meaning belongs to the shared chat-date contract.
  const checklist = plan("چک‌لیست ۱۴۰۵-۰۷-۲۷");
  assert.equal(checklist.plan?.tool, "checklist.read");
});

test("a tool that needs an argument asks for it, in the user's language, and does not guess", () => {
  const out = plan("use my channel");
  assert.equal(out.plan, null);
  assert.ok(out.rejection !== null && out.rejection.kind === "ambiguous");
  assert.deepEqual(out.rejection.candidates, ["channelId"]);
  assert.match(out.rejection.question.en, /channelId/u);
  assert.match(out.rejection.question.fa, /channelId/u);
  // …and when the id is there, the plan carries it.
  assert.equal(plan("use my channel #77").plan?.args["channelId"], "77");
});
