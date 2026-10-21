// Telegram bot — update routing and presentation (ADR-018).
//
// WHERE THE BUSINESS RULES LIVE, AND WHERE THEY DO NOT
//   This file decides NOTHING about journaling, linking or authorization. It
//   parses an update, resolves the caller through `TelegramLinkService.resolveUserId`
//   (the ONLY identity→account bridge in the system), calls the application
//   services and renders the result. Every rule it appears to apply — single-use
//   tokens, one live link per account, required fields, decimal validation — is
//   enforced BELOW it, and the tests that prove those rules call the services,
//   not the bot.
//
// WHAT IT DOES OWN
//   1. IDEMPOTENCY. Every update is claimed before dispatch, then
//      `processClaimed` atomically acquires a one-shot start marker in
//      `telegram_updates` before side effects. Replays cannot create a second
//      journal entry, act on a button twice or spend a linking token twice.
//   2. THE ONBOARDING GATE. An unlinked Telegram identity can reach onboarding
//      and nothing else. That is a UX boundary; the security boundary is that no
//      service can be called without a resolved user id.
//   3. PRESENTATION. All text comes from telegramCopy.ts, escaped and clamped.
//
// FAILURE POSTURE. A handler failure is logged as a FIXED CLASSIFICATION and the
// user gets one honest sentence — never a stack, never a provider message, and
// never a claim that something was saved when it was not. A failed reply is
// never allowed to propagate: the action it describes may already have committed.
import {
  buildCallbackData,
  classifyUpdate,
  parseCallbackData,
  type RateLimitKey,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate,
} from "@velora/contracts";
import { JournalDraftError, type JournalApplicationService, type JournalDraftView } from "../journal/journalApplicationService.js";
import { CHECKLIST_ITEMS, CHECKLIST_PROMPT_LINES, readLeadingChatDate, toLatinDigits } from "@velora/domain";
import {
  clamp,
  copyFor,
  esc,
  labelForField,
  renderChecklist,
  renderChecklistPrompt,
  renderDraft,
  renderStats,
  renderTrade,
  type Locale,
  type TelegramCopy,
  type TelegramCopyOptions,
} from "./telegramCopy.js";
import type { JournalAnalysisService } from "../journal/journalAnalysisService.js";
import type { AttachmentService } from "../attachments/attachmentService.js";
import type { AiAttemptStore } from "../aicoach/aiProvider.js";
import { botCanPostIn, TELEGRAM_MAX_DOWNLOAD_BYTES, TelegramApiError, type InlineKeyboardButton, type TelegramBotApi } from "./telegramApi.js";
import type { AuditStore } from "../auth/auditStore.js";
import { interpretImageAndRecord, transcribeAndRecord, type MediaInterpreter } from "../aicoach/mediaInterpreter.js";
import type { RateLimiter } from "../ratelimits/rateLimiter.js";
import type { TelegramChannelRecord, TelegramDraftKind, TelegramStore } from "./telegramStore.js";
import type { TelegramLinkService } from "./telegramLinkService.js";
import { TelegramPostError, type TelegramPostService } from "./telegramPostService.js";
import {
  aiMenu,
  bannerMenu,
  channelMenu,
  helpMenu,
  journalMenu,
  mainMenu,
  postsMenu,
  postResultMenu,
  templatesMenu,
  flowKeyboard,
  TEMPLATES_PER_PAGE,
  type MenuScreen,
} from "./telegramMenus.js";
import type { TelegramPendingFlow, TelegramPostPreferences, TelegramTemplateRecord } from "./telegramStore.js";
import { TEMPLATE_BODY_LIMIT } from "@velora/domain";
import { effectiveRegistry, findTool, findToolIn, NO_TOOL_CAPABILITIES, planFromModel, resolveIntent,
  type ToolDefinition,
  type AgentDecision, type Plan, type ToolCapabilities } from "./telegramAgent.js";
import { AiSearchService, type SearchHit } from "../ai/aiSearchService.js";
import { AiBrowserService, type BrowserCapture } from "../ai/aiBrowserService.js";
import { AiAgentPlanner } from "../ai/aiAgentPlanner.js";
import {
  AgentLoop,
  NO_CONTEXT,
  type AgentContextAdditions,
  type AgentLoopOutcome,
  type AgentStepResult,
  type AgentToolCall,
} from "../ai/aiAgentLoop.js";
import { MAX_AGENT_TOOL_STEPS, telegramAgentLoopBudget } from "../ai/aiToolCatalog.js";
import { BUILT_IN_TEMPLATES, builtinTemplate, inspectTemplate } from "@velora/domain";

/** The way back from a preview to the template list. */
const backToTemplates = (copy: TelegramCopy): InlineKeyboardButton[] => [
  { text: copy.btnBack, callbackData: buildCallbackData("menu", "templates") },
];

export interface TelegramBotDeps {
  readonly api: TelegramBotApi;
  readonly store: TelegramStore;
  readonly links: TelegramLinkService;
  readonly journal: JournalApplicationService;
  readonly analysis: JournalAnalysisService;
  readonly media: { readonly interpreter: MediaInterpreter; readonly attempts: AiAttemptStore };
  /** Absent ⇒ screenshots are recorded as metadata only; the entry still saves. */
  /**
   * The tool services the agent may call. Absent means absent: the registry rows stay `available:
   * false`, `/help` does not mention them, and a request for one is answered with the dependency that
   * is missing rather than with a shrug or a substituted action.
   */
  readonly tools?: {
    readonly search: AiSearchService;
    readonly browser: AiBrowserService;
    /** Text-only planning over `AiManager` feature `assistant`. Optional: patterns work without it. */
    readonly planner?: AiAgentPlanner | undefined;
  } | undefined;
  /**
   * The security audit trail. Optional because the bot works in a deployment that has no audit store
   * wired (a local harness), but a publish IS recorded when one exists: sending to a channel acts on
   * the platform's own authority and reaches people beyond the user, which is the class of action this
   * trail exists for.
   */
  readonly audit?: AuditStore | undefined;
  readonly attachments?: AttachmentService | undefined;
  /** Absent ⇒ no throttling beyond the Bot API's own limits. */
  readonly limiter?: RateLimiter | undefined;
  /** Public web origin for the onboarding link. A thunk: config may be absent. */
  readonly appUrl: () => string | null;
  /**
   * Prepared channel posts, user templates and the agent's tool execution. ABSENT is a supported
   * configuration: a deployment without channel-publishing wiring, where the bot must say so rather
   * than half-do it. Every other capability on this class has to keep working when this is undefined.
   */
  readonly posts?: TelegramPostService | undefined;
  readonly getUserLocale: (userId: string) => Promise<Locale | null>;
  readonly log: (event: Record<string, unknown>) => void;
  readonly now?: () => Date;
}

/**
 * The planner's view of a registry row: name, description, argument schema. Nothing else — an `effect`
 * or `requiresApproval` field in the prompt would be an invitation to argue about it.
 */
function plannerShape(tool: ToolDefinition, lang: "fa" | "en"): {
  readonly name: string;
  readonly description: string;
  readonly args: readonly { readonly name: string; readonly type: string; readonly required: boolean; readonly enum?: readonly string[] | undefined }[];
} {
  return { name: tool.name, description: tool.description[lang], args: tool.args };
}

/**
 * The set of values a later step is allowed to name, seeded with what the USER wrote.
 *
 * Read the source of the list carefully, because it is the whole security property of the loop: only the
 * utterance is mined here, NEVER the plan's own arguments. A model-proposed `url` is not "a value the user
 * gave" — it is the value the model would like to fetch — and adding it to its own allow-list would make
 * the target check tautological. From here on, the only values that can enter a later step are ones a tool
 * actually returned (each step's `context`), plus what the human typed in this chat.
 *
 * Every address in the message is collected, not just the first: "capture https://a and https://b" is a
 * user naming two destinations, and refusing the second because a regex stopped at the first would be the
 * guard inventing a limit nobody asked for.
 */
function contextFromUtterance(utterance: string): AgentContextAdditions {
  const urls: string[] = [];
  for (const match of utterance.matchAll(/https?:\/\/[^\s"'<>]{4,300}/giu)) {
    const value = match[0]?.replace(/[.,;:)]+$/u, "");
    if (value !== undefined && value !== "") urls.push(value);
  }
  // The ids and dates a run may later use start empty on purpose. A post id is created by THIS run's own
  // preview step, and a date a user typed is already handled by the tool that consumes it directly —
  // what the loop needs to be able to forward is a destination, and nothing else.
  return { urls, ids: [], dates: [] };
}

/** A stop reason in the user's language. Codes, never a provider body. */
function stopText(reason: string, detail: string | null, lang: "fa" | "en"): string {
  const which: Record<string, readonly [string, string]> = {
    "max-steps": ["سقف مرحله", "step ceiling"],
    "max-model-calls": ["سقف تماس با مدل", "model-call ceiling"],
    "wall-clock": ["ات زمان", "time limit"],
    "repeat-guard": ["تلاش تکراری برای همان مرحله", "a repeated step"],
    "tool-budget": ["سقف استفاده از یک ابزار در این درخواست", "a per-tool limit in this request"],
    "malformed-plan": ["پاسخ نامعتبر مدل", "an invalid plan from the model"],
    "planner-unavailable": ["مدل در دسترس نبود", "the model was unavailable"],
    "unverified-target": ["مقصد تأییدنشده", "an unverified target"],
    "approval-required": ["نیاز به تأیید شما", "your approval"],
    "no-plan": ["هیچ مرحله‌ای لازم نبود", "no step was needed"],
  };
  const label = which[reason] ?? [reason, reason];
  const text = lang === "fa" ? label[0] : label[1];
  return detail === null ? text : `${text}: ${detail}`;
}


export type UpdateOutcome = "handled" | "ignored" | "rejected" | "failed";

/** Command aliases: `/cmd` and `/cmd@BotName` are the same command. */
const COMMAND_SUFFIX = "(?:@[A-Za-z0-9_]{3,32})?";

/**
 * What one research step produced, before any message exists.
 *
 * A NAMED union rather than an inferred projection, because two callers read it: the single-step command
 * path and the agent loop. Both must interpret "no provider", "throttled", "provider refused", "nothing
 * found" and "here are the hits" identically — otherwise the loop could call a failed step a success,
 * which is the one error an agent must never make.
 */
export type WebSearchStep =
  | { readonly kind: "blocked" }
  | { readonly kind: "limited" }
  | { readonly kind: "error"; readonly code: string; readonly retryAfterSeconds: number | null }
  | { readonly kind: "empty"; readonly provider: string }
  | { readonly kind: "hits"; readonly provider: string; readonly latencyMs: number; readonly hits: readonly SearchHit[] };

/** The capture counterpart: the pixels, and what the vision model could actually read out of them. */
export type ChartCaptureStep =
  | { readonly kind: "blocked" }
  | { readonly kind: "limited" }
  | { readonly kind: "error"; readonly code: string }
  | {
      readonly kind: "captured";
      readonly capture: BrowserCapture;
      readonly readOk: boolean;
      readonly readCode: string | null;
      readonly observed: readonly string[];
      readonly missing: readonly string[];
    };

export class TelegramBot {
  private readonly now: () => Date;
  private readonly mediaAvailable: boolean;

  constructor(private readonly deps: TelegramBotDeps) {
    this.now = deps.now ?? (() => new Date());
    // Read once, from the interpreter the runtime actually built. `UnconfiguredMediaInterpreter` is
    // fixed at construction, and it is the ONLY authority for what the help text may promise: a
    // config var or an env var is not — the Worker can hold GEMINI_API_KEY and still have no path to
    // a provider, which is exactly the case that made this flag necessary.
    this.mediaAvailable = deps.media.interpreter.name !== "unconfigured";
  }

  /** Copy for a locale with this runtime's real capability attached, for the two option-taking keys. */
  private copyFor(locale: Locale | null, options: TelegramCopyOptions) {
    return { copy: copyFor(locale), options };
  }

  /**
   * Claim an update id before any work happens. `false` means another delivery
   * (a Telegram retry, or the other consumer in a misconfigured deployment)
   * already owns it.
   *
   * Public because the webhook path claims FIRST and answers Telegram before the
   * work completes: the claim is what makes that early answer safe, and it must
   * therefore be expressible without running the handler.
   */
  async claim(update: TelegramUpdate): Promise<boolean> {
    const kind = classifyUpdate(update);
    const telegramUserId = update.message?.from?.id ?? update.callback_query?.from.id ?? null;
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? null;
    const claimed = await this.deps.store.claimUpdate({
      updateId: String(update.update_id),
      telegramUserId: telegramUserId === null ? null : String(telegramUserId),
      chatId: chatId === null ? null : String(chatId),
      kind,
      at: this.now(),
    });
    if (!claimed) {
      // Not an error — Telegram is expected to redeliver, and a redelivery that
      // is recognised is exactly what the claim exists for.
      this.deps.log({ level: "info", event: "telegram.update_duplicate", kind });
    }
    return claimed;
  }

  /**
   * Start a CLAIMED update exactly once, dispatch it, and record its outcome.
   *
   * The durable start marker is acquired before any side effect. A worker replay
   * after a crash therefore becomes a no-op; a crash after the marker but before
   * finish leaves an explicitly started, unprocessed row for reconciliation.
   */
  async processClaimed(update: TelegramUpdate): Promise<UpdateOutcome> {
    const kind = classifyUpdate(update);
    const updateId = String(update.update_id);
    const telegramUserId = update.message?.from?.id ?? update.callback_query?.from.id ?? null;
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? null;
    const started = await this.deps.store.beginUpdateProcessing(updateId, this.now());
    if (!started) {
      this.deps.log({ level: "info", event: "telegram.update_processing_duplicate", kind });
      return "ignored";
    }
    let outcome: UpdateOutcome = "handled";
    let errorCode: string | null = null;
    try {
      outcome = await this.dispatch(update, kind, telegramUserId, chatId);
    } catch (err) {
      outcome = "failed";
      errorCode = classifyError(err);
      // Diagnostic detail stays in the log — which carries no message content,
      // no user text and no credential — while the user gets one fixed sentence.
      this.deps.log({ level: "error", event: "telegram.update_failed", code: errorCode });
      if (chatId !== null) await this.safeSend(String(chatId), copyFor(await this.localeOrNull(telegramUserId)).genericError);
    } finally {
      await this.deps.store.finishUpdate(updateId, outcome, errorCode, this.now()).catch(() => undefined);
    }
    return outcome;
  }

  /** Claim and process, awaited. The polling path and every test use this. */
  async handleUpdate(update: TelegramUpdate): Promise<UpdateOutcome> {
    if (!(await this.claim(update))) return "ignored";
    return this.processClaimed(update);
  }

  private async dispatch(update: TelegramUpdate, kind: string, telegramUserId: number | null, chatId: number | null): Promise<UpdateOutcome> {
    // Channel posts, service updates and edits: recognised, allowed to be
    // claimed, and deliberately not acted on. An edit is not a new entry.
    if (telegramUserId === null || chatId === null) return "ignored";
    if (kind !== "message" && kind !== "callback_query") return "ignored";

    const tgId = String(telegramUserId);
    // L3 — the rate-limit hit runs CONCURRENTLY with the identity/locale resolution, and the
    // verdict below is unchanged by it.
    //
    // WHY THIS IS SAFE (each half re-checked against the source, not against a summary):
    //   • disjoint relations, no shared lock — `PgRateLimitStore.hit` is one atomic
    //     `INSERT … ON CONFLICT (bucket) DO UPDATE … RETURNING` on `rate_limits`; the reads are
    //     `telegram_identities` and `users`. Neither is inside a `withTransaction`, so there is no
    //     lock order between them to invert.
    //   • no data dependency — `locale` feeds only the refusal sentence and the handler after the
    //     gate; `allowed()` consumes only its own upsert row (`evaluateRateLimit` is pure).
    //   • the client has room — one postgres.js instance with `max: POOL_MAX = 2`
    //     (`apps/worker-cf/src/pgHyperdrive.ts`), and `Promise.all` over two store reads on that
    //     same pool is already shipped in this class (`sendSettings`: findActiveChannel +
    //     findLiveIdentityByUserId, in one Promise.all).
    //   • the gate is still a gate — BOTH results are awaited before any handler runs, so a
    //     refused user reaches nothing, and `hit()` cannot be skipped by a concurrent failure.
    // WHY `Promise.all` AND NOT `allSettled`/bare-fire: `hit()` is issued before the first await,
    // so its side effect survives whichever promise settles first; and an early rejection from the
    // identity read must not propagate before the write has been handed over.
    //
    // THE ONE BEHAVIOURAL DELTA, AND WHY IT IS THE CONTRACT (reviewed 2026-10-19). If the sender
    // read rejects, the bucket has already been written — sequentially, no increment happened. That
    // is intentional, not an accident of the concurrency:
    //   • the policy is "updates 60/min" bounding work PER IDENTITY (docs/telegram/SECURITY.md §7),
    //     and a failed resolution is work that was spent;
    //   • the bucket must never be reachable only on success, or a caller could keep the budget by
    //     making resolution throw. Counting is unconditional for the same reason `allowed()` already
    //     swallows a limiter-store outage and answers `true` — counting never depends on the outcome;
    //   • nothing could depend on it before: no test, doc or decision record pinned "no increment on
    //     a resolution failure", and the claim/dedupe path is untouched.
    // It also cannot be turned into a retry tax. On the deployed host the webhook is answered 200
    // right after the CLAIM (`apps/worker-cf/src/index.ts`, `acceptDeferred`), so a `dispatch` failure
    // is never redelivered and never counted twice — one delivery, one increment, either way.
    const [locale, permitted] = await Promise.all([
      this.localeOrNull(telegramUserId),
      this.allowed(tgId),
    ]);
    if (!permitted) {
      await this.safeSend(String(chatId), copyFor(locale).rateLimited);
      return "rejected";
    }
    if (update.callback_query !== undefined) return this.handleCallback(update.callback_query, tgId, String(chatId));
    const message = update.message;
    if (message === undefined) return "ignored";
    return this.handleMessage(message, tgId, String(chatId));
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  private async handleMessage(message: TelegramMessage, tgId: string, chatId: string): Promise<UpdateOutcome> {
    const userId = await this.deps.links.resolveUserId(tgId);
    const locale = userId === null ? null : await this.localeFor(tgId);
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const text = (message.text ?? message.caption ?? "").trim();

    // `/start <payload>` is the linking handshake and must work while unlinked.
    const start = new RegExp(`^/start${COMMAND_SUFFIX}(?:\\s+(\\S+))?$`).exec(text);
    if (start !== null) {
      const payload = start[1] ?? null;
      if (payload !== null && payload !== "") return this.completeLink(payload, message, chatId, locale);
      if (userId === null) return this.sendOnboarding(chatId, locale);
      return this.sendMenu(chatId, userId, locale);
    }

    if (matchesCommand(text, "help")) {
      // The help text is built from what this runtime can actually do: `media` asks the interpreter it
      // was constructed with, `posts` asks whether a post service was wired. A capability that is not
      // configured is not advertised, so /help can never become a list of things that fail.
      // Read from the services, so the sentence is a fact about this deployment: an external tool is
      // named only when its credential actually resolves, and a tool that is absent is named as absent
      // rather than left out in silence — a user who was promised "ask me anything" deserves to learn
      // which specific thing this runtime cannot do, before they ask it in anger.
      const caps = await this.toolCapabilities();
      await this.safeSend(
        chatId,
        clamp(`${copy.helpTitle}\n\n${copy.helpBody({
          media: this.mediaAvailable,
          posts: this.deps.posts !== undefined,
          tools: {
            search: caps.webSearch,
            capture: caps.browserCapture,
            planner: this.deps.tools?.planner !== undefined,
            maxSteps: MAX_AGENT_TOOL_STEPS,
          },
        })}`),
      );
      return "handled";
    }

    // Every remaining path needs an account. Onboarding is the ONLY thing an
    // unlinked identity can reach — including for `/link`, which cannot build a
    // token for a Telegram user the platform does not know yet.
    if (userId === null) return this.sendOnboarding(chatId, locale);

    const identity = await this.deps.store.findLiveIdentityByTelegramUserId(tgId);
    // `touch` is observability only (never authorization), and the row just read carries the previous
    // value — so a write inside the last minute makes this one redundant. A burst of messages costs one
    // round trip less, and an activity gauge does not need better than minute accuracy.
    if (identity !== null && !seenRecently(identity.lastSeenAt)) await this.deps.links.touch(identity.id);

    if (matchesCommand(text, "cancel")) {
      // `/cancel` closes an open guided prompt. It is also the escape hatch the prompts themselves
      // name, so a user never has to remember a button path to get out of a question.
      const pending = (await this.deps.store.getPostPreferences(userId)).pendingFlow;
      if (pending === null) {
        await this.safeSend(chatId, copy.tplCanceled);
        return "handled";
      }
      await this.deps.store.setPendingFlow({ userId, flow: null, at: this.now() });
      await this.safeSend(chatId, copy.tplCanceled);
      return "handled";
    }
    if (matchesCommand(text, "unlink")) return this.confirmUnlink(chatId, locale, userId);
    if (matchesCommand(text, "settings")) return this.sendSettings(chatId, userId, locale);
    if (matchesCommand(text, "last")) return this.sendLast(chatId, userId, locale);
    if (matchesCommand(text, "history")) return this.sendHistory(chatId, userId, locale, 1);
    if (matchesCommand(text, "analyze")) return this.sendAnalysis(chatId, userId, tgId, locale);
    // ── journal maintenance commands (0036 round) ──
    // `/checklist` is the only one carrying a payload, and `matchesCommand` tolerates trailing text,
    // so the same command both opens the prompt (bare) and files the report (with a body).
    // `/trade` and `/edit` take an id; an id that is not yours returns the SAME sentence as "does not
    // exist", because ownership must never be observable through wording.
    if (matchesCommand(text, "stats")) return this.sendStats(chatId, userId, locale, statsWindowArg(text));
    if (matchesCommand(text, "checklist")) return this.handleChecklistCommand(text, userId, tgId, chatId, locale);
    if (matchesCommand(text, "trade")) return this.sendTradeDetail(chatId, userId, text, locale);
    if (matchesCommand(text, "edit")) return this.handleEditCommand(chatId, userId, text, locale);
    if (matchesCommand(text, "channel")) return this.handleChannelCommand(text, userId, chatId, locale);
    if (matchesCommand(text, "post")) return this.handlePostCommand(text, userId, chatId, String(message.message_id), locale);
    if (matchesCommand(text, "template")) return this.handleTemplateCommand(text, userId, chatId, locale);
    if (matchesCommand(text, "journal")) {
      await this.safeSend(chatId, copy.journalPrompt({ media: this.mediaAvailable }));
      return "handled";
    }

    if (message.voice !== undefined || message.audio !== undefined) return this.handleVoice(userId, tgId, chatId, message, locale);
    if (message.photo !== undefined && message.photo.length > 0) return this.handlePhoto(userId, tgId, chatId, message, locale);

    if (text === "") {
      await this.safeSend(chatId, message.document !== undefined ? copy.photoUnreadable : copy.journalNoData);
      return "handled";
    }
    if (text.startsWith("/")) return this.sendMenu(chatId, userId, locale);

    // A reply while a field prompt is open is the progressive-enrichment answer.
    // Checked before "is this a new entry", because `2655` is a valid price and a
    // valid (empty) trade description at the same time.
    const open = await this.deps.journal.currentDraft(userId, tgId);
    if (open !== null && open.missingFields.length > 0) return this.applyAnswer(userId, tgId, chatId, open, text, locale);

    // The parser decides, not a keyword list here: if the message carries no journal value at all,
    // it is chat, and the bot answers with the menu instead of an empty draft.
    const preview = await this.deps.journal.previewFromText({ userId, text });

    // ── guided menu flows (round 7): the answer to a question the BOT asked ──
    //
    // ORDER IS THE SAFETY PROPERTY, and it is deliberate in two directions:
    //   • a sentence with JOURNAL VALUE is never consumed by a template prompt — a lost trade is worse
    //     than a lost template body, so the parser wins and the prompt stays armed (the user is told);
    //   • text with no journal value is the answer to the open question, so a user who tapped
    //     "New template" can simply type the name instead of relearning a command.
    // The flow cursor is persisted (0042) and expires; nothing here trusts it for authorization.
    const pendingFlow = (await this.deps.store.getPostPreferences(userId)).pendingFlow;
    if (pendingFlow !== null) {
      if (!preview.hasValue) return this.advanceFlow(pendingFlow, userId, chatId, text, locale);
      const { copy: flowCopy } = this.copyFor(locale, { media: this.mediaAvailable });
      await this.safeSend(chatId, flowCopy.flowJournalWins);
    }

    if (!preview.hasValue && preview.missingFields.length === 5) {
      // ── the agent, and why it sits HERE ──────────────────────────────────
      // AFTER the journal parser has said "this text has nothing to file". Order matters more than
      // the pattern list: a bot that reads "buy XAUUSD 2650, stop 2640" as a command would silently
      // lose a trade, and no amount of clever routing recovers a journal entry the user typed in
      // good faith. So a sentence with journal value is ALWAYS a journal entry, and the agent gets
      // only what would otherwise be a shrug — which it can turn into stats, the checklist, a template
      // or a prepared post. `runAgentPlan` in turn calls only the SAME private handlers the slash
      // commands call, so it can never be a wider door than the command surface, and a misread costs
      // one sentence instead of a wrong write.
      const agent = await this.agentFor(text, userId, locale);
      if (agent !== null) {
        const outcome = await this.runAgentPlan(agent, userId, tgId, chatId, String(message.message_id), locale);
        // "ignored" is the agent saying "I recognised the words but this is not mine to execute" — a
        // bare "publish it" with no post to publish, say. Falling through keeps the honest no-data
        // answer intact rather than pretending nothing was understood.
        if (outcome !== "ignored") return outcome;
      }
      await this.safeSend(chatId, copy.journalNoData);
      return "handled";
    }
    // Budget checked before the draft row exists: a throttled user gets one
    // sentence, and the pending draft (if any) is left exactly as it was.
    if (!(await this.withinJournalBudget(chatId, tgId, locale))) return "rejected";
    return this.openDraft(userId, tgId, chatId, String(message.message_id), text, "TEXT", null, {}, locale);
  }

  // ── Linking ───────────────────────────────────────────────────────────────

  private async completeLink(payload: string, message: TelegramMessage, chatId: string, locale: Locale | null): Promise<UpdateOutcome> {
    const result = await this.deps.links.completeFromPayload({
      payload,
      telegramUserId: String(message.from?.id ?? ""),
      username: message.from?.username ?? null,
      requestId: null,
    });
    if (result.ok) {
      this.deps.log({ level: "info", event: result.alreadyLinked ? "telegram_link_already" : "telegram_link_completed" });
      const resolved = await this.localeFor(String(message.from?.id ?? ""));
      await this.safeSend(chatId, copyFor(resolved).linkSuccess);
      if (result.alreadyLinked) await this.safeSend(chatId, copyFor(resolved).linkAlready);
      await this.sendMenu(chatId, result.userId, resolved);
      return "handled";
    }
    // A refusal is logged by code only — never by payload, and never by the
    // account it may or may not belong to.
    this.deps.log({ level: "warn", event: "telegram_link_failed", code: result.code });
    await this.safeSend(chatId, linkFailureText(copyFor(locale), result.code));
    return "rejected";
  }

  private async sendOnboarding(chatId: string, locale: Locale | null): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const appUrl = this.deps.appUrl();
    if (appUrl === null) {
      await this.safeSend(chatId, copy.onboardingUnavailable);
      return "handled";
    }
    // A URL button, not a callback: the user leaves Telegram for the Velora
    // website, signs in there, and only then is a one-time linking link minted.
    // No credential is ever typed into this chat.
    await this.safeSend(chatId, clamp(`${stripTags(copy.onboardingTitle)}\n\n${copy.onboardingBody}`), {
      inlineKeyboard: [[{ text: copy.btnConnect, url: `${appUrl}/telegram/connect` }]],
    });
    return "handled";
  }

  /**
   * The main menu — six sections, every one of them a real handler.
   *
   * WHAT CHANGED IN ROUND 7, AND WHY. `/start` used to answer with eight commands as buttons and a
   * ninth that appeared only when the post service was wired. That served a user who knew what the
   * bot could do; it did not serve one who did not. The menu is now navigable (journal · posts ·
   * templates · banner · AI · settings · help), each section explains itself in a sentence, and every
   * screen carries "back" and "home" so nothing is a dead end. The slash commands still work — they
   * are the compatibility layer, not the primary path.
   */
  private async sendMenu(chatId: string, userId: string, locale: Locale | null): Promise<UpdateOutcome> {
    void userId;
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const screen = mainMenu(copy, { postsWired: this.postsService() !== null });
    await this.sendScreen(chatId, screen);
    return "handled";
  }

  /** One place that sends a built screen, so every menu is clamped and escaped the same way. */
  private async sendScreen(chatId: string, screen: MenuScreen): Promise<void> {
    await this.safeSend(chatId, clamp(screen.text), { inlineKeyboard: screen.keyboard.map((row) => [...row]) });
  }

  /** The user's persisted post settings, or the documented defaults when they have none. */
  private async preferences(userId: string): Promise<TelegramPostPreferences> {
    return this.deps.store.getPostPreferences(userId);
  }

  private async templatesFor(userId: string): Promise<readonly TelegramTemplateRecord[]> {
    const service = this.postsService();
    if (service === null) return [];
    return this.deps.store.listTemplates(userId);
  }

  /**
   * Whether this runtime can actually produce a PNG.
   *
   * Asked of the SERVICE, which probes the injected renderer once and caches the answer — the banner
   * screen must state the truth of THIS process, not a constant. A deployment that gains a renderer
   * (a Node host, a VPS) starts telling the truth about it with no code change here.
   */
  private async canRasterize(): Promise<boolean> {
    const service = this.postsService();
    if (service === null) return false;
    return service.canRenderBanner();
  }

  /** Route one `menu:<target>` tap to the screen (or the existing handler) it names. */
  private async openMenuTarget(
    target: string,
    userId: string,
    tgId: string,
    chatId: string,
    locale: Locale | null,
  ): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    switch (target) {
      case "home":
        return this.sendMenu(chatId, userId, locale);
      case "journal": {
        const screen = journalMenu(copy);
        await this.sendScreen(chatId, screen);
        return "handled";
      }
      case "posts": {
        const prefs = await this.preferences(userId);
        await this.sendScreen(chatId, postsMenu(copy, {
          postsWired: this.postsService() !== null,
          defaultTemplateName: prefs.defaultTemplateName,
        }));
        return "handled";
      }
      case "templates": {
        const [templates, prefs] = await Promise.all([this.templatesFor(userId), this.preferences(userId)]);
        await this.sendScreen(chatId, templatesMenu(copy, {
          templates,
          preferences: prefs,
          page: 1,
          postsWired: this.postsService() !== null,
        }));
        return "handled";
      }
      case "postresult":
        return this.sendPostResult(userId, chatId, locale);
      case "banner": {
        const prefs = await this.preferences(userId);
        await this.sendScreen(chatId, bannerMenu(copy, { preferences: prefs, canRaster: await this.canRasterize() }));
        return "handled";
      }
      case "ai":
        return this.sendAiStatus(chatId, locale);
      case "help":
        await this.sendScreen(chatId, helpMenu(copy, copy.helpBody({
          media: this.mediaAvailable,
          posts: this.deps.posts !== undefined,
          tools: {
            search: this.deps.tools !== undefined,
            capture: this.deps.tools !== undefined,
            planner: this.deps.tools?.planner !== undefined,
          },
        })));
        return "handled";
      // The journal destinations existed before this menu and keep their handlers unchanged.
      case "last":
        return this.sendLast(chatId, userId, locale);
      case "history":
        return this.sendHistory(chatId, userId, locale, 1);
      case "analyze":
        return this.sendAnalysis(chatId, userId, tgId, locale);
      case "settings":
        return this.sendSettings(chatId, userId, locale);
      case "channel":
        return this.sendChannelScreen(chatId, userId, locale);
      case "stats":
        return this.sendStats(chatId, userId, locale);
      case "checklist":
        await this.safeSend(chatId, renderChecklistPrompt(copy, CHECKLIST_PROMPT_LINES));
        return "handled";
      case "post":
        // Same call the `/post` command makes: the button cannot be a shortcut past the preview.
        return this.handlePostCommand("/post", userId, chatId, `menu`, locale);
      default:
        await this.safeSend(chatId, copy.genericError);
        return "rejected";
    }
  }

  /**
   * The AI-tools screen: what is wired, and the exact NAME of a missing key when something is not.
   *
   * Two rules hold this screen to the product's own standards. (1) `status()` returns secret names and
   * presence only — never a value — so the screen cannot leak one even by accident. (2) A tool that is
   * wired but unconfigured is reported as OFF with its missing key, which is the difference between
   * "this bot cannot do that" and "the operator has not finished setting it up".
   */
  private async sendAiStatus(chatId: string, locale: Locale | null): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const tools: { name: string; state: string; missing: readonly string[]; reason: string | null }[] = [];
    if (this.deps.tools === undefined) {
      tools.push({ name: "web_search", state: "unavailable", missing: [], reason: "NOT_WIRED_IN_THIS_DEPLOYMENT" });
      tools.push({ name: "browser_capture", state: "unavailable", missing: [], reason: "NOT_WIRED_IN_THIS_DEPLOYMENT" });
      tools.push({ name: "planner", state: "unavailable", missing: [], reason: "NOT_WIRED_IN_THIS_DEPLOYMENT" });
    } else {
      const search = await this.deps.tools.search.status();
      const capture = await this.deps.tools.browser.status();
      tools.push({
        name: "web_search",
        state: search.state,
        missing: search.secrets.filter((x) => !x.present).map((x) => x.key),
        reason: search.reason,
      });
      tools.push({
        name: "browser_capture",
        state: capture.state,
        missing: capture.secrets.filter((x) => !x.present).map((x) => x.key),
        reason: capture.reason,
      });
      tools.push({
        name: "planner",
        state: this.deps.tools.planner === undefined ? "unavailable" : "configured",
        missing: [],
        reason: this.deps.tools.planner === undefined ? "NO_PLANNER_WIRED" : null,
      });
    }
    await this.sendScreen(chatId, aiMenu(copy, { tools }));
    return "handled";
  }

  private async confirmUnlink(chatId: string, locale: Locale | null, userId: string): Promise<UpdateOutcome> {
    void userId;
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    await this.safeSend(chatId, copy.unlinkConfirm, {
      inlineKeyboard: [
        [
          { text: copy.btnUnlinkYes, callbackData: buildCallbackData("unlink", "yes") },
          { text: copy.btnUnlinkNo, callbackData: buildCallbackData("unlink", "no") },
        ],
      ],
    });
    return "handled";
  }

  // ── Journal: open, enrich, present ────────────────────────────────────────

  private async openDraft(
    userId: string,
    tgId: string,
    chatId: string,
    messageId: string,
    text: string,
    kind: TelegramDraftKind,
    transcript: string | null,
    media: Record<string, unknown>,
    locale: Locale | null,
  ): Promise<UpdateOutcome> {
    await this.deps.journal.expireStale();
    let view: JournalDraftView;
    try {
      view = await this.deps.journal.openFromText({
      userId,
      telegramUserId: tgId,
      chatId,
      sourceMessageId: messageId,
      text,
      sourceKind: kind,
        transcript,
        media,
      });
    } catch (err) {
      // The service refuses BEFORE creating a row when the message names a day it cannot read, so
      // there is no half-written draft to clean up here — that is why this catch can be this short.
      await this.safeSend(chatId, journalErrorText(err, this.copyFor(locale, { media: this.mediaAvailable }).copy));
      return "handled";
    }
    return this.presentDraft(chatId, view, locale, kind === "TEXT" ? null : copyFor(locale).photoStored);
  }

  /** Send the confirmation card, or ask for the ONE field that is still missing. */
  private async presentDraft(chatId: string, view: JournalDraftView, locale: Locale | null, prefix: string | null): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const body = renderDraft(copy, view, locale ?? "fa");
    const text = prefix === null ? body : `${prefix}\n\n${body}`;
    if (view.complete) {
      // The card shows exactly what will be written, and every value on it came
      // from the user's own message or from a field they typed afterwards.
      await this.safeSend(chatId, text, {
        inlineKeyboard: [
          [
            { text: copy.btnConfirm, callbackData: buildCallbackData("confirm", view.draftId) },
            { text: copy.btnCancel, callbackData: buildCallbackData("cancel", view.draftId) },
          ],
        ],
      });
      return "handled";
    }
    const missing = view.missingFields[0] ?? "";
    await this.safeSend(chatId, clamp(`${text}\n\n❓ ${copy.promptFor[missing as keyof typeof copy.promptFor] ?? copy.journalPrompt({ media: this.mediaAvailable })}`), {
      inlineKeyboard: [[{ text: copy.btnCancel, callbackData: buildCallbackData("cancel", view.draftId) }]],
    });
    return "handled";
  }

  private async applyAnswer(userId: string, tgId: string, chatId: string, open: JournalDraftView, answer: string, locale: Locale | null): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    try {
      const view = await this.deps.journal.answer({ userId, telegramUserId: tgId, draftId: open.draftId, answer });
      return this.presentDraft(chatId, view, locale, null);
    } catch (err) {
      if (err instanceof JournalDraftError) {
        if (err.code === "DRAFT_INCOMPLETE" && err.field !== null) {
          // The value did not parse as the field that was asked for. Say which
          // field and ask again — do not guess a different interpretation.
          await this.safeSend(chatId, `${copy.confirmedRejected(labelForField(copy, err.field, locale ?? "fa"))}\n❓ ${copy.promptFor[err.field as keyof typeof copy.promptFor] ?? copy.journalPrompt({ media: this.mediaAvailable })}`);
          return "handled";
        }
        if (isGone(err.code)) {
          await this.safeSend(chatId, copy.draftExpired);
          return "rejected";
        }
      }
      throw err;
    }
  }

  // ── Callbacks ─────────────────────────────────────────────────────────────

  private async handleCallback(query: TelegramCallbackQuery, tgId: string, chatId: string): Promise<UpdateOutcome> {
    const userId = await this.deps.links.resolveUserId(tgId);
    const locale = userId === null ? null : await this.localeFor(tgId);
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });

    const parsed = parseCallbackData(query.data ?? "");
    if (parsed === null) {
      // A callback this bot never minted. Acknowledge so the client stops
      // spinning, then do nothing: untrusted input is never a command.
      await this.answer(query.id);
      await this.safeSend(chatId, copy.genericError);
      return "rejected";
    }
    const { action, subject } = parsed;
    await this.answer(query.id);

    if (userId === null) {
      // Stale keyboard from before an unlink: the buttons no longer mean anything.
      return this.sendOnboarding(chatId, locale);
    }

    if (action === "menu") {
      // ONE router for every menu destination. The journal ones keep their pre-round-7 handlers
      // verbatim; the new sections are screens. Nothing here can reach a handler the slash commands
      // cannot, and `menu` subjects are a closed set (`MENU_TARGETS`), so a payload cannot name a
      // destination that was never designed.
      if (subject === "journal") {
        // "Journal" as a destination still means "start journaling", not "show a section" — the
        // prompt is what the user tapped for, and the section is one level up under "home".
        await this.safeSend(chatId, copy.journalPrompt({ media: this.mediaAvailable }));
        return "handled";
      }
      return this.openMenuTarget(subject, userId, tgId, chatId, locale);
    }

    // ── templates (round 7) ──
    if (action === "tpl_list") {
      const page = Number.parseInt(subject, 10);
      const [templates, prefs] = await Promise.all([this.templatesFor(userId), this.preferences(userId)]);
      await this.sendScreen(chatId, templatesMenu(copy, {
        templates,
        preferences: prefs,
        page: Number.isFinite(page) ? page : 1,
        postsWired: this.postsService() !== null,
      }));
      return "handled";
    }
    if (action === "tpl_new") return this.beginTemplateFlow(userId, chatId, locale, { kind: "new" });
    if (action === "tpl_edit") return this.beginTemplateFlow(userId, chatId, locale, { kind: "edit", templateId: subject });
    if (action === "tpl_pv") return this.previewTemplate(userId, subject, chatId, locale);
    if (action === "tpl_def") return this.makeDefaultTemplate(userId, subject, chatId, locale);
    if (action === "tpl_del") {
      const template = await this.deps.store.findTemplateById(userId, subject);
      if (template === null) {
        await this.safeSend(chatId, copy.tplNotFound);
        return "handled";
      }
      // A destructive step asks ONCE, and the question carries the confirmation button. Nothing is
      // written by this branch — that is what makes a double-tap on the list harmless.
      await this.safeSend(chatId, copy.tplDeleteAsk(template.name), {
        inlineKeyboard: [[
          { text: copy.btnConfirm, callbackData: buildCallbackData("tpl_delok", subject) },
          { text: copy.btnCancel, callbackData: buildCallbackData("tpl_list", "1") },
        ]],
      });
      return "handled";
    }
    if (action === "tpl_delok") return this.retireTemplate(userId, subject, chatId, locale);

    // ── banner and appearance (round 7) ──
    if (action === "bn_toggle") {
      const prefs = await this.preferences(userId);
      const enabled = subject === "on";
      const result = await this.deps.store.savePostPreferences({ userId, bannerEnabled: enabled });
      const saved = result.status === "saved" ? result.preferences : prefs;
      await this.sendScreen(chatId, bannerMenu(copy, { preferences: saved, canRaster: await this.canRasterize() }));
      return "handled";
    }
    if (action === "bn_title") {
      if (subject === "clear") {
        const result = await this.deps.store.savePostPreferences({ userId, bannerTitle: null });
        const saved = result.status === "saved" ? result.preferences : await this.preferences(userId);
        await this.safeSend(chatId, copy.bnTitleCleared);
        await this.sendScreen(chatId, bannerMenu(copy, { preferences: saved, canRaster: await this.canRasterize() }));
        return "handled";
      }
      // The title itself is text, so it arrives as a message (the flow cursor carries that step).
      await this.deps.store.setPendingFlow({
        userId,
        flow: { kind: "banner_title", name: null, body: null, templateId: null, postId: null, startedAt: this.now() },
        at: this.now(),
      });
      await this.safeSend(chatId, copy.bnAskTitle, { inlineKeyboard: flowKeyboard(copy).map((row) => [...row]) });
      return "handled";
    }

    // ── AI tools (round 7) ──
    if (action === "ai_status") return this.sendAiStatus(chatId, locale);

    // ── post editing (round 7) ──
    if (action === "post_edit") {
      const service = this.postsService();
      if (service === null) {
        await this.safeSend(chatId, copy.postNoService);
        return "handled";
      }
      const post = await service.findPost(userId, subject);
      if (post === null) {
        await this.safeSend(chatId, copy.genericError);
        return "rejected";
      }
      await this.deps.store.setPendingFlow({
        userId,
        flow: { kind: "post_edit_body", name: null, body: null, templateId: null, postId: post.id, startedAt: this.now() },
        at: this.now(),
      });
      await this.safeSend(chatId, clamp(`${copy.postEditAsk}\n\n<i>${esc(post.body.slice(0, 900))}</i>`), {
        inlineKeyboard: flowKeyboard(copy).map((row) => [...row]),
      });
      return "handled";
    }

    // ── guided flow cursor ──
    if (action === "flow_cancel") {
      await this.deps.store.setPendingFlow({ userId, flow: null, at: this.now() });
      await this.safeSend(chatId, copy.tplCanceled);
      const [templates, prefs] = await Promise.all([this.templatesFor(userId), this.preferences(userId)]);
      await this.sendScreen(chatId, templatesMenu(copy, {
        templates,
        preferences: prefs,
        page: 1,
        postsWired: this.postsService() !== null,
      }));
      return "handled";
    }

    if (action === "unlink") {
      if (subject === "no") return this.sendSettings(chatId, userId, locale);
      if (subject === "yes") {
        const result = await this.deps.links.unlink(userId, null);
        const removed = result.revokedTelegramUserId !== null;
        this.deps.log({ level: "info", event: removed ? "telegram_unlinked" : "telegram_unlink_noop" });
        await this.safeSend(chatId, removed ? copy.unlinkDone : copy.unlinkNothing);
        return "handled";
      }
      await this.safeSend(chatId, copy.genericError);
      return "rejected";
    }

    if (action === "history_more") {
      const page = Number.parseInt(subject, 10);
      if (!Number.isFinite(page) || page < 1 || page > 1000) {
        await this.safeSend(chatId, copy.genericError);
        return "rejected";
      }
      return this.sendHistory(chatId, userId, locale, page);
    }
    if (action === "post_pub") return this.publishApprovedPost(query, userId, tgId, chatId, subject, locale);
    if (action === "post_no") {
      // Dismissal is a no-op with a receipt: the preview said nothing would be sent, so this must
      // not become a second way to approve, and it must not silently swallow the tap either.
      await this.safeSend(chatId, copy.postDismissed);
      return "handled";
    }
    if (action === "channel_test") return this.testChannel(chatId, userId, locale);
    if (action === "connect") return this.sendOnboarding(chatId, locale);
    // ── trade detail / tombstone (0036 round) ──
    // Both are read-modify actions, so the version the user was SHOWN travels in the callback: a
    // tombstone at a stale version fails in the ledger and is reported as "look again", never applied
    // blindly. `trade_arm` asks, `trade_delete` acts — a single button would be a confirm in name.
    if (action === "trade") {
      return this.renderTradeCard(chatId, userId, subject, locale);
    }
    if (action === "trade_edit") {
      // `<id>-emotion` opens the picker; `<id>-emotion-<1..5>` APPLIES the value. The card used to
      // carry a button that only printed instructions, which is a button without an action — the
      // free-text fields are reached through /edit, and this handler still explains them.
      const cut = subject.lastIndexOf("-emotion");
      if (cut <= 0) {
        await this.safeSend(chatId, copy.tradeEditHelp(subject));
        return "handled";
      }
      const tradeId = subject.slice(0, cut);
      const choice = subject.slice(cut + "-emotion".length).replace(/^-+/, "");
      if (choice === "") {
        await this.safeSend(chatId, copy.emotionPrompt, {
          inlineKeyboard: [
            [1, 2, 3, 4, 5].map((n) => ({
              text: String(n),
              callbackData: buildCallbackData("trade_edit", `${tradeId}-emotion-${n}`),
            })),
          ],
        });
        return "handled";
      }
      const score = Number.parseInt(choice, 10);
      if (!Number.isInteger(score) || score < 1 || score > 5) {
        await this.safeSend(chatId, copy.genericError);
        return "rejected";
      }
      try {
        const current = await this.deps.journal.tradeDetail(userId, tradeId);
        await this.deps.journal.editTrade(userId, tradeId, { emotionalScore: score, version: current["version"] });
        await this.safeSend(chatId, copy.tradeEditDone);
        return "handled";
      } catch (err) {
        await this.safeSend(chatId, journalErrorText(err, copy));
        return "handled";
      }
    }
    if (action === "trade_arm") {
      const detail = await this.deps.journal.tradeDetail(userId, subject).catch(() => null);
      if (detail === null) {
        await this.safeSend(chatId, copy.tradeNotFound);
        return "handled";
      }
      const version = String(detail["version"] ?? "");
      await this.safeSend(chatId, copy.tradeDeleteAsk, {
        inlineKeyboard: [
          [
            { text: copy.btnTradeDeleteYes, callbackData: buildCallbackData("trade_delete", `${subject}-v${version}`) },
            { text: copy.btnTradeDeleteNo, callbackData: buildCallbackData("menu", "last") },
          ],
        ],
      });
      return "handled";
    }
    if (action === "trade_delete") {
      // `<id>-v<version>`, split on the LAST "-v" because a trade id may itself contain hyphens.
      const cut = subject.lastIndexOf("-v");
      const tradeId = cut > 0 ? subject.slice(0, cut) : subject;
      const version = cut > 0 ? Number.parseInt(subject.slice(cut + 2), 10) : Number.NaN;
      if (!Number.isFinite(version)) {
        await this.safeSend(chatId, copy.genericError);
        return "rejected";
      }
      try {
        await this.deps.journal.deleteTrade(userId, tradeId, version);
        await this.safeSend(chatId, copy.tradeDeleteDone);
        return "handled";
      } catch (err) {
        await this.safeSend(chatId, journalErrorText(err, copy));
        return "handled";
      }
    }
    if (action === "edit") {
      const open = await this.deps.journal.currentDraft(userId, tgId);
      if (open === null) {
        await this.safeSend(chatId, copy.journalPrompt({ media: this.mediaAvailable }));
        return "handled";
      }
      const fields = (open.missingFields.length === 0 ? ["entryPrice", "exitPrice", "volume"] : open.missingFields).map((field) => labelForField(copy, field, locale ?? "fa"));
      await this.safeSend(chatId, copy.editHelp(fields.join("، ")));
      return "handled";
    }
    if (action === "confirm") return this.confirmDraft(userId, tgId, chatId, subject, locale);
    if (action === "cancel") {
      try {
        await this.deps.journal.cancel({ userId, telegramUserId: tgId, draftId: subject });
        await this.safeSend(chatId, copy.cancelDone);
      } catch (err) {
        if (err instanceof JournalDraftError && err.code === "DRAFT_ALREADY_CONFIRMED") {
          await this.safeSend(chatId, copy.confirmAlready);
          return "handled";
        }
        await this.safeSend(chatId, copy.cancelNothing);
      }
      return "handled";
    }
    await this.safeSend(chatId, copy.genericError);
    return "rejected";
  }

  private async confirmDraft(userId: string, tgId: string, chatId: string, draftId: string, locale: Locale | null): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    try {
      const result = await this.deps.journal.confirm({ userId, telegramUserId: tgId, draftId });
      this.deps.log({ level: "info", event: "journal_created", tradeId: result.tradeId });
      await this.safeSend(chatId, copy.confirmSaved(result.tradeId), {
        inlineKeyboard: [[{ text: copy.btnLastTrade, callbackData: buildCallbackData("menu", "last") }, { text: copy.btnHistory, callbackData: buildCallbackData("menu", "history") }]],
      });
      // Screenshot storage and the channel mirror are POST-write concerns.
      // Neither can invalidate the entry that already exists in the ledger.
      await this.attachPendingMedia(userId, chatId, draftId, result.tradeId, locale);
      await this.publishToChannel(userId, result.trade, chatId, locale);
      return "handled";
    } catch (err) {
      if (err instanceof JournalDraftError) {
        if (err.code === "DRAFT_ALREADY_CONFIRMED") {
          await this.safeSend(chatId, copy.confirmAlready);
          return "handled";
        }
        if (err.code === "DRAFT_CONFIRMATION_IN_PROGRESS") {
          await this.safeSend(chatId, copy.confirmInProgress);
          return "handled";
        }
        if (isGone(err.code)) {
          await this.safeSend(chatId, copy.draftExpired);
          return "rejected";
        }
        if (err.code === "INVALID_JOURNAL_ENTRY" || err.code === "DRAFT_INCOMPLETE") {
          // The domain refused the write. The draft is re-opened so the user can
          // fix the named field; nothing was created.
          const field = err.field === null ? "" : labelForField(copy, err.field, locale ?? "fa");
          await this.safeSend(chatId, field === "" ? copy.confirmSaveFailed : copy.confirmedRejected(field));
          const open = await this.deps.journal.currentDraft(userId, tgId);
          if (open !== null) await this.presentDraft(chatId, open, locale, null);
          return "handled";
        }
      }
      throw err;
    }
  }

  // ── Voice and images ──────────────────────────────────────────────────────

  private async handleVoice(userId: string, tgId: string, chatId: string, message: TelegramMessage, locale: Locale | null): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const voice = message.voice ?? message.audio;
    if (voice === undefined) return this.sendMenu(chatId, userId, locale);
    // BEFORE the download and before the provider call: a voice note costs both,
    // and a throttled user must not be able to spend them.
    if (!(await this.withinJournalBudget(chatId, tgId, locale))) return "rejected";
    await this.safeSend(chatId, copy.voiceWorking);

    const bytes = await this.fetchBytes(voice.file_id);
    if (!bytes.ok) {
      await this.safeSend(chatId, bytes.code === "TOO_LARGE" || bytes.code === "FILE_TOO_LARGE" ? copy.voiceTooLarge : copy.voiceUnavailable);
      return "handled";
    }

    const transcription = await transcribeAndRecord(
      { interpreter: this.deps.media.interpreter, attempts: this.deps.media.attempts },
      { userId, feature: "transcribe", audio: bytes.bytes, mimeType: voice.mime_type ?? "audio/ogg", languageHint: locale === "en" ? "en-US" : "fa-IR" },
    );
    if (!transcription.ok) {
      this.deps.log({ level: "warn", event: "telegram_transcription_failed", code: transcription.code });
      // A missing key and an unreadable note are different problems; both are
      // reported honestly, and neither blocks the text path.
      await this.safeSend(chatId, transcription.code === "PROVIDER_NOT_CONFIGURED" ? copy.voiceUnavailable : copy.voiceEmpty);
      return "handled";
    }
    const text = transcription.text.trim();
    if (text === "") {
      await this.safeSend(chatId, copy.voiceEmpty);
      return "handled";
    }
    // The transcript is stored WITH the draft, so the user can see on the
    // confirmation card what was heard before anything is written.
    return this.openDraft(userId, tgId, chatId, String(message.message_id), text, "VOICE", text, {
      fileId: voice.file_id,
      durationSeconds: voice.duration ?? null,
      sizeBytes: bytes.bytes.length,
    }, locale);
  }

  private async handlePhoto(userId: string, tgId: string, chatId: string, message: TelegramMessage, locale: Locale | null): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const photos = message.photo ?? [];
    // Telegram sends several renditions; the largest is the most readable and is
    // the one a chart screenshot needs.
    const largest = photos.reduce((best: NonNullable<typeof message.photo>[number], candidate: NonNullable<typeof message.photo>[number]) => ((candidate.file_size ?? 0) >= (best.file_size ?? 0) ? candidate : best), photos[0]!);
    // BEFORE the download and the vision call: same reasoning as voice.
    if (!(await this.withinJournalBudget(chatId, tgId, locale))) return "rejected";

    const bytes = await this.fetchBytes(largest.file_id);
    if (!bytes.ok) {
      await this.safeSend(chatId, bytes.code === "TOO_LARGE" || bytes.code === "FILE_TOO_LARGE" ? copy.photoTooLarge : copy.photoUnreadable);
      return "handled";
    }

    const interpretation = await interpretImageAndRecord(
      { interpreter: this.deps.media.interpreter, attempts: this.deps.media.attempts },
      { userId, image: bytes.bytes, mimeType: "image/jpeg" },
    );

    const caption = (message.caption ?? "").trim();
    let notice: string;
    let sourceText = caption;
    let visionUsed = false;
    if (interpretation.ok) {
      const read = interpretation.fields;
      const parts: string[] = [];
      if (read.symbol !== null) parts.push(`symbol ${read.symbol}`);
      if (read.direction !== null) parts.push(`direction ${read.direction}`);
      if (read.entryPrice !== null) parts.push(`entry ${read.entryPrice}`);
      if (read.stopLoss !== null) parts.push(`stop ${read.stopLoss}`);
      if (read.takeProfit !== null) parts.push(`target ${read.takeProfit}`);
      visionUsed = parts.length > 0;
      notice = visionUsed ? `${copy.photoStored} (${esc(parts.join(", "))})` : copy.photoNoFields;
      // Vision values are a FALLBACK appended to the caption, never a
      // replacement for it, and they only ever reach the ledger after the user
      // confirms the merged card. A model cannot write a financial record.
      sourceText = sourceText === "" ? parts.join(" ") : `${sourceText}\n${parts.join(" ")}`;
    } else {
      notice = interpretation.code === "PROVIDER_NOT_CONFIGURED" ? copy.photoSignOnly : copy.photoUnreadable;
    }

    const media = { fileId: largest.file_id, mime: "image/jpeg", sizeBytes: bytes.bytes.length, vision: visionUsed };
    if (sourceText === "") {
      await this.safeSend(chatId, notice);
      return "handled";
    }
    return this.openDraft(userId, tgId, chatId, String(message.message_id), sourceText, "PHOTO", null, media, locale);
  }

  /** Fetch bytes by `file_id`. Bounded by the API layer's own size cap. */
  private async fetchBytes(fileId: string): Promise<{ ok: true; bytes: Buffer } | { ok: false; code: string }> {
    try {
      const file = await this.deps.api.getFile(fileId);
      // BOUNDED TWICE, IN THIS ORDER. `getFile` reports the size Telegram believes
      // the file has; refusing on that claim FIRST means an oversized voice note or
      // screenshot costs no bandwidth and no memory. The API layer then re-checks
      // the bytes actually received, because the declared size is a claim rather
      // than a guarantee — and it refuses rather than truncating, since a truncated
      // screenshot would be stored as a silently corrupt attachment.
      if (file.fileSizeBytes !== null && file.fileSizeBytes > TELEGRAM_MAX_DOWNLOAD_BYTES) {
        return { ok: false, code: "FILE_TOO_LARGE" };
      }
      if (file.filePath === null) return { ok: false, code: "FILE_NOT_FOUND" };
      return { ok: true, bytes: await this.deps.api.downloadFile(file.filePath) };
    } catch (err) {
      return { ok: false, code: classifyError(err) };
    }
  }

  /**
   * Attach the pending screenshot to the trade that was just created.
   *
   * FAILURE HERE IS NOT A FAILED JOURNAL: the entry exists in the ledger, and a
   * screenshot that could not be stored is reported and nothing more. Bytes are
   * re-fetched by `file_id` rather than kept in a database column, so a draft row
   * never holds an image.
   */
  private async attachPendingMedia(userId: string, chatId: string, draftId: string, tradeId: string, locale: Locale | null): Promise<void> {
    const attachments = this.deps.attachments;
    if (attachments === undefined) return;
    const draft = await this.deps.store.findDraftById(draftId);
    const fileId = draft?.media["fileId"];
    if (typeof fileId !== "string" || fileId === "") return;
    try {
      const file = await this.deps.api.getFile(fileId);
      if (file.filePath === null) return;
      const bytes = await this.deps.api.downloadFile(file.filePath);
      await attachments.upload({
        tradeId,
        userId,
        fileName: `telegram-${draft?.sourceMessageId ?? draftId}.jpg`,
        mime: "image/jpeg",
        category: "BEFORE",
        bytes,
      });
      this.deps.log({ level: "info", event: "telegram_attachment_stored", tradeId });
    } catch (err) {
      const code = classifyError(err);
      this.deps.log({ level: "warn", event: "telegram_attachment_failed", code });
      await this.safeSend(chatId, copyFor(locale).photoNoFields);
    }
  }

  // ── Channel mirror ────────────────────────────────────────────────────────

  private async publishToChannel(userId: string, trade: Record<string, unknown>, chatId: string, locale: Locale | null): Promise<void> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const channel = await this.deps.store.findActiveChannel(userId);
    if (channel === null) return;
    const tradeId = String(trade["id"] ?? "");
    if (tradeId === "") return;
    // The claim is the idempotency gate: a repeated confirmation of the same
    // trade cannot produce a second post (UNIQUE (channel_id, trade_id)).
    const claim = await this.deps.store.claimChannelPost({ channelId: channel.id, userId, tradeId, at: this.now() });
    if (!claim.claimed || claim.postId === null) return;
    try {
      const sent = await this.deps.api.sendMessage(channel.chatId, clamp(`${copy.historyTitle}\n\n${renderTrade(copy, trade)}`), { disableNotification: true });
      await this.deps.store.finishChannelPost(claim.postId, "PUBLISHED", sent.messageId, null, this.now());
    } catch (err) {
      const code = classifyError(err);
      await this.deps.store.finishChannelPost(claim.postId, "FAILED", null, code, this.now());
      this.deps.log({ level: "warn", event: "telegram_channel_publish_failed", code });
      await this.safeSend(chatId, copy.channelPublishFailed);
    }
  }

  // ── Channel setup ─────────────────────────────────────────────────────────

  // ── prepared channel posts, templates, and the agent ──────────────────
  //
  // THREE RULES RUN THROUGH THIS WHOLE BLOCK, and they are the reason it looks repetitive:
  //
  // 1. ONE IMPLEMENTATION PER ACTION. `/post`, the `post_pub` button and the agent's `post.publish`
  //    all land on the same private method. A capability that exists twice is a capability whose
  //    authorization, rate limit and idempotency exist twice — and drift between two copies is
  //    exactly how a "convenient" second path ends up skipping the check the first one has.
  // 2. THE DESTINATION IS NEVER INPUT. A chat id may arrive from a user's sentence or a button, but
  //    it is only ever a CANDIDATE that the store and Telegram must both confirm; the post row's own
  //    `channelId` is what a send uses.
  // 3. A PREVIEW IS NOT CONSENT. Everything up to the button is drafting; the send happens only in
  //    the callback, against a content hash the user was actually shown.
  private postsService(): TelegramPostService | null {
    return this.deps.posts ?? null;
  }

  /**
   * `/post [template] [date]` — build a preview, offer the buttons, send nothing.
   *
   * `actionKey` is what makes a re-delivered update reuse the SAME post row instead of drafting a
   * second copy of the same day's card: a command passes the Telegram message id, and the menu button
   * passes its callback-query id. Both are Telegram-side ids for one user action, which is the only
   * thing stable enough to dedupe on — a timestamp would not be, and a random uuid never is.
   */
  private async handlePostCommand(
    text: string,
    userId: string,
    chatId: string,
    actionKey: string,
    locale: Locale | null,
  ): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const service = this.postsService();
    if (service === null) {
      // Not configured is a state, not an error: the menu advertised this because a command exists,
      // so the answer names what is missing instead of pretending the user typed it wrong.
      await this.safeSend(chatId, copy.postNoService);
      return "handled";
    }
    const body = text.replace(/^\/post(?:@[A-Za-z0-9_]+)?\s*/, "").trim();
    // Tokens, in order, with a fixed meaning for each shape — a template key, a saved template NAME,
    // or a day. Anything else is refused rather than guessed, because a silently dropped argument in
    // a publishing command is how the wrong day's data ends up in front of an audience.
    let templateId: string | undefined;
    let templateName: string | undefined;
    let reportDate: string | undefined;
    for (const word of body.split(/\s+/u).filter((w) => w !== "")) {
      // `builtinTemplate` returns NULL (not undefined) for an unknown key, so the test has to be
      // against null: written the other way, EVERY non-built-in word was taken for a built-in id and
      // a saved template could never be named.
      if (builtinTemplate(word) !== null) {
        templateId = word;
        continue;
      }
      const lead = readLeadingChatDate(word);
      const parsed = lead.consumed === "" ? null : this.deps.journal.parseReportDateArg(lead.consumed);
      if (parsed !== null && parsed.kind === "ok") {
        reportDate = parsed.iso;
        continue;
      }
      if (parsed !== null) {
        // A date that EXISTS IN NEITHER CALENDAR never becomes "today" in a publish path.
        await this.safeSend(chatId, copy.checklistBadDate);
        return "rejected";
      }
      if (/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(word)) {
        templateName = word;
        continue;
      }
      await this.safeSend(chatId, `${copy.postUsage}\n${copy.templateListTitle}: ${BUILT_IN_TEMPLATES.map((t) => t.id).join(", ")}`);
      return "rejected";
    }
    // No template named ⇒ the daily bias card. A default belongs HERE, in the surface the user
    // addresses, and not inside the service: `preview` must keep refusing an unresolvable template,
    // because a caller that sends a name and silently gets a different card is worse than one that
    // gets a refusal. But `/post` with no argument is not a typo — it is the shortcut this command
    // exists to be, and the bias card is what "a post about today" means in this product.
    if (templateId === undefined && templateName === undefined) templateId = "velora.bias";

    let out: Awaited<ReturnType<TelegramPostService["preview"]>>;
    try {
      out = await service.preview({
      userId,
      templateId,
      templateName,
      reportDate,
      dedupeKey: `msg:${actionKey}`,
      locale: locale === "fa" ? "fa" : "en",
      });
    } catch (err) {
      // An unknown template name is the user's typo, not a fault: name it and hand back the list.
      // Anything else from the service is a real defect and must not be swallowed into a friendly
      // sentence, so it propagates and the update is recorded as failed.
      if (err instanceof TelegramPostError && err.code === "TEMPLATE_NOT_FOUND") {
        await this.safeSend(chatId, copy.templateNotFound);
        return "rejected";
      }
      throw err;
    }
    if (out.status === "needs-channel") {
      await this.safeSend(chatId, out.reason === "NO_CHANNEL" ? copy.postNoChannel : copy.postChannelNotOurs);
      return "rejected";
    }
    const post = out.post;
    if (post === null) {
      await this.safeSend(chatId, copy.genericError);
      return "failed";
    }
    // The preview shows the FINAL TEXT — the same bytes the button will publish — the destination it
    // is bound to, and a gap line for everything that was never recorded. Anything the template could
    // not resolve is visible here, because "approve this" is only meaningful once the user can see
    // what "this" is.
    const lines: string[] = [`${copy.postPreviewTitle} — ${post.chatId}`];
    if (out.reused) lines.push(copy.postReused);
    if (out.gaps.length > 0) lines.push(copy.postGaps(out.gaps.length));
    if (out.unknownPlaceholders.length > 0) lines.push(copy.postUnknownFields(out.unknownPlaceholders));
    if (out.unsupportedPlaceholders.length > 0) lines.push(copy.postUnsupportedExpr);
    if (out.truncated) lines.push(copy.postTruncated);
    if (out.markupDropped) lines.push(copy.postMarkupDropped);
    if (out.blockedReason !== null || out.incompleteData) {
      if (out.blockedReason !== null) lines.push(copy.postBlocked(out.blockedReason));
      // A blocked preview is a dead end unless the answer comes with the way out. Two causes exist and
      // each has exactly one fix: unrecorded fields are filed with the checklist, and an unverified
      // channel is bound with `/channel <id>` (the screen explains what Telegram must answer).
      lines.push(copy.postBlockedFix(out.incompleteData ? Math.max(out.gaps.length, 1) : 0));
    }
    // "Edit" sits with the publish button because it edits THAT preview: a second tap path to the same
    // text, where the edit revokes the approval the publish button would have taken.
    // A publish button appears ONLY when the destination is writable AND the card has no unrecorded
    // checklist field: the two facts are separate, so both are required.
    const publishable = out.blockedReason === null && !out.incompleteData;
    const keyboard: InlineKeyboardButton[][] =
      publishable
        ? [[{ text: copy.btnPublish, callbackData: buildCallbackData("post_pub", post.id) },
            { text: copy.btnPostEdit, callbackData: buildCallbackData("post_edit", post.id) },
            { text: copy.btnDismiss, callbackData: buildCallbackData("post_no", post.id) }]]
        : [
            // The fix buttons. Neither publishes anything: the checklist one opens the entry prompt and
            // the channel one is a read-only screen. BOTH are offered when both causes apply, because a
            // user looking at "blocked" should not have to fix one thing to be told about the next.
            [
              ...(out.gaps.length > 0 ? [{ text: copy.btnChecklist, callbackData: buildCallbackData("menu", "checklist") }] : []),
              { text: copy.btnManageChannel, callbackData: buildCallbackData("menu", "channel") },
            ],
            [{ text: copy.btnPostResult, callbackData: buildCallbackData("menu", "postresult") },
             { text: copy.btnHome, callbackData: buildCallbackData("menu", "home") }],
          ];
    // `safeSend` sends HTML by default, so the rendered markup needs no flag — and the buttons are
    // attached ONLY when nothing blocks the send: offering "Publish" for a destination Telegram would
    // refuse is a button that lies.
    await this.safeSend(chatId, clamp(`${lines.join("\n")}\n\n${out.text}`), {
      inlineKeyboard: keyboard.length > 0 ? keyboard : undefined,
    });
    // The banner is the post's artwork, so it goes through the SAME delivery path the publish uses
    // (`sendPhoto` with a file id) — and a preview that cannot carry it says so in text instead of
    // quietly sending a caption. SVG is stored on the row as the source either way.
    if (out.banner !== null && post.imageFileId === null) {
      await this.safeSend(chatId, clamp(copy.postBannerPreview(out.banner.rowsShown, out.banner.rowsDropped)));
      // The preview is the moment the user decides, so the image is shown HERE rather than only in the
      // channel: approve-what-you-can-see. A runtime with no rasterizer returns null and says so — the
      // preview degrades to the text card it always had, and the approval stays bound to those bytes.
      const png = await service.previewPng({ userId, postId: post.id });
      if (png === null) {
        await this.safeSend(chatId, copy.postBannerNotRendered);
      } else {
        await this.safeSendPhoto(chatId, png, copy.postBannerImage);
      }
    }
    return "handled";
  }

  /**
   * The publish-result screen.
   *
   * Reads the same outbox rows the publish path writes. Two honesty rules live here: a bound-but-
   * unpublished post is shown as a DRAFT (not as "sent"), and when publishing is impossible the screen
   * names the reason from the user's own binding state rather than implying the click failed.
   */
  private async sendPostResult(userId: string, chatId: string, locale: Locale | null): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const service = this.postsService();
    if (service === null) {
      await this.safeSend(chatId, copy.postNoService);
      return "handled";
    }
    const posts = await this.deps.store.listRecentPosts(userId, 5);
    // The blocking reason comes from the same lookup the publish path uses (the user's ACTIVE channel),
    // so this screen cannot promise a send that `publish` would refuse.
    const channel = await this.deps.store.findActiveChannel(userId);
    const blockedReason =
      channel === null
        ? copy.postNoChannel
        : channel.status !== "ACTIVE"
          ? copy.postChannelNotOurs
          : null;
    await this.sendScreen(chatId, postResultMenu(copy, { posts, blockedReason }));
    return "handled";
  }

  /** The button press that both approves and publishes, bound to the content the user was shown. */
  private async publishApprovedPost(
    query: TelegramCallbackQuery,
    userId: string,
    tgId: string,
    chatId: string,
    postId: string,
    locale: Locale | null,
  ): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const service = this.postsService();
    if (service === null) {
      await this.safeSend(chatId, copy.postNoService);
      return "handled";
    }
    // The tapping identity must be the owning identity: the button carries a post id, and a post id
    // alone must never be enough. `publish` re-checks ownership on the row, but the rate-limit bucket
    // and the log line below are keyed by the CALLER, so the caller has to be the owner here too.
    const post = await service.findPost(userId, postId);
    if (post === null) {
      await this.safeSend(chatId, copy.genericError);
      return "rejected";
    }
    // Throttle the SEND path in the channel namespace the binding already uses (10/hour): publishing
    // and re-binding share one blast radius — the user's own audience — so they share one budget
    // rather than doubling what a single user can push at a channel per hour.
    if (!(await this.allowed(tgId, "telegram:channel"))) return "rejected";
    // Two writes the user tapped as one: approval (binds the content hash) then publish. Approval
    // happens HERE, at the moment of the tap, and not when the preview was rendered — a preview the
    // user walked away from is not consent to a post that may have been edited since.
    await service.approve({ userId, postId });
    const outcome = await service.publish({ userId, postId });
    this.deps.log({ level: "info", event: "telegram_post_outcome", outcome: outcome.status });
    switch (outcome.status) {
      case "published":
        await this.safeSend(chatId, copy.postPublished(outcome.messageId));
        // The audit row is appended AFTER the send and AFTER the outbox transition, which is the only
        // order that can be honest: a record of a post that never went out would be worse than none.
        // Its failure is deliberately NOT swallowed — `AuditStore.append` propagates so a caller cannot
        // claim a trail exists when it does not, and a webhook retry of the error lands on
        // `already-published`, so nothing is sent twice by the retry itself.
        await this.deps.audit?.append({
          action: "TELEGRAM_POST_PUBLISHED",
          actorUserId: userId,
          targetUserId: userId,
          beforeState: `post:${postId} status:APPROVED`,
          afterState: `post:${postId} message:${outcome.messageId} visual:${outcome.visual}`,
          // The bot has no HTTP request to correlate with, so the callback-query id fills `requestId`:
          // it is the handle a Telegram-side investigation starts from (it is what appears in Bot API
          // logs for this exact interaction), and putting it in an existing column beats inventing one.
          requestId: query.id,
          occurredAt: this.now(),
          provider: "TELEGRAM",
        });
        // Which of the two shapes actually reached the channel, stated plainly. A user who asked for
        // the styled card and got text has to hear it from the bot, not find out by opening the channel.
        if (outcome.visual === "text" && post.bannerSvg !== null) await this.safeSend(chatId, copy.postBannerNotRendered);
        return "handled";
      case "already-published":
        await this.safeSend(chatId, copy.postAlreadyPublished);
        return "handled";
      case "in-flight":
        await this.safeSend(chatId, copy.postInFlight);
        return "handled";
      case "not-approved":
        await this.safeSend(chatId, copy.postNotApproved);
        return "rejected";
      case "unavailable":
        // The reasons are the ones the service can actually prove, and each needs a different next step
        // from the user — so the code is shown verbatim rather than smoothed into prose, and the two
        // fixable ones arrive with the button that fixes them.
        await this.safeSend(chatId, copy.postBlocked(outcome.reason), {
          inlineKeyboard:
            outcome.reason === "INCOMPLETE_DATA"
              ? [[{ text: copy.btnChecklist, callbackData: buildCallbackData("menu", "checklist") }],
                 [{ text: copy.btnHome, callbackData: buildCallbackData("menu", "home") }]]
              : outcome.reason === "CHANNEL_UNVERIFIED" || outcome.reason === "NO_CHANNEL"
                ? [[{ text: copy.btnManageChannel, callbackData: buildCallbackData("menu", "channel") }],
                   [{ text: copy.btnHome, callbackData: buildCallbackData("menu", "home") }]]
                : undefined,
        });
        return "rejected";
      case "not-claimable":
        // A row already claimed by another attempt is NOT retried here: `attempts` has moved, and a
        // second send of a post that may already be out is the one failure mode this design refuses.
        await this.safeSend(chatId, copy.postInFlight);
        return "handled";
      case "failed":
        await this.safeSend(chatId, copy.postFailed(outcome.code, outcome.retryAfterSeconds));
        return "rejected";
      case "not-found":
        await this.safeSend(chatId, copy.genericError);
        return "rejected";
    }
  }

  // ── Guided template and banner flows (round 7) ───────────────────────────
  //
  // WHY THE CURSOR IS PERSISTED AND NOT A MAP ON THE INSTANCE. The bot object is per-process and, on
  // Cloudflare, per-invocation: an in-memory pending step would be lost between the question and the
  // answer, and lost again on every deploy. `telegram_post_preferences` (0042) holds one cursor per
  // user, with the store-written start time that makes it expire — a prompt abandoned last week must
  // not capture the next sentence.

  /** How long an open prompt stays armed. */
  private static readonly FLOW_TTL_MS = 15 * 60 * 1000;

  private async beginTemplateFlow(
    userId: string,
    chatId: string,
    locale: Locale | null,
    mode: { readonly kind: "new" } | { readonly kind: "edit"; readonly templateId: string },
  ): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    if (this.postsService() === null) {
      await this.safeSend(chatId, copy.postNoService);
      return "handled";
    }
    if (mode.kind === "new") {
      await this.deps.store.setPendingFlow({
        userId,
        flow: { kind: "tpl_new_name", name: null, body: null, templateId: null, postId: null, startedAt: this.now() },
        at: this.now(),
      });
      await this.safeSend(chatId, copy.tplAskName, { inlineKeyboard: flowKeyboard(copy).map((row) => [...row]) });
      return "handled";
    }
    const template = await this.deps.store.findTemplateById(userId, mode.templateId);
    if (template === null) {
      await this.safeSend(chatId, copy.tplNotFound);
      return "handled";
    }
    await this.deps.store.setPendingFlow({
      userId,
      flow: { kind: "tpl_edit_body", name: template.name, body: null, templateId: template.id, postId: null, startedAt: this.now() },
      at: this.now(),
    });
    // The old body is quoted so the user edits rather than retypes — and so a mismatch between what
    // they think is stored and what is stored surfaces before they rewrite it.
    await this.safeSend(chatId, clamp(`${copy.tplAskBody}\n\n<b>${esc(template.name)}</b> v${String(template.version)}\n<code>${esc(template.body)}</code>`), {
      inlineKeyboard: flowKeyboard(copy).map((row) => [...row]),
    });
    return "handled";
  }

  /**
   * Consume one message as the answer to the open prompt, or say the prompt expired.
   *
   * The caller only reaches this after the journal parser has declined the text (see `handleText`),
   * which is the rule that keeps a trade from being swallowed by a template question.
   */
  private async advanceFlow(flow: TelegramPendingFlow, userId: string, chatId: string, text: string, locale: Locale | null): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const expired = this.now().getTime() - flow.startedAt.getTime() > TelegramBot.FLOW_TTL_MS;
    if (expired) {
      await this.deps.store.setPendingFlow({ userId, flow: null, at: this.now() });
      await this.safeSend(chatId, copy.tplFlowExpired);
      return "handled";
    }
    const service = this.postsService();
    if (service === null) {
      await this.deps.store.setPendingFlow({ userId, flow: null, at: this.now() });
      await this.safeSend(chatId, copy.postNoService);
      return "handled";
    }

    if (flow.kind === "banner_title") {
      const title = text.trim();
      if (title.length === 0 || title.length > 60) {
        await this.safeSend(chatId, copy.bnTitleTooLong);
        return "handled";
      }
      await this.deps.store.setPendingFlow({ userId, flow: null, at: this.now() });
      const result = await this.deps.store.savePostPreferences({ userId, bannerTitle: title });
      const prefs = result.status === "saved" ? result.preferences : await this.preferences(userId);
      await this.safeSend(chatId, copy.bnTitleSet(title));
      await this.sendScreen(chatId, bannerMenu(copy, { preferences: prefs, canRaster: await this.canRasterize() }));
      return "handled";
    }

    if (flow.kind === "tpl_new_name") {
      const name = text.trim();
      if (name.length === 0 || name.length > 64) {
        await this.safeSend(chatId, copy.tplNameInvalid);
        return "handled";
      }
      const existing = await this.deps.store.findCurrentTemplate(userId, name);
      if (existing !== null) {
        await this.safeSend(chatId, copy.tplNameTaken);
        return "handled";
      }
      await this.deps.store.setPendingFlow({
        userId,
        flow: { kind: "tpl_new_body", name, body: null, templateId: null, postId: null, startedAt: flow.startedAt },
        at: this.now(),
      });
      await this.safeSend(chatId, copy.tplAskBody, { inlineKeyboard: flowKeyboard(copy).map((row) => [...row]) });
      return "handled";
    }

    // ── a guided POST edit: new bytes on the same row, which revokes the approval ──
    if (flow.kind === "post_edit_body") {
      const body = text.trim();
      if (body.length === 0 || body.length > TEMPLATE_BODY_LIMIT) {
        await this.safeSend(chatId, copy.postEditInvalid);
        return "handled";
      }
      const postId = flow.postId;
      if (postId === null) {
        await this.deps.store.setPendingFlow({ userId, flow: null, at: this.now() });
        await this.safeSend(chatId, copy.postEditExpiredPost);
        return "handled";
      }
      try {
        // `edit` is `revisePost`: one statement replaces the body and its hash AND clears the approval,
        // so what the user tapped "publish" on can never be the text from before the edit (0037's
        // `approved_hash = content_hash` CHECK is the database half of the same rule).
        const revised = await service.edit({ userId, postId, body });
        await this.deps.store.setPendingFlow({ userId, flow: null, at: this.now() });
        await this.safeSend(chatId, copy.postEdited);
        // Show the revised bytes with a FRESH approval button — the one they must tap again.
        const keyboard: InlineKeyboardButton[][] = revised.post.status === "PUBLISHED" || revised.post.status === "CANCELLED"
          ? [[...backToTemplates(copy)]]
          : [[
              { text: copy.btnPublish, callbackData: buildCallbackData("post_pub", revised.post.id) },
              { text: copy.btnPostEdit, callbackData: buildCallbackData("post_edit", revised.post.id) },
            ]];
        await this.safeSend(chatId, clamp(`${copy.postPreviewTitle} — ${revised.post.chatId}\n\n${revised.post.body}`), {
          inlineKeyboard: keyboard,
        });
        return "handled";
      } catch (err) {
        await this.deps.store.setPendingFlow({ userId, flow: null, at: this.now() });
        if (err instanceof TelegramPostError) {
          await this.safeSend(chatId, err.code === "POST_NOT_EDITABLE" ? copy.postEditNotEditable : copy.postEditInvalid);
          return "handled";
        }
        throw err;
      }
    }

    // The two body steps share everything except which version they write.
    const body = text.trim();
    if (body.length === 0) {
      await this.safeSend(chatId, copy.tplBodyEmpty);
      return "handled";
    }
    if (body.length > TEMPLATE_BODY_LIMIT) {
      await this.safeSend(chatId, copy.tplBodyTooLong(TEMPLATE_BODY_LIMIT));
      return "handled";
    }
    if (flow.kind === "tpl_new_body") {
      const name = flow.name ?? "";
      const saved = await service.saveTemplate({
        userId,
        name,
        body,
        expectedVersion: null,
        locale: locale === "en" ? "en" : "fa",
      });
      if (saved.result.status !== "saved") {
        // Someone (or an earlier tap) created the name between the question and the answer. Reported,
        // never overwritten — 0037's versioning exists precisely for this.
        await this.deps.store.setPendingFlow({ userId, flow: null, at: this.now() });
        await this.safeSend(chatId, copy.tplNameTaken);
        return "handled";
      }
      await this.deps.store.setPendingFlow({ userId, flow: null, at: this.now() });
      await this.safeSend(chatId, copy.tplSaved(saved.result.record.name, saved.result.record.version));
      await this.sendTemplatesPage(userId, chatId, locale, 1);
      return "handled";
    }

    const template = flow.templateId === null ? null : await this.deps.store.findTemplateById(userId, flow.templateId);
    if (template === null) {
      await this.deps.store.setPendingFlow({ userId, flow: null, at: this.now() });
      await this.safeSend(chatId, copy.tplNotFound);
      return "handled";
    }
    // Compare-and-set on the version the user was shown: a lost update is reported, not applied.
    const edited = await service.saveTemplate({
      userId,
      name: template.name,
      body,
      expectedVersion: template.version,
      locale: locale === "en" ? "en" : "fa",
    });
    if (edited.result.status !== "saved") {
      await this.deps.store.setPendingFlow({ userId, flow: null, at: this.now() });
      await this.safeSend(chatId, copy.tplNotFound);
      return "handled";
    }
    await this.deps.store.setPendingFlow({ userId, flow: null, at: this.now() });
    await this.safeSend(chatId, copy.tplUpdated(edited.result.record.name, edited.result.record.version));
    await this.sendTemplatesPage(userId, chatId, locale, 1);
    return "handled";
  }

  private async sendTemplatesPage(userId: string, chatId: string, locale: Locale | null, page: number): Promise<void> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const [templates, prefs] = await Promise.all([this.templatesFor(userId), this.preferences(userId)]);
    await this.sendScreen(chatId, templatesMenu(copy, {
      templates,
      preferences: prefs,
      page,
      postsWired: this.postsService() !== null,
    }));
  }

  /**
   * Render one template against the user's OWN data; missing variables are NAMED, never filled.
   *
   * This is the same rendering `handlePostCommand` shows, reached from a button instead of a command
   * — the block below mirrors that path line for line on purpose. Two renderers would eventually
   * disagree, and the one the user approved is the one that must be published.
   */
  private async previewTemplate(userId: string, templateId: string, chatId: string, locale: Locale | null): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const service = this.postsService();
    if (service === null) {
      await this.safeSend(chatId, copy.postNoService);
      return "handled";
    }
    const template = await this.deps.store.findTemplateById(userId, templateId);
    if (template === null) {
      await this.safeSend(chatId, copy.tplNotFound);
      return "handled";
    }
    const prefs = await this.preferences(userId);
    let out: Awaited<ReturnType<TelegramPostService["preview"]>>;
    try {
      out = await service.preview({
        userId,
        templateName: template.name,
        dedupeKey: `tplpv:${template.id}:${String(template.version)}`,
        locale: locale === "en" ? "en" : "fa",
        banner: prefs.bannerEnabled,
        ...(prefs.bannerTitle === null ? {} : { bannerTitle: prefs.bannerTitle }),
      });
    } catch (err) {
      if (err instanceof TelegramPostError && err.code === "TEMPLATE_NOT_FOUND") {
        await this.safeSend(chatId, copy.tplNotFound);
        return "rejected";
      }
      throw err;
    }
    if (out.status === "needs-channel") {
      await this.safeSend(chatId, out.reason === "NO_CHANNEL" ? copy.postNoChannel : copy.postChannelNotOurs);
      return "rejected";
    }
    const post = out.post;
    if (post === null) {
      await this.safeSend(chatId, copy.genericError);
      return "failed";
    }
    const lines: string[] = [`${copy.tplPreviewTitle(template.name)} — ${post.chatId}`];
    if (out.gaps.length > 0) lines.push(copy.postGaps(out.gaps.length));
    // A variable with no value is shown as "not recorded" — the concrete answer to "handle missing
    // variables explicitly" — and it is named, because "some field was missing" is not actionable.
    if (out.unknownPlaceholders.length > 0) lines.push(copy.tplPreviewMissing(out.unknownPlaceholders));
    if (out.unsupportedPlaceholders.length > 0) lines.push(copy.postUnsupportedExpr);
    if (out.truncated) lines.push(copy.postTruncated);
    if (out.markupDropped) lines.push(copy.postMarkupDropped);
    if (out.blockedReason !== null) lines.push(copy.postBlocked(out.blockedReason));
    if (out.incompleteData) lines.push(copy.postBlockedFix(Math.max(out.gaps.length, 1)));
    // The publish button is offered only when nothing blocks the send — a button that cannot work is
    // the kind of promise this bot does not make. Two independent facts gate it: the destination must
    // accept the post, and the card must have no unrecorded required field.
    const publishable = out.blockedReason === null && !out.incompleteData;
    const keyboard: InlineKeyboardButton[][] =
      publishable
        ? [[
            { text: copy.btnPublish, callbackData: buildCallbackData("post_pub", post.id) },
            { text: copy.btnDismiss, callbackData: buildCallbackData("post_no", post.id) },
          ], [...backToTemplates(copy)]]
        : [
            ...(out.incompleteData
              ? [[{ text: copy.btnChecklist, callbackData: buildCallbackData("menu", "checklist") }]]
              : []),
            ...(out.blockedReason !== null
              ? [[{ text: copy.btnManageChannel, callbackData: buildCallbackData("menu", "channel") }]]
              : []),
            [...backToTemplates(copy)],
          ];
    await this.safeSend(chatId, clamp(`${lines.join("\n")}\n\n${out.text}`), { inlineKeyboard: keyboard });
    if (out.banner !== null) {
      // No rasterizer ⇒ say so in one sentence; never claim an image was produced.
      const png = await service.previewPng({ userId, postId: post.id });
      await this.safeSend(chatId, png === null ? copy.postBannerNotRendered : copy.postBannerPreview(out.banner.rowsShown, out.banner.rowsDropped));
    }
    return "handled";
  }

  private async makeDefaultTemplate(userId: string, templateId: string, chatId: string, locale: Locale | null): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const template = await this.deps.store.findTemplateById(userId, templateId);
    if (template === null) {
      await this.safeSend(chatId, copy.tplNotFound);
      return "handled";
    }
    const result = await this.deps.store.savePostPreferences({ userId, defaultTemplateName: template.name });
    if (result.status === "unknown-template") {
      await this.safeSend(chatId, copy.tplNotFound);
      return "handled";
    }
    await this.safeSend(chatId, copy.tplDefaultSet(template.name));
    await this.sendTemplatesPage(userId, chatId, locale, 1);
    return "handled";
  }

  private async retireTemplate(userId: string, templateId: string, chatId: string, locale: Locale | null): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const service = this.postsService();
    if (service === null) {
      await this.safeSend(chatId, copy.postNoService);
      return "handled";
    }
    const template = await this.deps.store.findTemplateById(userId, templateId);
    if (template === null) {
      await this.safeSend(chatId, copy.tplNotFound);
      return "handled";
    }
    await service.forgetTemplate(userId, template.name);
    // A default that points at a retired template would make `/post` ask a question it cannot answer,
    // so the pointer is cleared in the same operation and the user is told.
    const prefs = await this.preferences(userId);
    if (prefs.defaultTemplateName === template.name) {
      await this.deps.store.savePostPreferences({ userId, defaultTemplateName: null });
    }
    await this.safeSend(chatId, copy.tplDeleted(template.name));
    await this.sendTemplatesPage(userId, chatId, locale, 1);
    return "handled";
  }

  /** `/template` list · `/template save <name> <body>` · `/template delete <name>`. */
  private async handleTemplateCommand(
    text: string,
    userId: string,
    chatId: string,
    locale: Locale | null,
  ): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const service = this.postsService();
    if (service === null) {
      await this.safeSend(chatId, copy.postNoService);
      return "handled";
    }
    const body = text.replace(/^\/template(?:@[A-Za-z0-9_]+)?\s*/, "").trim();
    if (body === "" || /^list$/iu.test(body)) {
      const rows = await service.listTemplates(userId);
      if (rows.length === 0) {
        await this.safeSend(chatId, copy.templateEmpty);
        return "handled";
      }
      // The field list is derived from the stored body, not a column: a template's placeholders ARE
      // its contract, and re-reading them here means the list can never claim a field the body lost.
      const lines = rows.map((t) => {
        const tokens = inspectTemplate(t.body).tokens.filter((k) => k.known).map((k) => k.inner);
        const shown = tokens.length === 0 ? "—" : tokens.slice(0, 4).join(", ") + (tokens.length > 4 ? ", …" : "");
        return `• ${t.name} v${String(t.version)} — ${shown}`;
      });
      await this.safeSend(chatId, clamp(`${copy.templateListTitle}\n\n${lines.join("\n")}`));
      return "handled";
    }
    const save = /^save\s+([A-Za-z][A-Za-z0-9_.-]{0,63})\s+([\s\S]+)$/u.exec(body);
    if (save !== null) {
      const name = save[1] as string;
      const template = save[2] as string;
      // `expectedVersion: null` means "create". An existing name is then REFUSED with the row the
      // user would have overwritten, because silently versioning over a template they did not look at
      // is how a careful edit disappears; the retry with the version they just saw is the update path.
      const { result, explanation } = await service.saveTemplate({
        userId,
        name,
        body: template,
        expectedVersion: null,
        locale: locale === "fa" ? "fa" : "en",
      });
      if (result.status === "saved") {
        const notes: string[] = [copy.templateSaved(name, result.record.version)];
        // Saved-but-flagged beats refused: a template with an unknown field still works, and the user
        // is told which token will keep showing up literally. An EXPRESSION is the opposite — it is
        // refused outright, because accepting it would mean a template that executes something.
        for (const line of explanation) notes.push(`- ${line}`);
        await this.safeSend(chatId, clamp(notes.join("\n")));
        return "handled";
      }
      // A conflict is either an optimistic-version collision or the refusal of a body that cannot be
      // stored (too long, empty, an expression). `explanation` distinguishes them in the user's own
      // language, so it is shown whenever there is something to show and the generic line otherwise.
      if (explanation.length > 0) {
        await this.safeSend(chatId, clamp(explanation.map((e) => `- ${e}`).join("\n")));
        return "rejected";
      }
      await this.safeSend(chatId, copy.templateConflict);
      return "rejected";
    }
    const del = /^delete\s+([A-Za-z][A-Za-z0-9_.-]{0,63})$/u.exec(body);
    if (del !== null) {
      const done = await service.forgetTemplate(userId, del[1] as string);
      await this.safeSend(chatId, done ? copy.templateDeleted(del[1] as string) : copy.templateNotFound);
      return done ? "handled" : "rejected";
    }
    await this.safeSend(chatId, copy.templateUsage);
    return "handled";
  }

  // ── the agent: a router over the SAME handlers, nothing more ─────────────
  //
  // NO PROVIDER CALL. Every decision below comes from `resolveIntent`, a table of patterns, which
  // means the behaviour is the same in the API process, in a Worker and in a test, and `/help` can
  // promise it without an "if the model is up" caveat. It also means the agent cannot be prompted into
  // a capability the commands do not have: it selects a TOOL, and the tool is a call into this class.
  // A model that later adds phrasing to the ANSWER still goes through the AI Manager and the feature
  // guard, and can never add a step to the PLAN.
  /**
   * What the tools can do HERE, read from the services rather than from a config file we hope matches.
   *
   * Each call resolves the secrets the tool needs (one indexed read per key) and then asks nothing else
   * — `status()` deliberately makes no provider request, because a help text or a router that costs an
   * API call per message is a router that gets disabled. A tool whose key vanished mid-session therefore
   * disappears from the surface on the next message, which is the direction of failure this product
   * prefers: fewer promises, never more.
   */
  private async toolCapabilities(): Promise<ToolCapabilities> {
    const tools = this.deps.tools;
    if (tools === undefined) return NO_TOOL_CAPABILITIES;
    const [search, browser] = await Promise.all([tools.search.status(), tools.browser.status()]);
    return { webSearch: search.state === "configured" || search.state === "verified", browserCapture: browser.state === "configured" || browser.state === "verified" };
  }

  /**
   * The agent's decision for one message.
   *
   * THE PATTERN TABLE STILL DECIDES FIRST. It is free, deterministic and identical in every runtime, so
   * a sentence it understands never costs a provider call. The model is consulted only when the table
   * found nothing — and what the model may return is a tool NAME from the effective registry, which
   * `planFromModel` then re-validates. A jailbroken sentence therefore cannot reach a store call, a
   * channel or a publish: the registry, not the model, is the ceiling, and the execution below delegates
   * to the same private handlers the slash commands use, so the agent is never a wider door.
   */
  private async agentFor(text: string, userId: string, locale: Locale | null): Promise<AgentDecision | null> {
    if (this.postsService() === null) return null;
    if (text === "" || text.startsWith("/")) return null;
    const lang: "fa" | "en" = locale === "fa" ? "fa" : "en";
    const caps = await this.toolCapabilities();
    const deterministic = resolveIntent(text, lang, caps);
    if (deterministic.plan !== null || deterministic.rejection !== null) return deterministic;
    const planner = this.deps.tools?.planner;
    if (planner === undefined) return deterministic;
    // Only read-only, approval-free tools are offered. A side effect needs an approval the user tapped,
    // so it is not even a choice the model is given — an unlisted tool cannot be picked.
    const honourable = effectiveRegistry(caps).filter((tool) => tool.available && tool.name !== "journal.draft");
    const shape = (tool: ToolDefinition) => ({
      name: tool.name,
      description: tool.description[lang],
      args: tool.args,
    });
    // Two lists, deliberately. The model may only be SHOWN what it may legitimately choose — never a
    // tool that needs an approval the user has not given — while the whole set is what a returned plan
    // is CHECKED against, so a plan naming `post.publish` becomes a refusal that says why rather than a
    // non-event the user experiences as being ignored.
    const advertised = honourable.filter((tool) => !tool.requiresApproval);
    if (advertised.length === 0) return deterministic;
    const tools = honourable.map(shape);
    let proposal;
    try {
      proposal = await planner.plan({ userId, utterance: text, locale: lang, tools, advertised: advertised.map(shape) });
    } catch {
      // A provider that is down, refused or over quota must not degrade the user's experience: the
      // sentence falls through to the journal-draft path exactly as it did before the planner existed.
      return deterministic;
    }
    if (proposal.ok !== true) return deterministic;
    if (proposal.tool === null) return deterministic;
    return planFromModel({ tool: proposal.tool, args: proposal.args }, text, lang, caps);
  }

  /**
   * Answer a message the agent took, in one step or in several.
   *
   * THE SPLIT IS DELIBERATE, AND IT IS ABOUT COST AND PREDICTABILITY RATHER THAN CAPABILITY:
   *   • a request the pattern table recognised runs EXACTLY the tool it names, through the same private
   *     handler the slash command uses. It is free, it is identical in every runtime, and it does not
   *     become an excuse for a second provider call three seconds later;
   *   • a request only the model understood may CONTINUE: after each step the observation is handed back
   *     and the model is asked for the next step, until it says it is done or a ceiling bites. That is
   *     what makes this an agent rather than a router with a thesaurus — and the ceilings
   *     (steps, model calls, wall clock, per-tool repeats) are read by `AgentLoop`, not written in prose.
   *
   * A refusal is always an answer, never silence: an unapproved side effect, an unverified target and a
   * stopped run each get their own sentence in the user's language.
   */
  private async runAgentPlan(
    decision: AgentDecision,
    userId: string,
    tgId: string,
    chatId: string,
    actionKey: string,
    locale: Locale | null,
  ): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const lang: "fa" | "en" = locale === "fa" ? "fa" : "en";
    if (decision.rejection !== null) {
      const rejection = decision.rejection;
      // Every rejection is answered with what is missing, never with a shrug. `unsupported` names the
      // dependency absent from THIS runtime — the honest answer to "take a chart screenshot" where no
      // browser automation is installed, and better than quietly doing something else instead.
      // `ambiguous` asks the ONE question execution needs, in the user's own language.
      await this.safeSend(chatId, rejection.kind === "unsupported"
        ? copy.agentBlocked(rejection.reason)
        : copy.agentAmbiguous(rejection.question[lang]));
      return "handled";
    }
    if (decision.plan === null) return "ignored";
    const planner = this.deps.tools?.planner;
    if (decision.plan.matchedBy !== "model" || planner === undefined) {
      return this.runAgentTool(decision.plan, userId, tgId, chatId, actionKey, locale);
    }

    // One agent RUN costs one hit on its own bucket, on top of the per-tool buckets each step pays.
    // Without it, a loop of six steps would spend six "cheap" budgets and never meet a ceiling named
    // after itself.
    if (!(await this.allowed(tgId, "telegram:agent"))) return "rejected";

    // Capabilities are read ONCE per run. Two secret lookups per step would make the cheapest tool call
    // in the product a database round trip; a key that vanishes mid-request is still caught, because
    // every `perform*` re-checks its own service before it spends anything.
    const runCaps = await this.toolCapabilities();
    const registry = effectiveRegistry(runCaps);
    const shapes = registry.filter((tool) => tool.name !== "journal.draft").map((tool) => plannerShape(tool, lang));
    // Two lists from ONE read: what the model may be SHOWN (available, approval-free) and what a plan
    // may be CHECKED against (everything but the fall-through draft). Computed together so the pair
    // cannot drift into offering something the checker rejects, or accepting something never offered.
    const advertised = shapes.filter((shape) => {
      const def = registry.find((tool) => tool.name === shape.name);
      return def !== undefined && def.available && !def.requiresApproval;
    });

    const loop = new AgentLoop({
      plan: async ({ utterance, history, remainingMs }) => {
        const proposal = await planner.plan({
          userId,
          utterance,
          locale: lang,
          tools: shapes,
          advertised,
          history,
          remainingMs,
        });
        if (proposal.ok !== true) return { ok: false, code: proposal.code, tool: null, args: {} };
        // `null` is the loop's "I am done", and it arrives from a plan that also has no args — reading
        // `proposal.args` here would typecheck only by accident of the union's shape.
        if (proposal.tool === null) return { ok: true, code: null, tool: null, args: {} };
        return { ok: true, code: null, tool: proposal.tool, args: proposal.args };
      },
      execute: async (call, step) =>
        this.performToolStep(call, { userId, tgId, chatId, actionKey, locale, caps: runCaps, step }),
      now: () => this.now().getTime(),
      log: this.deps.log,
    });

    const outcome = await loop.run({
      userId,
      utterance: decision.plan.utterance,
      locale: lang,
      // The model's first proposal is the seed: it has already been validated by `planFromModel`
      // (registry membership, approval class, argument schema), so re-asking it "what now?" would spend
      // a call to arrive at the same step.
      seed: { tool: decision.plan.tool, args: decision.plan.args },
      budget: telegramAgentLoopBudget(),
      initialContext: contextFromUtterance(decision.plan.utterance),
      allowContinuation: true,
    });
    return this.renderLoopOutcome(outcome, chatId, copy, lang);
  }

  /**
   * One message per step, then the truth about what stopped the run.
   *
   * A stopped-after-three-steps run that printed only three answers would leave the user counting: "did
   * it forget the chart, or is there no chart?" So a guarded finish always says which ceiling fired and
   * how many steps ran. `completed` is the only status that stays silent, and `no-plan` never reaches
   * here (the dispatcher's fall-through answers that).
   */
  private async renderLoopOutcome(
    outcome: AgentLoopOutcome,
    chatId: string,
    copy: TelegramCopy,
    lang: "fa" | "en",
  ): Promise<UpdateOutcome> {
    if (outcome.status === "no-plan") return "ignored";
    if (outcome.stoppedBy === "approval-required" && outcome.pendingApproval !== null) {
      await this.safeSend(chatId, copy.agentNeedsApproval(outcome.pendingApproval));
      return "handled";
    }
    if (outcome.stoppedBy === "unverified-target") {
      // "handled", even when nothing ran: the run refused a destination and said why, which IS the answer.
      // Reporting "ignored" here would drop the dispatcher into its journal-draft fall-through and append
      // a "I couldn't find anything to record" line under a refusal — two messages, one of them false.
      await this.safeSend(chatId, copy.agentUnverifiedTarget(outcome.detail ?? "target"));
      return "handled";
    }
    if (outcome.steps.length === 0 && outcome.stoppedBy === "planner-unavailable") return "ignored";
    if (outcome.stoppedBy !== null) {
      await this.safeSend(chatId, clamp(copy.agentStopped(stopText(outcome.stoppedBy, outcome.detail, lang), outcome.steps.length)));
      return outcome.steps.length > 0 ? "handled" : "rejected";
    }
    return "handled";
  }

  /**
   * Run one tool call as a STEP rather than as an answer, and report what it produced.
   *
   * Every branch delegates to the same private handler or service the slash command uses — the loop is
   * not a wider door, it is the same door opened more than once. A rate-limited or failed step returns
   * `ok: false` with a fixed code; it never throws and it never reports success, which is what keeps a
   * partially failed run a `partial` one.
   */
  private async performToolStep(
    call: AgentToolCall,
    ctx: {
      readonly userId: string;
      readonly tgId: string;
      readonly chatId: string;
      readonly actionKey: string;
      readonly locale: Locale | null;
      readonly caps: ToolCapabilities;
      readonly step: number;
    },
  ): Promise<AgentStepResult> {
    const { copy } = this.copyFor(ctx.locale, { media: this.mediaAvailable });
    const def = findToolIn(call.tool, ctx.caps);
    const fail = (code: string, observation: string, retryAfterSeconds: number | null = null): AgentStepResult => ({
      ok: false,
      code,
      retryAfterSeconds,
      observation,
      context: undefined,
      payload: undefined,
    });
    if (def === undefined) return fail("TOOL_NOT_OFFERED", "this tool is not offered here");
    if (!def.available) return fail(def.blockedReason ?? "UNAVAILABLE", "the tool is not available in this runtime");
    // No generic bucket here ON PURPOSE: each path below pays its own key exactly once. A pre-check plus
    // the tool's own check would charge a user two `telegram:search` hits for one search, and a limit
    // that counts twice is a limit whose published number is a lie.

    switch (call.tool) {
      case "web.search": {
        const result = await this.performWebSearch(call.args["query"] ?? "", ctx.userId, ctx.tgId, ctx.locale);
        await this.renderSearchResult(ctx.chatId, copy, result);
        if (result.kind === "blocked") return fail("NO_WEB_PROVIDER", "no web search provider is configured");
        if (result.kind === "limited") return fail("RATE_LIMITED", "rate limited");
        if (result.kind === "error") return fail(result.code, `search failed: ${result.code}`, result.retryAfterSeconds);
        if (result.kind === "empty") return { ok: true, code: null, retryAfterSeconds: null, observation: "the search returned no results", context: NO_CONTEXT, payload: result };
        const urls = result.hits.map((hit) => hit.url).filter((u): u is string => typeof u === "string");
        const observation = `${String(result.hits.length)} results from ${result.provider}: ${result.hits
          .slice(0, 3)
          .map((hit) => `${hit.title} <${hit.url}>`)
          .join(" | ")}`;
        return {
          ok: true,
          code: null,
          retryAfterSeconds: null,
          observation: observation.slice(0, 400),
          // Only a URL a provider actually returned may be reused by a later step. The loop checks that
          // list before it will let `chart.capture` run, so a model that invents a destination is
          // refused by the guard rather than by a prompt's polite request.
          context: { urls, ids: [], dates: [] },
          payload: result,
        };
      }
      case "chart.capture": {
        const result = await this.performChartCapture(call.args["url"] ?? "", ctx.userId, ctx.tgId, ctx.locale);
        await this.renderChartCapture(ctx.chatId, copy, result);
        if (result.kind === "blocked") return fail("NO_BROWSER_AUTOMATION", "no browser automation is configured here");
        if (result.kind === "limited") return fail("RATE_LIMITED", "rate limited");
        if (result.kind === "error") return fail(result.code, `capture failed: ${result.code}`);
        const observed = result.observed.length > 0 ? result.observed.join(", ") : "nothing was legible";
        return {
          ok: true,
          code: null,
          retryAfterSeconds: null,
          observation: `captured ${result.capture.url} (${String(result.capture.width)}×${String(result.capture.height)}); read: ${observed}`,
          context: { urls: [result.capture.url], ids: [], dates: [] },
          payload: result,
        };
      }
      case "post.prepare": {
        const outcome = await this.handlePostCommand(
          `/post${typeof call.args["template"] === "string" && call.args["template"] !== "" ? ` ${call.args["template"]}` : ""}${typeof call.args["date"] === "string" && call.args["date"] !== "" ? ` ${call.args["date"]}` : ""}`,
          ctx.userId,
          ctx.chatId,
          ctx.actionKey,
          ctx.locale,
        );
        return {
          ok: outcome === "handled",
          code: outcome === "handled" ? null : "PREVIEW_FAILED",
          retryAfterSeconds: null,
          observation: "a channel post preview was prepared for the user to approve (nothing was sent)",
          context: NO_CONTEXT,
          payload: undefined,
        };
      }
      case "stats.read":
      case "checklist.read":
      case "checklist.gaps":
      case "template.list":
      case "channel.status": {
        // The same handler, reached with the step's own arguments. `matchedBy: "model"` is recorded as
        // provenance rather than as a claim: this step came from a plan, not from a pattern.
        const outcome = await this.runAgentTool(
          { tool: call.tool, args: call.args, utterance: "", matchedBy: "model" },
          ctx.userId, ctx.tgId, ctx.chatId, ctx.actionKey, ctx.locale,
        );
        return {
          ok: outcome === "handled",
          code: outcome === "handled" ? null : "READ_FAILED",
          retryAfterSeconds: null,
          observation: `answered with the ${call.tool} view, shown to the user`,
          context: NO_CONTEXT,
          payload: undefined,
        };
      }
      default:
        return fail("TOOL_NOT_LOOPABLE", "this tool is not run by the agent loop");
    }
  }

  /** Execute one planned tool by delegating to the command handler that already does it. */
  private async runAgentTool(
    plan: Plan,
    userId: string,
    tgId: string,
    chatId: string,
    actionKey: string,
    locale: Locale | null,
  ): Promise<UpdateOutcome> {
    const caps = await this.toolCapabilities();
    const def = findToolIn(plan.tool, caps);
    if (def === undefined || def.available === false) return "ignored";
    const arg = (name: string): string | undefined => {
      const value = plan.args[name];
      return typeof value === "string" && value !== "" ? value : undefined;
    };
    switch (plan.tool) {
      case "stats.read":
        return this.sendStats(chatId, userId, locale, arg("window"));
      case "checklist.read":
        return this.handleChecklistCommand(arg("date") === undefined ? "/checklist" : `/checklist ${arg("date")}`, userId, tgId, chatId, locale);
      case "checklist.gaps":
        return this.handleChecklistCommand(
          plan.args["days"] === undefined ? "/checklist coverage" : `/checklist coverage ${String(plan.args["days"])}`,
          userId, tgId, chatId, locale,
        );
      case "template.list":
        return this.handleTemplateCommand("/template", userId, chatId, locale);
      case "post.prepare":
        return this.handlePostCommand(
          `/post${arg("template") === undefined ? "" : ` ${arg("template")}`}${arg("date") === undefined ? "" : ` ${arg("date")}`}`,
          userId, chatId, actionKey, locale,
        );
      case "channel.status":
        return this.handleChannelCommand("/channel list", userId, chatId, locale);
      case "channel.select":
        return this.handleChannelCommand(`/channel use ${arg("channelId") ?? ""}`, userId, chatId, locale);
      case "web.search":
        return this.runWebSearch(arg("query") ?? "", userId, tgId, chatId, locale, plan);
      case "chart.capture":
        return this.runChartCapture(arg("url") ?? "", userId, tgId, chatId, locale, plan);
      case "journal.draft":
      case "post.publish":
        // NOT routed here. `journal.draft` is the fall-through the dispatcher already performs, and
        // `post.publish` needs a post id the user was shown — an id the agent must never invent, so a
        // bare "publish it" arrives as the dispatcher's normal answer with buttons instead.
        return "ignored";
      default:
        return "ignored";
    }
  }

  /**
   * Read-only web research, answered as SOURCES.
   *
   * There is no summary from us on purpose. A model-generated digest of other people's pages would
   * blend a claim of ours with a claim of theirs, and the whole point of this surface is that a trader
   * can tell the difference. So: the provider's own titles, snippets and links, with the retrieval
   * instant and the provider named, and each row's date either as the provider wrote it or marked as
   * not given. The text is HTML-escaped because a page title is untrusted input arriving in a message
   * we render with markup enabled.
   *
   * Cost is guarded by `telegram:analyze` — the existing per-user budget for an expensive external
   * call. A dedicated key would be a contracts change for no additional protection; the ceiling that
   * matters is that one user cannot turn a bot into a search indexer.
   */
  /**
   * The single-step research answer: one search, one message.
   *
   * Used by the pattern-matched path; the loop calls `performWebSearch` + `renderSearchResult` for the
   * same reason. One provider call, one budget hit and one rendering, shared by both entry points, so a
   * "single step" is not a cheaper second implementation of the same promise.
   */
  private async runWebSearch(
    query: string,
    userId: string,
    tgId: string,
    chatId: string,
    locale: Locale | null,
    plan: Plan,
  ): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const result = await this.performWebSearch(query, userId, tgId, locale);
    if (result.kind === "limited") return "rejected"; // no extra message: the outcome says it was throttled
    await this.renderSearchResult(chatId, copy, result);
    if (result.kind === "hits") {
      this.deps.log({
        level: "info",
        event: "telegram_agent_search",
        provider: result.provider,
        hits: result.hits.length,
        matchedBy: plan.matchedBy,
      });
    }
    return "handled";
  }

  /**
   * Ask the configured search provider, and say WHAT STOPPED US when there is nothing to ask.
   *
   * No provider means `blocked`, and the caller names the missing dependency — the answer a user needs
   * is not "0 results". The budget is `telegram:search`, this tool's own hourly bucket keyed by Telegram
   * identity, so a heavy searcher cannot also spend their journal-analysis budget and vice versa; that
   * separation is the whole reason the key exists.
   */
  private async performWebSearch(
    query: string,
    userId: string,
    tgId: string,
    locale: Locale | null,
  ): Promise<WebSearchStep> {
    const tools = this.deps.tools;
    if (tools === undefined || query.trim() === "") return { kind: "blocked" };
    if (!(await this.allowed(tgId, "telegram:search"))) return { kind: "limited" };
    const out = await tools.search.search({ query: query.trim(), maxResults: 5, locale: locale === "fa" ? "fa" : "en" });
    if (out.ok !== true) return { kind: "error", code: out.code, retryAfterSeconds: out.retryAfterSeconds };
    if (out.hits.length === 0) return { kind: "empty", provider: out.provider };
    return { kind: "hits", provider: out.provider, latencyMs: out.latencyMs, hits: out.hits };
  }

  /**
   * The answer, as SOURCES.
   *
   * There is no summary from us on purpose. A model-generated digest of other people's pages would blend
   * a claim of ours with a claim of theirs, and the whole point of this surface is that a trader can tell
   * the difference. So: the provider's own titles, snippets and links, with the retrieval instant and the
   * provider named, and each row's date either as the provider wrote it or marked as not given. The text
   * is HTML-escaped because a page title is untrusted input arriving in a message we render with markup
   * enabled.
   */
  private async renderSearchResult(
    chatId: string,
    copy: TelegramCopy,
    result: WebSearchStep,
  ): Promise<void> {
    if (result.kind === "blocked") {
      await this.safeSend(chatId, copy.agentBlocked("NO_WEB_PROVIDER"));
      return;
    }
    if (result.kind === "limited") {
      await this.safeSend(chatId, copy.rateLimited);
      return;
    }
    if (result.kind === "empty") {
      await this.safeSend(chatId, copy.searchNoResults);
      return;
    }
    if (result.kind === "error") {
      const wait = result.retryAfterSeconds !== null && result.retryAfterSeconds > 0 ? ` (${String(result.retryAfterSeconds)}s)` : "";
      await this.safeSend(chatId, copy.agentBlocked(`${result.code}${wait}`));
      return;
    }
    const lines = result.hits.map((hit: SearchHit, index: number) => {
      const when = hit.publishedAt !== null ? hit.publishedAt : hit.publishedLabel !== null ? `${hit.publishedLabel}?` : copy.searchNoDate;
      const score = hit.score === null ? "" : ` · ${hit.score.toFixed(2)}`;
      return `${String(index + 1)}. ${esc(hit.title)}\n   ${esc(hit.url)}\n   ${esc(hit.snippet)}\n   ${esc(when)}${score}`;
    });
    const header = copy.searchHeader(result.hits.length, result.provider, `${String(result.latencyMs)}ms`);
    await this.safeSend(chatId, clamp(`${header}\n\n${lines.join("\n\n")}\n\n${copy.searchFooter}`), {
      inlineKeyboard: undefined,
    });
  }

  /**
   * Chart capture: open a page we vouch for, read what is VISIBLE, report the rest as unread.
   *
   * THREE THINGS ARE KEPT APART, and that is the whole feature. (1) The pixels, from a browser service
   * pointed at a host on the chart allowlist — never at a URL this conversation happened to mention.
   * (2) The values read out of those pixels, which come from `interpretImageAndRecord`: the SAME call the
   * user-forwarded-screenshot path makes, so the feature flag, consent, quota, anonymisation and ledger
   * entries are identical and there is no second vision egress to forget. (3) What the journal already
   * knows. A field the image does not show is reported as missing; it is never filled from the symbol's
   * "usual" level, and nothing is written to the journal from a capture — an image a model read is not a
   * trade the user confirmed.
   *
   * The PNG is not stored: `AttachmentService` attaches bytes to a TRADE, and inventing a table to hold
   * one round's screenshots would be the parallel store this project forbids. The digest and dimensions
   * are reported instead, which is enough to prove what was looked at.
   */
  private async runChartCapture(
    url: string,
    userId: string,
    tgId: string,
    chatId: string,
    locale: Locale | null,
    plan: Plan,
  ): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const result = await this.performChartCapture(url, userId, tgId, locale);
    if (result.kind === "limited") return "rejected";
    await this.renderChartCapture(chatId, copy, result);
    if (result.kind === "captured") {
      this.deps.log({
        level: "info",
        event: "telegram_agent_chart",
        provider: result.capture.provider,
        vision: result.readOk && result.observed.length > 0,
        matchedBy: plan.matchedBy,
      });
    }
    return "handled";
  }

  /** The capture and the read, as DATA. Rendering is separate so a loop step and a command share it. */
  private async performChartCapture(
    url: string,
    userId: string,
    tgId: string,
    locale: Locale | null,
  ): Promise<ChartCaptureStep> {
    const tools = this.deps.tools;
    if (tools === undefined || url.trim() === "") return { kind: "blocked" };
    if (!(await this.allowed(tgId, "telegram:capture"))) return { kind: "limited" };
    const capture = await tools.browser.capture({ url: url.trim(), chartHostsOnly: true });
    if (!("contentType" in capture)) return { kind: "error", code: capture.code };
    const interpretation = await interpretImageAndRecord(
      { interpreter: this.deps.media.interpreter, attempts: this.deps.media.attempts },
      { userId, image: capture.bytes, mimeType: "image/png" },
    );
    const observed: string[] = [];
    const missing: string[] = [];
    if (interpretation.ok) {
      const read = interpretation.fields;
      for (const [key, value] of [
        ["symbol", read.symbol],
        ["direction", read.direction],
        ["entry", read.entryPrice],
        ["stop", read.stopLoss],
        ["target", read.takeProfit],
      ] as const) {
        if (value === null) missing.push(key);
        else observed.push(`${key} ${value}`);
      }
    }
    return {
      kind: "captured",
      capture,
      readOk: interpretation.ok,
      readCode: interpretation.ok ? null : interpretation.code,
      observed,
      missing,
    };
  }

  private async renderChartCapture(
    chatId: string,
    copy: TelegramCopy,
    result: ChartCaptureStep,
  ): Promise<void> {
    if (result.kind === "blocked") {
      await this.safeSend(chatId, copy.agentBlocked("NO_BROWSER_AUTOMATION"));
      return;
    }
    if (result.kind === "limited") {
      await this.safeSend(chatId, copy.rateLimited);
      return;
    }
    if (result.kind === "error") {
      await this.safeSend(chatId, copy.agentBlocked(result.code));
      return;
    }
    const source = `${result.capture.url} @ ${result.capture.capturedAt} · ${String(result.capture.width)}×${String(result.capture.height)} · sha256 ${result.capture.sha256.slice(0, 12)}`;
    const body = result.readOk
      ? result.observed.length > 0
        ? copy.chartObserved(result.observed.join(", "), result.missing.length > 0 ? copy.chartMissing(result.missing.join(", ")) : copy.chartNothingMissing)
        : copy.chartNothingReadable
      : result.readCode === "PROVIDER_NOT_CONFIGURED"
        ? copy.photoSignOnly
        : copy.photoUnreadable;
    await this.safeSend(chatId, clamp(`${copy.chartCaptured(source)}\n\n${body}\n\n${copy.chartNotStored}`));
  }

  private async handleChannelCommand(text: string, userId: string, chatId: string, locale: Locale | null): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const argument = text.replace(new RegExp(`^/channel${COMMAND_SUFFIX}`), "").trim();
    if (argument === "") {
      await this.safeSend(chatId, copy.channelHint);
      return "handled";
    }
    // `/channel list` — registered channels and which one posts. Bound and ACTIVE are different
    // facts, and conflating them is what makes "why did that go to the other channel?" unanswerable.
    if (/^list$/iu.test(argument)) {
      const channels = await this.deps.store.listChannels(userId);
      if (channels.length === 0) {
        await this.safeSend(chatId, copy.channelHint);
        return "handled";
      }
      const lines = channels.map((c) =>
        `• ${c.chatId} ${esc(c.title ?? "")} — ${c.status === "ACTIVE" ? copy.channelStatusActive : c.status === "STANDBY" ? copy.channelStatusStandby : c.status}`,
      );
      await this.safeSend(chatId, clamp(`${copy.channelListTitle}\n\n${lines.join("\n")}`));
      return "handled";
    }
    // `/channel use <chat id>` — re-select a channel the user has ALREADY verified. Two things this
    // deliberately does not do: it never binds a channel that is merely named in the sentence (that
    // is what `/channel <id>` + Telegram's own membership answer is for), and it never promotes an
    // unverified row, because selection is routing and not a second path to permission.
    const use = /^use\s+(-?\d{5,20})$/u.exec(argument);
    if (use !== null) {
      const target = use[1] as string;
      const existing = await this.deps.store.findChannel(userId, target);
      if (existing === null) {
        await this.safeSend(chatId, copy.channelNotFound);
        return "rejected";
      }
      const out = await this.deps.store.activateChannel(userId, target, this.now());
      if (out.ok === false) {
        await this.safeSend(chatId, out.reason === "NOT_VERIFIED" ? copy.channelNotVerified : copy.channelNotFound);
        return "rejected";
      }
      await this.safeSend(chatId, out.demoted === null
        ? copy.channelActivated(target)
        : `${copy.channelActivated(target)}
${copy.channelStandbyNow}`);
      return "handled";
    }
    if (!/^-?\d{5,20}$/.test(argument)) {
      await this.safeSend(chatId, copy.channelBadId);
      return "rejected";
    }
    // NEVER TRUST A CLIENT-SUPPLIED CHAT ID. The value below is only a
    // CANDIDATE: the bot's own membership and posting rights are what make it
    // usable, and those are asked of Telegram, not of the user.
    try {
      const me = await this.deps.api.getMe();
      const chat = await this.deps.api.getChat(argument);
      if (chat.type === "private") {
        // A PRIVATE CHAT IS NOT A CHANNEL. Binding it would mean mirroring the
        // journal back into the same conversation the user journals from — a
        // duplicate of their own input, and never what "journal channel" means.
        await this.safeSend(chatId, copy.channelPrivate);
        return "rejected";
      }
      const member = await this.deps.api.getChatMember(chat.id, me.id);
      // Telegram reports posting rights differently per chat kind, so the rule
      // follows the API's own vocabulary rather than a single membership test:
      // channels and supergroups answer `can_post_messages`, and a plain group
      // only needs the bot to still be in it.
      // ONE RULE, SHARED WITH THE PUBLISH PATH (`botCanPostIn`). The local version of this predicate
      // required `can_post_messages` for a supergroup, a field Telegram only reports for channels, so
      // binding a supergroup the bot administers answered "no posting rights" — and the publish path
      // separately asked for the membership of a user called "@me", which the API rejects outright.
      const canPost = botCanPostIn(chat.type, member);
      const record: TelegramChannelRecord = await this.deps.store.upsertChannel({
        userId,
        chatId: chat.id,
        title: chat.title,
        chatType: chat.type,
        status: canPost ? "ACTIVE" : "INSUFFICIENT_PERMISSIONS",
        canPost,
        at: this.now(),
      });
      if (!canPost) {
        await this.safeSend(chatId, copy.channelNoRights);
        return "rejected";
      }
      await this.safeSend(chatId, copy.channelVerified(esc(record.title ?? record.chatId)), {
        inlineKeyboard: [[{ text: copy.btnChannelTest, callbackData: buildCallbackData("channel_test", "channel") }]],
      });
      return "handled";
    } catch (err) {
      const code = classifyError(err);
      await this.safeSend(chatId, code === "CHAT_NOT_FOUND" ? copy.channelNotFound : copy.genericError);
      return "rejected";
    }
  }

  /**
   * The channel section.
   *
   * It renders the rows the binding path wrote, and it does NOT offer a "verify" button: verification is
   * `/channel <id>`, because the only trustworthy answer comes from Telegram's own membership check for
   * a chat id the user obtained themselves. A button that "verified" a name would be exactly the guess
   * this path exists to refuse.
   */
  private async sendChannelScreen(chatId: string, userId: string, locale: Locale | null): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const channels = await this.deps.store.listChannels(userId);
    await this.sendScreen(chatId, channelMenu(copy, {
      channels: channels.map((c) => ({ chatId: c.chatId, title: c.title, status: c.status, canPost: c.canPost })),
      apiWired: this.deps.api !== undefined,
    }));
    return "handled";
  }

  private async testChannel(chatId: string, userId: string, locale: Locale | null): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const channel = await this.deps.store.findActiveChannel(userId);
    if (channel === null) {
      await this.safeSend(chatId, copy.channelNone);
      return "handled";
    }
    try {
      await this.deps.api.sendMessage(channel.chatId, copy.channelTestOk, { disableNotification: true });
      await this.safeSend(chatId, copy.channelTestOk);
    } catch (err) {
      this.deps.log({ level: "warn", event: "telegram_channel_test_failed", code: classifyError(err) });
      await this.safeSend(chatId, copy.channelTestFailed);
    }
    return "handled";
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  private async sendLast(chatId: string, userId: string, locale: Locale | null): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const trade = await this.deps.journal.latest(userId);
    if (trade === null) {
      await this.safeSend(chatId, copy.lastEmpty);
      return "handled";
    }
    await this.safeSend(chatId, clamp(`${copy.lastTitle}\n\n${renderTrade(copy, trade)}`));
    return "handled";
  }

  private async sendHistory(chatId: string, userId: string, locale: Locale | null, page: number): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const history = await this.deps.journal.history(userId, { page, limit: 5 });
    if (history.items.length === 0) {
      await this.safeSend(chatId, copy.historyEmpty);
      return "handled";
    }
    const blocks = history.items.map((trade) => renderTrade(copy, trade));
    const body = `${copy.historyTitle}\n\n${blocks.join("\n\n")}\n\n${copy.historyFooter(history.page, history.totalPages, history.total)}`;
    const keyboard: InlineKeyboardButton[][] = page < history.totalPages ? [[{ text: copy.btnMore, callbackData: buildCallbackData("history_more", String(page + 1)) }]] : [];
    await this.safeSend(chatId, clamp(body), { inlineKeyboard: keyboard });
    return "handled";
  }

  private async sendAnalysis(chatId: string, userId: string, tgId: string, locale: Locale | null): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    // Before the "working…" message and before any model call: an analysis is the
    // single most expensive thing the bot does, and the limit must be visible in
    // what the user sees rather than hidden behind a spinner. The bucket is the
    // TELEGRAM identity (passed in by the caller), never the Velora user id.
    if (!(await this.withinAnalyzeBudget(chatId, tgId, locale))) return "rejected";
    await this.safeSend(chatId, copy.analyzeWorking);
    const result = await this.deps.analysis.analyze(userId);
    if (result.status !== "ok") {
      if (result.status === "error") this.deps.log({ level: "warn", event: "ai_analysis_failed", code: result.code });
      // ONE SENTENCE PER REAL CAUSE. A 429, a 503 and a timeout are three different facts to a user:
      // "wait a few minutes", "the provider is busy", "it did not answer in time". Collapsing them into
      // "the analysis failed" is the ambiguity this mapping exists to remove — and none of the branches
      // invents a result.
      const text =
        result.code === "PROVIDER_NOT_CONFIGURED"
          ? copy.analyzeDisabled
          : result.code === "CONSENT_REQUIRED"
            ? copy.analyzeConsent
            : result.code === "NO_DATA"
              ? copy.analyzeEmpty
              : result.code === "RATE_LIMITED"
                ? copy.analyzeRateLimited
                : result.code === "PROVIDER_UNAVAILABLE" || result.code === "PROVIDER_BUSY"
                  ? copy.analyzeBusy
                  : result.code === "PROVIDER_TIMEOUT"
                    ? copy.analyzeTimeout
                    : copy.analyzeFailed;
      await this.safeSend(chatId, text);
      return "handled";
    }
    // MODEL-GENERATED ANALYSIS, and the message says so. It is not a trading
    // record; nothing in this path writes to the ledger or the event log.
    await this.safeSend(chatId, clamp(`${copy.analyzeTitle}\n\n${renderInsight(result.insight)}\n\n${copy.analyzeDisclaimer}`));
    return "handled";
  }


  /**
   * Statistics, computed by the domain from persisted rows and formatted here. Two rules matter: a
   * window the store could not read in full is ANNOUNCED rather than presented as a whole, and the
   * derived observations stay labelled as derived — the AI coach is a different feature with its own
   * limit and its own consent, and it is not reached by this command.
   */
  private async sendStats(
    chatId: string,
    userId: string,
    locale: Locale | null,
    windowKind?: string,
  ): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const view = await this.deps.journal.stats(userId, { ...(windowKind ? { windowKind } : {}) });
    if (view.invalidWindow) {
      // Three refusals, three different sentences, because the fix differs each time: an unknown
      // word wants the token list, a nonexistent day wants the calendar's own bounds, and an
      // AMBIGUOUS day wants a marker — never a guess. The service already resolved the day with the
      // shared contract, so this handler parses no calendar of its own.
      const reason = view.windowError.kind;
      const raw = view.windowError.raw ?? "";
      await this.safeSend(chatId, reason === "ambiguous"
        ? copy.statsWindowAmbiguous(raw)
        : reason === "garbage"
          ? copy.statsWindowGarbage(raw)
          : copy.statsBadWindow(raw));
      return "handled";
    }
    // A named window is labelled from the copy; a DATE window is labelled by the service, which is
    // the only place that knows whether the user typed Gregorian or Jalali. The handler parses no
    // calendar here — that is the whole point of resolving the window in one place.
    const label = windowKind === undefined ? null : view.label ?? statsWindowLabel(copy, windowKind);
    if (view.stats.tradeCount === 0) {
      // A windowed "nothing" is not the same fact as an empty journal: the day may be empty while
      // the history is full, and saying "no records at all" would be a lie the user can disprove.
      await this.safeSend(chatId, label === null ? copy.statsEmpty : copy.statsEmptyWindow(label));
      return "handled";
    }
    const title = label === null
      ? copy.statsTitle
      : `${copy.statsTitle} · ${copy.statsWindowLabel}: ${label ?? statsWindowLabel(copy, windowKind ?? "")}`;
    await this.safeSend(
      chatId,
      clamp(`${title}\n\n${renderStats(copy, view.stats, view.sampled ? view.totalRows : null)}`),
    );
    return "handled";
  }

  /**
   * Renders the service's coverage aggregate. Two presentation rules, both about honesty rather than
   * style: `noRecordDays` is shown as "no record" and never as a failed review, and an item's count
   * is written as a number of DAYS it went unmentioned — the only unit the data actually supports.
   * The denominator is the period, so 0/7 reads as "never recorded", not "100 % unreviewed".
   */
  private async sendChecklistCoverage(
    chatId: string,
    userId: string,
    locale: Locale | null,
    days: number,
  ): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const view = await this.deps.journal.checklistCoverageSummary(userId, days);
    const s = view.summary;
    if (s.daysWithRecord === 0) {
      await this.safeSend(
        chatId,
        clamp(`${copy.coverageTitle}\n\n${copy.coveragePeriod(view.periodDays, view.jalaliRange)}\n\n${copy.coverageEmpty}`),
      );
      return "handled";
    }
    const rows = [
      // A clamped fetch may not have reached the oldest days of the period, in which case
      // `noRecordDays` is a floor of what is MISSING, not a count of it. Saying `7/30` while the
      // store returned 60 of 90 rows would present an unproven figure as a verdict, so the number
      // becomes a lower bound (`≥`) the moment `truncated` is true. The day-by-day figures that come
      // from rows actually read stay as they are — those rows are authoritative.
      `• ${copy.coverageDaysReviewed}: ${view.truncated ? "≥ " : ""}${String(s.daysWithRecord)}/${String(view.periodDays)}`,
      `• ${copy.coverageComplete}: ${String(s.completeDays)}`,
      `• ${copy.coveragePartial}: ${String(s.partialDays)}`,
      `• ${copy.coverageNoRecord}: ${view.truncated ? "≤ " : ""}${String(s.noRecordDays)}`,
    ];
    // RECEIVED vs NEEDED, with the store's own bound on the same line: `60/60 · 60` says the period
    // was read to its limit, `30/60 · 60` says thirty of its days simply had nothing in them. Those
    // are different facts, and the card used to blur them into one.
    rows.push(`• ${copy.coverageRecords}: ${String(view.recordsReceived)}/${String(view.recordsNeeded)} · ${String(view.recordsFetchedBound)}`);
    if (view.truncated) rows.push(`\n${copy.coverageTruncated(view.unverifiedDays)}`);
    // EVERY item with a non-zero count, ranked. A top-N cut would be a silent claim that the rest
    // were clean, so the list is only shortened for message length — and then it says so.
    const ranked = CHECKLIST_ITEMS.map((item) => ({ item, unreviewed: s.perItem[item].unreviewed, unknown: s.unknownByItem[item] }))
      .filter((r) => r.unreviewed > 0 || r.unknown > 0)
      // ONE comparator, in this order: most missing days first (so a truncation drops the least
      // informative rows), then unreviewed, then unknown, then the item name so ties are stable and
      // reproducible. Chaining two `.sort()` calls here silently cancelled the first one.
      .sort((a, c) =>
        (c.unreviewed + c.unknown) - (a.unreviewed + a.unknown)
        || c.unreviewed - a.unreviewed
        || c.unknown - a.unknown
        || a.item.localeCompare(c.item));
    // No top-N view. With eleven items a full list always fits one message, and any cap would hide a
    // non-zero count behind a "2 more" line that does not say WHICH — a truncated record statistic
    // reads as "the rest were clean", which is exactly the false claim this command exists to avoid.
    const shown = ranked;
    for (const r of shown) {
      const parts: string[] = [];
      if (r.unreviewed > 0) parts.push(`${copy.coverageUnreviewedLabel} ${String(r.unreviewed)}/${String(view.periodDays)}`);
      if (r.unknown > 0) parts.push(`${copy.coverageUnknownLabel} ${String(r.unknown)}/${String(view.periodDays)}`);
      rows.push(`• ${r.item} — ${parts.join(" · ")}`);
    }
    await this.safeSend(
      chatId,
      clamp(`${copy.coverageTitle}\n\n${copy.coveragePeriod(view.periodDays, view.jalaliRange)}\n\n${rows.join("\n")}`),
    );
    return "handled";
  }

  /** `/checklist` bare -> the prompt; with a body -> parse, merge into that day's row, confirm. */
  private async handleChecklistCommand(
    text: string,
    userId: string,
    tgId: string,
    chatId: string,
    locale: Locale | null,
  ): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const body = text.replace(/^\/checklist(@[A-Za-z0-9_]+)?\s*/, "").trim();
    if (body === "") {
      await this.safeSend(chatId, renderChecklistPrompt(copy, CHECKLIST_PROMPT_LINES));
      return "handled";
    }
    // `/checklist coverage [N]` — an aggregate of RECORDED states over the user's own last N days.
    // It reports what exists; it never labels a gap a mistake (see the domain function's header).
    const coverageMatch = /^coverage(?:\s+(\S+))?(?:\s|$)/i.exec(body);
    if (coverageMatch !== null) {
      const arg = (coverageMatch[1] ?? "").trim();
      const digits = toLatinDigits(arg);
      if (arg !== "" && !/^\d{1,2}$/.test(digits)) {
        await this.safeSend(chatId, copy.coverageDaysBad(arg));
        return "handled";
      }
      const days = digits === "" ? 7 : Number(digits);
      if (days < 1 || days > 60) {
        await this.safeSend(chatId, copy.coverageDaysBad(arg));
        return "handled";
      }
      return this.sendChecklistCoverage(chatId, userId, locale, days);
    }
    if (/^recent\b/i.test(body)) {
      const days = await this.deps.journal.recentChecklists(userId, 7);
      if (days.length === 0) {
        await this.safeSend(chatId, copy.checklistEmptyDay);
        return "handled";
      }
      const lines = days.map((d) =>
        `• ${d.date}: ${String(d.coverage.confirmed)}/${String(d.coverage.total)} ✅ · ${String(d.coverage.unknown)} ? · ${String(d.coverage.unreviewed)} ➖`,
      );
      await this.safeSend(chatId, clamp(`${copy.checklistRecentTitle}\n\n${lines.join("\n")}`));
      return "handled";
    }
    // A leading DAY chooses which day the report is about; without one, "today" is today in the
    // user's own timezone — never the server's.
    //
    // The day is read by the SAME contract /stats and the journal extractor use (`parseReportDateArg`
    // → `resolveChatDate`), so `1405-07-27` cannot mean one day here and another there. The rule this
    // replaces was `/^(\d{4}-\d{2}-\d{2})(?:\s+…)?$/` — Latin digits, zero-padded, Gregorian only.
    // Everything that regex accepted still resolves to the SAME ISO day (padded Latin years ≥ 1700);
    // what changes is that Persian digits, `j:`/`g:` markers and Jalali years are now UNDERSTOOD
    // instead of refused, and a day that exists in neither calendar is refused with a reason instead
    // of being read as some other day.
    const lead = readLeadingChatDate(body);
    const parsedDate = lead.consumed === "" ? { kind: "empty" as const } : this.deps.journal.parseReportDateArg(lead.consumed);
    const reportDate = parsedDate.kind === "ok" ? parsedDate.iso : null;
    const rest = lead.rest;
    if (parsedDate.kind === "rejected" || parsedDate.kind === "unreadable") {
      // Refuse loudly, write nothing. A `/checklist ۱۴۰۵-۱۳-۰۱` must not land on a real day the user
      // did not name, because that day's row would then MERGE into — and overwrite parts of — a review.
      await this.safeSend(chatId, parsedDate.kind === "rejected" && parsedDate.rejection.kind === "ambiguous"
        ? copy.checklistWindowAmbiguous(parsedDate.rejection.raw)
        : parsedDate.kind === "rejected"
          ? copy.checklistWindowGarbage(parsedDate.rejection.raw)
          : copy.checklistBadDate);
      return "handled";
    }
    if (reportDate !== null && rest === "") {
      const day = await this.deps.journal.readChecklist(userId, reportDate);
      const card = renderChecklist(copy, day.list, day.coverage, CHECKLIST_ITEMS);
      await this.safeSend(
        chatId,
        clamp(`${copy.checklistTitle} — ${day.reportDate}${day.stored ? "" : ` (${copy.checklistEmptyDay})`}\n\n${card}`),
      );
      return "handled";
    }
    try {
      const saved = await this.deps.journal.saveChecklist({
        userId,
        telegramUserId: tgId,
        text: rest,
        ...(reportDate === null ? {} : { reportDate }),
      });
      const card = renderChecklist(copy, saved.list, saved.coverage, CHECKLIST_ITEMS);
      const footer =
        saved.unparsed.length > 0
          ? `\n\n${copy.checklistUnparsed} ${saved.unparsed.map((u) => esc(u.key)).join(", ")}`
          : "";
      await this.safeSend(
        chatId,
        clamp(
          `${copy.checklistTitle} — ${saved.reportDate}\n\n${card}\n\n` +
            `${saved.created ? copy.checklistSavedNew : copy.checklistSavedMerge}${footer}`,
        ),
      );
      return "handled";
    } catch (err) {
      await this.safeSend(chatId, journalErrorText(err, copy));
      return "handled";
    }
  }

  /** `/trade <id>` — the detail card plus the two actions this build really offers on it. */
  private async sendTradeDetail(
    chatId: string,
    userId: string,
    text: string,
    locale: Locale | null,
  ): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const id = text.replace(/^\/trade(@[A-Za-z0-9_]+)?\s*/, "").trim().split(/\s+/)[0] ?? "";
    if (id === "") {
      await this.safeSend(chatId, copy.editUsage);
      return "handled";
    }
    return this.renderTradeCard(chatId, userId, id, locale);
  }

  private async renderTradeCard(
    chatId: string,
    userId: string,
    tradeId: string,
    locale: Locale | null,
  ): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    let detail: Record<string, unknown>;
    try {
      detail = await this.deps.journal.tradeDetail(userId, tradeId);
    } catch (err) {
      await this.safeSend(chatId, journalErrorText(err, copy));
      return "handled";
    }
    const version = String(detail["version"] ?? "");
    const keyboard: InlineKeyboardButton[][] = [
      [
        { text: copy.btnTradeEmotion, callbackData: buildCallbackData("trade_edit", `${tradeId}-emotion`) },
        { text: copy.btnTradeDelete, callbackData: buildCallbackData("trade_arm", tradeId) },
      ],
    ];
    // The version is printed on purpose: the user can see WHICH revision they are acting on, and the
    // confirm button carries the same number back as the compare-and-set token.
    await this.safeSend(
      chatId,
      clamp(`${copy.tradeDetailTitle} · \`${esc(tradeId)}\` · v${esc(version)}\n\n${renderTrade(copy, detail)}`),
      { inlineKeyboard: keyboard },
    );
    return "handled";
  }

  /** `/edit <id> <field> <value…>` — journaling fields only; anything else is refused by name. */
  private async handleEditCommand(
    chatId: string,
    userId: string,
    text: string,
    locale: Locale | null,
  ): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const parts = text.replace(/^\/edit(@[A-Za-z0-9_]+)?\s*/, "").trim().split(/\s+/);
    const tradeId = parts[0] ?? "";
    const field = (parts[1] ?? "").toLowerCase();
    const value = parts.slice(2).join(" ");
    if (tradeId === "" || field === "" || value === "") {
      await this.safeSend(chatId, copy.editUsage);
      return "handled";
    }
    const alias: Record<string, string> = { strategy: "strategyTag", emotion: "emotionalScore", notes: "notes" };
    const key = alias[field];
    if (key === undefined) {
      await this.safeSend(chatId, copy.fieldsImmutable);
      return "handled";
    }
    try {
      const current = await this.deps.journal.tradeDetail(userId, tradeId);
      const patch: Record<string, unknown> =
        key === "emotionalScore" ? { emotionalScore: Number.parseInt(value, 10) } : { [key]: value };
      await this.deps.journal.editTrade(userId, tradeId, { ...patch, version: current["version"] });
      await this.safeSend(chatId, copy.tradeEditDone);
      return "handled";
    } catch (err) {
      await this.safeSend(chatId, journalErrorText(err, copy));
      return "handled";
    }
  }

  private async sendSettings(chatId: string, userId: string, locale: Locale | null): Promise<UpdateOutcome> {
    const { copy } = this.copyFor(locale, { media: this.mediaAvailable });
    const [channel, identity] = await Promise.all([this.deps.store.findActiveChannel(userId), this.deps.store.findLiveIdentityByUserId(userId)]);
    const username = identity?.username == null || identity.username === "" ? "" : ` (@${esc(identity.username)})`;
    const lines = [copy.settingsBody(username), channel === null ? copy.settingsNoChannel : copy.settingsChannel(esc(channel.title ?? channel.chatId))];
    await this.safeSend(chatId, clamp(`${copy.settingsTitle}\n\n${lines.join("\n")}`), {
      inlineKeyboard: [
        [{ text: copy.btnChannelTest, callbackData: buildCallbackData("channel_test", "channel") }],
        [{ text: copy.btnUnlinkYes, callbackData: buildCallbackData("unlink", "yes") }],
      ],
    });
    return "handled";
  }

  // ── Infrastructure ────────────────────────────────────────────────────────

  /**
   * Per-identity throttling — the platform's existing fixed-window limiter, with
   * the Telegram user id as the bucket discriminator (a bot has no meaningful
   * client IP). Unlinked identities are limited too: onboarding must not become
   * a way to make the server do unbounded work.
   *
   * EVERY DECLARED `telegram:*` KEY IS WIRED SOMEWHERE, and this method is how the
   * expensive bot flows are covered: `telegram:update` bounds all traffic,
   * `telegram:journal` bounds draft creation and `telegram:analyze` bounds model
   * calls. A limit that exists only in the contracts table and in the security
   * documentation is not a control — it is a claim — so each key below has a call
   * site, and `telegramBot.test.ts` asserts each one actually refuses.
   */
  private async allowed(tgId: string, key: RateLimitKey = "telegram:update"): Promise<boolean> {
    const limiter = this.deps.limiter;
    if (limiter === undefined) return true;
    try {
      return (await limiter.hit(key, `tg:${tgId}`)).allowed;
    } catch {
      // A limiter-store outage must not take the bot down: failing closed on
      // every message would be worse than a short unthrottled window.
      return true;
    }
  }

  /**
   * Refuse a journal-creating action the user has no budget for, BEFORE anything
   * expensive happens.
   *
   * The ordering is the point. A voice note or a screenshot costs a provider call
   * and a download; checking the limit after them would let a throttled user keep
   * spending real money while being told to slow down. The caller checks this
   * first, and returns "rejected" without creating a draft row.
   */
  private async withinJournalBudget(chatId: string, tgId: string, locale: Locale | null): Promise<boolean> {
    if (await this.allowed(tgId, "telegram:journal")) return true;
    await this.safeSend(chatId, copyFor(locale).rateLimited);
    return false;
  }

  /** The analysis counterpart: a model call must not be reachable in a loop. */
  private async withinAnalyzeBudget(chatId: string, tgId: string, locale: Locale | null): Promise<boolean> {
    if (await this.allowed(tgId, "telegram:analyze")) return true;
    await this.safeSend(chatId, copyFor(locale).rateLimited);
    return false;
  }

  private async localeOrNull(telegramUserId: number | null): Promise<Locale | null> {
    return telegramUserId === null ? null : this.localeFor(String(telegramUserId));
  }

  private async localeFor(tgId: string): Promise<Locale | null> {
    const userId = await this.deps.links.resolveUserId(tgId);
    if (userId === null) return null;
    try {
      return await this.deps.getUserLocale(userId);
    } catch {
      return null; // a locale read must never break a flow
    }
  }

  /**
   * Photo send for a preview only — the preview goes to the private chat that asked for it, never to a
   * channel. Failures are swallowed into "nothing extra was sent", because a preview that could not
   * carry an image is not a reason to lose the approval buttons the user is about to tap; the outcome of
   * an actual PUBLISH is reported by the publish path, which does not swallow anything.
   */
  private async safeSendPhoto(chatId: string, bytes: Buffer, caption: string): Promise<void> {
    if (this.deps.api === null) return;
    try {
      await this.deps.api.sendPhoto(chatId, { bytes, filename: `velora-preview-${Date.now()}.png` }, { caption });
    } catch (err) {
      this.deps.log({ level: "warn", event: "telegram_preview_photo_failed", code: err instanceof TelegramApiError ? err.code : "UNKNOWN" });
    }
  }

  private async safeSend(chatId: string, text: string, options?: Parameters<TelegramBotApi["sendMessage"]>[2]): Promise<void> {
    try {
      await this.deps.api.sendMessage(chatId, clamp(text), options);
    } catch (err) {
      this.deps.log({ level: "warn", event: "telegram_send_failed", code: classifyError(err) });
    }
  }

  private async answer(callbackQueryId: string): Promise<void> {
    try {
      await this.deps.api.answerCallbackQuery(callbackQueryId);
    } catch (err) {
      // The button's action has already been decided; a missing acknowledgement
      // only leaves a spinner on the client.
      this.deps.log({ level: "warn", event: "telegram_callback_ack_failed", code: classifyError(err) });
    }
  }
}

/** `/cmd` or `/cmd@BotName`, optionally followed by arguments. */
/** One sentence per journal failure. A code is never the whole answer a user sees. */
function journalErrorText(err: unknown, copy: ReturnType<typeof copyFor>): string {
  const code = err instanceof JournalDraftError ? err.code : "";
  if (code === "TRADE_NOT_FOUND") return copy.tradeNotFound;
  if (code === "TRADE_VERSION_STALE") return copy.tradeStale;
  if (code === "FINANCIAL_FIELDS_IMMUTABLE") return copy.fieldsImmutable;
  if (code === "CHECKLIST_DATE_INVALID") return copy.checklistBadDate;
  // The offending text arrives in `field`; see `openFromText`, which puts the contract's raw token there.
  if (code === "JOURNAL_DATE_UNCLEAR") {
    const raw = err instanceof JournalDraftError && typeof err.field === "string" ? err.field : "";
    return copy.journalDateUnclear(raw);
  }
  return copy.genericError;
}

function matchesCommand(text: string, command: string): boolean {
  return new RegExp(`^/${command}${COMMAND_SUFFIX}(?:\\s|$)`).test(text);
}

/** `/stats today`, `/stats@MyVeloratradeBot week`, `/stats 2026-10-01` -> the argument, or nothing. */
function statsWindowArg(text: string): string | undefined {
  const m = /^\/stats\S*(?:\s+([\s\S]+))?$/.exec(text.trim());
  const arg = m?.[1]?.trim();
  return arg ? arg : undefined;
}

/** A window token as the user can say it, in their language. Unknown-but-parsable text is a date. */
function statsWindowLabel(copy: ReturnType<typeof copyFor>, kind: string): string {
  const k = kind.trim().toLowerCase();
  if (k === "today") return copy.statsWindowToday;
  if (k === "yesterday") return copy.statsWindowYesterday;
  if (k === "week" || k === "7d") return copy.statsWindowWeek;
  if (k === "all" || k === "all-time") return copy.statsWindowLabel;
  return k;
}

/** Map a linking refusal onto a sentence. Never a bare code, never a hint. */
function linkFailureText(copy: ReturnType<typeof copyFor>, code: string): string {
  switch (code) {
    case "TOKEN_EXPIRED":
      return copy.linkFailExpired;
    case "TOKEN_ALREADY_CONSUMED":
      return copy.linkFailUsed;
    case "TOKEN_REVOKED":
      return copy.linkFailRevoked;
    case "TOKEN_UNKNOWN":
      return copy.linkFailUnknown;
    case "IDENTITY_LINKED_TO_OTHER_ACCOUNT":
      return copy.linkFailIdentityTaken;
    case "ACCOUNT_ALREADY_LINKED":
      return copy.linkFailAccountTaken;
    default:
      return copy.linkFailPartner;
  }
}

/** Draft-level failure codes that mean "this draft is no longer actionable". */
function isGone(code: string): boolean {
  return code === "DRAFT_NOT_FOUND" || code === "DRAFT_EXPIRED";
}

/** Render a structured insight as readable lines, without inventing content. */
function renderInsight(insight: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(insight)) {
    if (value === null || value === undefined || value === "") continue;
    const label = esc(key.replace(/_/g, " "));
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      lines.push(`• <b>${label}</b>: ${esc(String(value))}`);
    } else if (Array.isArray(value)) {
      const items = value.slice(0, 6).map((item) => esc(typeof item === "string" ? item : JSON.stringify(item) ?? ""));
      if (items.length > 0) lines.push(`• <b>${label}</b>: ${items.join("، ")}`);
    }
  }
  return lines.length === 0 ? "—" : lines.join("\n");
}

/** Strip the bold tags copy uses, for messages that must be plain. */
function stripTags(text: string): string {
  return text.replace(/<\/?[a-z][^>]*>/g, "");
}

/** Fixed classification of a thrown error, safe to log and to store. */
function classifyError(err: unknown): string {
  if (err instanceof JournalDraftError) return err.code;
  if (err instanceof Error && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,48}$/.test(code)) return code;
  }
  return "UNEXPECTED";
}

/**
 * True when the identity's `last_seen_at` is inside the debounce window (60 s).
 *
 * Used only to skip a write that would record nothing new. `null`, an unparseable stamp, or a value
 * older than the window all answer false, i.e. the touch happens — the default stays "record it".
 */
function seenRecently(lastSeenAt: string | null, nowMs: number = Date.now()): boolean {
  if (lastSeenAt === null) return false;
  const at = Date.parse(lastSeenAt);
  if (!Number.isFinite(at)) return false;
  const age = nowMs - at;
  // The negative branch is not paranoia: a row stamped ahead of this clock (skew, or a write from a
  // peer with a fast clock) would otherwise satisfy `age < 60_000` forever and freeze the gauge.
  return age >= 0 && age < 60_000;
}
