/**
 * The agent's planner: one model call, used only when the deterministic table cannot decide.
 *
 * WHY A MODEL MAY SPEAK AT ALL. The bot's router is a pattern table (`telegramAgent.ts`), and it stays
 * the primary decision-maker: it is free, instant, identical in every runtime, and cannot be talked out
 * of its rules. A table's weakness is phrasing — "did my setups look ok for posting?" matches nothing.
 * The planner exists for exactly that gap, and it is *bounded* rather than autonomous:
 *
 *   • ONE call per STEP. The step sequence itself lives in `aiAgentLoop.ts`, which calls back into
 *     `plan()` with the transcript of what has already run; this file stays a pure (utterance, history)
 *     → next-step function, so a step can be replayed in a test without a browser or a search key.
 *     `history` empty means "first step", and the reply is then byte-identical to the single-step
 *     behaviour this file shipped with;
 *   • the model may only NAME a tool from the registry the caller passes and fill its declared
 *     arguments — it cannot invent a tool, a chat id, a post id or a destination;
 *   • tools that send, publish, or move money are excluded BEFORE the prompt is built, so a jailbroken
 *     sentence cannot even be offered a target. The registry, not the model, is the ceiling;
 *   • every plan is re-validated by `validateArgs` after parsing. A plan that does not typecheck is
 *     discarded and the deterministic path answers instead;
 *   • it goes through `AiManager` with feature `assistant`, so the flag, the rollout gate, consent,
 *     the quota, the ledger and the timeout are the same ones every other AI surface obeys. There is no
 *     second egress path for the agent, and no new feature id to leave unguarded.
 */
import type { AiManager } from "./aiManager.js";
import { createHash } from "node:crypto";
import { MAX_AGENT_TOOL_STEPS } from "./aiToolCatalog.js";
import type { AgentHistoryRow } from "./aiAgentLoop.js";

/**
 * The slice of a registry row the planner needs.
 *
 * Declared here rather than imported from the Telegram agent so this file has no dependency on a command
 * surface: the shape is what a *provider* must know, the registry is what the *router* enforces.
 */
export interface PlannerToolShape {
  readonly name: string;
  readonly description: string;
  readonly args: readonly {
    readonly name: string;
    readonly type: string;
    readonly required: boolean;
    readonly enum?: readonly string[] | undefined;
  }[];
}

export interface AgentPlanRequest {
  readonly userId: string;
  readonly utterance: string;
  readonly locale: "fa" | "en";
  /**
   * Every tool the runtime can honour, INCLUDING the ones that need an approval. This is what a returned
   * plan is validated against — recognition is broader than permission on purpose, so a plan naming a
   * tool the user must approve is refused with a reason instead of vanishing into "I did not
   * understand".
   */
  readonly tools: readonly PlannerToolShape[];
  /**
   * The subset to put in front of the model. Optional, and when omitted it is `tools`: the caller decides
   * what is OFFERED, this layer decides what is ACCEPTED, and the two are stated separately so neither
   * can drift into silently becoming the other.
   */
  readonly advertised?: readonly PlannerToolShape[] | undefined;
  /**
   * What has already run in this request. Empty or absent is the first step.
   *
   * The rows carry the loop's own short, already-redacted observation, never the tool's raw output: a
   * search snippet is untrusted text, and untrusted text is exactly what a router must not be able to
   * be steered by. Counts, titles, codes and ids are enough to decide a next step, and they are the only
   * things the model is shown.
   */
  readonly history?: readonly AgentHistoryRow[] | undefined;
  /**
   * How much of the run's wall-clock budget is left, in ms. The loop owns the deadline; a step that would
   * blow past it must not be started, so the manager's own deadline is clamped to what remains.
   */
  readonly remainingMs?: number | undefined;
}

export type AgentPlanResult =
  | { readonly ok: true; readonly tool: string; readonly args: Record<string, string>; readonly provider: string; readonly model: string }
  /** `null` tool means the model honestly said "none of these fit". That is a RESULT, not a failure. */
  | { readonly ok: true; readonly tool: null }
  | { readonly ok: false; readonly code: string };

const PLANNER_DEADLINE_MS = 12_000;
const PLANNER_ATTEMPT_TIMEOUT_MS = 9_000;
const MAX_UTTERANCE_CHARS = 900;

/**
 * The instructions. Short on purpose: a planner prompt that explains the product is a planner prompt
 * the model can argue with. What it does contain is the shape of the answer and the prohibitions that
 * matter — no invented identifiers, no reformatting, and `null` is always an acceptable reply.
 */
/** The transcript block, for step two onward. Empty transcript ⇒ no block at all. */
function historyBlock(history: readonly AgentHistoryRow[]): string {
  if (history.length === 0) return "";
  const rows = history.map(
    (row) =>
      `${row.step}. ${row.tool} ${JSON.stringify(row.args)} -> ${row.ok ? "ok" : `FAILED (${row.code ?? "error"})`}: ${row.observation}`,
  );
  return [
    "",
    "Steps already done for this same request:",
    ...rows,
    "Rules for the NEXT step:",
    "- If the results above already answer the request, reply {\"tool\": null}.",
    "- Only add a step that USES a value from the results above. Never repeat a listed step or restate it with a tweak.",
    "- A value (url, id, date) you did not see above does not exist: refuse rather than guess it.",
  ].join("\n");
}

function plannerPrompt(tools: readonly PlannerToolShape[], history: readonly AgentHistoryRow[] = []): string {
  const lines = tools.map((tool) => {
    const args = tool.args
      .map((arg) => `${arg.name}:${arg.type}${arg.required ? "!" : ""}${arg.enum !== undefined ? `(${arg.enum.join("|")})` : ""}`)
      .join(", ");
    return `- ${tool.name}${args === "" ? "" : ` — args {${args}}`} — ${tool.description}`;
  });
  return [
    "You route one user request to one tool of this Telegram journal bot.",
    "Reply with ONLY a JSON object: {\"tool\": \"<name or null>\", \"args\": { ... }}.",
    "Allowed tools, with their only arguments:",
    ...lines,
    "Rules:",
    "1. Choose at most one tool. If none fits, or the request needs a value the user did not give, answer {\"tool\": null}.",
    "2. Never invent an id, a date, a symbol or a price. Copy values verbatim from the request.",
    "3. Unknown keys are errors: use only the arguments listed.",
    "4. No commentary, no markdown fences, no second object.",
    ...(history.length === 0 ? ["5. Never chain: one tool, or null."] : []),
  ].join("\n");
}

/**
 * sha256 of the sentence, for 0028's `input_hash`.
 *
 * The ledger must be able to say "this request was seen" without storing the request: what a trader
 * types to the agent is personal data, and a routing call has no business archiving it. With nothing to
 * fingerprint the answer is `null`, which the manager accepts — never a placeholder that would later be
 * mistaken for a real digest.
 */
function hashOf(text: string): string | null {
  if (text === "") return null;
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The ledger fingerprint for one STEP of one request.
 *
 * `input_hash` exists so an operator can see that a given request was seen — and with a multi-step loop a
 * second call for the SAME utterance is a different request: different prompt, different answer. Hashing
 * the bare utterance would therefore blur two ledger rows into one fingerprint. `step` keeps them apart
 * without storing anything beyond the sentence the user already typed.
 */
function stepHashOf(text: string, step: number): string | null {
  if (text === "") return null;
  return hashOf(step <= 1 ? text : `${text}\u0000step:${step}`);
}

/** The first JSON object in a reply, tolerating a fence or a stray sentence around it. */
export function firstJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(raw.slice(start, i + 1));
          return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * The plan, from the manager's structured output.
 *
 * Exported separately because it is the part worth testing on its own: a model that returns
 * `{"tool":"post.publish"}` or `{"tool":"stats.read","args":{"userId":"7"}}` must be refused HERE, and
 * not by an operator remembering to check. `allowed` is the caller's registry-as-shape, so the same
 * function serves a runtime with search configured and one without.
 */
export function interpretPlan(
  parsed: Record<string, unknown> | null,
  allowed: readonly PlannerToolShape[],
): { readonly tool: string; readonly args: Record<string, string> } | { readonly tool: null } | null {
  if (parsed === null) return null;
  const tool = parsed["tool"];
  if (tool === null) return { tool: null };
  if (typeof tool !== "string" || tool.trim() === "") return null;
  const name = tool.trim();
  const shape = allowed.find((candidate) => candidate.name === name);
  if (shape === undefined) return null; // a tool this product does not offer — or does not offer HERE
  const rawArgs = parsed["args"];
  const args: Record<string, string> = {};
  if (rawArgs !== undefined) {
    if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return null;
    const source = rawArgs as Record<string, unknown>;
    for (const [key, value] of Object.entries(source)) {
      if (!shape.args.some((arg) => arg.name === key)) continue; // unknown keys dropped, never forwarded
      if (typeof value === "string") args[key] = value.slice(0, 500);
      else if (typeof value === "number" && Number.isFinite(value)) args[key] = String(value);
      // A nested object or an array as an argument is a model trying to pass structure where a scalar
      // was declared. Dropping it is what keeps `validateArgs` the only place required-ness is decided.
    }
  }
  return { tool: name, args };
}

export interface AgentPlannerDeps {
  readonly manager: AiManager;
  readonly now?: () => number;
}

export class AiAgentPlanner {
  /** The step ceiling, from the catalogue, so the bot's guard and the prompt cannot drift apart. */
  readonly maxSteps = MAX_AGENT_TOOL_STEPS;

  constructor(private readonly deps: AgentPlannerDeps) {}

  async plan(request: AgentPlanRequest): Promise<AgentPlanResult> {
    const utterance = request.utterance.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, MAX_UTTERANCE_CHARS);
    if (utterance === "" || request.tools.length === 0) return { ok: true, tool: null };
    const now = this.deps.now ?? (() => Date.now());
    const history = request.history ?? [];
    const prompt = `${plannerPrompt(request.advertised ?? request.tools, history)}${historyBlock(history)}\n\nUser request (${request.locale}): ${utterance}`;
    const call = await this.deps.manager.call({
      userId: request.userId,
      feature: "assistant",
      ledgerFeature: "assistant",
      // v2 is the transcript-aware prompt. The ledger records the version precisely so a behaviour
      // change is attributable, and bumping it is mandatory when the instructions change.
      promptVersion: "telegram_agent_planner_v2",
      prompt,
      // Whichever is tighter: the planner's own ceiling, or what the run has left. A step with 400 ms of
      // budget remaining does not get 9 seconds.
      deadlineMs: now() + Math.max(1, Math.min(PLANNER_DEADLINE_MS, request.remainingMs ?? PLANNER_DEADLINE_MS)),
      attemptTimeoutMs: Math.min(PLANNER_ATTEMPT_TIMEOUT_MS, Math.max(1, request.remainingMs ?? PLANNER_ATTEMPT_TIMEOUT_MS)),
      inputHash: stepHashOf(utterance, history.length + 1),
      requiresStructuredOutput: true,
    });
    if (call.status !== "generated") {
      // The manager's own vocabulary, so a disabled feature, a spent quota and a provider outage stay
      // distinguishable by the caller — each needs a different sentence in front of the user.
      return { ok: false, code: "status" in call && typeof call.status === "string" ? call.status : "PROVIDER_FAILED" };
    }
    const raw = call.insight !== null && call.insight !== undefined && typeof call.insight === "object" && !Array.isArray(call.insight)
      ? (call.insight as Record<string, unknown>)
      : call.text !== null && call.text !== undefined
        ? firstJsonObject(call.text)
        : null;
    const interpreted = interpretPlan(raw, request.tools);
    if (interpreted === null) return { ok: false, code: "MALFORMED_PLAN" };
    if (interpreted.tool === null) return { ok: true, tool: null };
    return {
      ok: true,
      tool: interpreted.tool,
      args: interpreted.args,
      provider: call.provider,
      model: call.model,
    };
  }
}
