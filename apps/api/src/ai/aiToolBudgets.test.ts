// Per-tool budgets, enforced and equal to what the catalogue publishes.
//
// Two failure modes this file exists to catch, both of which happened in this product's history:
//   • a limit written in one table and enforced from another, so the published number means nothing; and
//   • a tool's registry `limitKey` naming a bucket nobody hits — the same shape as the planner's
//     `maxSteps` field, which was decorative until a loop read it.
// The first is caught by asserting equality against `RATE_LIMIT_DEFAULTS`; the second by asserting that
// every key the registry names EXISTS, and that the bot's own entry points hit it.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { RATE_LIMIT_DEFAULTS, type RateLimitKey } from "@velora/contracts";
import { TOOL_BUDGETS, MAX_AGENT_TOOL_STEPS, AGENT_PER_TOOL_STEP_LIMITS, AGENT_RUN_DEADLINE_MS, telegramAgentLoopBudget } from "./aiToolCatalog.js";
import { TOOL_REGISTRY, effectiveRegistry, NO_TOOL_CAPABILITIES } from "../telegram/telegramAgent.js";

test("every tool's published hourly budget IS its enforced bucket", () => {
  // `TOOL_BUDGETS` used to be prose. These three assertions are what make it a number the runtime obeys:
  // the search and capture buckets read the same values, so changing one table must change the other or
  // the build goes red.
  assert.equal(RATE_LIMIT_DEFAULTS["telegram:search"].limit, TOOL_BUDGETS.web_search.perUserPerHour);
  assert.equal(RATE_LIMIT_DEFAULTS["telegram:capture"].limit, TOOL_BUDGETS.browser_capture.perUserPerHour);
  assert.equal(RATE_LIMIT_DEFAULTS["telegram:search"].windowSec, 3600);
  assert.equal(RATE_LIMIT_DEFAULTS["telegram:capture"].windowSec, 3600);
  // A capture is the expensive tool (a browser session, a PNG, a vision call) and must stay the tightest.
  assert.ok(RATE_LIMIT_DEFAULTS["telegram:capture"].limit < RATE_LIMIT_DEFAULTS["telegram:search"].limit);
});

test("an agent run has a bucket of its own, bounded relative to the per-tool ones", () => {
  const agent = RATE_LIMIT_DEFAULTS["telegram:agent"];
  assert.equal(agent.windowSec, 3600);
  // The run bucket must be at least the per-tool ceiling's own order of magnitude, or a user could not
  // spend the tool budget the product advertises: 20 runs × up to 3 searches is still inside 30 searches
  // only because the per-run per-tool cap is what keeps a run from consuming the whole hourly allowance.
  assert.ok(agent.limit >= 10, "an agent hour must admit real work, not just one request");
});

test("every registry tool names a bucket that exists, and an expensive one does not ride on the free key", () => {
  for (const tool of TOOL_REGISTRY) {
    assert.ok(tool.limitKey in RATE_LIMIT_DEFAULTS, `${tool.name} names ${tool.limitKey}, which is not a policy`);
    const expensive = tool.effect === "external" || tool.name === "web.search" || tool.name === "chart.capture";
    if (expensive) {
      // `telegram:update` is the bot's ambient per-message budget. An external or provider-touching tool
      // allowed to fall back to it would be an unlimited-capacity tool wearing a 60/minute name tag.
      assert.notEqual(tool.limitKey, "telegram:update", `${tool.name} may not share the ambient message bucket`);
    }
  }
  // And the two research tools spend SEPARATE keys: sharing one is how "I searched 30 times" and
  // "I captured 12 times" became the same number.
  assert.notEqual(
    TOOL_REGISTRY.find((t) => t.name === "web.search")?.limitKey,
    TOOL_REGISTRY.find((t) => t.name === "chart.capture")?.limitKey,
  );
});

test("the loop's ceilings are the catalogue's ceilings, not a copy of them", () => {
  const built = telegramAgentLoopBudget();
  assert.equal(built.maxSteps, MAX_AGENT_TOOL_STEPS);
  assert.equal(built.maxModelCalls, MAX_AGENT_TOOL_STEPS + 1);
  assert.equal(built.wallClockMs, AGENT_RUN_DEADLINE_MS);
  assert.deepEqual(built.perToolLimit, AGENT_PER_TOOL_STEP_LIMITS);
  // A per-run cap above the step ceiling would be unreachable, and an unreachable ceiling is a lie.
  for (const [tool, cap] of Object.entries(AGENT_PER_TOOL_STEP_LIMITS)) {
    assert.ok(cap >= 1 && cap <= MAX_AGENT_TOOL_STEPS, `${tool} per-run cap ${String(cap)} is outside 1..${String(MAX_AGENT_TOOL_STEPS)}`);
  }
  // The wall must at least admit the most expensive single call plus its answer, or the loop would stop
  // before its own first step could finish. The browser provider's timeout is 25 s by catalogue.
  assert.ok(AGENT_RUN_DEADLINE_MS > 25_000, "the run deadline must outlast one capture's provider timeout");
});

test("the capability flags decide availability, and every runtime sees the same buckets", () => {
  // Two assertions that keep the Worker honest: an unavailable tool is still a DECLARED tool with a
  // bucket, so a runtime that cannot search still refuses it under the same key rather than inventing a
  // second, unthrottled path.
  const bare = effectiveRegistry(NO_TOOL_CAPABILITIES);
  const search = bare.find((t) => t.name === "web.search");
  assert.equal(search?.available, false);
  assert.equal(search?.limitKey, "telegram:search");
  assert.equal(search?.blockedReason, "NO_WEB_PROVIDER");
});

test("a bucket the contract publishes is a bucket the bot actually hits", () => {
  // The static half of the enforcement check. Each Telegram key must be named in the bot's source as an
  // `allowed(...)` argument or be the registry's key for a tool — a policy that no call site reads is a
  // limit that exists only in the file an operator reads while troubleshooting.
  const bot = readFileSync(new URL("../telegram/telegramBot.ts", import.meta.url), "utf8");
  const registryKeys = new Set<string>(TOOL_REGISTRY.map((t) => t.limitKey));
  for (const key of ["telegram:update", "telegram:journal", "telegram:analyze", "telegram:channel", "telegram:agent", "telegram:search", "telegram:capture"] as const) {
    const hitDirectly = bot.includes(`allowed(tgId, "${key}")`) || bot.includes(`"${key}")`);
    const usedByATool = registryKeys.has(key);
    assert.ok(hitDirectly || usedByATool, `${key} is published in RATE_LIMIT_DEFAULTS but enforced nowhere in the bot`);
  }
  // And the research tools are enforced where the request is made, not where the reply is sent: the
  // provider call and the bucket check live in the same `perform*` function.
  const searchBody = bot.slice(bot.indexOf("private async performWebSearch"), bot.indexOf("private async renderSearchResult"));
  assert.match(searchBody, /allowed\(tgId, "telegram:search"\)/u);
  const captureBody = bot.slice(bot.indexOf("private async performChartCapture"), bot.indexOf("private async renderChartCapture"));
  assert.match(captureBody, /allowed\(tgId, "telegram:capture"\)/u);
  const runStart = bot.indexOf("private async runAgentPlan");
  const agentBody = bot.slice(runStart, bot.indexOf("private async renderLoopOutcome"));
  assert.ok(runStart > 0 && agentBody.length > 200, "the anchors moved: this test must be re-pointed, not left vacuous");
  assert.match(agentBody, /allowed\(tgId, "telegram:agent"\)/u);
});
