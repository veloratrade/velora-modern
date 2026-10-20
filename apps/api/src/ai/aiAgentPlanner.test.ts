/**
 * The planner's own rules — the part that has to be right even when a model is behaving perfectly.
 *
 * A fake `AiManager` stands in for the whole AI boundary here, which is legitimate for these tests
 * because what is under test is not the provider call but the CONTRACT around it: which feature the call
 * is made under (that is what puts it behind the flag, the consent gate, the quota and the ledger), what
 * the model is allowed to name, and what happens when its answer is well-formed JSON saying something
 * this product does not offer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AiAgentPlanner, firstJsonObject, interpretPlan, type PlannerToolShape } from "./aiAgentPlanner.js";
import type { AiManager, AiCallRequest } from "./aiManager.js";

const TOOLS: readonly PlannerToolShape[] = [
  { name: "stats.read", description: "Performance summary", args: [{ name: "window", type: "enum", required: false, enum: ["today", "week"] }] },
  { name: "web.search", description: "Search the web", args: [{ name: "query", type: "string", required: true }] },
  { name: "post.publish", description: "Publish the approved post", args: [{ name: "postId", type: "string", required: true }] },
];

function manager(outcome: Record<string, unknown>, record: AiCallRequest[]): AiManager {
  return {
    call: async (request: AiCallRequest) => {
      record.push(request);
      return outcome as never;
    },
  } as unknown as AiManager;
}

test("the JSON fence is tolerated, a trailing sentence is tolerated, a second object is not", () => {
  assert.deepEqual(firstJsonObject('```json\n{"tool": null}\n```'), { tool: null });
  assert.deepEqual(firstJsonObject('Sure! {"tool":"stats.read","args":{"window":"week"}} hope that helps'), {
    tool: "stats.read",
    args: { window: "week" },
  });
  assert.equal(firstJsonObject("I cannot help with that."), null);
  // A brace inside a string must not end the object early — this is why the scan tracks quoting.
  assert.deepEqual(firstJsonObject('{"tool":"web.search","args":{"query":"a } b"}}'), { tool: "web.search", args: { query: "a } b" } });
  assert.equal(firstJsonObject("{not json}"), null);
});

test("a plan is accepted only for a tool the caller offered, with only its declared arguments", () => {
  assert.deepEqual(interpretPlan({ tool: "stats.read", args: { window: "week", userId: "7" } }, TOOLS), {
    tool: "stats.read",
    args: { window: "week" },
  }, "an invented `userId` is dropped, not forwarded to a store call");
  assert.deepEqual(interpretPlan({ tool: null }, TOOLS), { tool: null }, "a refusal is a valid answer");
  assert.equal(interpretPlan({ tool: "telegram.send", args: {} }, TOOLS), null, "a tool this product does not offer");
  assert.equal(interpretPlan({ tool: "post.publish", args: {} }, []), null, "a tool withheld from THIS runtime");
  assert.equal(interpretPlan({ tool: "stats.read", args: [{ nope: 1 }] }, TOOLS), null, "args must be an object");
  assert.deepEqual(interpretPlan({ tool: "web.search", args: { query: "x", nested: { a: 1 } } }, TOOLS), {
    tool: "web.search",
    args: { query: "x" },
  }, "a structured value where a scalar was declared is dropped");
  assert.equal(interpretPlan(null, TOOLS), null);
  assert.equal(interpretPlan({ tool: 42 }, TOOLS), null, "a numeric tool name is not a tool");
});

test("one bounded manager call under feature `assistant`, with the utterance hashed and never stored", async () => {
  const record: AiCallRequest[] = [];
  const planner = new AiAgentPlanner({
    manager: manager({ status: "generated", text: '{"tool":"web.search","args":{"query":"gold"}}', provider: "gemini", model: "gemini-2.5-flash", insight: null }, record),
    now: () => 1_000,
  });
  const out = await planner.plan({ userId: "u1", utterance: "find  news   about gold\nplease", locale: "en", tools: TOOLS });
  assert.deepEqual(out, { ok: true, tool: "web.search", args: { query: "gold" }, provider: "gemini", model: "gemini-2.5-flash" });
  assert.equal(record.length, 1, "one call per message, not a loop");
  const request = record[0]!;
  assert.equal(request.feature, "assistant", "the planner rides an existing feature, so the flag and the guard apply");
  assert.equal(request.requiresStructuredOutput, true);
  assert.equal(request.deadlineMs, 1_000 + 12_000, "the caller owns the deadline and the manager enforces it");
  assert.ok(request.inputHash !== null && request.inputHash !== undefined && /^[0-9a-f]{64}$/u.test(request.inputHash));
  assert.ok(!request.prompt.includes("gemini-2.5-flash"));
  assert.ok(request.prompt.includes('"tool": "<name or null>"'), "the prompt states the answer shape");
  // The tool list the model may choose from, and nothing that needs an approval the user never tapped.
  assert.ok(request.prompt.includes("stats.read"), "offered tools are described");
  // What is OFFERED is the caller's decision, not the planner's: the bot withholds every
  // approval-required tool before it ever builds a prompt (asserted in `telegramBot.test.ts`), and this
  // layer's job is to refuse a name that was not offered. A planner that second-guessed its caller would
  // make two policy decisions in two places and guarantee they disagree.
  for (const tool of TOOLS) assert.ok(request.prompt.includes(tool.name), `the prompt describes ${tool.name}`);
});

test("a disabled feature, a spent quota or a nonsense plan all end the same way: no plan, no side effect", async () => {
  const record: AiCallRequest[] = [];
  const refused = new AiAgentPlanner({ manager: manager({ status: "refused", code: "FEATURE_DISABLED" }, record) });
  assert.deepEqual(await refused.plan({ userId: "u", utterance: "stats?", locale: "en", tools: TOOLS }), { ok: false, code: "refused" });

  const nonsense = new AiAgentPlanner({
    manager: manager({ status: "generated", text: "I would use post.publish with id 12", provider: "gemini", model: "m", insight: null }, record),
  });
  assert.deepEqual(await nonsense.plan({ userId: "u", utterance: "publish it", locale: "en", tools: TOOLS }), {
    ok: false,
    code: "MALFORMED_PLAN",
  });

  // No tools offered at all ⇒ the manager is not contacted, because there is nothing legal to pick.
  const quiet = new AiAgentPlanner({ manager: manager({ status: "generated", text: "{}" }, record) });
  assert.deepEqual(await quiet.plan({ userId: "u", utterance: "hello", locale: "en", tools: [] }), { ok: true, tool: null });
  // Two calls reached the manager (the refused one and the nonsense one) and the third never tried: with
  // no tool offered there is nothing legal to pick, so not even a feature-flag check is spent.
  assert.equal(record.length, 2, "the empty-registry call must not reach the manager at all");
});
