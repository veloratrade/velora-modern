// The Telegram agent: understand a sentence, pick a tool that exists, run the safe part, ask first.
//
// WHY A REGISTRY AND NOT A PROMPT
//   "Agentic" is not a licence to hand a model a shell. Every capability the bot can perform is
//   declared HERE, once, with its argument schema, its effect class and whether it needs approval.
//   A request that matches no tool is not executed and not narrated as if it were; a tool that the
//   runtime cannot perform is DECLARED UNAVAILABLE rather than attempted. The model, where one is
//   used, is never the thing that decides whether an action is allowed — this table does, and the
//   same ownership checks the slash commands run are re-run per tool call.
//
// THE ROUTING IS DETERMINISTIC ON PURPOSE
//   Persian and English keyword patterns plus a typed argument extractor, no provider call. That is
//   not a shortcut: it means `/help` can honestly promise the routing works in every runtime
//   (including the Worker, which has no AI egress), it costs no tokens, it cannot be prompt-injected
//   into doing something else, and a misread is reproducible in a test. Where a model genuinely
//   adds value — turning a paragraph of prose into journal fields — it is the EXISTING extraction
//   path (`journalApplicationService.openFromText` → the AI Manager), reached through a tool, not
//   re-implemented here.
//
// WHAT HAPPENS TO A REQUEST THE RUNTIME CANNOT SERVE
//   `web.search` and `chart.capture` are declared, and they are BLOCKED: this build has no browser
//   automation and no search provider (verified in §1 of the round's audit — `playwright` appears
//   only in old audit prose, and there is no search client anywhere in `apps`/`packages`). A blocked
//   tool returns a reason naming the missing dependency. It never returns a fabricated result, and
//   the help text does not advertise it. That is the whole difference between "not configured yet"
//   and "the bot lied".

import type { TemplateLocale } from "@velora/domain";

// ─────────────────────────────── tools ───────────────────────────────
export type ToolEffect = "read" | "write" | "external";

export interface ToolArgument {
  readonly name: string;
  readonly type: "string" | "integer" | "enum" | "date";
  readonly required: boolean;
  readonly enum?: readonly string[] | undefined;
  readonly description: Readonly<Record<TemplateLocale, string>>;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: Readonly<Record<TemplateLocale, string>>;
  /** `external` leaves this system (a channel post); `write` changes the user's own records. */
  readonly effect: ToolEffect;
  /** External effects always need an explicit approval of the final content AND destination. */
  readonly requiresApproval: boolean;
  readonly args: readonly ToolArgument[];
  /** A tool this runtime cannot perform. Declared, not hidden — so the answer can say why. */
  readonly available: boolean;
  readonly blockedReason: string | null;
  /**
   * The rate-limit namespace the bot enforces for this tool. Every expensive tool must name its OWN key:
   * sharing `telegram:analyze` between journal analysis and a chart capture meant one user's browsing
   * could spend their analysis budget and vice versa, and it left `TOOL_BUDGETS` enforcing nothing.
   * `telegram:update` is only ever the key for a local, no-cost read.
   */
  readonly limitKey:
    | "telegram:update"
    | "telegram:journal"
    | "telegram:analyze"
    | "telegram:channel"
    | "telegram:agent"
    | "telegram:search"
    | "telegram:capture";
}

const ENUM_WINDOWS = ["today", "yesterday", "week", "all"] as const;

/** The whole table. Adding a capability means adding a row here AND wiring it in the bot. */
export const TOOL_REGISTRY: readonly ToolDefinition[] = [
  {
    name: "stats.read",
    effect: "read",
    requiresApproval: false,
    available: true,
    blockedReason: null,
    limitKey: "telegram:update",
    description: { fa: "خلاصهٔ عملکرد در یک بازه", en: "Performance summary for a window" },
    args: [{ name: "window", type: "enum", required: false, enum: ENUM_WINDOWS, description: { fa: "بازه", en: "Window" } }],
  },
  {
    name: "checklist.read",
    effect: "read",
    requiresApproval: false,
    available: true,
    blockedReason: null,
    limitKey: "telegram:update",
    description: { fa: "چک‌لیست یک روز", en: "One day's checklist" },
    args: [{ name: "date", type: "date", required: false, description: { fa: "تاریخ (جلالی/میلادی)", en: "Date (Jalali or Gregorian)" } }],
  },
  {
    name: "checklist.gaps",
    effect: "read",
    requiresApproval: false,
    available: true,
    blockedReason: null,
    limitKey: "telegram:update",
    description: { fa: "چه چیزی تأیید یا نامشخص مانده", en: "What is confirmed, unknown or left unreviewed" },
    args: [{ name: "days", type: "integer", required: false, description: { fa: "تعداد روز", en: "Number of days" } }],
  },
  {
    name: "journal.draft",
    effect: "write",
    requiresApproval: true,
    available: true,
    blockedReason: null,
    limitKey: "telegram:journal",
    description: { fa: "ساخت پیش‌نویس ژورنال از متن کاربر", en: "Open a journal draft from the user's own text" },
    args: [{ name: "text", type: "string", required: true, description: { fa: "متن", en: "Text" } }],
  },
  {
    name: "template.list",
    effect: "read",
    requiresApproval: false,
    available: true,
    blockedReason: null,
    limitKey: "telegram:update",
    description: { fa: "قالب‌های در دسترس", en: "The templates this user can use" },
    args: [],
  },
  {
    name: "post.prepare",
    effect: "write",
    requiresApproval: false,
    available: true,
    blockedReason: null,
    limitKey: "telegram:update",
    description: { fa: "ساخت پیش‌نویس پست برای کانال (هیچ‌چیز ارسال نمی‌شود)", en: "Render a channel post as a preview (sends nothing)" },
    args: [
      { name: "template", type: "string", required: false, description: { fa: "کلید قالب", en: "Template key or name" } },
      { name: "date", type: "date", required: false, description: { fa: "روز مورد نظر", en: "Day to draw on" } },
    ],
  },
  {
    name: "post.publish",
    effect: "external",
    requiresApproval: true,
    available: true,
    blockedReason: null,
    limitKey: "telegram:channel",
    description: { fa: "انتشار پیش‌نویس تأییدشده در کانال", en: "Publish the approved preview to the channel" },
    args: [{ name: "postId", type: "string", required: true, description: { fa: "شناسهٔ پیش‌نویس", en: "Preview id" } }],
  },
  {
    name: "channel.status",
    effect: "read",
    requiresApproval: false,
    available: true,
    blockedReason: null,
    limitKey: "telegram:update",
    description: { fa: "وضعیت کانال‌های ثبت‌شده", en: "The state of this user's registered channels" },
    args: [],
  },
  {
    name: "channel.select",
    effect: "write",
    requiresApproval: true,
    available: true,
    blockedReason: null,
    limitKey: "telegram:channel",
    description: { fa: "انتخاب کانال فعال از کانال‌های خود کاربر", en: "Choose the active channel among the user's own" },
    args: [{ name: "channelId", type: "string", required: true, description: { fa: "شناسهٔ کانال", en: "Channel id" } }],
  },
  // ── Declared, and blocked. These rows exist so the ANSWER can be specific. ──
  {
    name: "web.search",
    effect: "read",
    requiresApproval: false,
    available: false,
    blockedReason: "NO_WEB_PROVIDER",
    limitKey: "telegram:search",
    description: { fa: "جست‌وجوی وب", en: "Search the web" },
    args: [{ name: "query", type: "string", required: true, description: { fa: " پرسش", en: "Query" } }],
  },
  {
    name: "chart.capture",
    effect: "read",
    requiresApproval: false,
    available: false,
    blockedReason: "NO_BROWSER_AUTOMATION",
    limitKey: "telegram:capture",
    description: { fa: "گرفتن تصویر چارت از یک صفحه", en: "Capture a chart image from a page" },
    args: [
      { name: "url", type: "string", required: true, description: { fa: "نشانی", en: "Address" } },
      { name: "symbol", type: "string", required: false, description: { fa: "نماد برای راستی‌آزمایی", en: "Symbol to verify" } },
    ],
  },
];

/**
 * Which tools this runtime can honour, per deployment.
 *
 * `false` is not a policy judgement, it is a fact about the process: no search key, no browser service.
 * The registry keeps a row for every tool either way, because a row is what lets the bot answer
 * "I cannot take a chart screenshot here, because no browser automation is configured" instead of
 * pretending the sentence was not understood — and because hiding a capability that exists in another
 * runtime is how a product ends up with two vocabularies.
 */
export interface ToolCapabilities {
  readonly webSearch: boolean;
  readonly browserCapture: boolean;
}

/** Nothing configured: the shape every runtime starts from, so a bug cannot widen the surface. */
export const NO_TOOL_CAPABILITIES: ToolCapabilities = { webSearch: false, browserCapture: false };

/** Which registry rows a capability flag decides. A row not listed here is always available. */
const GATED_TOOLS: Readonly<Record<string, keyof ToolCapabilities>> = {
  "web.search": "webSearch",
  "chart.capture": "browserCapture",
};

export function effectiveRegistry(caps: ToolCapabilities): readonly ToolDefinition[] {
  return TOOL_REGISTRY.map((tool) => {
    const gate = GATED_TOOLS[tool.name];
    if (gate === undefined) return tool;
    return caps[gate] ? { ...tool, available: true, blockedReason: null } : tool;
  });
}

export function findToolIn(name: string, caps: ToolCapabilities): ToolDefinition | undefined {
  return effectiveRegistry(caps).find((t) => t.name === name);
}

export function toolNames(): string[] {
  return TOOL_REGISTRY.map((t) => t.name);
}

export function findTool(name: string): ToolDefinition | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}

/** Only what this runtime can actually do — what `/help` and the menu are allowed to advertise. */
export function availableToolNames(caps: ToolCapabilities = NO_TOOL_CAPABILITIES): string[] {
  return effectiveRegistry(caps).filter((t) => t.available).map((t) => t.name);
}

// ─────────────────────────────── planning ───────────────────────────────
export interface Plan {
  readonly tool: string;
  readonly args: Record<string, string>;
  /** What the user said, kept for the draft tools and for the audit trail of the request. */
  readonly utterance: string;
  /**
   * How the plan was recognised. `patterns` is a confident match; `journal-fallback` is the
   * existing "anything else is a journal note" behaviour, kept as a named outcome so the bot's
   * fall-through is visible in a test rather than implicit in control flow.
   */
  readonly matchedBy: "patterns" | "journal-fallback" | "model";
}

export type Rejection =
  | { readonly kind: "unsupported"; readonly tool: string; readonly reason: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[]; readonly question: Readonly<Record<TemplateLocale, string>> };

export interface AgentDecision {
  readonly plan: Plan | null;
  readonly rejection: Rejection | null;
}

/**
 * Argument extraction, shared with the rest of the bot.
 *
 * A symbol is read as a token only when it looks like one (`XAUUSD`, `EURUSD`, `GOLD`, `BTCUSDT`) —
 * because "buy 2650" must not become a symbol, and a wrong symbol is a wrong trade record. Dates are
 * delegated to the shared chat-date contract (`readLeadingChatDate`), which is the ONLY thing in
 * this product allowed to decide what a typed date means; the agent never parses a date itself.
 */
const SYMBOL_RE = /\b([A-Z]{3,6}(?:USD|USDT|USDJPY|EUR|JPY|GBP|AUD|CAD|CHF|NZD)|XAU|XAG|BTC|ETH|SOL)\b/u;
const TIMEFRAME_RE = /\b(M1|M5|M15|M30|H1|H4|D1|W1)\b/u;
const DAYS_RE = /(?:\b(?:last|past)\s+(\d{1,2})\s+days?\b|\b(\d{1,2})\s*(?:روز|روزهای)\b)/u;

/**
 * The routing table. Each row is (tool, pattern, priority).
 *
 * PRIORITY IS THE PART WORTH READING. A sentence can match several rows — "publish it now, the
 * checklist stats look good" mentions stats, the checklist AND publishing — and a first-match rule
 * would answer the noun and ignore the verb, i.e. print a summary while the user waits for a post.
 * The rule is therefore: A VERB THAT CHANGES THE WORLD OUTRANKS A NOUN THAT DESCRIBES ONE. 30 for
 * the explicit actions (publish, select a channel), 25 for preparing one, 20 for "what is missing",
 * 10 for a plain read, 5 for the blocked capabilities (so "search the web" is answered as a refusal
 * about searching, never reinterpreted as stats). Ties go to the earlier row, which makes the table
 * itself the tie-break documentation.
 */
const PATTERNS: readonly { readonly tool: string; readonly re: RegExp; readonly priority: number }[] = [
  {
    tool: "stats.read",
    re: /(آمار|عملکرد|وین.?ریت|پرافیت.?فاکتور|سود|زیان|\bstats?\b|\bperformance\b|win rate|profit factor)/iu,
    priority: 10,
  },
  {
    tool: "checklist.gaps",
    re: /(چه چیزی|کدام|باقی|مانده|بازبینی.?نشده|نامشخص|جای خالی|coverage|what (is|are).*(left|missing|unknown)|which.*(unknown|left)|remaining)/iu,
    priority: 20,
  },
  {
    tool: "checklist.read",
    re: /(چک.?لیست|checklist|daily review|مرور روزانه)/iu,
    priority: 10,
  },
  {
    tool: "template.list",
    re: /(قالب|قالب‌های من|template|templates)/iu,
    priority: 10,
  },
  {
    tool: "post.prepare",
    re: /(پیش.?نویس پست|برای کانال|کارت بایاس|کارت ستاپ|بنر|banner|prepare.*(post|card)|draft a post|make a (bias|setup) card)/iu,
    priority: 25,
  },
  {
    tool: "post.publish",
    re: /(انتشار|منتشر کن|بفرست به کانال|publish( it)?( to the channel)?|post it now)/iu,
    priority: 30,
  },
  {
    tool: "channel.status",
    re: /(کانال من|وضعیت کانال|channel status|which channel|\/channel\b)/iu,
    priority: 10,
  },
  {
    tool: "channel.select",
    re: /(کانال فعال|انتخاب کانال|use (my |the )?channel|set active channel)/iu,
    priority: 30,
  },
  {
    tool: "web.search",
    re: /(جست.?وجو|سرچ|گوگل|google|search (the )?web|look up)/iu,
    priority: 5,
  },
  {
    tool: "chart.capture",
    re: /(اسکرین.?شات (بگیر|چارت)|تصویر چارت|چارت تریدینگ.?ویو|capture.*(chart|screenshot)|(trading\s?view).{0,24}screenshot|screenshot.{0,24}(trading\s?view)|take a (chart |tradingview )?screenshot)/iu,
    priority: 5,
  },
];

export function resolveIntent(
  text: string,
  locale: TemplateLocale = "en",
  caps: ToolCapabilities = NO_TOOL_CAPABILITIES,
): AgentDecision {
  const trimmed = text.trim();
  if (trimmed === "") return { plan: null, rejection: null };

  const matches = PATTERNS.filter(({ re }) => re.test(trimmed));
  if (matches.length === 0) return { plan: null, rejection: null };
  const hits = [...matches].sort((a, b) => b.priority - a.priority);
  for (const { tool } of hits) {
    // The EFFECTIVE table, not the static one: a pattern that names web search is a real plan where a
    // key is configured and an honest refusal where it is not. Reading the static row would refuse both.
    const def = findToolIn(tool, caps);
    if (def === undefined) continue;
    if (!def.available) {
      return { plan: null, rejection: { kind: "unsupported", tool, reason: def.blockedReason ?? "UNAVAILABLE" } };
    }
    const args = extractArgs(tool, trimmed);
    const missing = def.args.filter((a) => a.required && args[a.name] === undefined);
    if (missing.length > 0 && tool !== "journal.draft") {
      return {
        plan: null,
        rejection: {
          kind: "ambiguous",
          candidates: missing.map((m) => m.name),
          question: {
            fa: `برای «${tool}» این لازم است: ${missing.map((m) => m.name).join("، ")}.`,
            en: `${tool} needs: ${missing.map((m) => m.name).join(", ")}.`,
          },
        },
      };
    }
    return { plan: { tool, args, utterance: trimmed, matchedBy: "patterns" }, rejection: null };
  }
  return { plan: null, rejection: null };
}

/**
 * Turn a model plan into an `AgentDecision`, or refuse it.
 *
 * The model proposes; this function decides. A plan is accepted only when (a) the tool is in the
 * EFFECTIVE registry — so a blocked or unknown name dies here, (b) the tool's effect does not need a
 * human's approval, because an approval the user never saw cannot be granted by a model's reading of a
 * sentence, and (c) every argument passes `validateArgs`, which is the same check the pattern router's
 * own output goes through. `matchedBy: "model"` then records where the plan came from, so `/help`'s
 * promise, the logs and the tests can all distinguish a deterministic match from a proposed one.
 */
export function planFromModel(
  proposal: { readonly tool: string; readonly args: Record<string, string> } | { readonly tool: null },
  utterance: string,
  locale: TemplateLocale = "en",
  caps: ToolCapabilities = NO_TOOL_CAPABILITIES,
): AgentDecision {
  if (proposal.tool === null) return { plan: null, rejection: null };
  const def = findToolIn(proposal.tool, caps);
  if (def === undefined) {
    return {
      plan: null,
      rejection: { kind: "unsupported", tool: proposal.tool, reason: "TOOL_NOT_OFFERED" },
    };
  }
  if (!def.available) return { plan: null, rejection: { kind: "unsupported", tool: def.name, reason: def.blockedReason ?? "UNAVAILABLE" } };
  if (def.requiresApproval) {
    // Not "denied because dangerous" — "not decided by a model". The user still gets the deterministic
    // answer, which for a publish request is the preview with its own button.
    return {
      plan: null,
      rejection: {
        kind: "ambiguous",
        candidates: [def.name],
        question: {
          fa: `«${def.name}» را فقط با دکمهٔ تأیید خودتان انجام می‌دهم.`,
          en: `${def.name} needs your own approval, so I will not run it from a sentence.`,
        },
      },
    };
  }
  const checked = validateArgs(def, proposal.args);
  if (!checked.ok) {
    return {
      plan: null,
      rejection: {
        kind: "ambiguous",
        candidates: checked.errors.slice(0, 3),
        question: {
          fa: `برای «${def.name}» این مقدارها کامل نیست: ${checked.errors.join("؛ ")}.`,
          en: `${def.name} is missing or invalid: ${checked.errors.join("; ")}.`,
        },
      },
    };
  }
  const args: Record<string, string> = {};
  for (const [key, value] of Object.entries(checked.args)) args[key] = String(value);
  return { plan: { tool: def.name, args, utterance, matchedBy: "model" }, rejection: null };
}

function extractArgs(tool: string, text: string): Record<string, string> {
  const args: Record<string, string> = {};
  if (tool === "stats.read") {
    const window = /(\bامروز\b|today)/iu.test(text)
      ? "today"
      : /(\bدیروز\b|yesterday)/iu.test(text)
        ? "yesterday"
        : /(\bاین هفته\b|this week|\bweek\b|هفتگی)/iu.test(text)
          ? "week"
          : /(\bهمه\b|all time|\ball\b)/iu.test(text)
            ? "all"
            : null;
    if (window !== null) args["window"] = window;
  }
  if (tool === "checklist.gaps") {
    const m = DAYS_RE.exec(text);
    const days = m?.[1] ?? m?.[2];
    if (days !== undefined) args["days"] = days;
  }
  const symbol = SYMBOL_RE.exec(text);
  if (symbol?.[1] !== undefined && (tool === "post.prepare" || tool === "journal.draft" || tool === "chart.capture")) {
    args["symbol"] = symbol[1];
  }
  const tf = TIMEFRAME_RE.exec(text);
  if (tf?.[1] !== undefined && (tool === "post.prepare" || tool === "journal.draft")) args["timeframe"] = tf[1];
  const template = /(velora\.(bias|setup|weekly))|(قالب\s+([a-z0-9_-]{1,40}))/iu.exec(text);
  if (template !== null && tool === "post.prepare") {
    const key = template[1] ?? (template[4] === undefined ? null : `template:${template[4]}`);
    if (key !== null) args["template"] = key;
  }
  if (tool === "web.search") {
    // The query is what FOLLOWS the trigger phrase, not the whole sentence: "search the web for gold's
    // outlook and tell me if it is bullish" becomes `gold's outlook and tell me if it is bullish`, which
    // is a search string. It is truncated to the tool's own budget downstream, so a 500-word paste cannot
    // become a 500-word query. Nothing is invented when the trigger has nothing after it — the missing
    // argument is then reported, and the user is asked, which is the honest answer.
        // The trigger's own spacing lives INSIDE the optional groups (`web(?: for)?`, not `web (?:for)?`): a
    // literal space outside them makes "search the web: gold" unmatchable, because the pattern then
    // demands a space that the colon took. Caught by a test, not by reading — which is why it is
    // commented rather than merely fixed.
    const wanted = /(?:search(?: the)? web(?: for)?|look up|google|جست.?وجو(?: وب)?|سرچ(?: وب)?|گوگل)[\s:،\-]{0,3}(.{3,240})/iu.exec(text);
    if (wanted !== null && wanted[1] !== undefined) args["query"] = wanted[1].trim().slice(0, 240);
  }
  if (tool === "chart.capture") {
    // Only an explicit address is a destination. A symbol and the words "tradingview" are NOT enough to
    // build a URL, because a URL the product assembled would be a page we guessed at — and the capture
    // guard then has nothing real to check. The address still goes through `assertSafeUrl` and the chart
    // host allowlist at the service; extraction only means the user does not have to repeat themselves.
    const link = /(https?:\/\/[^\s"'<>]{4,300})/iu.exec(text);
    if (link !== null && link[1] !== undefined) args["url"] = link[1].replace(/[.,;:)]+$/u, "");
  }
  const postId = /post-(\d{1,9})/u.exec(text);
  if (postId !== null && tool === "post.publish") args["postId"] = postId[0];
  const channel = /channel[\s:#-]{0,3}(\d{1,12})/iu.exec(text);
  if (channel !== null && channel[1] !== undefined && tool === "channel.select") args["channelId"] = channel[1];
  return args;
}

/**
 * Validate a plan's arguments against the tool's schema BEFORE anything runs.
 *
 * This is the "strict argument schemas" requirement, and it is what stops a plan built from user
 * text (or from a model's JSON) from carrying `days: "999999"`, an enum value that does not exist,
 * or a 40 KB string into a store call. Returns the normalised args, or the reason it refused.
 */
export function validateArgs(
  tool: ToolDefinition,
  args: Readonly<Record<string, string | undefined>>,
): { readonly ok: true; readonly args: Record<string, string | number> } | { readonly ok: false; readonly errors: readonly string[] }  {
  const errors: string[] = [];
  const out: Record<string, string | number> = {};
  for (const spec of tool.args) {
    const raw = args[spec.name];
    if (raw === undefined || raw === "") {
      if (spec.required) errors.push(`${spec.name}: required`);
      continue;
    }
    switch (spec.type) {
      case "integer": {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 366) errors.push(`${spec.name}: expected an integer in 1..366`);
        else out[spec.name] = n;
        break;
      }
      case "enum": {
        if (!(spec.enum ?? []).includes(raw)) errors.push(`${spec.name}: expected one of ${(spec.enum ?? []).join("|")}`);
        else out[spec.name] = raw;
        break;
      }
      case "date": {
        // Only a shape check here: what the date MEANS is the shared chat-date contract's job, and
        // an agent that re-parses dates is an agent that disagrees with `/stats` about a Tuesday.
        if (!/^[\d\u06f0-\u06f9\u0660-\u0669./-]{4,32}$/u.test(raw)) errors.push(`${spec.name}: not a date`);
        else out[spec.name] = raw;
        break;
      }
      case "string":
      default: {
        if (raw.length > 500) errors.push(`${spec.name}: too long`);
        else out[spec.name] = raw;
      }
    }
  }
  // Unknown keys are dropped, not passed through: a tool receives what its row declares, so an
  // invented `userId` or `chatId` in a plan cannot reach a store call.
  return errors.length > 0 ? { ok: false, errors } : { ok: true, args: out };
}

/** The approval prompt a side-effect plan must produce instead of acting. */
export function approvalRequest(tool: ToolDefinition, preview: { readonly summary: string; readonly destination: string | null }): {
  readonly question: string;
  readonly summary: string;
  readonly destination: string | null;
} {
  return {
    // The question names the CONTENT and the DESTINATION, because approval of neither alone is
    // approval of a post. A prior "prepare a banner" never reaches here as consent.
    question: preview.destination === null ? "Approve this for the active channel?" : `Approve this for ${preview.destination}?`,
    summary: preview.summary,
    destination: preview.destination,
  };
}
