// The agent's step loop, tested as pure control flow.
//
// Every ceiling the product claims has to be provable WITHOUT a provider: the fake planner below can
// be told exactly what to propose on each call, the fake executor decides whether a step succeeded, and
// the clock is injected — so a test can say "the fourth step never started" rather than "probably".
// These are the tests that turn `MAX_AGENT_TOOL_STEPS` from a comment into a bound.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgentLoop,
  verifyTarget,
  NO_CONTEXT,
  type AgentContextAdditions,
  type AgentLoopBudget,
  type AgentPlannerCall,
  type AgentStepResult,
  type AgentToolCall,
} from "./aiAgentLoop.js";
import { MAX_AGENT_TOOL_STEPS, telegramAgentLoopBudget } from "./aiToolCatalog.js";

function step(over: Partial<AgentStepResult> = {}): AgentStepResult {
  return {
    ok: true,
    code: null,
    retryAfterSeconds: null,
    observation: "fine",
    context: NO_CONTEXT,
    payload: undefined,
    ...over,
  };
}

/** A planner that replays a script, then reports the run finished. */
function scriptedPlanner(script: readonly (AgentPlannerCall | null)[]): {
  readonly plan: (request: { utterance: string; history: readonly unknown[]; step: number }) => Promise<AgentPlannerCall>;
  readonly calls: readonly { history: readonly unknown[]; step: number }[];
} {
  const calls: { history: readonly unknown[]; step: number }[] = [];
  let i = 0;
  return {
    calls,
    plan: async (request) => {
      calls.push({ history: request.history, step: request.step });
      const item = script[i] ?? null;
      i += 1;
      return item ?? { ok: true, code: null, tool: null, args: {} };
    },
  };
}

const propose = (tool: string, args: Record<string, string> = {}): AgentPlannerCall => ({ ok: true, code: null, tool, args });

function budget(over: Partial<AgentLoopBudget> = {}): AgentLoopBudget {
  return {
    maxSteps: MAX_AGENT_TOOL_STEPS,
    maxModelCalls: MAX_AGENT_TOOL_STEPS + 1,
    wallClockMs: 45_000,
    perToolLimit: { "web.search": 3, "chart.capture": 2 },
    ...over,
  };
}

async function run(
  options: {
    readonly script?: readonly (AgentPlannerCall | null)[];
    readonly seed?: AgentToolCall | null;
    readonly budget?: Partial<AgentLoopBudget>;
    readonly initialContext?: AgentContextAdditions;
    readonly execute?: (call: AgentToolCall, step: number) => Promise<AgentStepResult>;
    readonly clockStepMs?: number;
    readonly allowContinuation?: boolean;
  } = {},
) {
  const executed: AgentToolCall[] = [];
  const planner = scriptedPlanner(options.script ?? []);
  let t = 1_000_000;
  const loop = new AgentLoop({
    plan: planner.plan,
    execute: async (call, n) => {
      executed.push(call);
      t += options.clockStepMs ?? 0;
      // The default executor answers every step successfully, so each test varies only the one thing it
      // is about. `n` is passed through for the rare test that needs step numbering.
      return await (options.execute?.(call, n) ?? Promise.resolve(step()));
    },
    // The clock is FROZEN except for one advance per executed step, which is how a wall-clock test should
    // read: "each step took 20 seconds of real work". Advancing on every `now()` call would let the number
    // of internal clock reads decide the outcome, and the test would measure the harness.
    now: () => t,
  });
  const result = await loop.run({
    userId: "1",
    utterance: "do the thing",
    locale: "en",
    seed: options.seed ?? null,
    budget: budget(options.budget),
    initialContext: options.initialContext,
    allowContinuation: options.allowContinuation ?? true,
  });
  return { result, executed, planner };
}

test("a seeded step runs once, costs no model call, and finishes when continuation is refused", async () => {
  const { result, executed, planner } = await run({
    seed: { tool: "stats.read", args: { window: "week" } },
    allowContinuation: false,
  });
  assert.deepEqual(executed.map((c) => c.tool), ["stats.read"]);
  assert.equal(planner.calls.length, 0, "the deterministic path must not spend a provider call");
  assert.equal(result.status, "completed");
  assert.equal(result.stoppedBy, null);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.steps[0]?.matchedBy, "patterns");
});

test("a model-led run chains: step two is asked for WITH step one's observation", async () => {
  const { result, executed } = await run({
    seed: { tool: "web.search", args: { query: "gold" } },
    script: [propose("chart.capture", { url: "https://www.tradingview.com/symbols/XAUUSD/" })],
    initialContext: { urls: ["https://www.tradingview.com/symbols/XAUUSD/"], ids: [], dates: [] },
    execute: async (call) =>
      call.tool === "web.search"
        ? step({ observation: "2 results", context: { urls: ["https://www.tradingview.com/symbols/XAUUSD/"], ids: [], dates: [] } })
        : step({ observation: "captured" }),
  });
  assert.deepEqual(executed.map((c) => c.tool), ["web.search", "chart.capture"]);
  assert.equal(result.steps.length, 2);
  // Two calls for two steps: the seeded step was NOT re-asked, and the run ended when the model said
  // "done" — one question per continuation, no question for work already decided by the table.
  assert.equal(result.modelCalls, 2, "one question per continuation, none for the seeded step");
  assert.equal(result.status, "completed");
  assert.equal(result.steps[1]?.call.args["url"], "https://www.tradingview.com/symbols/XAUUSD/");
});

test("the step ceiling bites: the loop never runs a step beyond MAX_AGENT_TOOL_STEPS", async () => {
  // A planner that always proposes a NEW step: without a ceiling this is an unbounded spend.
  const script: AgentPlannerCall[] = Array.from({ length: 12 }, (_unused, i) => propose("stats.read", { window: `w${String(i)}` }));
  // `stats.read` gets a generous per-run allowance HERE so this test measures the step ceiling and not
  // the per-tool one; the real per-tool limit is asserted in its own test below.
  const { result, executed } = await run({ script, budget: { perToolLimit: { "stats.read": 12 } } });
  assert.equal(executed.length, MAX_AGENT_TOOL_STEPS);
  assert.equal(result.stoppedBy, "max-steps");
  assert.equal(result.status, "partial", "a run cut off by its ceiling is not 'completed'");
  assert.equal(result.steps.length, MAX_AGENT_TOOL_STEPS);
});

test("the model-call ceiling bites even though every step it asked about succeeded", async () => {
  // A run is allowed one question per step PLUS the one that ends it. Two calls means: ask, run, ask,
  // run, and then stop WITHOUT a third question — the point being that a chatty model cannot keep the
  // run alive by never saying "done".
  const script: AgentPlannerCall[] = Array.from({ length: 10 }, (_unused, i) => propose(`t${String(i)}.read`));
  const { result, executed } = await run({ script, budget: { maxModelCalls: 2 } });
  assert.equal(result.modelCalls, 2);
  assert.equal(executed.length, 2);
  assert.equal(result.stoppedBy, "max-model-calls");
  assert.equal(result.status, "partial", "it stopped because it ran out of questions, not because it was done");
});

test("the wall-clock ceiling stops a step from STARTING, not just from being reported", async () => {
  // Each step takes 20 s of real time and the run has 45 s. Three steps still FIT the rule the loop
  // implements — the deadline is checked BEFORE a step starts, and 5 s remained when the third began —
  // and the FOURTH is refused. That is the guarantee that matters: an overrun stops the spending rather
  // than describing it afterwards, so no provider call is issued into an expired budget.
  const { result, executed } = await run({
    script: [propose("a.tool"), propose("b.tool"), propose("c.tool"), propose("d.tool")],
    clockStepMs: 20_000,
    budget: { wallClockMs: 45_000 },
  });
  assert.equal(executed.length, 3, `a fourth step must not start once the budget is gone, got ${String(executed.length)}`);
  assert.equal(result.stoppedBy, "wall-clock");
  assert.equal(result.status, "partial");
});

test("a repeated tool with the same arguments is refused rather than looped", async () => {
  const { result, executed } = await run({
    seed: { tool: "web.search", args: { query: "GOLD" } },
    script: [propose("web.search", { query: " gold " })], // same call modulo case and whitespace
  });
  assert.equal(executed.length, 1, "the duplicate must never reach the provider");
  assert.equal(result.stoppedBy, "repeat-guard");
  assert.equal(result.status, "partial");
});

test("one tool may not run more than its per-run limit, even with different arguments", async () => {
  const script: AgentPlannerCall[] = [
    propose("web.search", { query: "a" }),
    propose("web.search", { query: "b" }),
    propose("web.search", { query: "c" }),
    propose("web.search", { query: "d" }),
  ];
  const { result, executed } = await run({ script, budget: { perToolLimit: { "web.search": 2 } } });
  assert.equal(executed.length, 2);
  assert.equal(result.stoppedBy, "tool-budget");
  assert.match(result.detail ?? "", /limit 2/u);
});

test("a target the run never saw is refused BEFORE the executor is reached", async () => {
  const { result, executed } = await run({
    script: [propose("chart.capture", { url: "https://evil.example.internal/steal" })],
  });
  assert.equal(executed.length, 0, "the whole point: nothing was fetched");
  assert.equal(result.stoppedBy, "unverified-target");
  assert.equal(result.detail, "chart.capture.url");
});

test("a target that DID come from a tool result is allowed through the same guard", async () => {
  const { result, executed } = await run({
    seed: { tool: "web.search", args: { query: "gold" } },
    script: [propose("chart.capture", { url: "https://www.tradingview.com/x" })],
    execute: async () => step({ context: { urls: ["https://www.tradingview.com/x"], ids: [], dates: [] } }),
  });
  assert.equal(executed.length, 2);
  assert.equal(result.stoppedBy, null);
});

test("verifyTarget only governs the arguments that name a destination", () => {
  const known = { urls: new Set(["https://a.example/x"]), ids: new Set<string>(["post-7"]), dates: new Set<string>() };
  assert.equal(verifyTarget({ tool: "chart.capture", args: { url: "https://a.example/x" } }, known), null);
  assert.equal(verifyTarget({ tool: "chart.capture", args: { url: "https://b.example/y" } }, known), "url");
  assert.equal(verifyTarget({ tool: "post.publish", args: { postId: "post-7" } }, known), null);
  assert.equal(verifyTarget({ tool: "post.publish", args: { postId: "post-8" } }, known), "postId");
  // A read-only tool has no destination to verify: the guard must not pretend otherwise.
  assert.equal(verifyTarget({ tool: "stats.read", args: { window: "week" } }, known), null);
});

test("a side effect the user has not approved stops the run instead of being planned", async () => {
  const { result, executed } = await run({ script: [propose("post.publish", { postId: "post-9" })] });
  assert.equal(executed.length, 0);
  assert.equal(result.stoppedBy, "approval-required");
  assert.equal(result.pendingApproval, "post.publish");
});

test("a failed step is a failed step: never a success, never a silence", async () => {
  const { result } = await run({
    seed: { tool: "web.search", args: { query: "gold" } },
    script: [],
    execute: async () => step({ ok: false, code: "PROVIDER_503", observation: "provider said 503" }),
  });
  assert.equal(result.status, "partial");
  assert.equal(result.steps[0]?.result.ok, false);
  assert.equal(result.steps[0]?.result.code, "PROVIDER_503");
});

test("an executor that throws is recorded as a failed step, not swallowed", async () => {
  const { result } = await run({
    seed: { tool: "web.search", args: { query: "gold" } },
    execute: async () => {
      throw new Error("browser died");
    },
  });
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]?.result.ok, false);
  assert.equal(result.steps[0]?.result.code, "TOOL_THREW");
  assert.equal(result.status, "partial");
});

test("a planner that throws mid-run keeps the work already done and says so", async () => {
  const loop = new AgentLoop({
    plan: async () => {
      throw new Error("provider down");
    },
    execute: async () => step(),
    now: () => 0,
  });
  const thrown = await loop.run({
    userId: "1",
    utterance: "u",
    locale: "en",
    seed: { tool: "web.search", args: { query: "gold" } },
    budget: budget(),
    initialContext: undefined,
    allowContinuation: true,
  });
  assert.equal(thrown.steps.length, 1, "the step that succeeded before the planner died is still reported");
  assert.equal(thrown.stoppedBy, "planner-unavailable");
  assert.equal(thrown.status, "partial");
});

test("a malformed plan is asked once more, then the run stops", async () => {
  const bad = (): AgentPlannerCall => ({ ok: false, code: "MALFORMED_PLAN", tool: null, args: {} });
  const { result, planner } = await run({ script: [bad(), bad()] });
  assert.equal(result.stoppedBy, "malformed-plan");
  assert.equal(planner.calls.length, 2, "exactly one re-ask — a second bad answer is a stop, not a retry loop");
  assert.equal(result.steps.length, 0);
  assert.equal(result.status, "stopped");
});

test("one malformed answer followed by a good one continues the run", async () => {
  const bad = (): AgentPlannerCall => ({ ok: false, code: "MALFORMED_PLAN", tool: null, args: {} });
  const { result, executed } = await run({ script: [bad(), propose("stats.read")] });
  assert.equal(result.stoppedBy, null);
  assert.equal(executed.length, 1);
  assert.equal(result.status, "completed", "the recovery is not a partial run: the step it planned did run");
});

test("an unparseable tool NAME is malformed too, and is never sent to the executor", async () => {
  const { result, executed } = await run({ script: [propose("drop table;"), propose("DROP TABLE")] });
  assert.equal(executed.length, 0);
  assert.equal(result.stoppedBy, "malformed-plan");
});

test("the transcript given to the model for step two names the first step and its outcome", async () => {
  const { planner } = await run({
    seed: { tool: "web.search", args: { query: "gold" } },
    script: [null],
    execute: async () => step({ observation: "3 results from tavily" }),
  });
  const second = planner.calls[0];
  assert.equal(second?.step, 2);
  const history = second?.history as readonly { tool: string; ok: boolean; observation: string }[];
  assert.equal(history[0]?.tool, "web.search");
  assert.equal(history[0]?.ok, true);
  assert.equal(history[0]?.observation, "3 results from tavily");
});

test("the default budget is the catalogue's, so a documented ceiling cannot be decorative", () => {
  const built = telegramAgentLoopBudget();
  assert.equal(built.maxSteps, MAX_AGENT_TOOL_STEPS);
  assert.equal(built.maxModelCalls, MAX_AGENT_TOOL_STEPS + 1);
  assert.ok(built.wallClockMs > 0);
  assert.ok(Object.keys(built.perToolLimit).length > 0);
});
