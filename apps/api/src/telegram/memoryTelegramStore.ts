// In-memory adapter for the Telegram port.
//
// CONTRACT-IDENTICAL, NOT A SIMPLIFICATION. It reproduces the two properties the
// PostgreSQL adapter gets from the engine, so a test that passes here is a test
// of the SERVICE rather than of the double:
//   * `claimUpdate` — first delivery wins, repeats report false;
//   * `consumeLinkToken` — single-use and expiry decided in one synchronous
//     critical section, because Node runs this body to completion without
//     yielding (`await` only at the boundaries), so two concurrent callers
//     cannot both observe PENDING.
// The partial unique indexes are modelled explicitly (`#findLive…` scans), so
// "one live identity per user / per Telegram id" is enforced here too.
//
// NOT database evidence — the same label the repo's other memory stores carry.
import type {
  IdentityInsert,
  LinkConsumption,
  TelegramChannelRecord,
  TelegramChannelStatus,
  TelegramDraftKind,
  TelegramDraftRecord,
  TelegramDraftState,
  TelegramIdentityRecord,
  TelegramStore,
  TelegramTokenRecord,
} from "./telegramStore.js";

/**
 * A mutable view of a stored token.
 *
 * The PORT type is `readonly` — a caller must not be able to change a row it was
 * handed. This double nevertheless owns mutable state, so it keeps its own
 * writable projection rather than weakening the port (or fighting the compiler
 * with casts at each mutation site).
 */
type MutableToken = { -readonly [K in keyof TelegramTokenRecord]: TelegramTokenRecord[K] } & { tokenHash: string; id: string };

interface UpdateRow {
  updateId: string;
  processedAt: Date | null;
  outcome: string | null;
  errorCode: string | null;
}

export class MemoryTelegramStore implements TelegramStore {
  readonly updates = new Map<string, UpdateRow>();
  readonly identities: TelegramIdentityRecord[] = [];
  readonly tokens: MutableToken[] = [];
  readonly drafts: TelegramDraftRecord[] = [];
  readonly channels = new Map<string, TelegramChannelRecord>();
  readonly posts: { id: string; channelId: string; userId: string; tradeId: string; status: string; messageId: string | null; errorCode: string | null }[] = [];

  #seq = 0;
  #nextId(): string {
    this.#seq += 1;
    return String(this.#seq);
  }

  // ── Updates ───────────────────────────────────────────────────────────────

  async claimUpdate(claim: { updateId: string; telegramUserId: string | null; chatId: string | null; kind: string; at: Date }): Promise<boolean> {
    if (this.updates.has(claim.updateId)) return false;
    this.updates.set(claim.updateId, { updateId: claim.updateId, processedAt: null, outcome: null, errorCode: null });
    return true;
  }

  async finishUpdate(updateId: string, outcome: "handled" | "ignored" | "rejected" | "failed", errorCode: string | null, at: Date): Promise<void> {
    const row = this.updates.get(updateId);
    if (row === undefined) return;
    row.processedAt = at;
    row.outcome = outcome;
    row.errorCode = errorCode;
  }

  // ── Identities ────────────────────────────────────────────────────────────

  async findLiveIdentityByTelegramUserId(telegramUserId: string): Promise<TelegramIdentityRecord | null> {
    return this.identities.find((i) => i.telegramUserId === telegramUserId && i.status === "LINKED") ?? null;
  }

  async findLiveIdentityByUserId(userId: string): Promise<TelegramIdentityRecord | null> {
    return this.identities.find((i) => i.userId === userId && i.status === "LINKED") ?? null;
  }

  async findLatestIdentityByUserId(userId: string): Promise<TelegramIdentityRecord | null> {
    const rows = this.identities.filter((i) => i.userId === userId);
    return rows.length === 0 ? null : (rows[rows.length - 1] ?? null);
  }

  async insertLiveIdentity(input: { userId: string; telegramUserId: string; username: string | null; at: Date }): Promise<IdentityInsert> {
    if (this.identities.some((i) => i.telegramUserId === input.telegramUserId && i.status === "LINKED")) {
      return { ok: false, reason: "IDENTITY_TAKEN" };
    }
    if (this.identities.some((i) => i.userId === input.userId && i.status === "LINKED")) {
      return { ok: false, reason: "ACCOUNT_TAKEN" };
    }
    const identity: TelegramIdentityRecord = {
      id: this.#nextId(),
      userId: input.userId,
      telegramUserId: input.telegramUserId,
      username: input.username,
      status: "LINKED",
      linkedAt: input.at.toISOString(),
      revokedAt: null,
      lastSeenAt: null,
    };
    this.identities.push(identity);
    return { ok: true, identity };
  }

  async revokeIdentity(userId: string, identityId: string, at: Date): Promise<boolean> {
    const identity = this.identities.find((i) => i.id === identityId && i.userId === userId && i.status === "LINKED");
    if (identity === undefined) return false;
    const index = this.identities.indexOf(identity);
    this.identities[index] = { ...identity, status: "REVOKED", revokedAt: at.toISOString() };
    return true;
  }

  async touchIdentity(identityId: string, at: Date): Promise<void> {
    const identity = this.identities.find((i) => i.id === identityId);
    if (identity === undefined) return;
    const index = this.identities.indexOf(identity);
    this.identities[index] = { ...identity, lastSeenAt: at.toISOString() };
  }

  // ── Linking transactions ──────────────────────────────────────────────────

  async createLinkToken(input: { userId: string; tokenHash: string; expiresAt: Date; at: Date }): Promise<void> {
    for (const token of this.tokens) {
      if (token.userId !== input.userId || token.status !== "PENDING") continue;
      const expired = Date.parse(token.expiresAt) <= input.at.getTime();
      token.status = expired ? "EXPIRED" : "REVOKED";
      token.revokedAt = expired ? null : input.at.toISOString();
    }
    this.tokens.push({
      id: this.#nextId(),
      userId: input.userId,
      status: "PENDING",
      createdAt: input.at.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      consumedAt: null,
      revokedAt: null,
      consumedByTelegramUserId: null,
      tokenHash: input.tokenHash,
    });
  }

  async consumeLinkToken(input: { tokenHash: string; telegramUserId: string; at: Date }): Promise<LinkConsumption> {
    const token = this.tokens.find((t) => t.tokenHash === input.tokenHash);
    if (token === undefined) return { ok: false, reason: "UNKNOWN" };
    if (token.status === "PENDING" && Date.parse(token.expiresAt) > input.at.getTime()) {
      token.status = "CONSUMED";
      token.consumedAt = input.at.toISOString();
      token.consumedByTelegramUserId = input.telegramUserId;
      return { ok: true, userId: token.userId, tokenId: token.id };
    }
    if (token.status === "CONSUMED") return { ok: false, reason: "CONSUMED" };
    if (token.status === "REVOKED") return { ok: false, reason: "REVOKED" };
    return { ok: false, reason: "EXPIRED" };
  }

  async attachConsumedIdentity(tokenId: string, identityId: string): Promise<void> {
    void tokenId;
    void identityId;
    // The memory adapter keeps the identity inside its own rows; nothing to link.
  }

  async findLatestTokenByUserId(userId: string): Promise<TelegramTokenRecord | null> {
    const last = this.tokens.filter((t) => t.userId === userId).at(-1);
    return last ?? null;
  }

  // ── Drafts ────────────────────────────────────────────────────────────────

  async createDraft(input: {
    userId: string;
    telegramUserId: string;
    chatId: string;
    sourceMessageId: string;
    sourceKind: TelegramDraftKind;
    draft: TelegramDraftRecord["draft"];
    missingFields: readonly string[];
    transcript: string | null;
    media: Record<string, unknown>;
    expiresAt: Date;
    at: Date;
  }): Promise<TelegramDraftRecord> {
    const existing = this.drafts.find((d) => d.telegramUserId === input.telegramUserId && d.sourceMessageId === input.sourceMessageId);
    if (existing !== undefined) return existing;
    const state: TelegramDraftState = input.missingFields.length > 0 ? "NEEDS_DETAIL" : "AWAITING_CONFIRMATION";
    const record: TelegramDraftRecord = {
      id: this.#nextId(),
      userId: input.userId,
      telegramUserId: input.telegramUserId,
      chatId: input.chatId,
      sourceMessageId: input.sourceMessageId,
      sourceKind: input.sourceKind,
      state,
      draft: input.draft,
      missingFields: [...input.missingFields],
      transcript: input.transcript,
      media: input.media,
      createdAt: input.at.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      confirmedTradeId: null,
    };
    this.drafts.push(record);
    return record;
  }

  async findOpenDraft(telegramUserId: string, at: Date): Promise<TelegramDraftRecord | null> {
    const open = this.drafts.filter(
      (d) =>
        d.telegramUserId === telegramUserId &&
        (d.state === "AWAITING_CONFIRMATION" || d.state === "NEEDS_DETAIL") &&
        Date.parse(d.expiresAt) > at.getTime(),
    );
    return open.length === 0 ? null : (open[open.length - 1] ?? null);
  }

  async findDraftById(draftId: string): Promise<TelegramDraftRecord | null> {
    return this.drafts.find((d) => d.id === draftId) ?? null;
  }

  async updateDraft(
    draftId: string,
    patch: { draft?: TelegramDraftRecord["draft"]; missingFields?: readonly string[]; state?: TelegramDraftState },
    at: Date,
  ): Promise<TelegramDraftRecord | null> {
    const index = this.drafts.findIndex((d) => d.id === draftId);
    const current = this.drafts[index];
    if (current === undefined) return null;
    const next: TelegramDraftRecord = {
      ...current,
      ...(patch.draft !== undefined ? { draft: patch.draft } : {}),
      ...(patch.missingFields !== undefined ? { missingFields: [...patch.missingFields] } : {}),
      ...(patch.state !== undefined ? { state: patch.state } : {}),
    };
    void at;
    this.drafts[index] = next;
    return next;
  }

  async claimDraftForConfirmation(draftId: string, at: Date): Promise<boolean> {
    const index = this.drafts.findIndex((d) => d.id === draftId);
    const current = this.drafts[index];
    if (current === undefined) return false;
    if (current.state !== "AWAITING_CONFIRMATION" && current.state !== "NEEDS_DETAIL") return false;
    void at;
    this.drafts[index] = { ...current, state: "CONFIRMING" };
    return true;
  }

  async markDraftConfirmed(draftId: string, tradeId: string, at: Date): Promise<boolean> {
    const index = this.drafts.findIndex((d) => d.id === draftId);
    const current = this.drafts[index];
    if (current === undefined || current.state !== "CONFIRMING") return false;
    void at;
    this.drafts[index] = { ...current, state: "CONFIRMED", confirmedTradeId: tradeId };
    return true;
  }

  async releaseConfirmationClaim(draftId: string, restoreState: TelegramDraftState, at: Date): Promise<void> {
    const index = this.drafts.findIndex((d) => d.id === draftId);
    const current = this.drafts[index];
    if (current === undefined || current.state !== "CONFIRMING") return;
    void at;
    this.drafts[index] = { ...current, state: restoreState };
  }

  async expireStaleDrafts(at: Date): Promise<number> {
    let count = 0;
    for (let i = 0; i < this.drafts.length; i++) {
      const draft = this.drafts[i];
      if (draft === undefined) continue;
      if (draft.state !== "AWAITING_CONFIRMATION" && draft.state !== "NEEDS_DETAIL") continue;
      if (Date.parse(draft.expiresAt) > at.getTime()) continue;
      this.drafts[i] = { ...draft, state: "EXPIRED" };
      count += 1;
    }
    return count;
  }

  // ── Channels ──────────────────────────────────────────────────────────────

  async upsertChannel(input: {
    userId: string;
    chatId: string;
    title: string | null;
    chatType: TelegramChannelRecord["chatType"];
    status: TelegramChannelStatus;
    canPost: boolean;
    at: Date;
  }): Promise<TelegramChannelRecord> {
    const key = `${input.userId}:${input.chatId}`;
    const record: TelegramChannelRecord = {
      id: this.channels.get(key)?.id ?? this.#nextId(),
      userId: input.userId,
      chatId: input.chatId,
      title: input.title,
      chatType: input.chatType,
      status: input.status,
      canPost: input.canPost,
      verifiedAt: input.at.toISOString(),
      revokedAt: null,
    };
    this.channels.set(key, record);
    return record;
  }

  async findActiveChannel(userId: string): Promise<TelegramChannelRecord | null> {
    for (const channel of this.channels.values()) {
      if (channel.userId === userId && channel.status === "ACTIVE") return channel;
    }
    return null;
  }

  async findChannel(userId: string, chatId: string): Promise<TelegramChannelRecord | null> {
    return this.channels.get(`${userId}:${chatId}`) ?? null;
  }

  async revokeChannel(userId: string, chatId: string, at: Date): Promise<boolean> {
    const key = `${userId}:${chatId}`;
    const channel = this.channels.get(key);
    if (channel === undefined || channel.status === "REVOKED") return false;
    this.channels.set(key, { ...channel, status: "REVOKED", revokedAt: at.toISOString() });
    return true;
  }

  async claimChannelPost(input: { channelId: string; userId: string; tradeId: string; at: Date }): Promise<{ claimed: boolean; postId: string | null }> {
    const existing = this.posts.find((p) => p.channelId === input.channelId && p.tradeId === input.tradeId);
    if (existing !== undefined) return { claimed: false, postId: null };
    const post = {
      id: this.#nextId(),
      channelId: input.channelId,
      userId: input.userId,
      tradeId: input.tradeId,
      status: "PENDING",
      messageId: null as string | null,
      errorCode: null as string | null,
    };
    this.posts.push(post);
    return { claimed: true, postId: post.id };
  }

  async finishChannelPost(postId: string, status: "PUBLISHED" | "FAILED", messageId: string | null, errorCode: string | null, at: Date): Promise<void> {
    void at;
    const post = this.posts.find((p) => p.id === postId);
    if (post === undefined) return;
    post.status = status;
    post.messageId = messageId;
    post.errorCode = errorCode;
  }

  async listPublishedTradeIds(channelId: string): Promise<readonly string[]> {
    return this.posts.filter((p) => p.channelId === channelId && p.status === "PUBLISHED").map((p) => p.tradeId);
  }
}
