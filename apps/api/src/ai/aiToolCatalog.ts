/**
 * The TOOL catalogue: what the agent may reach beyond a language model, on which provider, at which
 * pinned endpoint, with which secrets, and under which budget.
 *
 * WHY THIS IS A SEPARATE CATALOGUE FROM `aiCatalog.ts`'s PROVIDERS.
 *   `aiCatalog` answers "which LLM may perform this AI FEATURE", and its whole machinery — route
 *   resolver, fallback chain, quota reservation, ledger — is about model calls that take a prompt and
 *   return text. A web search and a screenshot are not that: they take a query, return structured
 *   records or image bytes, and have nothing for a model fallback chain to fall back TO. Forcing them
 *   into `AiExecutor` would have meant either a fake "model" with no model, or a `capabilities`
 *   entry that the route resolver could then pick for a TEXT feature — an entry whose answer is a
 *   search result, silently delivered as if it were generated prose.
 *
 *   What is reused instead is the discipline and the plumbing that already exist: the SAME
 *   admin-managed secret store (`AI_SECRET_KEYS`, AES-256-GCM envelope, fingerprint, fail-closed
 *   without a master key), the SAME provider-verify/credential-status vocabulary
 *   (`AiCredentialStatus`), and the SAME "endpoint is pinned in code, never in the request" rule the
 *   relay config uses. So there is one place a credential lives, one place a status is recorded, and
 *   one place an endpoint comes from — which is the whole point of the "no parallel services" rule.
 *
 * EVERY ENDPOINT BELOW IS A CONSTANT. A caller — the model, an admin form, a user message — can
 * choose WHICH provider is used and can supply a query, but can never supply the origin a request is
 * sent to. `browserless` is the one exception, and deliberately so: it is a service the operator hosts,
 * so its origin is configuration (`BROWSERLESS_URL`), read through the encrypted secret store and
 * validated at use time. That asymmetry (operator-chosen endpoint vs request-chosen destination) is
 * explained again in `aiToolOutbound.ts`, where it actually matters.
 */
import type { AiCredentialStatus } from "./aiConfigStore.js";

export const AI_TOOLS = ["web_search", "browser_capture", "banner_raster"] as const;
export type AiTool = (typeof AI_TOOLS)[number];

/**
 * What the admin panel shows. The states are deliberately not a boolean: "a valid LLM key was added"
 * must not turn unrelated tools green, so `configured` means only "the credential resolves" and
 * `verified` means "we just asked the provider and it answered successfully". `unsupported` is
 * reserved for a capability this RUNTIME cannot have at all (a rasterizer in a Worker), which is a
 * different fact from `unavailable` (no credential configured yet) and from `failing` (configured,
 * tried, and the provider returned an error).
 */
export const TOOL_CAPABILITY_STATES = ["configured", "verified", "unavailable", "failing", "unsupported"] as const;
export type ToolCapabilityState = (typeof TOOL_CAPABILITY_STATES)[number];

export interface ToolCapabilityEvidence {
  readonly tool: AiTool;
  readonly provider: string;
  readonly state: ToolCapabilityState;
  /** `configured`/`verified` only when the runtime can execute the tool at all. */
  readonly runtimeSupported: boolean;
  /** Secret names this tool needs, and whether each resolves. NEVER a value. */
  readonly secrets: readonly { readonly key: string; readonly present: boolean; readonly source: "admin" | "env" | null }[];
  /** A fixed, non-echoing reason. No URL, no provider body, no credential fragment. */
  readonly reason: string | null;
  /** Provider-verification status vocabulary, reused so admin has ONE table for all credentials. */
  readonly lastStatus: AiCredentialStatus | null;
  readonly lastCheckedAt: string | null;
}

export interface ToolProviderDefinition {
  readonly tool: AiTool;
  readonly provider: string;
  readonly label: string;
  /**
   * Pinned origin for every request, or `null` when the origin is operator configuration. Nothing
   * here is ever interpolated from a caller: `endpointBase` + a path from this file, and that is all.
   */
  readonly endpointBase: string | null;
  /** Secret keys required. Read through `AiSecretService`, so admin-managed beats env. */
  readonly requiredSecrets: readonly string[];
  /** Secret keys that change behaviour when present (a token, a region) but are not mandatory. */
  readonly optionalSecrets: readonly string[];
  /** Whether the endpoint config secret itself may point at a private network (operator-hosted). */
  readonly endpointMayBePrivate: boolean;
  readonly runtime: "node" | "any";
  readonly local: boolean;
  /** Public docs URL for the operator: what to provision, where the key is minted. */
  readonly docsUrl: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxResults: number;
  /** Cost tier, mirroring `ProviderDefinition` so admin can rank a fallback order the same way. */
  readonly costTier: 0 | 1 | 2;
}

export const TOOL_PROVIDERS: readonly ToolProviderDefinition[] = [
  {
    tool: "web_search",
    provider: "tavily",
    label: "Tavily Search API",
    endpointBase: "https://api.tavily.com",
    requiredSecrets: ["TAVILY_API_KEY"],
    optionalSecrets: [],
    endpointMayBePrivate: false,
    runtime: "any",
    local: false,
    docsUrl: "https://docs.tavily.com/documentation/api-reference/endpoint/search",
    timeoutMs: 8_000,
    maxResponseBytes: 256 * 1024,
    maxResults: 10,
    costTier: 1,
  },
  {
    tool: "web_search",
    provider: "brave",
    label: "Brave Search API",
    endpointBase: "https://api.search.brave.com",
    requiredSecrets: ["BRAVE_SEARCH_API_KEY"],
    optionalSecrets: ["BRAVE_SEARCH_TIMEOUT_MS"],
    endpointMayBePrivate: false,
    runtime: "any",
    local: false,
    docsUrl: "https://api-dashboard.search.brave.com/documentation",
    timeoutMs: 8_000,
    maxResponseBytes: 256 * 1024,
    maxResults: 20,
    costTier: 1,
  },
  {
    tool: "web_search",
    provider: "serper",
    label: "Serper (Google SERP proxy)",
    endpointBase: "https://google.serper.dev",
    requiredSecrets: ["SERPER_API_KEY"],
    optionalSecrets: [],
    endpointMayBePrivate: false,
    runtime: "any",
    local: false,
    docsUrl: "https://serper.dev",
    timeoutMs: 8_000,
    maxResponseBytes: 256 * 1024,
    maxResults: 20,
    costTier: 1,
  },
  {
    tool: "browser_capture",
    provider: "browserless",
    label: "Browserless (Chrome DevTools service)",
    // `null` on purpose. A headless-Chrome service is a thing an operator runs (or buys), and hardcoding
    // a vendor origin would either make self-hosting impossible or make the vendor mandatory. The
    // origin therefore comes from `BROWSERLESS_URL` through the encrypted secret store and is
    // re-validated at every use — the guard is not skipped just because the value is configuration.
    endpointBase: null,
    requiredSecrets: ["BROWSERLESS_URL", "BROWSERLESS_TOKEN"],
    optionalSecrets: [],
    // A self-hosted browser often IS on the private network. The ENDPOINT may be private; the PAGE it
    // is told to open may not. That distinction is enforced in `aiBrowserService`, not here.
    endpointMayBePrivate: true,
    runtime: "any",
    local: false,
    docsUrl: "https://docs.browserless.io",
    timeoutMs: 25_000,
    // A full-page PNG of a real chart page is megabytes. The cap exists to stop an unbounded body from
    // reaching memory, not to make small captures possible: 12 MiB is above any page worth capturing.
    maxResponseBytes: 12 * 1024 * 1024,
    maxResults: 1,
    costTier: 1,
  },
  {
    tool: "banner_raster",
    provider: "resvg",
    label: "resvg (in-process SVG → PNG)",
    endpointBase: null,
    // No credential at all: it is a native module in this process. `local` is what makes the admin
    // panel able to say "verified — rendered a 1080×564 PNG here" without any key being involved, and
    // it is also why the state can be `unsupported` in a Worker rather than merely `unavailable`.
    requiredSecrets: [],
    optionalSecrets: [],
    endpointMayBePrivate: false,
    runtime: "node",
    local: true,
    docsUrl: "https://github.com/resvg/resvg-js",
    timeoutMs: 5_000,
    maxResponseBytes: 8 * 1024 * 1024,
    maxResults: 1,
    costTier: 0,
  },
];

/**
 * Per-user hourly budgets, in one place, because "the agent may call tools" without a ceiling is just a
 * denial-of-service primitive with a nice UI. Hours are the same fixed window the Telegram rate limiter
 * uses; a step ceiling is what makes a planning loop impossible rather than unlikely.
 *
 * `web_search` and `browser_capture` are ENFORCED numbers: they are the `limit` of the matching
 * `RATE_LIMIT_DEFAULTS` bucket (`telegram:search`, `telegram:capture`), which the bot hits per tool call
 * keyed by Telegram identity, and `aiToolBudgets.test.ts` fails if the two tables ever disagree.
 * `banner_raster` has no bucket of its own because it is not a request: it runs at most once per publish
 * attempt, and attempts are capped by the outbox at `MAX_PUBLISH_ATTEMPTS`.
 */
export const TOOL_BUDGETS: Readonly<Record<AiTool, { readonly perUserPerHour: number; readonly maxQueryChars: number; readonly maxBytes: number }>> = {
  web_search: { perUserPerHour: 30, maxQueryChars: 400, maxBytes: 256 * 1024 },
  browser_capture: { perUserPerHour: 12, maxQueryChars: 2_048, maxBytes: 12 * 1024 * 1024 },
  banner_raster: { perUserPerHour: 60, maxQueryChars: 8 * 1024, maxBytes: 8 * 1024 * 1024 },
};

/**
 * How many tool steps ONE agent request may contain. Beyond this, a plan is a loop with extra steps.
 *
 * This number is READ, not quoted: `AgentLoop` refuses to start a step once `steps >= MAX_AGENT_TOOL_STEPS`
 * (`telegramAgentLoopBudget()` builds it from here), so the catalogue and the enforcement cannot drift.
 */
export const MAX_AGENT_TOOL_STEPS = 6;

/**
 * How many times ONE tool may run inside a single agent request.
 *
 * A per-run cap is a different question from the per-hour one in `TOOL_BUDGETS`: "may the agent search
 * three times while answering THIS sentence" is about whether a run is coherent, while "30 searches an
 * hour" is about a user's budget. Anything not listed here may run ONCE — the safe default, because a
 * tool that is not expected to repeat is not allowed to.
 */
export const AGENT_PER_TOOL_STEP_LIMITS: Readonly<Record<string, number>> = {
  "web.search": 3,
  "chart.capture": 2,
};

/**
 * The wall-clock ceiling for one agent request, measured with the bot's own clock.
 *
 * 45 s is not arbitrary: a browser capture's own provider timeout is 25 s and a search is 8 s, so the
 * window admits one of each plus a planner call, and stops a run that would otherwise hang a webhook
 * worker. The loop checks it BEFORE starting a step, so an overrun stops the spending rather than
 * describing it afterwards.
 */
export const AGENT_RUN_DEADLINE_MS = 45_000;

/** The budget the loop runs under, assembled HERE so no caller can quietly loosen one of the ceilings. */
export function telegramAgentLoopBudget(): {
  readonly maxSteps: number;
  readonly maxModelCalls: number;
  readonly wallClockMs: number;
  readonly perToolLimit: Readonly<Record<string, number>>;
} {
  return {
    maxSteps: MAX_AGENT_TOOL_STEPS,
    // one call per step, plus the one that decides to stop: an unbounded number of questions is how a
    // "bounded" loop keeps spending after its work is done.
    maxModelCalls: MAX_AGENT_TOOL_STEPS + 1,
    wallClockMs: AGENT_RUN_DEADLINE_MS,
    perToolLimit: AGENT_PER_TOOL_STEP_LIMITS,
  };
}

export function isAiTool(value: unknown): value is AiTool {
  return typeof value === "string" && (AI_TOOLS as readonly string[]).includes(value);
}

export function toolProvider(tool: AiTool, provider: string): ToolProviderDefinition | null {
  return TOOL_PROVIDERS.find((p) => p.tool === tool && p.provider === provider) ?? null;
}

/**
 * The provider to use for a tool: an operator override (`<TOOL>_PROVIDER` env or admin setting) wins,
 * then the first declared row, which is the order the admin panel is allowed to reorder. Returning the
 * whole definition rather than a name means a caller cannot ask for a provider that does not exist.
 */
export function defaultToolProvider(tool: AiTool, override: string | null | undefined): ToolProviderDefinition | null {
  const rows = TOOL_PROVIDERS.filter((p) => p.tool === tool);
  if (rows.length === 0) return null;
  const wanted = typeof override === "string" ? override.trim().toLowerCase() : "";
  if (wanted !== "") {
    const found = rows.find((p) => p.provider === wanted);
    // A name that matches no row for this tool is a MISCONFIGURATION, and the answer is "unavailable"
    // — not the first row. Falling through would let `SEARCH_PROVIDER=openai` (a typo, or a copy-paste
    // of a model provider) quietly validate and spend against Tavily while the admin panel reported
    // success for "openai". Refusing is the only answer that keeps a capability statement true.
    if (found === undefined) return null;
    return found;
  }
  return rows[0] ?? null;
}

/** Public origins a CAPTURED page may be pointed at. A deny-by-default list, extended by config. */
export const CAPTURE_HOST_ALLOWLIST_FALLBACK: readonly string[] = [];

/**
 * The chart hosts a capture may target WITHOUT operator configuration.
 *
 * This is not a general "browsing" allowance: it is the short list of chart pages this product's own
 * prompts describe (TradingView, and the app's own share links). A user asking for "my broker's
 * charts" is answered with `unsupported for that host` plus the sentence telling them to attach a
 * screenshot instead — which is honest, whereas silently fetching an authenticated broker page is
 * both a terms violation and an account-exposure risk.
 */
export const TRUSTED_CHART_HOSTS: readonly string[] = ["www.tradingview.com", "tradingview.com"];

export function isTrustedChartHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return TRUSTED_CHART_HOSTS.some((t) => h === t || h.endsWith(`.${t}`));
}
