// Telegram persistence port (ADR-018).
//
// THE ATOMICITY OF `consumeLinkToken` IS THE CONTRACT'S CENTRE OF GRAVITY.
//   Two deliveries of the same deep link can reach the service at the same
//   instant (a double tap, or a Telegram retry). The port therefore exposes NO
//   `findTokenForUse` + `markTokenConsumed` pair: a caller cannot assemble a
//   check-then-use sequence, because the only way to use a token is a single
//   operation that either wins outright or reports why it lost. Implementations
//   must make that operation atomic (PostgreSQL: one conditional UPDATE;
//   memory: one synchronous critical section). A port that allowed a caller to
//   split the two would be a port that allowed token replay.
//
// WHY THE PORT ALSO CARRIES IDENTITY + DRAFT + CHANNEL METHODS
//   They are all "the Telegram client's own state" and they all share the same
//   ownership rule (every row names a Velora user). Splitting them into four
//   ports would multiply composition-root wiring without creating a boundary
//   anything could be swapped across independently.
import type { JournalDraftFields } from "@velora/domain";

export interface TelegramIdentityRecord {
  readonly id: string;
  readonly userId: string;
  readonly telegramUserId: string;
  readonly username: string | null;
  readonly status: "LINKED" | "REVOKED";
  readonly linkedAt: string;
  readonly revokedAt: string | null;
  readonly lastSeenAt: string | null;
}

export interface TelegramTokenRecord {
  readonly id: string;
  readonly userId: string;
  readonly status: "PENDING" | "CONSUMED" | "EXPIRED" | "REVOKED";
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
  readonly consumedByTelegramUserId: string | null;
}

export type TelegramDraftState = "AWAITING_CONFIRMATION" | "NEEDS_DETAIL" | "CONFIRMING" | "CONFIRMED" | "CANCELLED" | "EXPIRED";
export type TelegramDraftKind = "TEXT" | "VOICE" | "PHOTO";

/** Terminal voice drafts keep their confirmed trade notes, never the transient transcript copy. */
export function isTerminalTelegramDraftState(state: TelegramDraftState): boolean {
  return state === "CONFIRMED" || state === "CANCELLED" || state === "EXPIRED";
}

export interface TelegramDraftRecord {
  readonly id: string;
  readonly userId: string;
  readonly telegramUserId: string;
  readonly chatId: string;
  readonly sourceMessageId: string;
  readonly sourceKind: TelegramDraftKind;
  readonly state: TelegramDraftState;
  readonly draft: JournalDraftFields;
  readonly missingFields: readonly string[];
  /** Voice transcript, retained only while the draft is actionable. */
  readonly transcript: string | null;
  /** Non-secret media metadata; never bytes and never a temporary URL. */
  readonly media: Record<string, unknown>;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly confirmedTradeId: string | null;
}

export type TelegramChannelStatus = "PENDING_VERIFICATION" | "ACTIVE" | "REVOKED" | "INSUFFICIENT_PERMISSIONS" | "STANDBY";

export interface TelegramChannelRecord {
  readonly id: string;
  readonly userId: string;
  readonly chatId: string;
  readonly title: string | null;
  readonly chatType: "channel" | "supergroup" | "group";
  readonly status: TelegramChannelStatus;
  readonly canPost: boolean;
  readonly verifiedAt: string | null;
  readonly revokedAt: string | null;
}

export type LinkConsumptionFailure = "UNKNOWN" | "EXPIRED" | "CONSUMED" | "REVOKED";

export type LinkConsumption =
  | { readonly ok: true; readonly userId: string; readonly tokenId: string }
  | { readonly ok: false; readonly reason: LinkConsumptionFailure };

export type IdentityInsert =
  | { readonly ok: true; readonly identity: TelegramIdentityRecord }
  | { readonly ok: false; readonly reason: "IDENTITY_TAKEN" | "ACCOUNT_TAKEN" };

export interface TelegramStore {
  // ── Update idempotency ────────────────────────────────────────────────────
  /** Atomically CLAIM an update id. False means another delivery owns it. */
  claimUpdate(claim: {
    readonly updateId: string;
    readonly telegramUserId: string | null;
    readonly chatId: string | null;
    readonly kind: string;
    readonly at: Date;
  }): Promise<boolean>;
  /** Atomically start a claimed update once; false means processed or already started and must be treated as a no-op. */
  beginUpdateProcessing(updateId: string, at: Date): Promise<boolean>;
  /** Finish only a started, still-unprocessed update; repeated calls cannot rewrite a terminal outcome. */
  finishUpdate(updateId: string, outcome: "handled" | "ignored" | "rejected" | "failed", errorCode: string | null, at: Date): Promise<void>;

  // ── Identities ────────────────────────────────────────────────────────────
  findLiveIdentityByTelegramUserId(telegramUserId: string): Promise<TelegramIdentityRecord | null>;
  findLiveIdentityByUserId(userId: string): Promise<TelegramIdentityRecord | null>;
  /** Newest identity for a user regardless of status (state resolution needs it). */
  findLatestIdentityByUserId(userId: string): Promise<TelegramIdentityRecord | null>;
  insertLiveIdentity(input: {
    readonly userId: string;
    readonly telegramUserId: string;
    readonly username: string | null;
    readonly at: Date;
  }): Promise<IdentityInsert>;
  /** Revoke a LIVE identity owned by `userId`. False when it was not live/owned. */
  revokeIdentity(userId: string, identityId: string, at: Date): Promise<boolean>;
  touchIdentity(identityId: string, at: Date): Promise<void>;

  // ── Linking transactions ──────────────────────────────────────────────────
  /**
   * Create the next one-time transaction for a user, atomically: any pending
   * transaction is first marked EXPIRED (if past its instant) or REVOKED
   * (superseded). One user therefore has at most one pending token, which is
   * also what the partial unique index enforces independently.
   */
  createLinkToken(input: { readonly userId: string; readonly tokenHash: string; readonly expiresAt: Date; readonly at: Date }): Promise<void>;
  /** Atomic single-use consumption. See the file header. */
  consumeLinkToken(input: { readonly tokenHash: string; readonly telegramUserId: string; readonly at: Date }): Promise<LinkConsumption>;
  /** Attach the created identity to the consumed transaction (audit linkage). */
  attachConsumedIdentity(tokenId: string, identityId: string): Promise<void>;
  findLatestTokenByUserId(userId: string): Promise<TelegramTokenRecord | null>;

  // ── Journal drafts ────────────────────────────────────────────────────────
  createDraft(input: {
    readonly userId: string;
    readonly telegramUserId: string;
    readonly chatId: string;
    readonly sourceMessageId: string;
    readonly sourceKind: TelegramDraftKind;
    readonly draft: JournalDraftFields;
    readonly missingFields: readonly string[];
    readonly transcript: string | null;
    readonly media: Record<string, unknown>;
    readonly expiresAt: Date;
    readonly at: Date;
  }): Promise<TelegramDraftRecord>;
  /** The user's actionable draft: newest, unexpired, still awaiting an answer. */
  findOpenDraft(telegramUserId: string, at: Date): Promise<TelegramDraftRecord | null>;
  findDraftById(draftId: string): Promise<TelegramDraftRecord | null>;
  updateDraft(
    draftId: string,
    patch: { readonly draft?: JournalDraftFields; readonly missingFields?: readonly string[]; readonly state?: TelegramDraftState },
    at: Date,
  ): Promise<TelegramDraftRecord | null>;
  /**
   * CLAIM a draft for confirmation: actionable → CONFIRMING, atomically.
   *
   * This is the write-once gate for journal creation. Two simultaneous
   * confirmations of the same draft (a double tap, or a Telegram retry that
   * carried a different update id) race here and exactly one wins, so the trade
   * is created once. A boolean is enough: the loser has nothing to do but tell
   * the user it is already being saved.
   */
  claimDraftForConfirmation(draftId: string, at: Date): Promise<boolean>;
  /** Bind the created trade. Conditional on the draft being in CONFIRMING. */
  markDraftConfirmed(draftId: string, tradeId: string, at: Date): Promise<boolean>;
  /**
   * Release a claim after a FAILED creation, restoring the draft to the given
   * state so the user can retry. Never used on success.
   */
  releaseConfirmationClaim(draftId: string, restoreState: TelegramDraftState, at: Date): Promise<void>;
  /** Expire stale drafts (called opportunistically; not a background job). */
  expireStaleDrafts(at: Date): Promise<number>;

  // ── Journal channel ───────────────────────────────────────────────────────
  upsertChannel(input: {
    readonly userId: string;
    readonly chatId: string;
    readonly title: string | null;
    readonly chatType: "channel" | "supergroup" | "group";
    readonly status: TelegramChannelStatus;
    readonly canPost: boolean;
    readonly at: Date;
  }): Promise<TelegramChannelRecord>;
  findActiveChannel(userId: string): Promise<TelegramChannelRecord | null>;
  findChannel(userId: string, chatId: string): Promise<TelegramChannelRecord | null>;
  revokeChannel(userId: string, chatId: string, at: Date): Promise<boolean>;
  /** Idempotent publish claim. False means this trade was already mirrored. */
  claimChannelPost(input: {
    readonly channelId: string;
    readonly userId: string;
    readonly tradeId: string;
    readonly at: Date;
  }): Promise<{ readonly claimed: boolean; readonly postId: string | null }>;
  finishChannelPost(postId: string, status: "PUBLISHED" | "FAILED", messageId: string | null, errorCode: string | null, at: Date): Promise<void>;
  /** Trades already mirrored to this channel, for history rendering. */
  listPublishedTradeIds(channelId: string): Promise<readonly string[]>;
  /**
   * Every channel this user has ever registered, ACTIVE first then newest verification. Selection is
   * meaningless without the list, and the list is meaningless without the state each row is in —
   * including STANDBY (0038: verified, bound, deliberately not the current target).
   */
  listChannels(userId: string): Promise<readonly TelegramChannelRecord[]>;
  /**
   * Choose which registered channel is ACTIVE. Exactly one may be, so the demotion of the previous
   * one and the promotion of the chosen one happen in ONE transaction — two active rows are not a
   * transient state this store can produce.
   *
   * Refuses (without writing) when the target is not the user's own, or is not verified for posting:
   * selection is a routing decision, never a way to skip verification.
   */
  activateChannel(
    userId: string,
    chatId: string,
    at: Date,
  ): Promise<
    | { readonly ok: true; readonly activated: TelegramChannelRecord; readonly demoted: TelegramChannelRecord | null }
    | { readonly ok: false; readonly reason: "NOT_FOUND" | "NOT_VERIFIED" }
  >;

  /**
   * Record a day's review. MERGE, not replace: a report naming two items must not un-answer the
   * nine it did not mention, and two devices reviewing the same day must not lose each other.
   * `created` says whether this was the day's first row.
   */
  upsertDailyChecklist(input: ChecklistUpsertInput): Promise<ChecklistUpsertResult>;
  findDailyChecklist(userId: string, reportDate: string): Promise<TelegramChecklistRecord | null>;
  /** Newest first, for "what have I reviewed lately". Bounded by the caller. */
  listDailyChecklists(userId: string, limit: number): Promise<readonly TelegramChecklistRecord[]>;

  // ── Post templates (0037) ─────────────────────────────────────────────────
  /**
   * Save a template as a NEW VERSION. Never an overwrite: `expectedVersion` is the version the
   * user was shown, and if the stored current version has moved on, the caller gets
   * `{ status: "conflict", current }` and nothing is written. A trader's wording is theirs; a lost
   * update is reported, not silently applied.
   *
   * `expectedVersion: null` means "this name must not exist yet" — an existing name is a conflict,
   * never a rename or an implicit replace.
   */
  saveTemplate(input: TemplateSaveInput): Promise<TemplateSaveResult>;
  findCurrentTemplate(userId: string, name: string): Promise<TelegramTemplateRecord | null>;
  /**
   * The template a BUTTON names.
   *
   * A callback payload can only carry an ASCII id (a Persian name cannot travel in one), so every
   * template button carries the id and the handler re-reads the row here — filtered to the caller's
   * own CURRENT rows, which is why another user's id and a retired one are the same "not found".
   */
  findTemplateById(userId: string, id: string): Promise<TelegramTemplateRecord | null>;
  /** The current template of every name this user owns, newest version first per name. */
  listTemplates(userId: string): Promise<readonly TelegramTemplateRecord[]>;
  /**
   * Retire a name. Tombstone, not DELETE — a post that was rendered from version 3 must still be
   * explainable after the user retires it. False when the name is not theirs or not current.
   */
  retireTemplate(userId: string, name: string, at: Date): Promise<boolean>;

  // ── Menu preferences and the guided-flow cursor (0042) ────────────────────
  /**
   * The user's persisted post settings, or the DEFAULTS when they have never changed one.
   *
   * "No row" and "a row that says the default" are the same answer, and this method returns the
   * latter for both: a caller must never have to distinguish them, because a screen that renders
   * differently depending on whether an empty row exists is a bug waiting for its first user.
   */
  getPostPreferences(userId: string): Promise<TelegramPostPreferences>;
  /**
   * Merge the given settings into the user's row, leaving the others untouched.
   *
   * `defaultTemplateName` is validated against the user's CURRENT templates here rather than by a
   * foreign key (the authoritative row is a partial index — see 0042's header): naming a template
   * that does not exist, or is not theirs, is refused with `{ status: "unknown-template" }` and
   * nothing is written.
   */
  savePostPreferences(input: PostPreferencesPatch): Promise<PostPreferencesSaveResult>;
  /**
   * Open (or replace) the one guided flow this user has in progress. `null` closes it.
   *
   * The started-at stamp is written by the STORE, from the caller's clock, so the expiry rule
   * ("fifteen minutes, then the prompt stops capturing messages") is enforced against a timestamp
   * that a restart cannot reset.
   */
  setPendingFlow(input: { readonly userId: string; readonly flow: TelegramPendingFlow | null; readonly at: Date }): Promise<void>;

  // ── Prepared posts (0037) ─────────────────────────────────────────────────
  /**
   * Idempotent preview write. The dedupe key is what makes a re-delivered Telegram update, a
   * double-tapped button and a retried job produce ONE previewable post rather than several: a
   * second claim of the same key returns the existing row with `status: "duplicate"` and the
   * caller must not send again.
   *
   * `contentHash` is a sha256 of `body`. It is stored, not trusted: approval and publication are
   * both compared against it, so editing the text revokes the approval in the database rather than
   * in somebody's memory.
   */
  claimPost(input: PostClaimInput): Promise<PostClaimResult>;
  /**
   * Replace a previewed post's text and re-hash it, CLEARING the approval in the same statement.
   * Only a not-yet-published row is editable (the state list says so), so a user cannot rewrite what
   * has already gone out, and an edit always revokes consent rather than relying on a caller to
   * remember that it should. Null when the row is not the user's or is past the editable states.
   */
  revisePost(input: {
    readonly userId: string;
    readonly postId: string;
    readonly body: string;
    readonly contentHash: string;
    readonly bannerSvg: string | null;
    readonly at: Date;
  }): Promise<TelegramPostRecord | null>;
  findPost(userId: string, postId: string): Promise<TelegramPostRecord | null>;
  listRecentPosts(userId: string, limit: number): Promise<readonly TelegramPostRecord[]>;
  /**
   * APPROVE the exact bytes. Returns the row when `contentHash` still matches what is stored and
   * null when it does not (the preview the user is approving is stale — re-render, re-approve).
   * Conditional in one statement: two approvals of one post cannot both land on a send.
   */
  approvePost(input: { readonly userId: string; readonly postId: string; readonly contentHash: string; readonly at: Date }): Promise<TelegramPostRecord | null>;
  /**
   * CLAIM the send: APPROVED or FAILED → PUBLISHING, atomically, and only while `attempts` is
   * below the bound. True means this caller may call the Bot API; false means somebody else is
   * already sending it, it is already published, or it is out of retries.
   */
  claimPublish(input: { readonly userId: string; readonly postId: string; readonly maxAttempts: number; readonly at: Date }): Promise<boolean>;
  /**
   * Record the outcome of the send that was claimed. PUBLISHED requires the message id.
   *
   * `imageFileId` is written in the SAME statement, not by a follow-up: it is the id Telegram gave for
   * the photo this send carried, so the fact and its evidence belong to one transition. Omitting it
   * leaves the stored value alone (COALESCE in the SQL path) — a retry that fell back to the text card
   * must not erase an id an earlier attempt already obtained.
   */
  finishPost(input: {
    readonly userId: string;
    readonly postId: string;
    readonly status: "PUBLISHED" | "FAILED";
    readonly message_id?: string | null;
    readonly errorCode: string | null;
    readonly at: Date;
    readonly imageFileId?: string | null | undefined;
  }): Promise<TelegramPostRecord | null>;

}

// ── Daily checklist (0036) ────────────────────────────────────────────────
/**
 * One trader's review of one calendar day.
 *
 * `items` is deliberately an opaque JSON value here: the VOCABULARY of the checklist belongs to
 * `packages/domain/src/journalChecklist.ts`, and the store must not grow a second, weaker copy of
 * it. What the store does guarantee is the arithmetic that makes a report trustworthy — one row
 * per (user, day), a sparse write MERGED over the stored one rather than replacing it, and counts
 * derived from the items, so no caller can assert a review is complete.
 */
export interface TelegramChecklistRecord {
  readonly id: string;
  readonly userId: string;
  readonly reportDate: string;
  readonly timezone: string;
  readonly items: Record<string, unknown>;
  readonly confirmedItems: number;
  readonly unreviewedItems: number;
  readonly unknownItems: number;
  readonly stopLoss: string | null;
  readonly riskValue: string | null;
  readonly riskUnit: "PERCENT" | "AMOUNT" | "UNSPECIFIED";
  readonly notes: string | null;
  readonly reviewState: "UNREVIEWED" | "PARTIAL" | "CONFIRMED";
  readonly sourceKind: "TEXT" | "VOICE" | "PHOTO" | "MANUAL";
  readonly reviewedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChecklistUpsertInput {
  readonly userId: string;
  readonly telegramUserId: string | null;
  readonly reportDate: string;
  readonly timezone: string;
  readonly sourceKind: "TEXT" | "VOICE" | "PHOTO" | "MANUAL";
  /** Only the items this report names; anything absent keeps the stored answer (or stays unreviewed). */
  readonly items: Readonly<Record<string, { state: string; value: string | null; normalised: boolean }>>;
  /** null means "this report said nothing about notes"; it never clears a stored note. */
  readonly notes: string | null;
  readonly stopLoss: string | null;
  readonly riskValue: string | null;
  readonly riskUnit: "PERCENT" | "AMOUNT" | "UNSPECIFIED";
  readonly at: Date;
}

export interface ChecklistUpsertResult {
  readonly created: boolean;
  readonly record: TelegramChecklistRecord;
}

// ── Post templates (0037) ───────────────────────────────────────────────
/**
 * One version of one user's template.
 *
 * `version` is monotonically increasing per (user, name) and `supersededAt` is the only currency
 * marker: exactly one row per name has it NULL. There is no `isCurrent` boolean, because two sources
 * of truth about currency is how a UI ends up publishing a stale body.
 */
export interface TelegramTemplateRecord {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly body: string;
  readonly version: number;
  readonly supersededAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Closed set of guided flows the menu can have open. A new step is a migration (0042), by design. */
export type TelegramFlowKind = "tpl_new_name" | "tpl_new_body" | "tpl_edit_body" | "banner_title";

/**
 * A guided flow in progress: which question the bot last asked, and the answers so far.
 *
 * `startedAt` is store-owned and used ONLY for expiry; a flow never authorises anything by itself —
 * every step re-reads the user's own templates before it writes.
 */
export interface TelegramPendingFlow {
  readonly kind: TelegramFlowKind;
  readonly name: string | null;
  readonly body: string | null;
  readonly templateId: string | null;
  readonly startedAt: Date;
}

/** What a user's post settings are, with defaults filled in. */
export interface TelegramPostPreferences {
  readonly userId: string;
  readonly defaultTemplateName: string | null;
  readonly bannerEnabled: boolean;
  readonly bannerTitle: string | null;
  readonly pendingFlow: TelegramPendingFlow | null;
  readonly updatedAt: Date | null;
}

/** A partial write: an absent key means "leave it as it is", `null` means "clear it". */
export interface PostPreferencesPatch {
  readonly userId: string;
  readonly defaultTemplateName?: string | null | undefined;
  readonly bannerEnabled?: boolean | undefined;
  readonly bannerTitle?: string | null | undefined;
}

export type PostPreferencesSaveResult =
  | { readonly status: "saved"; readonly preferences: TelegramPostPreferences }
  | { readonly status: "unknown-template"; readonly name: string };

export interface TemplateSaveInput {
  readonly userId: string;
  readonly name: string;
  readonly body: string;
  /** The version the user was shown; null when they are creating the name. */
  readonly expectedVersion: number | null;
  readonly at: Date;
}

export type TemplateSaveResult =
  | { readonly status: "saved"; readonly record: TelegramTemplateRecord }
  /** `current` is what is actually stored, so the caller can show the user what they would have overwritten. */
  | { readonly status: "conflict"; readonly current: TelegramTemplateRecord | null };

// ── Prepared posts (0037) ───────────────────────────────────────────────
export type TelegramPostStatus = "DRAFT" | "APPROVED" | "PUBLISHING" | "PUBLISHED" | "FAILED" | "CANCELLED";

export interface TelegramPostRecord {
  readonly id: string;
  readonly userId: string;
  readonly channelId: string;
  readonly chatId: string;
  readonly body: string;
  readonly contentHash: string;
  readonly approvedHash: string | null;
  readonly approvedAt: string | null;
  readonly bannerSvg: string | null;
  readonly imageFileId: string | null;
  readonly templateKey: string | null;
  readonly templateVersion: number | null;
  readonly status: TelegramPostStatus;
  readonly dedupeKey: string;
  readonly telegramMessageId: string | null;
  readonly publishedAt: string | null;
  readonly errorCode: string | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PostClaimInput {
  readonly userId: string;
  readonly channelId: string;
  readonly chatId: string;
  readonly body: string;
  readonly contentHash: string;
  readonly dedupeKey: string;
  readonly bannerSvg: string | null;
  readonly imageFileId: string | null;
  readonly templateKey: string | null;
  readonly templateVersion: number | null;
  readonly at: Date;
}

export type PostClaimResult =
  | { readonly status: "claimed"; readonly post: TelegramPostRecord }
  | { readonly status: "duplicate"; readonly post: TelegramPostRecord };
