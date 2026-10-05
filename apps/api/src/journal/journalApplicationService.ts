// Journal application service (ADR-018).
//
// CLIENT-AGNOSTIC ON PURPOSE. Nothing in this file mentions Telegram, a chat id
// or a bot: it takes an already-normalised draft and a resolved Velora user, and
// it writes through the EXISTING `TradeService`. The bot is one caller; the web
// journal, a future mobile client and a voice flow are others, and every one of
// them inherits the same validation, the same ADR-002 ledger fold and the same
// ownership rules instead of re-deriving any of them.
//
// THE WRITE PATH IS THE EXISTING ONE. Journal creation is
//   draft → confirmation → TradeService.createTrade → domain fold → ledger
// with no Telegram-specific insert anywhere. That is what makes a Telegram
// journal appear immediately in the web application: it IS the same record.
//
// WHY A CONFIRMATION CLAIM RATHER THAN A PRE-CHECK. `claimDraftForConfirmation`
// flips the draft to CONFIRMING atomically before the trade is created, so two
// simultaneous confirmations cannot both pass a check and write two trades. On a
// failed create the claim is RELEASED and the draft returns to an actionable
// state, so a domain rejection costs the user a retry rather than their draft.
import {
  applyFollowUp,
  draftToTradePayload,
  extractJournalDraft,
  hasAnyJournalValue,
  isDraftComplete,
  missingJournalFields,
  type JournalDraftFields,
  type JournalField,
} from "@velora/domain";
import { TELEGRAM_DRAFT_TTL_SECONDS } from "@velora/contracts";
import { TradeError, type TradeService } from "../trades/tradeService.js";
import type {
  TelegramDraftKind,
  TelegramDraftRecord,
  TelegramDraftState,
  TelegramStore,
} from "../telegram/telegramStore.js";

export class JournalDraftError extends Error {
  constructor(
    readonly code:
      | "DRAFT_NOT_FOUND"
      | "DRAFT_NOT_OWNED"
      | "DRAFT_EXPIRED"
      | "DRAFT_INCOMPLETE"
      | "DRAFT_ALREADY_CONFIRMED"
      | "DRAFT_CONFIRMATION_IN_PROGRESS"
      | "INVALID_JOURNAL_ENTRY",
    message: string,
    /** The field the domain rejected, when the failure names one. */
    readonly field: JournalField | string | null = null,
  ) {
    super(message);
    this.name = "JournalDraftError";
  }
}

/** What the presenter needs to render a confirmation or a rejection. */
export interface JournalDraftView {
  readonly draftId: string;
  readonly fields: JournalDraftFields;
  readonly missingFields: readonly string[];
  readonly state: TelegramDraftState;
  readonly complete: boolean;
  readonly sourceKind: TelegramDraftKind;
  readonly transcript: string | null;
}

export interface ConfirmResult {
  readonly tradeId: string;
  readonly trade: Record<string, unknown>;
}

export interface JournalApplicationServiceDeps {
  readonly trades: TradeService;
  readonly drafts: TelegramStore;
  /** Profile timezone (0002 `users.timezone`) — ADR-004 D-11 manual-time policy. */
  readonly getUserTimezone: (userId: string) => Promise<string>;
  readonly now?: () => Date;
  readonly draftTtlSeconds?: number;
}

export class JournalApplicationService {
  private readonly now: () => Date;
  private readonly ttlSeconds: number;

  constructor(private readonly deps: JournalApplicationServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.ttlSeconds = deps.draftTtlSeconds ?? TELEGRAM_DRAFT_TTL_SECONDS;
  }

  /**
   * Open a draft from a natural-language message.
   *
   * Values the parser could not find stay null and are reported in
   * `missingFields`; the caller must not attempt a write while that list is
   * non-empty (and `confirm` enforces it independently).
   */
  async openFromText(input: {
    readonly userId: string;
    readonly telegramUserId: string;
    readonly chatId: string;
    readonly sourceMessageId: string;
    readonly text: string;
    readonly sourceKind?: TelegramDraftKind;
    readonly transcript?: string | null;
    readonly media?: Record<string, unknown>;
  }): Promise<JournalDraftView> {
    const at = this.now();
    const timeZone = await this.safeTimezone(input.userId);
    const extracted = extractJournalDraft({ text: input.text, now: at, timeZone });
    const draft = await this.deps.drafts.createDraft({
      userId: input.userId,
      telegramUserId: input.telegramUserId,
      chatId: input.chatId,
      sourceMessageId: input.sourceMessageId,
      sourceKind: input.sourceKind ?? "TEXT",
      draft: extracted.fields,
      missingFields: extracted.missingRequired,
      transcript: input.transcript ?? null,
      media: input.media ?? {},
      expiresAt: new Date(at.getTime() + this.ttlSeconds * 1000),
      at,
    });
    return toView(draft);
  }

  /**
   * Extract WITHOUT persisting — lets a caller decide whether a message is a
   * journal attempt at all before any row is created.
   */
  async previewFromText(input: { readonly userId: string; readonly text: string }): Promise<{
    readonly fields: JournalDraftFields;
    readonly missingFields: readonly string[];
    readonly hasValue: boolean;
  }> {
    const timeZone = await this.safeTimezone(input.userId);
    const extracted = extractJournalDraft({ text: input.text, now: this.now(), timeZone });
    return {
      fields: extracted.fields,
      missingFields: extracted.missingRequired,
      hasValue: hasAnyJournalValue(extracted.fields),
    };
  }

  /**
   * Answer the field the bot asked about.
   *
   * OWNERSHIP IS CHECKED BEFORE ANYTHING ELSE, and the check is on the RESOLVED
   * user id (`draft.userId`), not on the Telegram id alone: a draft whose owner
   * does not match the caller's resolved account is reported as NOT_FOUND — the
   * same response a missing draft gives, so ids cannot be probed.
   */
  async answer(input: { readonly userId: string; readonly telegramUserId: string; readonly draftId: string; readonly answer: string }): Promise<JournalDraftView> {
    const at = this.now();
    const draft = await this.requireOwnedDraft(input.draftId, input.userId, input.telegramUserId, at);
    const next = missingJournalFields(draft.draft)[0];
    if (next === undefined) {
      throw new JournalDraftError("DRAFT_INCOMPLETE", "Nothing is missing from this entry.", null);
    }
    const merged = applyFollowUp(draft.draft, next, input.answer);
    const missing = missingJournalFields(merged);
    if (missing.includes(next)) {
      // The answer did not yield a usable value. Keep the draft open on the same
      // field so the user can simply try again — never guess a value for them.
      throw new JournalDraftError("DRAFT_INCOMPLETE", "That value could not be read.", next);
    }
    const updated = await this.deps.drafts.updateDraft(
      draft.id,
      { draft: merged, missingFields: missing, state: missing.length === 0 ? "AWAITING_CONFIRMATION" : "NEEDS_DETAIL" },
      at,
    );
    if (updated === null) throw new JournalDraftError("DRAFT_NOT_FOUND", "That entry is no longer available.");
    return toView(updated);
  }

  /**
   * Confirm and WRITE.
   *
   * Order of operations is the safety property:
   *   1. ownership + actionability,
   *   2. completeness (a draft with unknown required fields cannot be written),
   *   3. CLAIM (atomic, cross-process),
   *   4. the existing TradeService create — the only writer,
   *   5. bind the trade to the draft.
   * A domain rejection at step 4 releases the claim and re-opens the draft.
   */
  async confirm(input: { readonly userId: string; readonly telegramUserId: string; readonly draftId: string }): Promise<ConfirmResult> {
    const at = this.now();
    const draft = await this.requireOwnedDraft(input.draftId, input.userId, input.telegramUserId, at);
    const missing = missingJournalFields(draft.draft);
    if (missing.length > 0) {
      throw new JournalDraftError("DRAFT_INCOMPLETE", "This entry is missing required values.", missing[0] ?? null);
    }
    if (!isDraftComplete(draft.draft)) {
      throw new JournalDraftError("DRAFT_INCOMPLETE", "This entry is missing required values.", null);
    }

    const claimed = await this.deps.drafts.claimDraftForConfirmation(draft.id, at);
    if (!claimed) {
      const current = await this.deps.drafts.findDraftById(draft.id);
      if (current !== null && current.state === "CONFIRMED") {
        throw new JournalDraftError("DRAFT_ALREADY_CONFIRMED", "This entry was already saved.");
      }
      throw new JournalDraftError("DRAFT_CONFIRMATION_IN_PROGRESS", "This entry is already being saved.");
    }

    let trade: Record<string, unknown>;
    try {
      trade = await this.deps.trades.createTrade(input.userId, draftToTradePayload(draft.draft));
    } catch (err) {
      // The domain is authoritative and it just refused. Re-open the draft so the
      // user loses nothing, and name the field when the refusal names one.
      const field = err instanceof TradeError && typeof err.details?.["field"] === "string" ? (err.details["field"] as string) : null;
      const reopenable = field !== null && (["symbol", "direction", "entryPrice", "exitPrice", "volume"] as readonly string[]).includes(field);
      if (reopenable) {
        const cleared: JournalDraftFields = { ...draft.draft, [field as JournalField]: null };
        await this.deps.drafts.updateDraft(draft.id, { draft: cleared, missingFields: missingJournalFields(cleared), state: "NEEDS_DETAIL" }, at);
        await this.deps.drafts.releaseConfirmationClaim(draft.id, "NEEDS_DETAIL", at);
        throw new JournalDraftError("INVALID_JOURNAL_ENTRY", "The trading platform rejected a value.", field);
      }
      await this.deps.drafts.releaseConfirmationClaim(draft.id, "AWAITING_CONFIRMATION", at);
      throw new JournalDraftError("INVALID_JOURNAL_ENTRY", "The entry could not be saved.", field);
    }

    const tradeId = String(trade["id"] ?? "");
    const bound = await this.deps.drafts.markDraftConfirmed(draft.id, tradeId, at);
    if (!bound) {
      // The trade exists and is the truth; failing to bind the draft must not be
      // reported as a failed save. It is a bookkeeping gap, and the idempotency
      // ledger (`telegram_updates`) already prevents a second create for the
      // same update.
      return { tradeId, trade };
    }
    return { tradeId, trade };
  }

  /** Cancel an actionable draft. Idempotent: a cancelled draft stays cancelled. */
  async cancel(input: { readonly userId: string; readonly telegramUserId: string; readonly draftId: string }): Promise<void> {
    const at = this.now();
    const draft = await this.requireOwnedDraft(input.draftId, input.userId, input.telegramUserId, at);
    if (draft.state === "CONFIRMED") {
      throw new JournalDraftError("DRAFT_ALREADY_CONFIRMED", "This entry was already saved.");
    }
    await this.deps.drafts.updateDraft(draft.id, { state: "CANCELLED" }, at);
  }

  /** The draft the bot should act on when a message arrives without an id. */
  async currentDraft(userId: string, telegramUserId: string): Promise<JournalDraftView | null> {
    const at = this.now();
    const draft = await this.deps.drafts.findOpenDraft(telegramUserId, at);
    if (draft === null) return null;
    if (draft.userId !== userId) return null; // ownership mismatch is "no draft", never a disclosure
    if (Date.parse(draft.expiresAt) <= at.getTime()) {
      await this.deps.drafts.updateDraft(draft.id, { state: "EXPIRED" }, at);
      return null;
    }
    return toView(draft);
  }

  /** Most recent journal entry, or null. Reads through the existing search path. */
  async latest(userId: string): Promise<Record<string, unknown> | null> {
    const result = await this.deps.trades.searchTrades(userId, { page: "1", limit: "1", order: "open_time" });
    const items = Array.isArray(result["items"]) ? (result["items"] as Record<string, unknown>[]) : [];
    return items[0] ?? null;
  }

  /** Paginated journal history for one user. */
  async history(userId: string, input: { readonly page?: number; readonly limit?: number } = {}): Promise<{
    readonly items: readonly Record<string, unknown>[];
    readonly page: number;
    readonly totalPages: number;
    readonly total: number;
  }> {
    const page = Math.max(1, input.page ?? 1);
    const limit = Math.max(1, Math.min(20, input.limit ?? 5));
    const result = await this.deps.trades.searchTrades(userId, { page: String(page), limit: String(limit), order: "open_time" });
    const items = Array.isArray(result["items"]) ? (result["items"] as Record<string, unknown>[]) : [];
    const pagination = (result["pagination"] ?? {}) as Record<string, unknown>;
    return {
      items,
      page,
      totalPages: Number(pagination["totalPages"] ?? 1),
      total: Number(pagination["total"] ?? items.length),
    };
  }

  /** Expire abandoned drafts. Called opportunistically; not a background job. */
  async expireStale(): Promise<number> {
    return this.deps.drafts.expireStaleDrafts(this.now());
  }

  private async requireOwnedDraft(draftId: string, userId: string, telegramUserId: string, at: Date): Promise<TelegramDraftRecord> {
    const draft = await this.deps.drafts.findDraftById(draftId);
    // A missing draft, another user's draft and a draft belonging to a different
    // Telegram identity all produce the SAME error. Nothing here tells a caller
    // which of the three happened.
    if (draft === null || draft.userId !== userId || draft.telegramUserId !== telegramUserId) {
      throw new JournalDraftError("DRAFT_NOT_FOUND", "That entry is no longer available.");
    }
    if ((draft.state === "AWAITING_CONFIRMATION" || draft.state === "NEEDS_DETAIL") && Date.parse(draft.expiresAt) <= at.getTime()) {
      await this.deps.drafts.updateDraft(draft.id, { state: "EXPIRED" }, at);
      throw new JournalDraftError("DRAFT_EXPIRED", "That entry expired.");
    }
    return draft;
  }

  private async safeTimezone(userId: string): Promise<string> {
    try {
      const zone = await this.deps.getUserTimezone(userId);
      return zone.trim() === "" ? "UTC" : zone;
    } catch {
      // A profile lookup failure must not fail journaling; the fallback is UTC,
      // which is also 0002's column default.
      return "UTC";
    }
  }
}

function toView(draft: TelegramDraftRecord): JournalDraftView {
  return {
    draftId: draft.id,
    fields: draft.draft,
    missingFields: draft.missingFields,
    state: draft.state,
    complete: isDraftComplete(draft.draft),
    sourceKind: draft.sourceKind,
    transcript: draft.transcript,
  };
}
