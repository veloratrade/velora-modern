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
//   1. IDEMPOTENCY. Every update is claimed before any work happens
//      (`telegram_updates`, keyed by Telegram's own update id), so a retried
//      delivery cannot create a second journal entry, cannot act on a button
//      twice and cannot spend a linking token twice.
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
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate,
} from "@velora/contracts";
import { JournalDraftError, type JournalApplicationService, type JournalDraftView } from "../journal/journalApplicationService.js";
import { clamp, copyFor, esc, labelForField, renderDraft, renderTrade, type Locale } from "./telegramCopy.js";
import type { JournalAnalysisService } from "../journal/journalAnalysisService.js";
import type { AttachmentService } from "../attachments/attachmentService.js";
import type { AiAttemptStore } from "../aicoach/aiProvider.js";
import type { InlineKeyboardButton, TelegramBotApi } from "./telegramApi.js";
import { interpretImageAndRecord, transcribeAndRecord, type MediaInterpreter } from "../aicoach/mediaInterpreter.js";
import type { RateLimiter } from "../ratelimits/rateLimiter.js";
import type { TelegramChannelRecord, TelegramDraftKind, TelegramStore } from "./telegramStore.js";
import type { TelegramLinkService } from "./telegramLinkService.js";

export interface TelegramBotDeps {
  readonly api: TelegramBotApi;
  readonly store: TelegramStore;
  readonly links: TelegramLinkService;
  readonly journal: JournalApplicationService;
  readonly analysis: JournalAnalysisService;
  readonly media: { readonly interpreter: MediaInterpreter; readonly attempts: AiAttemptStore };
  /** Absent ⇒ screenshots are recorded as metadata only; the entry still saves. */
  readonly attachments?: AttachmentService | undefined;
  /** Absent ⇒ no throttling beyond the Bot API's own limits. */
  readonly limiter?: RateLimiter | undefined;
  /** Public web origin for the onboarding link. A thunk: config may be absent. */
  readonly appUrl: () => string | null;
  readonly getUserLocale: (userId: string) => Promise<Locale | null>;
  readonly log: (event: Record<string, unknown>) => void;
  readonly now?: () => Date;
}

export type UpdateOutcome = "handled" | "ignored" | "rejected" | "failed";

/** Command aliases: `/cmd` and `/cmd@BotName` are the same command. */
const COMMAND_SUFFIX = "(?:@[A-Za-z0-9_]{3,32})?";

export class TelegramBot {
  private readonly now: () => Date;

  constructor(private readonly deps: TelegramBotDeps) {
    this.now = deps.now ?? (() => new Date());
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
   * Dispatch a CLAIMED update and record how it ended.
   *
   * The `finally` block is the durability guarantee: whatever happens below —
   * including a thrown error — the claimed row is stamped with an outcome, so an
   * update that is stuck unprocessed is visible rather than invisible.
   */
  async processClaimed(update: TelegramUpdate): Promise<UpdateOutcome> {
    const kind = classifyUpdate(update);
    const telegramUserId = update.message?.from?.id ?? update.callback_query?.from.id ?? null;
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? null;
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
      await this.deps.store.finishUpdate(String(update.update_id), outcome, errorCode, this.now()).catch(() => undefined);
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
    const locale = await this.localeOrNull(telegramUserId);
    if (!(await this.allowed(tgId))) {
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
    const copy = copyFor(locale);
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
      await this.safeSend(chatId, clamp(`${copy.helpTitle}\n\n${copy.helpBody}`));
      return "handled";
    }

    // Every remaining path needs an account. Onboarding is the ONLY thing an
    // unlinked identity can reach — including for `/link`, which cannot build a
    // token for a Telegram user the platform does not know yet.
    if (userId === null) return this.sendOnboarding(chatId, locale);

    const identity = await this.deps.store.findLiveIdentityByTelegramUserId(tgId);
    if (identity !== null) await this.deps.links.touch(identity.id);

    if (matchesCommand(text, "unlink")) return this.confirmUnlink(chatId, locale, userId);
    if (matchesCommand(text, "settings")) return this.sendSettings(chatId, userId, locale);
    if (matchesCommand(text, "last")) return this.sendLast(chatId, userId, locale);
    if (matchesCommand(text, "history")) return this.sendHistory(chatId, userId, locale, 1);
    if (matchesCommand(text, "analyze")) return this.sendAnalysis(chatId, userId, locale);
    if (matchesCommand(text, "channel")) return this.handleChannelCommand(text, userId, chatId, locale);
    if (matchesCommand(text, "journal")) {
      await this.safeSend(chatId, copy.journalPrompt);
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

    // Ordinary conversation must not create a row. The parser decides, not a
    // keyword list here: if the message carries no journal value at all, it is
    // chat, and the bot answers with the menu instead of an empty draft.
    const preview = await this.deps.journal.previewFromText({ userId, text });
    if (!preview.hasValue && preview.missingFields.length === 5) {
      await this.safeSend(chatId, copy.journalNoData);
      return "handled";
    }
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
    const copy = copyFor(locale);
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

  private async sendMenu(chatId: string, userId: string, locale: Locale | null): Promise<UpdateOutcome> {
    void userId;
    const copy = copyFor(locale);
    const keyboard: InlineKeyboardButton[][] = [
      [{ text: copy.btnNewJournal, callbackData: buildCallbackData("menu", "journal") }],
      [
        { text: copy.btnLastTrade, callbackData: buildCallbackData("menu", "last") },
        { text: copy.btnHistory, callbackData: buildCallbackData("menu", "history") },
      ],
      [
        { text: copy.btnAnalyze, callbackData: buildCallbackData("menu", "analyze") },
        { text: copy.btnSettings, callbackData: buildCallbackData("menu", "settings") },
      ],
    ];
    await this.safeSend(chatId, clamp(`${copy.menuTitle}\n\n${copy.menuBody}`), { inlineKeyboard: keyboard });
    return "handled";
  }

  private async confirmUnlink(chatId: string, locale: Locale | null, userId: string): Promise<UpdateOutcome> {
    void userId;
    const copy = copyFor(locale);
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
    const view = await this.deps.journal.openFromText({
      userId,
      telegramUserId: tgId,
      chatId,
      sourceMessageId: messageId,
      text,
      sourceKind: kind,
      transcript,
      media,
    });
    return this.presentDraft(chatId, view, locale, kind === "TEXT" ? null : copyFor(locale).photoStored);
  }

  /** Send the confirmation card, or ask for the ONE field that is still missing. */
  private async presentDraft(chatId: string, view: JournalDraftView, locale: Locale | null, prefix: string | null): Promise<UpdateOutcome> {
    const copy = copyFor(locale);
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
    await this.safeSend(chatId, clamp(`${text}\n\n❓ ${copy.promptFor[missing as keyof typeof copy.promptFor] ?? copy.journalPrompt}`), {
      inlineKeyboard: [[{ text: copy.btnCancel, callbackData: buildCallbackData("cancel", view.draftId) }]],
    });
    return "handled";
  }

  private async applyAnswer(userId: string, tgId: string, chatId: string, open: JournalDraftView, answer: string, locale: Locale | null): Promise<UpdateOutcome> {
    const copy = copyFor(locale);
    try {
      const view = await this.deps.journal.answer({ userId, telegramUserId: tgId, draftId: open.draftId, answer });
      return this.presentDraft(chatId, view, locale, null);
    } catch (err) {
      if (err instanceof JournalDraftError) {
        if (err.code === "DRAFT_INCOMPLETE" && err.field !== null) {
          // The value did not parse as the field that was asked for. Say which
          // field and ask again — do not guess a different interpretation.
          await this.safeSend(chatId, `${copy.confirmedRejected(labelForField(copy, err.field, locale ?? "fa"))}\n❓ ${copy.promptFor[err.field as keyof typeof copy.promptFor] ?? copy.journalPrompt}`);
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
    const copy = copyFor(locale);

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
      switch (subject) {
        case "journal":
          await this.safeSend(chatId, copy.journalPrompt);
          return "handled";
        case "last":
          return this.sendLast(chatId, userId, locale);
        case "history":
          return this.sendHistory(chatId, userId, locale, 1);
        case "analyze":
          return this.sendAnalysis(chatId, userId, locale);
        case "settings":
          return this.sendSettings(chatId, userId, locale);
        default:
          await this.safeSend(chatId, copy.genericError);
          return "rejected";
      }
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
    if (action === "channel_test") return this.testChannel(chatId, userId, locale);
    if (action === "connect") return this.sendOnboarding(chatId, locale);
    if (action === "edit") {
      const open = await this.deps.journal.currentDraft(userId, tgId);
      if (open === null) {
        await this.safeSend(chatId, copy.journalPrompt);
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
    const copy = copyFor(locale);
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
    const copy = copyFor(locale);
    const voice = message.voice ?? message.audio;
    if (voice === undefined) return this.sendMenu(chatId, userId, locale);
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
    const copy = copyFor(locale);
    const photos = message.photo ?? [];
    // Telegram sends several renditions; the largest is the most readable and is
    // the one a chart screenshot needs.
    const largest = photos.reduce((best, candidate) => ((candidate.file_size ?? 0) >= (best.file_size ?? 0) ? candidate : best), photos[0]!);

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
    const copy = copyFor(locale);
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

  private async handleChannelCommand(text: string, userId: string, chatId: string, locale: Locale | null): Promise<UpdateOutcome> {
    const copy = copyFor(locale);
    const argument = text.replace(new RegExp(`^/channel${COMMAND_SUFFIX}`), "").trim();
    if (argument === "") {
      await this.safeSend(chatId, copy.channelHint);
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
      const canPost =
        chat.type === "channel" || chat.type === "supergroup"
          ? member.canPostMessages
          : member.status === "creator" || member.status === "administrator" || member.status === "member";
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

  private async testChannel(chatId: string, userId: string, locale: Locale | null): Promise<UpdateOutcome> {
    const copy = copyFor(locale);
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
    const copy = copyFor(locale);
    const trade = await this.deps.journal.latest(userId);
    if (trade === null) {
      await this.safeSend(chatId, copy.lastEmpty);
      return "handled";
    }
    await this.safeSend(chatId, clamp(`${copy.lastTitle}\n\n${renderTrade(copy, trade)}`));
    return "handled";
  }

  private async sendHistory(chatId: string, userId: string, locale: Locale | null, page: number): Promise<UpdateOutcome> {
    const copy = copyFor(locale);
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

  private async sendAnalysis(chatId: string, userId: string, locale: Locale | null): Promise<UpdateOutcome> {
    const copy = copyFor(locale);
    await this.safeSend(chatId, copy.analyzeWorking);
    const result = await this.deps.analysis.analyze(userId);
    if (result.status !== "ok") {
      if (result.status === "error") this.deps.log({ level: "warn", event: "ai_analysis_failed", code: result.code });
      const text =
        result.code === "PROVIDER_NOT_CONFIGURED"
          ? copy.analyzeDisabled
          : result.code === "CONSENT_REQUIRED"
            ? copy.analyzeConsent
            : result.code === "NO_DATA"
              ? copy.analyzeEmpty
              : copy.analyzeFailed;
      await this.safeSend(chatId, text);
      return "handled";
    }
    // MODEL-GENERATED ANALYSIS, and the message says so. It is not a trading
    // record; nothing in this path writes to the ledger or the event log.
    await this.safeSend(chatId, clamp(`${copy.analyzeTitle}\n\n${renderInsight(result.insight)}\n\n${copy.analyzeDisclaimer}`));
    return "handled";
  }

  private async sendSettings(chatId: string, userId: string, locale: Locale | null): Promise<UpdateOutcome> {
    const copy = copyFor(locale);
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
   */
  private async allowed(tgId: string): Promise<boolean> {
    const limiter = this.deps.limiter;
    if (limiter === undefined) return true;
    try {
      return (await limiter.hit("telegram:update", `tg:${tgId}`)).allowed;
    } catch {
      // A limiter-store outage must not take the bot down: failing closed on
      // every message would be worse than a short unthrottled window.
      return true;
    }
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
function matchesCommand(text: string, command: string): boolean {
  return new RegExp(`^/${command}${COMMAND_SUFFIX}(?:\\s|$)`).test(text);
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
