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
import { isTerminalTelegramDraftState } from "./telegramStore.js";
import type {
  ChecklistUpsertInput,
  PostClaimInput,
  PostClaimResult,
  TelegramPostRecord,
  TelegramTemplateRecord,
  TemplateSaveInput,
  TemplateSaveResult,
  ChecklistUpsertResult,
  TelegramChecklistRecord,
  PostPreferencesPatch,
  PostPreferencesSaveResult,
  TelegramPendingFlow,
  TelegramPostPreferences,
} from "./telegramStore.js";
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
  processingStartedAt: Date | null;
  processedAt: Date | null;
  outcome: string | null;
  errorCode: string | null;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export class MemoryTelegramStore implements TelegramStore {
  /** Day-keyed checklists, mirroring the (user_id, report_date) unique key. */
  private readonly checklists: Record<string, TelegramChecklistRecord> = {};
  /**
   * Every version ever saved, current or superseded, exactly as 0037 stores them: this store is the
   * one the bot tests run against, so it must reproduce the append-only behaviour (including the
   * lost-update conflict) rather than offer a convenient last-write-wins map.
   */
  private readonly templates: Mutable<TelegramTemplateRecord>[] = [];
  private readonly outbox: Mutable<TelegramPostRecord>[] = [];
  private templateSeq = 0;
  private postSeq = 0;
  /** 0042's one row per user; absent = the defaults, exactly as the table's absence does. */
  private readonly preferences = new Map<string, Mutable<TelegramPostPreferences>>();
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
    this.updates.set(claim.updateId, { updateId: claim.updateId, processingStartedAt: null, processedAt: null, outcome: null, errorCode: null });
    return true;
  }

  async beginUpdateProcessing(updateId: string, at: Date): Promise<boolean> {
    const row = this.updates.get(updateId);
    if (row === undefined || row.processedAt !== null || row.processingStartedAt !== null) return false;
    row.processingStartedAt = at;
    return true;
  }

  async finishUpdate(updateId: string, outcome: "handled" | "ignored" | "rejected" | "failed", errorCode: string | null, at: Date): Promise<void> {
    const row = this.updates.get(updateId);
    if (row === undefined || row.processingStartedAt === null || row.processedAt !== null) return;
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
      transcript: patch.state !== undefined && isTerminalTelegramDraftState(patch.state) ? null : current.transcript,
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
    this.drafts[index] = { ...current, state: "CONFIRMED", confirmedTradeId: tradeId, transcript: null };
    return true;
  }

  async releaseConfirmationClaim(draftId: string, restoreState: TelegramDraftState, at: Date): Promise<void> {
    const index = this.drafts.findIndex((d) => d.id === draftId);
    const current = this.drafts[index];
    if (current === undefined || current.state !== "CONFIRMING") return;
    void at;
    this.drafts[index] = {
      ...current,
      state: restoreState,
      transcript: isTerminalTelegramDraftState(restoreState) ? null : current.transcript,
    };
  }

  async expireStaleDrafts(at: Date): Promise<number> {
    let count = 0;
    for (let i = 0; i < this.drafts.length; i++) {
      const draft = this.drafts[i];
      if (draft === undefined) continue;
      if (draft.state !== "AWAITING_CONFIRMATION" && draft.state !== "NEEDS_DETAIL") continue;
      if (Date.parse(draft.expiresAt) > at.getTime()) continue;
      this.drafts[i] = { ...draft, state: "EXPIRED", transcript: null };
      count += 1;
    }
    return count;
  }

  // ── Channels ──────────────────────────────────────────────────────────────

  async listChannels(userId: string): Promise<readonly TelegramChannelRecord[]> {
    return [...this.channels.values()]
      .filter((c) => c.userId === userId)
      .sort((a, b) => (a.status === "ACTIVE" ? -1 : 1) - (b.status === "ACTIVE" ? -1 : 1));
  }

  /** The same order as the adapter: demote first, then promote, so one ACTIVE is invariant. */
  async activateChannel(
    userId: string,
    chatId: string,
    at: Date,
  ): Promise<
    | { readonly ok: true; readonly activated: TelegramChannelRecord; readonly demoted: TelegramChannelRecord | null }
    | { readonly ok: false; readonly reason: "NOT_FOUND" | "NOT_VERIFIED" }
  > {
    const target = [...this.channels.values()].find((c) => c.userId === userId && c.chatId === chatId);
    if (target === undefined) return { ok: false, reason: "NOT_FOUND" };
    if (target.canPost !== true || target.verifiedAt === null || target.status === "PENDING_VERIFICATION" || target.status === "REVOKED") {
      return { ok: false, reason: "NOT_VERIFIED" };
    }
    // `TelegramChannelRecord` carries no `updatedAt`: the record type is the shape the bot reads,
    // and the timestamp lives in the database. So the memory store mutates in place the way the
    // adapter's UPDATE does, and `at` below is only used for the STANDBY/ACTIVE bookkeeping tests
    // that care about ordering.
    void at;
    let demoted: TelegramChannelRecord | null = null;
    for (const [key, c] of [...this.channels.entries()]) {
      if (c.userId === userId && c.status === "ACTIVE" && c.chatId !== chatId) {
        const next: TelegramChannelRecord = { ...c, status: "STANDBY" };
        this.channels.set(key, next);
        demoted = next;
        break;
      }
    }
    const activated: TelegramChannelRecord = { ...target, status: "ACTIVE", revokedAt: null };
    this.channels.set(this.keyOf(target), activated);
    return { ok: true, activated, demoted };
  }

  private keyOf(channel: TelegramChannelRecord): string {
    return `${channel.userId}:${channel.chatId}`;
  }

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

  // ── Daily checklist (0036) ──────────────────────────────────────────────
  // Mirrors the PostgreSQL UPSERT's rules exactly — merge over the stored items, counts derived
  // from the merged object — so a unit test cannot pass against a rule the real store lacks.
  async upsertDailyChecklist(input: ChecklistUpsertInput): Promise<ChecklistUpsertResult> {
    const key = `${input.userId}:${input.reportDate}`;
    const stored = this.checklists[key];
    const items: Record<string, unknown> = { ...(stored?.items ?? {}) };
    for (const [name, value] of Object.entries(input.items)) if (value !== undefined) items[name] = value;
    const count = (state: string) =>
      Object.values(items).filter((v) => (v as { state?: string })?.state === state).length;
    const confirmed = count("CONFIRMED");
    const unknown = count("UNKNOWN");
    const at = input.at.toISOString();
    const record: TelegramChecklistRecord = {
      id: stored?.id ?? `cl-${Object.keys(this.checklists).length + 1}`,
      userId: input.userId,
      reportDate: input.reportDate,
      timezone: stored?.timezone ?? input.timezone,
      items,
      confirmedItems: confirmed,
      unreviewedItems: Math.max(0, 11 - confirmed - unknown),
      unknownItems: unknown,
      stopLoss: input.stopLoss ?? stored?.stopLoss ?? null,
      riskValue: input.riskValue ?? stored?.riskValue ?? null,
      riskUnit: input.riskValue !== null ? input.riskUnit : (stored?.riskUnit ?? "UNSPECIFIED"),
      notes: input.notes ?? stored?.notes ?? null,
      reviewState: confirmed === 11 ? "CONFIRMED" : confirmed > 0 ? "PARTIAL" : "UNREVIEWED",
      sourceKind: input.sourceKind,
      reviewedAt: confirmed === 11 ? (stored?.reviewedAt ?? at) : null,
      createdAt: stored?.createdAt ?? at,
      updatedAt: at,
    };
    this.checklists[key] = record;
    return { created: stored === undefined, record };
  }

  async findDailyChecklist(userId: string, reportDate: string): Promise<TelegramChecklistRecord | null> {
    return this.checklists[`${userId}:${reportDate}`] ?? null;
  }

  async listDailyChecklists(userId: string, limit: number): Promise<readonly TelegramChecklistRecord[]> {
    const bound = Math.max(1, Math.min(60, Math.floor(limit) || 1));
    return Object.values(this.checklists)
      .filter((r) => r.userId === userId)
      .sort((a, b) => (a.reportDate < b.reportDate ? 1 : a.reportDate > b.reportDate ? -1 : 0))
      .slice(0, bound);
  }

  // ── Post templates (0037) ─────────────────────────────────────────────────

  /**
   * 0042 — defaults when there is no row, so a caller never has to distinguish "never configured" from
   * "configured to the default" (the table says the same thing by storing nothing).
   */
  async getPostPreferences(userId: string): Promise<TelegramPostPreferences> {
    const row = this.preferences.get(userId);
    if (row === undefined) {
      return {
        userId,
        defaultTemplateName: null,
        bannerEnabled: true,
        bannerTitle: null,
        pendingFlow: null,
        updatedAt: null,
      };
    }
    return { ...row, pendingFlow: row.pendingFlow === null ? null : { ...row.pendingFlow } };
  }

  async savePostPreferences(input: PostPreferencesPatch): Promise<PostPreferencesSaveResult> {
    // Validated against CURRENT templates, mirroring the reason 0042 has no foreign key: the
    // authoritative row is the partial "not superseded" one.
    if (input.defaultTemplateName !== undefined && input.defaultTemplateName !== null) {
      const named = this.currentTemplate(input.userId, input.defaultTemplateName);
      if (named === undefined) return { status: "unknown-template", name: input.defaultTemplateName };
    }
    const before = await this.getPostPreferences(input.userId);
    const row: Mutable<TelegramPostPreferences> = {
      ...before,
      ...(input.defaultTemplateName === undefined ? {} : { defaultTemplateName: input.defaultTemplateName }),
      ...(input.bannerEnabled === undefined ? {} : { bannerEnabled: input.bannerEnabled }),
      ...(input.bannerTitle === undefined ? {} : { bannerTitle: input.bannerTitle }),
      updatedAt: new Date(),
    };
    this.preferences.set(input.userId, row);
    return { status: "saved", preferences: await this.getPostPreferences(input.userId) };
  }

  async setPendingFlow(input: { readonly userId: string; readonly flow: TelegramPendingFlow | null; readonly at: Date }): Promise<void> {
    const before = await this.getPostPreferences(input.userId);
    this.preferences.set(input.userId, { ...before, pendingFlow: input.flow, updatedAt: input.at });
  }

  private currentTemplate(userId: string, name: string): Mutable<TelegramTemplateRecord> | undefined {
    const key = name.trim();
    return this.templates.find((t) => t.userId === userId && t.name === key && t.supersededAt === null);
  }

  async saveTemplate(input: TemplateSaveInput): Promise<TemplateSaveResult> {
    const name = input.name.trim();
    const current = this.currentTemplate(input.userId, name);
    if (input.expectedVersion === null) {
      if (current !== undefined) return { status: "conflict", current: { ...current } };
      // A retired name is reusable; its new row continues the sequence so no version is ever
      // reused for one name (the pg adapter's COALESCE(MAX(version) + 1) is the same rule).
    } else {
      if (current === undefined || current.version !== input.expectedVersion) {
        return { status: "conflict", current: current === undefined ? null : { ...current } };
      }
      current.supersededAt = input.at.toISOString();
      current.updatedAt = input.at.toISOString();
    }
    const record: Mutable<TelegramTemplateRecord> = {
      id: `tpl-${(this.templateSeq += 1)}`,
      userId: input.userId,
      name,
      body: input.body,
      version:
        current === undefined
          ? this.templates.filter((t) => t.userId === input.userId && t.name === name).reduce((top, t) => Math.max(top, t.version), 0) + 1
          : current.version + 1,
      supersededAt: null,
      createdAt: input.at.toISOString(),
      updatedAt: input.at.toISOString(),
    };
    this.templates.push(record);
    return { status: "saved", record: { ...record } };
  }

  async findCurrentTemplate(userId: string, name: string): Promise<TelegramTemplateRecord | null> {
    const found = this.currentTemplate(userId, name);
    return found === undefined ? null : { ...found };
  }

  async findTemplateById(userId: string, id: string): Promise<TelegramTemplateRecord | null> {
    const found = this.templates.find((t) => t.userId === userId && t.id === id && t.supersededAt === null);
    return found === undefined ? null : { ...found };
  }

  async listTemplates(userId: string): Promise<readonly TelegramTemplateRecord[]> {
    const byName = new Map<string, TelegramTemplateRecord>();
    for (const t of this.templates) {
      if (t.userId !== userId || t.supersededAt !== null) continue;
      const seen = byName.get(t.name);
      if (seen === undefined || seen.version < t.version) byName.set(t.name, { ...t });
    }
    return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async retireTemplate(userId: string, name: string, at: Date): Promise<boolean> {
    const current = this.currentTemplate(userId, name);
    if (current === undefined) return false;
    current.supersededAt = at.toISOString();
    current.updatedAt = at.toISOString();
    return true;
  }

  // ── Prepared posts (0037) ─────────────────────────────────────────────────

  async claimPost(input: PostClaimInput): Promise<PostClaimResult> {
    const existing = this.outbox.find((r) => r.userId === input.userId && r.dedupeKey === input.dedupeKey);
    if (existing !== undefined) return { status: "duplicate", post: { ...existing } };
    const post: Mutable<TelegramPostRecord> = {
      id: `post-${(this.postSeq += 1)}`,
      userId: input.userId,
      channelId: input.channelId,
      chatId: input.chatId,
      body: input.body,
      contentHash: input.contentHash,
      approvedHash: null,
      approvedAt: null,
      bannerSvg: input.bannerSvg,
      imageFileId: input.imageFileId,
      templateKey: input.templateKey,
      templateVersion: input.templateVersion,
      status: "DRAFT",
      dedupeKey: input.dedupeKey,
      telegramMessageId: null,
      publishedAt: null,
      errorCode: null,
      attempts: 0,
      createdAt: input.at.toISOString(),
      updatedAt: input.at.toISOString(),
    };
    this.outbox.push(post);
    return { status: "claimed", post: { ...post } };
  }

  async revisePost(input: {
    userId: string;
    postId: string;
    body: string;
    contentHash: string;
    bannerSvg: string | null;
    at: Date;
  }): Promise<TelegramPostRecord | null> {
    const row = this.outbox.find((r) => r.id === input.postId && r.userId === input.userId);
    if (row === undefined) return null;
    if (row.status !== "DRAFT" && row.status !== "APPROVED" && row.status !== "FAILED" && row.status !== "CANCELLED") return null;
    row.body = input.body;
    row.contentHash = input.contentHash;
    row.bannerSvg = input.bannerSvg;
    // Editing revokes approval — the same rule the adapter's UPDATE encodes in one statement.
    row.approvedHash = null;
    row.approvedAt = null;
    row.status = "DRAFT";
    row.updatedAt = input.at.toISOString();
    return { ...row };
  }

  async findPost(userId: string, postId: string): Promise<TelegramPostRecord | null> {
    const found = this.outbox.find((r) => r.id === postId && r.userId === userId);
    return found === undefined ? null : { ...found };
  }

  async listRecentPosts(userId: string, limit: number): Promise<readonly TelegramPostRecord[]> {
    const bound = Math.max(1, Math.min(50, Math.floor(limit) || 1));
    return this.outbox
      .filter((r) => r.userId === userId)
      .slice()
      .reverse()
      .slice(0, bound)
      .map((r) => ({ ...r }));
  }

  async approvePost(input: { userId: string; postId: string; contentHash: string; at: Date }): Promise<TelegramPostRecord | null> {
    const row = this.outbox.find((r) => r.id === input.postId && r.userId === input.userId);
    // Same three conditions as the adapter's single UPDATE: owner, exact bytes, sendable state.
    if (row === undefined || row.contentHash !== input.contentHash) return null;
    if (row.status !== "DRAFT" && row.status !== "APPROVED" && row.status !== "FAILED") return null;
    row.status = "APPROVED";
    row.approvedHash = input.contentHash;
    row.approvedAt = input.at.toISOString();
    row.updatedAt = input.at.toISOString();
    return { ...row };
  }

  async claimPublish(input: { userId: string; postId: string; maxAttempts: number; at: Date }): Promise<boolean> {
    const row = this.outbox.find((r) => r.id === input.postId && r.userId === input.userId);
    if (row === undefined) return false;
    const max = Math.max(1, Math.min(5, Math.floor(input.maxAttempts) || 1));
    if (row.attempts >= max) return false;
    if (row.status !== "APPROVED" && row.status !== "FAILED") return false;
    row.status = "PUBLISHING";
    row.attempts += 1;
    row.updatedAt = input.at.toISOString();
    return true;
  }

  async finishPost(input: {
    userId: string;
    postId: string;
    status: "PUBLISHED" | "FAILED";
    message_id?: string | null;
    errorCode: string | null;
    at: Date;
    imageFileId?: string | null | undefined;
  }): Promise<TelegramPostRecord | null> {
    const row = this.outbox.find((r) => r.id === input.postId && r.userId === input.userId);
    if (row === undefined || row.status !== "PUBLISHING") return null;
    // Same rule as the SQL path: an absent id keeps the stored one, so a text-card retry after a
    // successful upload does not lose the reference the upload earned.
    if (input.imageFileId !== undefined && input.imageFileId !== null) row.imageFileId = input.imageFileId;
    row.status = input.status;
    row.telegramMessageId = input.status === "PUBLISHED" ? (input.message_id ?? null) : null;
    row.publishedAt = input.status === "PUBLISHED" ? input.at.toISOString() : null;
    row.errorCode = input.status === "FAILED" ? (input.errorCode ?? "SEND_FAILED") : null;
    row.updatedAt = input.at.toISOString();
    return { ...row };
  }

}
