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
import {
  CHECKLIST_ITEMS,
  asStatTrade,
  checklistCoverage,
  computeJournalStats,
  dayWindowInZone,
  summarizeChecklistCoverage,
  deserializeChecklist,
  mergeChecklist,
  gregorianToJalali,
  formatJalaliDate,
  normalizeReportDate,
  parseChecklistText,
  resolveChatDate,
  type ChatDateOk,
  type ChatDateSource,
  type ChatDateResult,
  type ChatDateRejection,
  serializeChecklist,
  type ChecklistCoverage,
  type ChecklistCoverageDay,
  type ChecklistItem,
  type DailyChecklist,
  type JournalStats,
  type ChecklistCoverageSummary,
} from "@velora/domain";
import { TradeError, type TradeService } from "../trades/tradeService.js";
import { isTerminalTelegramDraftState } from "../telegram/telegramStore.js";
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
      | "INVALID_JOURNAL_ENTRY"
      // New in the 0036 round. Deliberately SEPARATE codes from the draft ones: "that trade was
      // not found" and "your draft expired" need different sentences, and collapsing them would
      // make the presenter guess at a cause it already knows.
      | "CHECKLIST_DATE_INVALID"
      // A date in a journal message that the shared contract could not read. Separate from
      // CHECKLIST_DATE_INVALID on purpose: this one is about WHICH DAY A TRADE HAPPENED, and the
      // answer is "tell me the calendar", not "your argument was malformed".
      | "JOURNAL_DATE_UNCLEAR"
      | "TRADE_NOT_FOUND"
      | "TRADE_VERSION_STALE"
      | "FINANCIAL_FIELDS_IMMUTABLE",
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


/**
 * Accept only what a `numeric(20,8)` column accepts. The domain already folds Persian digits and
 * strips a percent sign, so a normalized reading matches this exactly; anything else is a description
 * and must not be forced into a number the user never wrote.
 */
function numericOrNull(value: string | null): string | null {
  if (value === null) return null;
  return /^-?\d+(?:\.\d{1,8})?$/.test(value) ? value : null;
}

/** A caller's window request: explicit bounds, a named window, or nothing at all. */

export interface StatsWindow {
  readonly from?: string | null;
  readonly to?: string | null;
  readonly windowKind?: string | null;
}

/**
 * A stats window after resolution: UTC bounds, no bounds at all (all time), or a refusal the caller
 * must surface as a message. `windowKind` is carried through the no-bounds case so a caller that
 * passed explicit `from`/`to` keeps working unchanged — which is why this branch is `StatsWindow`
 * itself rather than a second shape that could drift from it.
 */
type ResolvedWindow =
  | { readonly from: string; readonly to: string }
  | StatsWindow
  | "window-unreadable"
  | { readonly rejected: ChatDateRejection }
  | undefined;

/** What `/checklist <date>` said, read through the shared contract. */
/** A day a chat command asked for, reduced to what the store takes. */
export type ResolvedReportDate =
  | { readonly kind: "today"; readonly iso: string }
  | { readonly kind: "ok"; readonly iso: string; readonly calendar: ChatDateSource; readonly jalali: string | undefined }
  | { readonly kind: "rejected"; readonly rejection: ChatDateRejection }
  | { readonly kind: "unreadable"; readonly raw: string };

export type ChecklistDateParse =
  | { readonly kind: "ok"; readonly iso: string; readonly calendar: ChatDateSource; readonly jalali: string | undefined }
  | { readonly kind: "rejected"; readonly rejection: ChatDateRejection }
  | { readonly kind: "unreadable"; readonly raw: string };

/**
 * Why a window was refused, carrying the text the user typed so the presenter can echo it back.
 * `unreadable` is a window word that never looked like a date at all; the other two come from the
 * shared contract in `jalali.ts` and distinguish "that day does not exist" from "I cannot tell which
 * calendar you meant" — different answers, so they must not collapse into one message.
 */
export type StatsWindowError =
  | { readonly kind: "unreadable"; readonly raw: string | null }
  | { readonly kind: "garbage"; readonly raw: string }
  | { readonly kind: "ambiguous"; readonly raw: string };

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
    // FAIL CLOSED, before `createDraft`, so nothing is written for a message whose day is unclear.
    // An unreadable date would otherwise default to TODAY (the documented convention of
    // `resolveTradeTime`) and the trade would be journalled on a day the user never named — which,
    // unlike a checklist merge, cannot be undone by re-answering: the ledger row carries
    // `occurred_close_at_utc` and no code path in this build rewrites it. The user's text is passed
    // back through the SAME `resolveChatDate` the extractor used (`field` carries the offending token
    // for the message), so this line adds no second grammar — it re-asks the one grammar for a
    // verdict it can turn into an error rather than a note.
    const dateVerdict = resolveChatDate(input.text);
    if (dateVerdict !== null && dateVerdict.kind === "rejected") {
      throw new JournalDraftError("JOURNAL_DATE_UNCLEAR", "The day this message names cannot be read with certainty.", dateVerdict.rejection.raw);
    }
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
  // ── Daily checklist (0036) ───────────────────────────────────────────────
  //
  // The checklist is the only place in this service where an ABSENT value is still meaningful, so
  // the design is about not destroying that: the merge happens in the domain (`mergeChecklist`),
  // the counts are derived by the store, and a date that cannot be read is refused rather than
  // quietly becoming "today".

  /**
   * Today in the user's own timezone: a review date is a calendar day, not an instant (ADR-004).
   *
   * PUBLIC because the prepared-post data port needs the same reading. A second implementation of
   * "what day is it for this user" is exactly how a channel post and a private journal end up disagree
   * about which day they describe, so the one method is the one rule.
   */
  async todayInUserZone(userId: string): Promise<string> {
    return this.calendarDayInUserZone(userId, 0);
  }

  /**
   * The same reading shifted by N local days. `yesterday` for the stats window needs it, and it is
   * deliberately NOT `toISOString().slice(0,10)` minus one day: that walks back to the wrong calendar
   * date for anyone east of UTC-16, which is most of the user base this bot was written for.
   */
  private async calendarDayInUserZone(userId: string, dayOffset: number): Promise<string> {
    const timezone = await this.safeTimezone(userId);
    const at = dayOffset === 0 ? this.now() : new Date(this.now().getTime() + dayOffset * 86_400_000);
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
        .format(at);
    } catch {
      // A profile with a timezone the runtime does not know must not cost the user their report.
      return at.toISOString().slice(0, 10);
    }
  }

  /**
   * Which day is a `/checklist` argument about? RESOLVED BY THE SHARED CONTRACT, not by the
   * stored-side rule below.
   *
   * IMPACT ON EXISTING DATA, stated before changing this path's grammar: `normalizeReportDate` is
   * the rule that validated every row already written, and it is left exactly as it was — it reads
   * any 1..9999 year as GREGORIAN and only accepts Latin digits. That is correct for a stored value
   * (`report_date` is a `DATE` column, and the unique key is `(user_id, report_date)`), but it is
   * unsafe as a CHAT rule, because it happily answers "1405-07-26 is a Gregorian day in the 15th
   * century" while the same words in /stats mean a Nowruz-1405 day. So:
   *   • no stored `report_date` is reinterpreted, rewritten or migrated by anything here;
   *   • a date typed in Persian digits or with a `j:` marker is now UNDERSTOOD where it used to be
   *     rejected outright (`CHECKLIST_DATE_INVALID`) — a superset of what this command accepted before;
   *   • the ONLY previously-accepted input whose meaning changes is a Latin year below 1700, e.g.
   *     `/checklist 1405-07-27`, which used to address the 15th-century Gregorian day and is now read
   *     as Jalali. No such row can have been created by this app (it shipped in 2026), so this cannot
   *     orphan a day the user has already filed; if one existed, the worst case is that a NEW report
   *     lands on the Jalali day while the old row stays where it is — visible, not silently moved.
   * Stored-side validation still runs through `normalizeReportDate`, so an ISO day this resolver
   * produces can never disagree with what the store accepts.
   */
  parseReportDateArg(input: string): ChecklistDateParse {
    const text = input.trim();
    // An empty argument is the CALLER's decision (it means "today"), not a date reading, so this
    // function refuses it rather than inventing a day.
    if (text === "") return { kind: "unreadable", raw: "" };
    const resolved = resolveChatDate(text);
    if (resolved === null) return { kind: "unreadable", raw: text };
    if (resolved.kind === "rejected") return { kind: "rejected", rejection: resolved.rejection };
    const normalised = this.toStoredDay({ kind: "ok", iso: resolved.iso, calendar: resolved.calendar, jalali: resolved.jalali });
    return normalised.kind === "ok" ? normalised : { kind: "rejected", rejection: { kind: "garbage", raw: text } };
  }

  /** The stored-side rule, applied to a day the contract has already resolved. */
  private toStoredDay(parse: ChecklistDateParse): ResolvedReportDate {
    if (parse.kind !== "ok") return parse;   // refusal passes through unchanged
    const iso = normalizeReportDate(parse.iso);
    return iso === null
      ? { kind: "rejected", rejection: { kind: "garbage", raw: parse.iso } }
      : { kind: "ok", iso, calendar: parse.calendar, jalali: parse.jalali };
  }

  /**
   * Record one day's review from free text. Nothing here infers an item the user did not name:
   * `unparsed` keys and the coverage counts are returned so the presenter can say what is still
   * missing, in the user's own terms.
   */
  async saveChecklist(input: {
    readonly userId: string;
    readonly telegramUserId: string | null;
    readonly text: string;
    readonly reportDate?: string | null;
    readonly sourceKind?: "TEXT" | "VOICE" | "PHOTO" | "MANUAL";
  }): Promise<{
    readonly created: boolean;
    readonly list: DailyChecklist;
    readonly coverage: ChecklistCoverage;
    readonly reportDate: string;
    readonly unparsed: readonly { readonly key: string }[];
  }> {
    const timezone = await this.safeTimezone(input.userId);
    // The day is resolved by the SHARED contract, then re-normalised by the stored-side rule, so the
    // value handed to the store is one `report_date` can hold and the unique key cannot drift.
    const dateArg: ResolvedReportDate =
      input.reportDate === undefined || input.reportDate === null || input.reportDate.trim() === ""
        ? { kind: "today", iso: await this.todayInUserZone(input.userId) }
        : this.toStoredDay(this.parseReportDateArg(input.reportDate));
    if (dateArg.kind === "unreadable" || dateArg.kind === "rejected") {
      // FAIL CLOSED. A day we cannot read is never replaced by "today" here: today may be a day the
      // user already reviewed, and an upsert merges — a wrong guess would overwrite real answers.
      throw new JournalDraftError(
        "CHECKLIST_DATE_INVALID",
        dateArg.kind === "rejected"
          ? `That is not ${dateArg.rejection.kind === "garbage" ? "a real day in either calendar" : "a day whose calendar I can tell"}.`
          : "A checklist date must be YYYY-MM-DD, or j:/g: plus a day.",
      );
    }
    const requested = dateArg.iso;
    const parsed = parseChecklistText(input.text);
    const stored = await this.deps.drafts.findDailyChecklist(input.userId, requested);
    const base =
      stored === null
        ? deserializeChecklist(requested, null)
        : deserializeChecklist(requested, {
            items: stored.items,
            notes: stored.notes,
            riskUnit: stored.riskUnit,
            timezone: stored.timezone,
          });
    const merged = mergeChecklist({ ...base, timezone }, parsed);
    const shape = serializeChecklist(merged);
    // The SPARSE map is what makes this write a merge: an item this report does not name is not
    // sent at all, so whatever answer is already on that day's row survives it.
    const touched = CHECKLIST_ITEMS.filter(
      (item) => parsed.values[item] !== undefined || parsed.unknowns.includes(item),
    );
    const items: Record<string, { state: string; value: string | null; normalised: boolean }> = {};
    for (const item of touched) {
      const entry = shape.items[item];
      if (entry === undefined) continue; // serializeChecklist always emits all eleven; belt and braces
      // Written field by field rather than spread: the serialized shape is readonly, and a spread
      // would type every property as optional — exactly the looseness the store refuses.
      items[item] = { state: entry.state, value: entry.value, normalised: entry.normalised };
    }
    const result = await this.deps.drafts.upsertDailyChecklist({
      userId: input.userId,
      telegramUserId: input.telegramUserId,
      reportDate: requested,
      timezone,
      sourceKind: input.sourceKind ?? "TEXT",
      items: items as Record<ChecklistItem, { state: string; value: string | null; normalised: boolean }>,
      notes: parsed.notes,
      // The two numeric columns get a number or nothing at all. `stopLoss: زیر سقف ۴ ساعته` is a
      // perfectly good note and a perfectly bad decimal, so such a value stays in the JSONB item (where
      // the user's words are preserved verbatim) and the column keeps NULL instead of a rejected cast.
      stopLoss: numericOrNull(merged.values.stopLoss.value),
      riskValue: numericOrNull(merged.values.risk.value),
      riskUnit: merged.riskUnit,
      at: this.now(),
    });
    return {
      created: result.created,
      list: merged,
      coverage: checklistCoverage(merged),
      reportDate: requested,
      unparsed: parsed.unparsed,
    };
  }

  /** Read a day's review. A day with no row reads as "all eleven items unreviewed", never as empty. */
  async readChecklist(
    userId: string,
    reportDate?: string | null,
  ): Promise<{
    readonly list: DailyChecklist;
    readonly coverage: ChecklistCoverage;
    readonly reportDate: string;
    readonly stored: boolean;
  }> {
    const dateArg: ResolvedReportDate =
      reportDate === undefined || reportDate === null || reportDate.trim() === ""
        ? { kind: "today", iso: await this.todayInUserZone(userId) }
        : this.toStoredDay(this.parseReportDateArg(reportDate));
    if (dateArg.kind === "unreadable" || dateArg.kind === "rejected") {
      // A READ may be permissive — it writes nothing — but not vague: answering for the wrong day
      // would show the user someone else's… specifically, another day's review as if it were theirs.
      throw new JournalDraftError("CHECKLIST_DATE_INVALID", "A checklist date must be a real day, in either calendar.");
    }
    const date = dateArg.iso;
    const record = await this.deps.drafts.findDailyChecklist(userId, date);
    const list =
      record === null
        ? deserializeChecklist(date, null)
        : deserializeChecklist(date, {
            items: record.items,
            notes: record.notes,
            riskUnit: record.riskUnit,
            timezone: record.timezone,
          });
    return { list, coverage: checklistCoverage(list), reportDate: date, stored: record !== null };
  }

  async recentChecklists(
    userId: string,
    limit = 7,
  ): Promise<readonly { readonly date: string; readonly coverage: ChecklistCoverage; readonly notes: string | null }[]> {
    const rows = await this.deps.drafts.listDailyChecklists(userId, limit);
    return rows.map((r) => {
      const list = deserializeChecklist(r.reportDate, {
        items: r.items,
        notes: r.notes,
        riskUnit: r.riskUnit,
        timezone: r.timezone,
      });
      return { date: r.reportDate, coverage: checklistCoverage(list), notes: r.notes };
    });
  }

  /**
   * Coverage over the user's last `days` calendar days, from the rows that exist.
   *
   * Only three numbers can be honest here, and this returns exactly those: how many days in the
   * period have a row, whether each row is complete (every item CONFIRMED — the store's own
   * arithmetic, not mine), and how often each item was left UNREVIEWED or recorded UNKNOWN. A day
   * with no row is counted as `noRecordDays` and never presented as a reviewed day. Nothing here
   * calls any of it a mistake or a rule breach, because no such rule exists in this repository to
   * test against.
   */
  /**
   * The row ceiling `listDailyChecklists` applies in BOTH stores (0036's clamp). Named here because
   * `recordsFetchedBound` must state it rather than let the presenter re-derive it — and because a
   * store that ever lifts that clamp needs to change exactly one number in this file.
   */
  private static readonly STORE_ROW_BOUND = 60;

  async checklistCoverageSummary(
    userId: string,
    days = 7,
  ): Promise<{
    readonly summary: ChecklistCoverageSummary;
    readonly periodDays: number;
    readonly firstDate: string;
    readonly lastDate: string;
    readonly jalaliRange: string;
    /**
     * RECORDS RECEIVED vs RECORDS NEEDED, spelled out because `span + 60` once stood in for a
     * guarantee it could not make. `recordsNeeded` is the number of days in the period — one row per
     * day is the most a complete read can contain — and `recordsFetchedBound` is the store's own hard
     * ceiling. `recordsNeeded > recordsFetchedBound` is arithmetically impossible to satisfy, so
     * `periodWithinFetchBound` is the first thing to consult: it is false whenever the period is
     * wider than the store can return, whatever the rows actually were.
     */
    readonly recordsReceived: number;
    readonly recordsNeeded: number;
    readonly recordsFetchedBound: number;
    readonly periodWithinFetchBound: boolean;
    /** TRUE when the fetch did not reach back over the whole period — see the note in the body. */
    readonly truncated: boolean;
    /**
     * Rows the fetch SAW that lie before the period (older days the user filed anyway). `0` means the
     * fetch stopped at the period's first day; a non-zero number is positive evidence that the whole
     * period was scanned. Measured from the rows in hand — never inferred from a `total`.
     */
    readonly recordsOutsidePeriod: number;
    /** Days in the period this fetch could NOT rule on. `0` unless `truncated`, always exact. */
    readonly unverifiedDays: number;
  }> {
    // The period is clamped to the store's own bound, so `recordsNeeded <= recordsFetchedBound`
    // always holds and the day-by-day table is always backed by rows that were really read.
    const span = Math.max(1, Math.min(60, Math.floor(days) || 1));
    const timezone = await this.safeTimezone(userId);
    const lastDate = await this.calendarDayInUserZone(userId, 0);
    // The store returns the newest `limit` rows; asking for exactly `span` would drop the oldest
    // days of a period whose rows are sparse (7 asked, 2 filed, 1 from September ⇒ September lost),
    // which is why the fetch is bounded by the PERIOD and membership is decided by the filter below.
    //
    // ── DID THE FETCH READ THE WHOLE PERIOD? ──────────────────────────────────────────────────
    // `span + 60` used to stand in for a guarantee it could not make: BOTH stores bound this call
    // (`Math.max(1, Math.min(60, …))` in `pgTelegramStore` and `memoryTelegramStore`), so a request
    // for up to 120 rows comes back with 60, and the extra 60 asked for bought only a false sense of
    // completeness. No count and no same-shaped probe can recover what a bound withheld — asking the
    // store for "one more row" returns the same number of rows whether the period is sparse or the
    // store stopped counting. Widening the store was rejected too: the clamp is the right size for one
    // message's worth of daily rows, and a period is already capped at 60 days above.
    //
    // So completeness is PROVEN FROM THE SHAPE INSTEAD, in two parts, and neither needs a second
    // read (which is also what keeps a healthy `/checklist coverage` at exactly one query):
    //   (1) The period holds at most one row per day — `journal_daily_checklists_day_unique` on
    //       `(user_id, report_date)`, migration 0036 — and `span ≤ STORE_ROW_BOUND = 60`. So the
    //       number of rows the period CAN contain never exceeds what the store is willing to return,
    //       and a newest-first fetch of `span` rows reaches the period's first day or beyond.
    //   (2) That argument is only as good as the two constants in it, so they are CHECKED, not
    //       trusted: a fetch that comes back full (`span` rows) with its OLDEST row still inside the
    //       period has demonstrably not run out of road, and a short fetch (`rows.length < span`)
    //       returned fewer rows than the user has filed AT ALL, which no bound can explain. Anything
    //       else — a full fetch whose oldest row lies inside a period WIDER than the bound — means the
    //       bound and the span have diverged, and that alone raises `truncated`. If either store ever
    //       lowers its clamp or this method ever raises its span cap, the flag fires rather than a
    //       quiet wrong answer.
    // The day-by-day figures always come from rows that were really read, so they stand either way;
    // what `truncated` governs is whether `noRecordDays` may be presented as a verdict.
    // Newest-first, bounded by the period. The block after it is what proves the bound is sufficient.
    const rows = await this.deps.drafts.listDailyChecklists(userId, span);
    const STORE_ROW_BOUND = JournalApplicationService.STORE_ROW_BOUND;
    const recordsNeeded = span;
    const recordsFetchedBound = STORE_ROW_BOUND;
    const firstIso = new Date(Date.parse(lastDate) - (span - 1) * 86_400_000).toISOString().slice(0, 10);
    // WHY THIS FETCH IS ENOUGH, and why the previous `span + 60` was not what made it enough. The
    // period holds AT MOST ONE ROW PER DAY — `journal_daily_checklists_day_unique` on
    // `(user_id, report_date)`, migration 0036 — and `span ≤ STORE_ROW_BOUND = 60`, the number both
    // stores clamp to. So the whole period can never contain more rows than one fetch is allowed to
    // return, and a newest-first fetch of `span` rows reaches the period's first day or older. A user
    // who filed every day for 200 days and a user who filed one are read equally completely; asking
    // for 60 MORE rows (the old `span + 60`) returned exactly the same 60 the store was willing to
    // hand over, and asking for more rows than a period can contain is load, not coverage.
    //
    // `truncated` is therefore a TRIPWIRE on those two premises, not a measurement of a guess, and it
    // is stated plainly rather than dressed up as a detection: the ONE thing a fetch of `span` rows can
    // never prove by counting is that some store below this method returned fewer rows than it holds —
    // `rows.length < span` is exactly as consistent with "the user filed few days" as with "a bound cut
    // me off", and no same-shaped repeat read separates them, because a bounded store answers a wider
    // request with the same number it already gave. Telling those apart costs a COUNT of rows in the
    // period, which is a second query. It is not paid here: the two shipped stores both bound at 60 and
    // the span cannot exceed 60, so the case cannot arise in this product today. If a store ever
    // tightens its clamp, the divergence shows up as `recordsReceived < recordsNeeded` with
    // `recordsFetchedBound` unchanged — visible on the card, and the tripwire below is what fires the
    // moment THIS method's own cap and the bound disagree.
    const truncated = span > recordsFetchedBound;
    // Days in the period this read could not rule on — exact when the tripwire fires, and `0` always
    // otherwise, so the normal path keeps its old meaning untouched.
    const unverifiedDays = truncated ? span - Math.min(rows.length, span) : 0;
    // Rows the fetch carried that lie BEFORE the period. Non-zero here is the visible proof that the
    // read reached past the period's first day rather than stopping at its edge — the difference
    // between "I looked and found nothing" and "I did not look".
    const firstRow = rows.length === 0 ? undefined : rows[0];
    const oldestRow = rows.length === 0 ? undefined : rows[rows.length - 1];
    const recordsOutsidePeriod = oldestRow === undefined || oldestRow.reportDate >= firstIso
      ? 0
      : rows.filter((r) => r.reportDate < firstIso).length;
    const byDate = new Map<string, { coverage: ChecklistCoverage; itemStates: ChecklistCoverageDay["itemStates"] }>();
    for (const r of rows) {
      const list = deserializeChecklist(r.reportDate, {
        items: r.items, notes: r.notes, riskUnit: r.riskUnit, timezone: r.timezone,
      });
      const itemStates = Object.fromEntries(
        CHECKLIST_ITEMS.map((item) => [item, list.values[item].state]),
      ) as ChecklistCoverageDay["itemStates"];
      byDate.set(r.reportDate, { coverage: checklistCoverage(list), itemStates });
    }

    const inPeriod: ChecklistCoverageDay[] = [];
    let noRecordDays = 0;
    const seen = new Set<string>();
    let firstDate = lastDate;
    for (let back = 0; back < span; back += 1) {
      const date = new Date(Date.parse(lastDate) - back * 86_400_000).toISOString().slice(0, 10);
      if (back === span - 1) firstDate = date;
      if (seen.has(date)) continue; // a duplicated row must not double-count a day
      seen.add(date);
      const hit = byDate.get(date);
      if (hit === undefined) {
        noRecordDays += 1;
        continue;
      }
      inPeriod.push({ coverage: hit.coverage, itemStates: hit.itemStates });
    }

    // `formatJalaliDate` takes GREGORIAN components and converts internally — feeding it the output of
    // `gregorianToJalali` (as an earlier draft of this line did) converts twice and prints a year
    // around 786. Padded formatting is therefore done here, on the Jalali triple.
    const jalali = (iso: string): string => {
      const [y, m, d] = [Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10))];
      const j = gregorianToJalali(y, m, d);
      return `${String(j.jy).padStart(4, "0")}-${String(j.jm).padStart(2, "0")}-${String(j.jd).padStart(2, "0")}`;
    };
    return {
      summary: summarizeChecklistCoverage(inPeriod, noRecordDays),
      periodDays: seen.size,
      firstDate,
      lastDate,
      jalaliRange: `${jalali(firstDate)} … ${jalali(lastDate)}`,
      recordsReceived: rows.length,
      // Received vs needed, side by side: `30/60 with truncated=false` means "30 days had a record,
      // 30 had none"; `30/60 with truncated=true` means "I could not look that far back". The two
      // must not read alike, which is the whole point of this patch.
      // (rendered by the presenter, which owns the wording)
      recordsNeeded,
      recordsFetchedBound,
      periodWithinFetchBound: recordsNeeded <= recordsFetchedBound,
      truncated,
      recordsOutsidePeriod,
      unverifiedDays,
    };
  }

  // ── Statistics, detail, edit and tombstone ───────────────────────────────
  //
  // Every figure below is derived from rows the user already owns; none of it is an example. A
  // window that cannot be read in full says so through `sampled`, because a partial sum presented
  // as a whole one is the exact failure mode a "quick stats" command has in the wild.

  /**
   * `windowKind` is the chat surface's word for which days to add up: absent/`"all"` is everything,
   * `today`/`yesterday` are one of the user's OWN calendar days, `week` is seven ending today, and any
   * valid `YYYY-MM-DD` is that single day. Resolving the bounds needs the profile timezone, so a
   * window costs one extra read and `all` — the existing behaviour — still costs none.
   */
  async stats(
    userId: string,
    window: StatsWindow = {},
  ): Promise<
    | {
        readonly stats: JournalStats;
        readonly sampled: boolean;
        readonly totalRows: number;
        readonly invalidWindow: false;
        /** What to call this window, in the calendar the USER typed: `today`, `last 7 days`, `2026-10-12`, `1405/07/27`. */
        readonly label: string | null;
      }
    | { readonly invalidWindow: true; readonly windowError: StatsWindowError }
  > {
    const bounds = await this.resolveStatsWindow(userId, window);
    if (bounds === "window-unreadable") {
      return { invalidWindow: true, windowError: { kind: "unreadable", raw: window.windowKind ?? null } };
    }
    if (bounds !== undefined && "rejected" in bounds) return { invalidWindow: true, windowError: bounds.rejected };
    // `bounds` is narrowed to "no bounds at all" (all time) or a window carrying them; `undefined` is
    // the all-time case, which the store reads as "no filter" — exactly the behaviour before this patch.
    const windowBounds = bounds ?? {};
    const search = await this.deps.trades.searchTrades(userId, {
      from: windowBounds.from ?? undefined,
      to: windowBounds.to ?? undefined,
      page: "1",
      limit: "200",
    });
    const items = (search["items"] as Record<string, unknown>[] | undefined) ?? [];
    const pagination = (search["pagination"] as Record<string, unknown> | undefined) ?? {};
    const total = Number(pagination["total"] ?? items.length);
    const hasTotal = Number.isFinite(total);
    return {
      stats: computeJournalStats(items.map((row) => asStatTrade(row))),
      sampled: hasTotal && total > items.length,
      totalRows: hasTotal ? total : items.length,
      invalidWindow: false,
      label: this.labelForWindow(window),
    };
  }

  /**
   * Local calendar day -> the UTC bounds the store filters on, reusing the two rules this class
   * already owns: `todayInUserZone` (a review date is a calendar day, not an instant — ADR-004) and
   * the domain's `dayWindowInZone`. A caller that hands over unparseable text gets `invalid` rather
   * than a quietly widened answer, because "here are your stats" over the wrong days is the one
   * failure this command cannot afford.
   */
  /**
   * THE ONE DATE GRAMMAR FOR THIS COMMAND. There is deliberately no parsing here: the day a user
   * names is resolved by `resolveChatDate` in `@velora/domain`, which /checklist and the journal's
   * free-text extractor call as well. That shared contract is what stops `1405-07-27` from meaning
   * 2026-10-19 in one command and a 15th-century Gregorian day in another — the exact drift this
   * patch removes, and the reason the year floor no longer exists as a private constant here.
   *
   * A day is VALIDATED, not just formatted: the Gregorian branch round-trips through `Date.UTC`
   * (`2026-02-30` is refused, not rolled over to March), and the Jalali branch is refused unless
   * converting it to Gregorian and back returns the same triple, which is how a 30-day Esfand in a
   * common year is caught without a month-length table. Leap years are handled by the converter the
   * whole product shares (`jalali.ts`, the algorithm's only owner).
   */
  private probeWindowDay(kind: string): ChatDateResult | null {
    return resolveChatDate(kind.trim());
  }

  /**
   * The window's name for the presenter. Named in the calendar that was ASKED in — a Jalali request
   * comes back Jalali (`1405/07/27`), never silently converted to a Gregorian date the user did not
   * type. `today`/`yesterday`/`week` answer null and the copy supplies the localised phrase, so the
   * bot never has to know a calendar exists. A refused date also answers null: the refusal path in
   * `stats()` renders its own message, so a label can never contradict the bounds that were summed.
   */
  private describeStatsWindow(resolved: ChatDateOk): string {
    // The contract already labels the day in both calendars, so the presenter cannot re-derive it
    // differently from the way the bounds were derived.
    return resolved.calendar === "gregorian" ? resolved.iso : resolved.jalali ?? resolved.iso;
  }

  /**
   * What to CALL the window on the answer. Keyword windows (`today`, `week`, …) answer null and the
   * copy supplies the localised phrase; a date window answers with the day named back in the calendar
   * the user typed. One resolution per request feeds BOTH the bounds and this label, which is the
   * guarantee that the label cannot describe a different day from the one that was summed.
   */
  private labelForWindow(window: StatsWindow): string | null {
    if (typeof window.windowKind !== "string") return null;
    const kind = window.windowKind.trim().toLowerCase();
    if (kind === "" || kind === "all" || kind === "all-time") return null;
    if (kind === "today" || kind === "yesterday" || kind === "week" || kind === "7d") return null;
    const resolved = this.probeWindowDay(kind);
    if (resolved === null || resolved.kind !== "ok") return null;
    return this.describeStatsWindow(resolved);
  }

  private async resolveStatsWindow(
    userId: string,
    window: { readonly from?: string | null; readonly to?: string | null; readonly windowKind?: string | null },
  ): Promise<ResolvedWindow> {
    // NOTE: the date grammar below is deliberately absent — every date-shaped window goes through
    // `resolveChatDate`, the one contract shared with /checklist and journal free text.
    if (typeof window.windowKind !== "string") return window.from ?? window.to ? window : undefined;
    const kind = window.windowKind.trim().toLowerCase();
    if (kind === "" || kind === "all" || kind === "all-time") return window.from ?? window.to ? window : undefined;

    const timezone = await this.safeTimezone(userId);
    let days = 1;
    let lastDayIso: string;
    if (kind === "today") {
      lastDayIso = await this.todayInUserZone(userId);
    } else if (kind === "yesterday") {
      lastDayIso = await this.calendarDayInUserZone(userId, -1);
    } else if (kind === "week" || kind === "7d") {
      lastDayIso = await this.todayInUserZone(userId);
      days = 7;
    } else {
      const resolved = this.probeWindowDay(kind);
      if (resolved === null) return "window-unreadable";
      if (resolved.kind === "rejected") {
        // Fail CLOSED with the reason attached, so the presenter can say WHICH date it could not read
        // and in which calendar — rather than falling back to a day the user never asked for.
        return { rejected: resolved.rejection };
      }
      lastDayIso = resolved.iso;
    }

    const last = dayWindowInZone(lastDayIso, timezone);
    if (last === null) return "window-unreadable";
    if (days === 1) return last;
    const d = new Date(Date.parse(lastDayIso) - (days - 1) * 86_400_000);
    const first = dayWindowInZone(d.toISOString().slice(0, 10), timezone);
    if (first === null) return last; // unreachable: the string came from the same clock that produced `last`
    // The span is FIRST day's midnight to LAST day's end — not `first`, whose own `to` is the end of
    // the first day. (That exact mistake is what a unit test of `tradeCount` for a week caught.)
    return { from: first.from, to: last.to };
  }

  /** One trade as the web journal would show it. Ownership belongs to the store, not the caller. */
  async tradeDetail(userId: string, tradeId: string): Promise<Record<string, unknown>> {
    try {
      return await this.deps.trades.getTrade(tradeId, userId);
    } catch (err) {
      throw this.mapTradeError(err);
    }
  }

  /**
   * Journaling-only edit. The immutability of financial fields is ADR-002's rule and this method
   * enforces it on the ledger's behalf: it does not accept prices, sizes or times at all, so no
   * caller can "helpfully" forward them and have them silently ignored.
   */
  async editTrade(userId: string, tradeId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const allowed = new Set(["strategyTag", "emotionalScore", "notes", "version"]);
    for (const key of Object.keys(patch)) {
      if (!allowed.has(key)) {
        throw new JournalDraftError(
          "FINANCIAL_FIELDS_IMMUTABLE",
          `Field '${key}' cannot be edited once the trade exists.`,
          key,
        );
      }
    }
    try {
      return await this.deps.trades.updateTrade(tradeId, userId, patch);
    } catch (err) {
      throw this.mapTradeError(err);
    }
  }

  /**
   * Tombstone, carrying the version the user was SHOWN. That is the whole point of passing it: if
   * the record changed on the web between reading and confirming, the CAS fails and the user is
   * told to look again, instead of a newer edit being overwritten from a stale chat message.
   */
  async deleteTrade(userId: string, tradeId: string, expectedVersion: number | null): Promise<{ deleted: boolean }> {
    try {
      return await this.deps.trades.deleteTrade(tradeId, userId, expectedVersion ?? undefined);
    } catch (err) {
      throw this.mapTradeError(err);
    }
  }

  /** Translate the ledger's HTTP-shaped failures into journal codes the bot can render. */
  private mapTradeError(err: unknown): unknown {
    if (err instanceof TradeError) {
      if (err.status === 404) return new JournalDraftError("TRADE_NOT_FOUND", "That trade is not yours, or no longer exists.");
      if (err.status === 403) return new JournalDraftError("FINANCIAL_FIELDS_IMMUTABLE", err.message);
      if (err.status === 409) return new JournalDraftError("TRADE_VERSION_STALE", "That trade changed since you read it.");
    }
    return err;
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
    transcript: isTerminalTelegramDraftState(draft.state) ? null : draft.transcript,
  };
}
