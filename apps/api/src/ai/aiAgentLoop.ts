/**
 * The agent's STEP LOOP: plan → run → observe → decide the next step, under four ceilings.
 *
 * WHY THIS FILE EXISTS AT ALL.
 * Before it, "agent" meant one model call that named one tool, and `MAX_AGENT_TOOL_STEPS` was a number
 * nothing read — a ceiling written down is not a ceiling enforced. Real requests are multi-step
 * ("find out what news moved gold today, then capture the chart and show me the post for that day"),
 * and refusing them is honest but thin, while letting a model chain calls unbounded is a
 * denial-of-service primitive with a nice UI. So the loop is what makes the ceiling REAL: every step
 * costs, and every cost is counted.
 *
 * THE FOUR CEILINGS, all of them enforced HERE rather than advertised there:
 *   1. `maxSteps` — tool executions per request, from `MAX_AGENT_TOOL_STEPS`;
 *   2. `maxModelCalls` — planner calls (steps + one, so a plan that runs out of steps never spins);
 *   3. `wallClockMs` — a deadline measured with the injected clock, checked BEFORE a step starts, so an
 *      overrun stops spending instead of merely reporting late;
 *   4. `perToolLimit` — how often one tool may appear in a single run, which is also the loop guard.
 *
 * WHAT THE LOOP IS NOT:
 *   • not an authority. `requiresApproval` tools are never executed here — the run stops and hands the
 *     pending side effect back so the user approves the FINAL content through the existing button;
 *   • not a source of values. An argument naming a target (a url, a post id, a channel id) is accepted
 *     only when that exact value already appeared in the user's own message or in a previous step's
 *     observation. A model that invents `https://evil.example/x` is refused with `UNVERIFIED_TARGET`
 *     before anything is fetched, which is the difference between "the agent chained two tools" and
 *     "the agent became an SSRF primitive";
 *   • not a launderer. A failing tool call becomes an observation with `ok: false` and the provider's
 *     fixed code, and the run is reported `partial` — never as a success, and never as silence.
 *
 * The loop is pure control flow: no timers, no network, no Telegram, no store. The caller supplies the
 * executor, the planner and the clock, which is what lets every guard above be tested in milliseconds
 * instead of needing a live provider.
 */

/** One tool call the loop decided to make. */
export interface AgentToolCall {
  readonly tool: string;
  readonly args: Record<string, string>;
}

/**
 * What a step produced.
 *
 * `observation` is the ONLY part the model reads back, so it is short and already redacted by the
 * producer (titles, counts, codes — never a provider body, never a credential). `payload` is for the
 * caller's own rendering and is never shown to the model: that split is what keeps "what the agent
 * knows" smaller than "what the user is shown".
 */
export interface AgentStepResult {
  readonly ok: boolean;
  readonly code: string | null;
  readonly retryAfterSeconds: number | null;
  readonly observation: string;
  /**
   * Values this step legitimately put on the table for a later step: the urls a search returned, the
   * post id a preview created, the dates a gap report named. A later step may only use what is listed
   * here or what the user typed themselves.
   */
  readonly context: AgentContextAdditions | undefined;
  readonly payload: unknown;
}

export interface AgentContextAdditions {
  readonly urls: readonly string[];
  readonly ids: readonly string[];
  readonly dates: readonly string[];
}

export const NO_CONTEXT: AgentContextAdditions = { urls: [], ids: [], dates: [] };

/** Run one step. The caller owns every side effect, every limit hit and every message. */
export type AgentExecutor = (call: AgentToolCall, step: number, signal: { readonly remainingMs: number }) => Promise<AgentStepResult>;

export interface AgentLoopBudget {
  readonly maxSteps: number;
  readonly maxModelCalls: number;
  readonly wallClockMs: number;
  /** How many times ONE tool may run in one request. Missing key ⇒ 1, which is the safe default. */
  readonly perToolLimit: Readonly<Record<string, number>>;
}

/**
 * The transcript row the planner is shown about a finished step. `observation` only — the payload is
 * never re-serialised into a prompt, because a search result body is untrusted text and giving it to a
 * router is how a router gets redirected.
 */
export interface AgentHistoryRow {
  readonly step: number;
  readonly tool: string;
  readonly args: Record<string, string>;
  readonly ok: boolean;
  readonly code: string | null;
  readonly observation: string;
}

/** Which arguments must be values this run has actually seen. */
const MUST_BE_KNOWN: Readonly<Record<string, readonly { arg: string; kind: keyof AgentContextAdditions }[]>> = {
  "chart.capture": [{ arg: "url", kind: "urls" }],
  "post.publish": [{ arg: "postId", kind: "ids" }],
  "channel.select": [{ arg: "channelId", kind: "ids" }],
};

export type AgentStopReason =
  | null
  | "max-steps"
  | "max-model-calls"
  | "wall-clock"
  | "repeat-guard"
  | "tool-budget"
  | "malformed-plan"
  | "planner-unavailable"
  | "unverified-target"
  | "approval-required"
  | "no-plan";

export interface AgentLoopOutcome {
  /**
   * `completed` — the planner stopped asking and every step it ran succeeded;
   * `partial` — work was done and then something stopped it, so the answer must say which;
   * `stopped` — nothing was achieved, only a guard fired;
   * `no-plan` — the agent found nothing to do (the caller falls back to its normal answer).
   */
  readonly status: "completed" | "partial" | "stopped" | "no-plan";
  readonly stoppedBy: AgentStopReason;
  readonly steps: readonly AgentExecutedStep[];
  readonly modelCalls: number;
  readonly elapsedMs: number;
  /** The tool the loop refused to run itself, when it stopped for an approval. */
  readonly pendingApproval: string | null;
  /** A guard's own detail, for the log line — never a provider body. */
  readonly detail: string | null;
}

export interface AgentExecutedStep {
  readonly call: AgentToolCall;
  readonly result: AgentStepResult;
  readonly matchedBy: "patterns" | "model";
  readonly elapsedMs: number;
}

export interface AgentPlannerCall {
  readonly ok: boolean;
  readonly code: string | null;
  readonly tool: string | null;
  readonly args: Record<string, string>;
}

export interface AgentLoopRequest {
  readonly userId: string;
  readonly utterance: string;
  readonly locale: "fa" | "en";
  /** The first step, when the deterministic table already decided it. Costs no model call. */
  readonly seed: AgentToolCall | null;
  readonly budget: AgentLoopBudget;
  /** Values the user themselves supplied, which a later step may legitimately reuse. */
  readonly initialContext: AgentContextAdditions | undefined;
  /** Whether the loop may ask for a SECOND step. False ⇒ today's single-step behaviour, exactly. */
  readonly allowContinuation: boolean;
}

export interface AgentLoopDeps {
  /** The next step, given the transcript. `tool: null` means "finish and answer". */
  readonly plan: (request: {
    readonly utterance: string;
    readonly history: readonly AgentHistoryRow[];
    readonly step: number;
    readonly remainingMs: number;
  }) => Promise<AgentPlannerCall>;
  readonly execute: AgentExecutor;
  readonly now?: () => number;
  readonly log?: (event: Record<string, unknown>) => void;
}

function canonical(call: AgentToolCall): string {
  const keys = Object.keys(call.args).sort();
  return `${call.tool}|${keys.map((k) => `${k}=${(call.args[k] ?? "").trim().toLowerCase()}`).join("&")}`;
}

function knownValues(contexts: readonly AgentContextAdditions[], kind: keyof AgentContextAdditions): Set<string> {
  const set = new Set<string>();
  for (const c of contexts) for (const value of c[kind]) set.add(value.trim());
  return set;
}

/** The `MUST_BE_KNOWN` check, exported because it is the security-relevant line and deserves its own test. */
export function verifyTarget(call: AgentToolCall, known: { readonly [K in keyof AgentContextAdditions]: Set<string> }): string | null {
  const rules = MUST_BE_KNOWN[call.tool];
  if (rules === undefined) return null;
  for (const rule of rules) {
    const value = call.args[rule.arg];
    if (value === undefined || value === "") continue; // absence is that tool's own required-args problem
    if (!known[rule.kind].has(value.trim())) return rule.arg;
  }
  return null;
}

export class AgentLoop {
  constructor(private readonly deps: AgentLoopDeps) {}

  async run(request: AgentLoopRequest): Promise<AgentLoopOutcome> {
    const now = this.deps.now ?? (() => Date.now());
    const startedAt = now();
    const deadline = startedAt + request.budget.wallClockMs;
    const steps: AgentExecutedStep[] = [];
    const history: AgentHistoryRow[] = [];
    const contexts: AgentContextAdditions[] = request.initialContext !== undefined ? [request.initialContext] : [];
    const perToolCount = new Map<string, number>();
    let modelCalls = 0;
    let stoppedBy: AgentStopReason = null;
    let detail: string | null = null;
    let pendingApproval: string | null = null;
    let malformedStreak = 0;

    const remaining = (): number => Math.max(0, deadline - now());
    const finish = (): AgentLoopOutcome => {
      // `completed` is reserved for a run that stopped because it was DONE. Every other reason — a
      // ceiling, a guard, a failing step — is `partial` even when the steps that ran all succeeded,
      // because the user's request was not fully answered and the message must say so.
      const status: AgentLoopOutcome["status"] =
        steps.length === 0 ? (stoppedBy === null ? "no-plan" : "stopped") : stoppedBy === null && steps.every((s) => s.result.ok) ? "completed" : "partial";
      this.deps.log?.({
        level: status === "completed" ? "info" : "warn",
        event: "telegram_agent_loop",
        status,
        stoppedBy,
        steps: steps.length,
        modelCalls,
        elapsedMs: now() - startedAt,
        ...(detail !== null ? { detail } : {}),
        ...(pendingApproval !== null ? { pendingApproval } : {}),
      });
      return {
        status,
        stoppedBy,
        steps,
        modelCalls,
        elapsedMs: now() - startedAt,
        pendingApproval,
        detail,
      };
    };

    let next: AgentToolCall | null = request.seed;
    let matchedBy: "patterns" | "model" = request.seed !== null ? "patterns" : "model";

    for (;;) {
      // ── decide the next step ────────────────────────────────────────────
      if (next === null) {
        if (steps.length >= request.budget.maxSteps) {
          stoppedBy = "max-steps";
          detail = `limit ${request.budget.maxSteps}`;
          break;
        }
        if (modelCalls >= request.budget.maxModelCalls) {
          stoppedBy = "max-model-calls";
          break;
        }
        if (remaining() <= 0) {
          stoppedBy = "wall-clock";
          break;
        }
        modelCalls += 1;
        let proposal: AgentPlannerCall;
        try {
          proposal = await this.deps.plan({
            utterance: request.utterance,
            history,
            step: steps.length + 1,
            remainingMs: remaining(),
          });
        } catch {
          // A planner that throws is a planner that is down. The transcript so far is still worth
          // answering with, which is why this is a stop and not a failure.
          stoppedBy = "planner-unavailable";
          break;
        }
        if (!proposal.ok) {
          // A plan the PLANNER refused (it returned a tool name that is not in the registry, or output
          // that is not JSON) is a different fact from a planner that is DOWN, and it gets different
          // handling: one more question, then a stop. Treating both as "unavailable" would let a model
          // that merely misspoke look like an outage in the logs — and vice versa.
          if (proposal.code === "MALFORMED_PLAN") {
            malformedStreak += 1;
            detail = "MALFORMED_PLAN";
            if (malformedStreak >= 2) {
              stoppedBy = "malformed-plan";
              break;
            }
            continue;
          }
          stoppedBy = "planner-unavailable";
          detail = proposal.code;
          break;
        }
        if (proposal.tool === null) break; // "I have enough — answer it"
        const parsed = parseToolArgs(proposal.tool, proposal.args);
        if (parsed === null) {
          malformedStreak += 1;
          detail = "MALFORMED_TOOL_NAME";
          if (malformedStreak >= 2) {
            stoppedBy = "malformed-plan";
            break;
          }
          continue; // ask once more, now that the transcript says what has already run
        }
        malformedStreak = 0;
        next = parsed;
        matchedBy = "model";
      }

      // ── gate the step ───────────────────────────────────────────────────
      const call = next;
      const key = canonical(call);
      if (steps.some((s) => canonical(s.call) === key)) {
        stoppedBy = "repeat-guard";
        detail = key.slice(0, 120);
        break;
      }
      const allowedForTool = request.budget.perToolLimit[call.tool] ?? 1;
      if ((perToolCount.get(call.tool) ?? 0) >= allowedForTool) {
        stoppedBy = "tool-budget";
        detail = `${call.tool} limit ${allowedForTool}`;
        break;
      }
      if (isApprovalOnlyTool(call.tool)) {
        // The loop stops HERE, not at the send — and BEFORE the target check, because "this effect needs
        // your own tap" is the truer refusal than "the id you named is unknown": both are true, and the
        // one the user can act on comes first. The caller shows the preview and its button, so the
        // approval is of content the user actually saw, which no amount of planning can substitute.
        stoppedBy = "approval-required";
        pendingApproval = call.tool;
        break;
      }
      const offending = verifyTarget(call, {
        urls: knownValues(contexts, "urls"),
        ids: knownValues(contexts, "ids"),
        dates: knownValues(contexts, "dates"),
      });
      if (offending !== null) {
        stoppedBy = "unverified-target";
        detail = `${call.tool}.${offending}`;
        break;
      }
      if (remaining() <= 0) {
        stoppedBy = "wall-clock";
        break;
      }

      // ── run it ──────────────────────────────────────────────────────────
      perToolCount.set(call.tool, (perToolCount.get(call.tool) ?? 0) + 1);
      const before = now();
      let result: AgentStepResult;
      try {
        result = await this.deps.execute(call, steps.length + 1, { remainingMs: remaining() });
      } catch (error) {
        // An exception from a tool is a FAILED STEP, recorded as one. Turning it into `ok: true` with an
        // empty observation is exactly the laundering this rule exists to prevent.
        result = {
          ok: false,
          code: error instanceof Error && error.name === "AbortError" ? "TOOL_TIMEOUT" : "TOOL_THREW",
          retryAfterSeconds: null,
          observation: "the step threw and returned nothing",
          context: undefined,
          payload: undefined,
        };
      }
      steps.push({ call, result, matchedBy, elapsedMs: now() - before });
      history.push({
        step: steps.length,
        tool: call.tool,
        args: call.args,
        ok: result.ok,
        code: result.code,
        observation: result.observation.slice(0, 400),
      });
      if (result.context !== undefined) contexts.push(result.context);
      next = null;

      // A runtime without a planner (or a caller that asked for one step) stops here. The alternative —
      // looping to ask a model that does not exist — would turn `/help`'s promise into a provider call
      // and a timeout, so the single-step case is a deliberate stop, not an oversight.
      if (!request.allowContinuation) break;
    }

    return finish();
  }
}

/**
 * `tool` must be a bare registry name; anything else is a malformed plan, not a typo to be forgiven.
 * Kept separate from `verifyTarget` so the two refusal reasons stay distinguishable in a log.
 */
function parseToolArgs(tool: string, args: Record<string, string>): AgentToolCall | null {
  if (typeof tool !== "string") return null;
  const name = tool.trim();
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){0,2}$/u.test(name)) return null;
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (typeof v === "string") safe[k] = v;
  }
  return { tool: name, args: safe };
}

/**
 * Tools whose effect needs a tap the user has not given. The loop hard-stops on these even if a caller
 * forgot to filter them out of the offer list — defence in depth over a shared assumption.
 */
function isApprovalOnlyTool(name: string): boolean {
  return name === "post.publish" || name === "channel.select" || name === "journal.draft" || name === "trade.execute";
}
