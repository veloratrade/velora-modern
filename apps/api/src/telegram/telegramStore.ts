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

export type TelegramChannelStatus = "PENDING_VERIFICATION" | "ACTIVE" | "REVOKED" | "INSUFFICIENT_PERMISSIONS";

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
}
