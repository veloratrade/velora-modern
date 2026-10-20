// Prepared channel posts: gather real values, render, preview, approve, publish.
//
// WHY A SERVICE AND NOT BOT CODE
//   The same three steps have to run from the Telegram bot (a tap on "Publish") and from anything
//   else that can own a session — and the security properties are the interesting ones: which
//   channel is addressed, whose data was read, whether the bytes being sent are the bytes that were
//   approved. Putting them in one place is what lets each be asserted once instead of per entry
//   point. The bot keeps presentation and authorization; this keeps the workflow.
//
// THE APPROVAL RULE, STATED EXACTLY
//   A preview is stored with `content_hash = sha256(body)`. Approval stores `approved_hash`.
//   Publishing is allowed only while the two agree, and the database enforces that (0037's
//   `approval_matches_content`), so an edit after approval cannot inherit consent — it returns to
//   needing a fresh approval. A prior "prepare a banner" is therefore NOT permission to publish: the
//   permission is per post row, per exact bytes.
//
// WHAT THIS NEVER DOES
//   - It never accepts a chat id from a caller as a destination. The destination is always a
//     `telegram_channels` row owned by the user, and it is refused if verification is not ACTIVE
//     with `canPost` (0023's rule, re-read here rather than remembered).
//   - It never invents a value. Fields the user has not recorded stay as the domain's
//     "not recorded" marker, and every gap is returned to the caller so the preview can SHOW it.
//     An AI interpretation, when there is one, is passed in by the caller and rendered under its own
//     label — never merged into the trader's own words.
//   - It never retries a send that may have landed. `claimPublish` is a one-way door: if the
//     process dies mid-request, the row stays PUBLISHING and the user is told it may already be
//     posted, because a duplicate on a public channel is worse than a post needing one more tap.

import { createHash } from "node:crypto";
import {
  BUILT_IN_TEMPLATES,
  NOT_RECORDED,
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_TEXT_LIMIT,
  builtinTemplate,
  describeTemplateGaps,
  inspectTemplate,
  isAllowedLink,
  renderBanner,
  renderTemplate,
  TEMPLATE_FIELDS,
  toLatinDigits,
  type BannerResult,
  type TemplateLocale,
  type TemplateValues,
} from "@velora/domain";
import type { TelegramBotApi, TelegramFileRef } from "./telegramApi.js";
import { TelegramApiError } from "./telegramApi.js";
import type { PostClaimResult, TelegramChannelRecord, TelegramPostRecord, TelegramStore, TelegramTemplateRecord, TemplateSaveResult } from "./telegramStore.js";

export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** How many times one post may be sent at all. Beyond it, the user is told, not retried. */
export const MAX_PUBLISH_ATTEMPTS = 3;

// ─────────────────────────────── ports ───────────────────────────────
/** The journal reads this service needs. Narrow on purpose: not "the whole application service". */
export interface PostDataPort {
  /** The day's checklist as stored, or null when the user never reported that day. */
  checklistFor(userId: string, reportDate: string): Promise<{
    items: Record<string, { state: string; value: string | null }>;
    coverage: { confirmed: number; unknown: number; unreviewed: number };
    timezone: string;
  } | null>;
  /** Stats for a named window, already summarised — the service must not re-derive any of it. */
  statsFor(userId: string, windowKind: "today" | "yesterday" | "week" | "all"): Promise<PostStats | null>;
  /** One of the user's own trades, for a post about a specific position. Null when not theirs. */
  tradeFor(userId: string, tradeId: string): Promise<PostTrade | null>;
  /**
   * The day a "today" argument resolves to, in the user's zone — the caller owns the timezone, so this
   * is ASYNC: in the real deployment the zone is a row lookup, and a synchronous signature here would
   * have forced the port to either cache a user's profile or fall back to the server's day, which is
   * precisely the bug the shared date contract exists to prevent.
   */
  todayFor(userId: string): Promise<string>;
}

export interface PostStats {
  readonly closedCount: number;
  readonly openCount: number;
  readonly winRate: string | null;
  readonly profitFactor: string | null;
  /** Net realised P&L for the window (the journal's `totalPnl`, named for what the card says). */
  readonly netPnl: string | null;
  /**
   * Average R and the P&L extremes. Named after the metrics that EXIST in the journal summary
   * (`averageR`, `bestTrade`, `worstTrade`): there is no net-R or best-R figure anywhere in this
   * product, and a template field called `bestR` holding a P&L number would be a fabricated metric
   * with a plausible name — the exact failure this product cannot afford in a post an audience reads
   * as performance evidence.
   */
  readonly averageR: string | null;
  readonly bestTrade: string | null;
  readonly worstTrade: string | null;
  readonly totalFees: string;
  readonly averageWin: string;
  readonly averageLoss: string;
  /** Human label for the window, e.g. "this week" / "all time". */
  readonly windowLabel: string;
  /** Non-null when the figures come from a bounded sample rather than the whole window. */
  readonly sampledOf: number | null;
  readonly flags: readonly string[];
}

export interface PostTrade {
  readonly id: string;
  readonly symbol: string;
  readonly direction: string;
  readonly entryPrice: string | null;
  readonly exitPrice: string | null;
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
  readonly volume: string | null;
  readonly strategy: string | null;
  readonly emotion: string | null;
  readonly notes: string | null;
  readonly openTime: string | null;
  readonly timezone: string;
  /** The user's own timezone, used only to render a date for display. */
  readonly occurredLabel: string | null;
}

export interface PostServiceDeps {
  readonly store: TelegramStore;
  readonly data: PostDataPort;
  /** The Bot API. Null when the deployment has no token — publishing is then refused, not faked. */
  readonly api: TelegramBotApi | null;
  /** Hosts a URL button may point at. Anything else is not a destination we offer. */
  readonly allowedLinkHosts: readonly string[];
  readonly now?: () => Date;
  /**
   * SVG → PNG for the banner card, when this runtime can produce one (see `telegram/bannerRaster.ts`).
   *
   * WHY A PLAIN FUNCTION AND NOT THE DOMAIN'S `BannerSink` PORT. `BannerSink.upload(svg) → ref`
   * assumed an upload endpoint that returns a reference before the photo is sent. The Bot API has no
   * such method: a `file_id` only exists once a photo has gone to a chat. What this runtime CAN do is
   * rasterize, and what publish then needs is bytes — so the injected capability is exactly the bytes,
   * and "absent" means "no native image module or no Persian font here", decided once at wiring time.
   * A `null` return means "the render failed", which the publish path treats as "send the text card":
   * never an error the trader has to survive, and never a blank image standing in for a real one.
   */
  readonly renderBannerPng?: ((svg: string) => Promise<Buffer | null>) | undefined;
}

// ─────────────────────────────── preview ───────────────────────────────
export interface PreviewRequest {
  readonly userId: string;
  readonly locale: TemplateLocale;
  /**
   * Which registered channel to address. Omitted = the user's ACTIVE one. When present it must be a
   * chat this user has bound AND verified: an id that merely appears in the conversation is not a
   * destination, so a guess cannot aim a post at somebody else's channel (0037's composite owner FK
   * keeps that true even if this check were ever removed).
   */
  readonly channelChatId?: string | undefined;
  /** A built-in id (`velora.bias`) or a saved template name. Exactly one of the two. */
  readonly templateId?: string | undefined;
  readonly templateName?: string | undefined;
  /** The day whose checklist feeds the card. Defaults to the user's own "today". */
  readonly reportDate?: string | undefined;
  readonly tradeId?: string | undefined;
  readonly windowKind?: "today" | "yesterday" | "week" | "all" | undefined;
  /** Stable per user action: a re-delivered update reuses the row instead of making a second post. */
  readonly dedupeKey: string;
  /**
   * A title override for the banner card, from the user's own settings (0042).
   *
   * Deliberately an input rather than a store read: the service composes a card from the request it
   * was given, and a renderer that silently consulted a settings row would make two callers with the
   * same request produce different artwork. Capped by the migration at 60 characters.
   */
  readonly bannerTitle?: string | null | undefined;
  /** An AI interpretation supplied by the caller, already labelled. Never read from a template. */
  readonly analysis?: string | null | undefined;
  /** A Telegram file id for the user's own screenshot, so the caption can be posted WITH it. */
  readonly chartFileId?: string | null | undefined;
  /** Compose the banner artwork. Off for a text-only post, and off when the caller has no sink. */
  readonly banner?: boolean | undefined;
}

/**
 * Two outcomes, because a post without a destination is not a post. The card and its gaps come back
 * either way, but only a preview that resolved a channel produces a row a user can approve: writing
 * a `channel_id = 0` placeholder would put a fake destination in a table whose only job is to
 * remember where something actually went.
 */
export type PreviewResult =
  | {
      readonly status: "ready";
  readonly post: TelegramPostRecord;
  readonly text: string;
  readonly banner: BannerResult | null;
  readonly gaps: readonly string[];
  readonly unknownPlaceholders: readonly string[];
  readonly unsupportedPlaceholders: readonly string[];
  readonly strippedTags: readonly string[];
  readonly truncated: boolean;
  readonly markupDropped: boolean;
  /** Where the image would be posted to, resolved from the user's OWN bindings. */
  readonly channel: TelegramChannelRecord | null;
  /** Why a send would be refused even though a destination is bound. Null when it is fine. */
  readonly blockedReason: "NO_API" | "CHANNEL_UNVERIFIED" | null;
  readonly reused: boolean;
      }
  | {
      readonly status: "needs-channel";
      readonly text: string;
      readonly banner: BannerResult | null;
      readonly gaps: readonly string[];
      readonly unknownPlaceholders: readonly string[];
      readonly unsupportedPlaceholders: readonly string[];
      readonly strippedTags: readonly string[];
      readonly truncated: boolean;
      readonly markupDropped: boolean;
      readonly reason: "NO_CHANNEL" | "CHANNEL_NOT_OURS";
    };

/**
 * A resolved template. `body` is the text for the locale that was asked for — decided HERE, once, in
 * code for a built-in and verbatim for a user's own row. `version` travels with it because the post
 * must record WHICH version produced it (0037 stores `template_key` + `template_version`).
 */
export interface TemplateSource {
  readonly kind: "builtin" | "user";
  readonly body: string;
  readonly key: string;
  readonly version: number;
}

export class TelegramPostService {
  constructor(private readonly deps: PostServiceDeps) {}

  private get now(): () => Date {
    return this.deps.now ?? (() => new Date());
  }

  /** Resolve a built-in id or a saved template name to a body. Never to arbitrary text. */
  async resolveTemplate(
    userId: string,
    request: { templateId?: string; templateName?: string },
    locale: TemplateLocale,
  ): Promise<TemplateSource | null> {
    if (request.templateId !== undefined && request.templateName !== undefined) return null;
    if (request.templateId !== undefined) {
      const found = builtinTemplate(request.templateId);
      if (found === null) return null;
      return { kind: "builtin", body: found.body[locale], key: found.id, version: found.version };
    }
    if (request.templateName === undefined) return null;
    const saved = await this.deps.store.findCurrentTemplate(userId, request.templateName);
    return saved === null ? null : { kind: "user", body: saved.body, key: saved.name, version: saved.version };
  }

  /**
   * The values a card may show. Everything here is read from a persisted record; nothing is
   * inferred, filled in from a previous day, or derived from a model's guess.
   */
  async collectValues(request: PreviewRequest, locale: TemplateLocale): Promise<{ values: TemplateValues; stats: PostStats | null }> {
    const values: Record<string, string | number | null> = {};
    const reportDate = request.reportDate ?? (await this.deps.data.todayFor(request.userId));
    const checklist = await this.deps.data.checklistFor(request.userId, reportDate);
    const stats = request.windowKind === undefined ? null : await this.deps.data.statsFor(request.userId, request.windowKind);

    // The day is a fact about the REQUEST, not about the checklist: `/post velora.bias 2026-10-19`
    // knows which day it is about whether or not that day was ever filed. It therefore sits OUTSIDE
    // the branch below — inside it, a post about an unreported day printed "date: not recorded" for a
    // date the user had just typed, which is the one kind of wrong that a reader cannot spot.
    values["date"] = reportDate;
    if (checklist !== null) {
      for (const [key, item] of Object.entries(checklist.items)) {
        values[`checklist.${key}`] = item.value;
        values[`checklist.${key}.state`] = item.state;
      }
      values["checklist.confirmed"] = checklist.coverage.confirmed;
      values["checklist.unknown"] = checklist.coverage.unknown;
      values["checklist.unreviewed"] = checklist.coverage.unreviewed;
      // `stopLoss` and `risk` are checklist items in this build, so the loop above already covered
      // them. If a future item set moves them, this is where the second read would go — stated
      // rather than silently assumed.
    }
    if (stats !== null) {
      values["stats.window"] = stats.windowLabel;
      values["stats.closedCount"] = stats.closedCount;
      values["stats.openCount"] = stats.openCount;
      values["stats.winRate"] = stats.winRate;
      values["stats.profitFactor"] = stats.profitFactor;
      values["stats.netPnl"] = stats.netPnl;
      values["stats.averageR"] = stats.averageR;
      values["stats.bestTrade"] = stats.bestTrade;
      values["stats.worstTrade"] = stats.worstTrade;
      values["stats.totalFees"] = stats.totalFees;
      values["stats.averageWin"] = stats.averageWin;
      values["stats.averageLoss"] = stats.averageLoss;
      // The sampling note is a VALUE, not a decoration: a card built from a bounded sample has to
      // say so in its own text, or the ratio on it reads as a fact about every trade.
      values["stats.sampled"] =
        stats.sampledOf === null
          ? ""
          : locale === "fa"
            ? `نمونه از ${toLatinDigits(String(stats.sampledOf))} رکورد — آمار کامل نیست.`
            : `Sampled from ${stats.sampledOf} records — not the full dataset.`;
    }
    if (request.tradeId !== undefined) {
      const trade = await this.deps.data.tradeFor(request.userId, request.tradeId);
      if (trade !== null) {
        values["symbol"] = trade.symbol;
        values["side"] = trade.direction;
        values["entry"] = trade.entryPrice;
        values["exit"] = trade.exitPrice;
        values["stop"] = trade.stopLoss;
        values["target"] = trade.takeProfit;
        values["risk"] = trade.volume === null ? null : `${trade.volume}`;
        values["strategy"] = trade.strategy;
        values["emotion"] = trade.emotion;
        values["notes"] = trade.notes;
        values["date"] = trade.occurredLabel ?? trade.openTime ?? values["date"] ?? null;
        // NO `values["time"]`: the only time a trade record carries is a UTC instant, and a card whose
        // "Time" line shows a UTC hour to a reader in Tehran is a wrong clock, not a missing one. A
        // user template that names `{{time}}` therefore gets "not recorded" — which is the truth until
        // a localised reading exists in the data layer.
        values["link"] = tradeLink(trade.id, this.deps.allowedLinkHosts[0] ?? null);
      }
    }
    if (request.analysis !== undefined && request.analysis !== null && request.analysis.trim() !== "") {
      values["analysis"] = labelAnalysis(request.analysis, locale);
    }
    if (request.chartFileId !== null && request.chartFileId !== undefined && request.chartFileId !== "") {
      // The file id is a reference to the user's own capture on Telegram's storage. `chart` is a
      // text placeholder, so it renders as a caption line, not as a fabricated path.
      values["chart"] = locale === "fa" ? "تصویر چارت ضمیمه شد" : "chart image attached";
    }
    return { values, stats };
  }

  /**
   * Render + store a preview. The returned `gaps` are what the bot must show the user BEFORE asking
   * for approval: a card with holes is offered as a card with holes.
   */
  async preview(request: PreviewRequest): Promise<PreviewResult> {
    const source = await this.resolveTemplate(
      request.userId,
      {
        ...(request.templateId === undefined ? {} : { templateId: request.templateId }),
        ...(request.templateName === undefined ? {} : { templateName: request.templateName }),
      },
      request.locale,
    );
    if (source === null) throw new TelegramPostError("TEMPLATE_NOT_FOUND");

    const body = source.body;
    const { values } = await this.collectValues(request, request.locale);
    const rendered = renderTemplate({
      body,
      values,
      locale: request.locale,
      limit: TELEGRAM_TEXT_LIMIT,
      // The SAME allowlist that gates `{{link}}` gates an `<a href>` written into a template body.
      // Without this line a user's own template would be the one place a link could enter a post.
      allowedLinkHosts: this.deps.allowedLinkHosts,
    });
    const banner =
      request.banner === true
        ? renderBanner({
            title: request.bannerTitle ?? bannerTitle(source.key, request.locale),
            direction: request.locale === "fa" ? "rtl" : "ltr",
            locale: request.locale,
            rows: bannerRows(values, rendered.missing, request.locale),
            // NO `imageUrl`: a Telegram `file_id` is not a URL an <image> element may fetch, and
            // pointing the artwork at a capture this process never opened would be a claim about a
            // file. The photo goes to Telegram as the photo; the banner stays the banner.
            footnote:
              rendered.missing.length === 0
                ? footnote(source, request.locale)
                : `${footnote(source, request.locale)} · ${request.locale === "fa" ? `${rendered.missing.length} فیلد خالی` : `${rendered.missing.length} empty fields`}`,
            // A `file_id` is not a URL an <image> element can fetch, so the banner never points at
            // it. The photo itself is sent from the caption's own `sendPhoto`, from the original.
          })
        : null;

    const channel = await this.resolveChannel(request);
    if (channel === null) {
      return {
        status: "needs-channel",
        text: rendered.text,
        banner,
        gaps: describeTemplateGaps(inspectTemplate(body), rendered.missing, request.locale),
        unknownPlaceholders: rendered.unknown,
        unsupportedPlaceholders: rendered.unsupported,
        strippedTags: rendered.strippedTags,
        truncated: rendered.truncated,
        markupDropped: rendered.markupDropped,
        reason: request.channelChatId !== undefined ? "CHANNEL_NOT_OURS" : "NO_CHANNEL",
      };
    }
    // Claiming BEFORE the send is the duplicate guard: a re-delivered update reuses this row.
    const claim: PostClaimResult = await this.deps.store.claimPost({
      userId: request.userId,
      channelId: channel.id,
      chatId: channel.chatId,
      body: rendered.text,
      contentHash: sha256Hex(rendered.text),
      dedupeKey: request.dedupeKey,
      bannerSvg: banner?.svg ?? null,
      imageFileId: request.chartFileId ?? null,
      templateKey: source.key,
      templateVersion: source.version,
      at: this.now(),
    });

    const blocked = await this.blockedReason(channel);
    return {
      status: "ready" as const,
      post: claim.post,
      text: rendered.text,
      banner,
      gaps: describeTemplateGaps(inspectTemplate(body), rendered.missing, request.locale),
      unknownPlaceholders: rendered.unknown,
      unsupportedPlaceholders: rendered.unsupported,
      strippedTags: rendered.strippedTags,
      truncated: rendered.truncated,
      markupDropped: rendered.markupDropped,
      channel,
      blockedReason: blocked,
      reused: claim.status === "duplicate",
    };
  }

  /** Only the user's OWN verified bindings are destinations. Never a chat id read out of text. */
  private async resolveChannel(request: PreviewRequest): Promise<TelegramChannelRecord | null> {
    if (request.channelChatId !== undefined) {
      const found = await this.deps.store.findChannel(request.userId, request.channelChatId);
      return found;
    }
    return this.deps.store.findActiveChannel(request.userId);
  }

  /** Why publishing is impossible right now, or null. A preview is always allowed; a send is not. */
  private async blockedReason(channel: TelegramChannelRecord | null): Promise<"NO_API" | "CHANNEL_UNVERIFIED" | null> {
    // Shared by preview and publish on purpose: the two must never disagree about what "allowed"
    // means, or a preview says yes and a send quietly does something else.
    if (this.deps.api === null) return "NO_API";
    if (channel === null) return "CHANNEL_UNVERIFIED";
    // Re-read the capability rather than trusting the stored flag alone: an admin can remove the
    // bot between two posts, and 0023 stores the verdict as of the last verification.
    try {
      const member = await this.deps.api!.getChatMember(channel.chatId, "@me");
      if (member.status === "kicked" || member.status === "left") return "CHANNEL_UNVERIFIED";
      if (channel.status !== "ACTIVE" || !channel.canPost) return "CHANNEL_UNVERIFIED";
      if (channel.chatType !== "group" && member.canPostMessages !== true) return "CHANNEL_UNVERIFIED";
    } catch {
      return "CHANNEL_UNVERIFIED";
    }
    return channel.status === "ACTIVE" && channel.canPost ? null : "CHANNEL_UNVERIFIED";
  }

  /**
   * Re-render and re-store a post the user is editing. The new bytes get a NEW content hash, which
   * is what revokes the previous approval (0037 makes the old approval un-publishable).
   */
  /**
   * Re-render a post the user is editing, IN THE SAME ROW.
   *
   * A second row would leave the first one approved and publishable — two copies of "the same" post
   * with one consent between them. `revisePost` replaces the body and its hash and CLEARS the
   * approval in one conditional statement, so the edit is what revokes consent rather than a later
   * check somewhere else.
   */
  async edit(input: {
    readonly userId: string;
    readonly postId: string;
    readonly body: string;
    readonly bannerSvg?: string | null | undefined;
  }): Promise<{ readonly post: TelegramPostRecord; readonly changed: boolean; readonly explanation: readonly string[] }> {
    const before = await this.deps.store.findPost(input.userId, input.postId);
    if (before === null) throw new TelegramPostError("POST_NOT_FOUND");
    const inspection = inspectTemplate(input.body);
    if (inspection.empty || inspection.tooLong || inspection.unsupported.length > 0) {
      throw new TelegramPostError("TEMPLATE_INVALID");
    }
    const revised = await this.deps.store.revisePost({
      userId: input.userId,
      postId: input.postId,
      body: input.body,
      contentHash: sha256Hex(input.body),
      // `undefined` keeps the artwork the post already had; only a re-render of the banner replaces
      // it, and passing null here would silently delete a preview the user can still see.
      bannerSvg: input.bannerSvg ?? null,
      at: this.now(),
    });
    if (revised === null) throw new TelegramPostError("POST_NOT_EDITABLE");
    return {
      post: revised,
      changed: revised.body !== before.body,
      explanation: describeTemplateGaps(inspection, [], "en"),
    };
  }

  /**
   * Approve the exact bytes of one post. Returns null when the post is not the user's, or when the
   * text has moved since the preview they were shown — the caller must then re-preview rather than
   * send something nobody approved.
   */
  /**
   * The banner PNG for a stored preview, so the user can be shown the IMAGE before approving anything.
   *
   * `null` whenever there is nothing honest to show — no banner in the draft, no rasterizer in this
   * runtime, or the render failed. The caller then says the image preview is unavailable here; the text
   * preview still stands, and the approval is bound to those text bytes and their hash either way.
   */
  /**
   * Whether THIS runtime can produce a PNG at all.
   *
   * A probe, not a constant: the injected `renderBannerPng` is the only thing that knows, and it is
   * different per host (the Node API has `@resvg/resvg-js`, the Cloudflare Worker has no native module
   * and answers null). The result is cached for the life of the service because the answer cannot
   * change without a redeploy — and because a menu screen must not spend a render on every open.
   */
  async canRenderBanner(): Promise<boolean> {
    if (this.deps.renderBannerPng === undefined) return false;
    this.bannerProbe ??= this.deps.renderBannerPng(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>',
    )
      .then((bytes) => bytes !== null)
      .catch(() => false);
    return this.bannerProbe;
  }

  private bannerProbe: Promise<boolean> | null = null;

  async previewPng(input: { readonly userId: string; readonly postId: string }): Promise<Buffer | null> {
    if (this.deps.renderBannerPng === undefined) return null;
    const post = await this.deps.store.findPost(input.userId, input.postId);
    if (post === null || post.bannerSvg === null) return null;
    return await this.deps.renderBannerPng(post.bannerSvg);
  }

  async approve(input: { readonly userId: string; readonly postId: string }): Promise<TelegramPostRecord | null> {
    const post = await this.deps.store.findPost(input.userId, input.postId);
    if (post === null) return null;
    return this.deps.store.approvePost({ userId: input.userId, postId: input.postId, contentHash: post.contentHash, at: this.now() });
  }

  /**
   * Send an approved post. The three failure classes are distinct on purpose:
   *   • `NOT_APPROVED` — nobody approved these bytes (call `approve` first; not a retry);
   *   • `SEND_UNVERIFIED` — the channel no longer accepts our post;
   *   • `SEND_FAILED` / `RATE_LIMITED` / `TIMEOUT` — the attempt is recorded and, where Telegram
   *      says so, `retryAfterSeconds` is surfaced instead of being slept on internally.
   */
  async publish(input: { readonly userId: string; readonly postId: string }): Promise<PublishOutcome> {
    if (this.deps.api === null) return { status: "unavailable", reason: "NO_API" };
    const post = await this.deps.store.findPost(input.userId, input.postId);
    if (post === null) return { status: "not-found" };
    if (post.status === "PUBLISHED") return { status: "already-published", messageId: post.telegramMessageId };
    if (post.status === "PUBLISHING") return { status: "in-flight" };
    // One reason, because it is the only one this layer can state as fact: the row carries no trace
    // of WHETHER it was ever approved (0037 clears both approval columns when the bytes change, so
    // an edited post and a never-approved one are the same row shape). The precise cause belongs to
    // the action that produced it — the edit response says "your edit revoked the approval", the
    // publish refusal says "approve the preview first" — and both of those are true because the
    // caller knows what it just did. Guessing a finer reason HERE would be an invented distinction.
    if (post.approvedHash !== post.contentHash || post.approvedAt === null) {
      return { status: "not-approved" };
    }
    const channel = await this.deps.store.findChannel(input.userId, post.chatId);
    if (channel === null) return { status: "unavailable", reason: "NO_CHANNEL" };
    // Re-verify the destination at the moment of sending, not only at preview time: an admin can
    // remove the bot, or the binding can be revoked, between the two taps. Fail closed on any
    // uncertainty — a post that should have gone out is recoverable, one that should not has left.
    const refused = await this.blockedReason(channel);
    if (refused !== null && refused !== "NO_API") return { status: "unavailable", reason: refused };
    const claimed = await this.deps.store.claimPublish({ userId: input.userId, postId: input.postId, maxAttempts: MAX_PUBLISH_ATTEMPTS, at: this.now() });
    if (!claimed) {
      const after = await this.deps.store.findPost(input.userId, input.postId);
      return { status: "not-claimable", statusNow: after?.status ?? "UNKNOWN", attempts: after?.attempts ?? 0 };
    }
    // The image is decided at send time, not at preview time, in this order:
    //   1. a `file_id` already stored — no upload, no rasterizing, byte-identical to what was previewed;
    //   2. fresh PNG bytes for the banner SVG, when this runtime can rasterize;
    //   3. the card as text.
    // (3) is not a failure: the text IS the message, the banner is its presentation. What is not
    // allowed is claiming an image went out. The outcome therefore reports which path was taken, and
    // the user is told — see `visual` below.
    const png =
      post.imageFileId === null && post.bannerSvg !== null && this.deps.renderBannerPng !== undefined
        ? await this.deps.renderBannerPng(post.bannerSvg)
        : null;
    const withImage = post.imageFileId !== null || png !== null;
    const captionLimit = withImage ? TELEGRAM_CAPTION_LIMIT : TELEGRAM_TEXT_LIMIT;
    const body = post.body.length > captionLimit ? `${post.body.slice(0, captionLimit - 1)}…` : post.body;
    try {
      const sent =
        post.imageFileId !== null
          ? await this.deps.api.sendPhoto(channel.chatId, post.imageFileId, { caption: body })
          : png !== null
            ? await this.deps.api.sendPhoto(
                channel.chatId,
                { bytes: png, filename: `velora-post-${input.postId}.png` },
                { caption: body },
              )
            : await this.deps.api.sendMessage(channel.chatId, body, { disableNotification: false });
      const finished = await this.deps.store.finishPost({
        userId: input.userId,
        postId: input.postId,
        status: "PUBLISHED",
        message_id: sent.messageId,
        errorCode: null,
        at: this.now(),
        // Only a byte upload can YIELD an id; a send that reused a reference returns the same value,
        // and COALESCE keeps the stored one when nothing came back.
        ...(sent.photoFileId !== undefined ? { imageFileId: sent.photoFileId } : {}),
      });
      return { status: "published", messageId: sent.messageId, visual: withImage ? "image" as const : "text" as const, post: finished ?? post };
    } catch (err) {
      const code = err instanceof TelegramApiError ? err.code : "API_ERROR";
      const finished = await this.deps.store.finishPost({
        userId: input.userId,
        postId: input.postId,
        status: "FAILED",
        message_id: null,
        errorCode: code,
        at: this.now(),
      });
      return {
        status: "failed",
        code,
        retryAfterSeconds: err instanceof TelegramApiError ? err.retryAfterSeconds : null,
        attempts: finished?.attempts ?? 1,
      };
    }
  }

  // ─────────────────────────────── templates ───────────────────────────────
  /**
   * Save a user template. Validation happens HERE, before any write, and the answer explains
   * itself: an unknown placeholder is not an error that blocks saving (the user may be writing for a
   * field that exists in a newer build) but it must be named out loud, and an expression is refused
   * because templates cannot compute — that is the whole reason there is no template engine risk.
   */
  async saveTemplate(input: {
    readonly userId: string;
    readonly name: string;
    readonly body: string;
    readonly expectedVersion: number | null;
    readonly locale: TemplateLocale;
  }): Promise<{ readonly result: TemplateSaveResult; readonly explanation: readonly string[] }> {
    const inspection = inspectTemplate(input.body);
    if (inspection.empty || inspection.tooLong || inspection.unsupported.length > 0) {
      return {
        result: { status: "conflict", current: input.expectedVersion === null ? null : await this.deps.store.findCurrentTemplate(input.userId, input.name) },
        explanation: describeTemplateGaps(inspection, [], input.locale),
      };
    }
    const result = await this.deps.store.saveTemplate({
      userId: input.userId,
      name: input.name,
      body: input.body,
      expectedVersion: input.expectedVersion,
      at: this.now(),
    });
    return { result, explanation: describeTemplateGaps(inspection, [], input.locale) };
  }

  /**
   * The post as its OWNER sees it — the only way the bot may read a post before acting on a button
   * press. `null` covers both "does not exist" and "is not yours" with the same answer, so a guessed
   * post id cannot learn anything about somebody else's outbox.
   */
  async findPost(userId: string, postId: string): Promise<TelegramPostRecord | null> {
    return this.deps.store.findPost(userId, postId);
  }

  async listTemplates(userId: string): Promise<readonly TelegramTemplateRecord[]> {
    return this.deps.store.listTemplates(userId);
  }

  /** The catalogue a user sees: the built-ins first, then their own current versions. */
  // (Locale selects only the NAME shown; a user's body is shown as stored.)
  async availableTemplates(userId: string, locale: TemplateLocale): Promise<readonly { key: string; name: string; version: number; builtIn: boolean }[]> {
    const mine = await this.deps.store.listTemplates(userId);
    return [
      ...BUILT_IN_TEMPLATES.map((t) => ({ key: t.id, name: t.name[locale], version: t.version, builtIn: true as const })),
      ...mine.map((t) => ({ key: t.name, name: t.name, version: t.version, builtIn: false as const })),
    ];
  }

  async forgetTemplate(userId: string, name: string): Promise<boolean> {
    return this.deps.store.retireTemplate(userId, name, this.now());
  }

  /** A URL button is only ever built from an allowlisted host — never from template content. */
  isLinkAllowed(url: string): boolean {
    return isAllowedLink(url, this.deps.allowedLinkHosts);
  }
}

export type PublishOutcome =
  | {
      readonly status: "published";
      readonly messageId: string;
      /**
       * "image" when the channel received a photo post, "text" when it received the card as text. The
       * bot says which one it delivered: a trader who expected the styled banner and got text must know
       * that happened and why (no rasterizer in this runtime) rather than discover it in the channel.
       */
      readonly visual: "image" | "text";
      readonly post: TelegramPostRecord;
    }
  | { readonly status: "already-published"; readonly messageId: string | null }
  | { readonly status: "in-flight" }
  | { readonly status: "not-approved" }
  | { readonly status: "unavailable"; readonly reason: "NO_API" | "NO_CHANNEL" | "CHANNEL_UNVERIFIED" }
  | { readonly status: "not-found" }
  | { readonly status: "not-claimable"; readonly statusNow: string; readonly attempts: number }
  | { readonly status: "failed"; readonly code: string; readonly retryAfterSeconds: number | null; readonly attempts: number };

export class TelegramPostError extends Error {
  constructor(
    readonly code: "TEMPLATE_NOT_FOUND" | "POST_NOT_FOUND" | "TEMPLATE_INVALID" | "POST_NOT_EDITABLE",
  ) {
    super(`post: ${code}`);
    this.name = "TelegramPostError";
  }
}

function bannerTitle(key: string, locale: TemplateLocale): string {
  const found = builtinTemplate(key);
  if (found !== null) return found.name[locale];
  return locale === "fa" ? "پست VELORA" : "VELORA post";
}

/** The banner shows exactly the fields the card shows, in the same order — no extra claims. */
/** Labels come from the same catalogue the placeholders are validated against — one source. */
function fieldLabel(key: string, locale: TemplateLocale): string {
  const spec = TEMPLATE_FIELDS[key];
  if (spec !== undefined) return spec.label[locale];
  return key.startsWith("checklist.") ? key.slice("checklist.".length) : key;
}

function bannerRows(values: TemplateValues, missing: readonly string[], locale: TemplateLocale) {
  const rows: { label: string; value: string; emphasis?: "gain" | "loss" | "muted" }[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (key === "analysis" || key === "chart" || key === "link" || value === null || value === undefined || value === "") continue;
    const label = fieldLabel(key, locale);
    rows.push({
      label,
      value: String(value),
      ...(missing.includes(key) ? { emphasis: "muted" as const } : {}),
    });
    if (rows.length >= 11) break;
  }
  if (rows.length === 0) {
    rows.push({ label: locale === "fa" ? "وضعیت" : "Status", value: NOT_RECORDED[locale], emphasis: "muted" });
  }
  return rows;
}

function footnote(source: TemplateSource, locale: TemplateLocale): string {
  const label = source.kind === "builtin" ? `VELORA · ${source.key} v${source.version}` : `VELORA · ${source.key} v${source.version}`;
  return locale === "fa" ? `${label} · فقط دادهٔ ثبت‌شده` : `${label} · recorded data only`;
}

/**
 * The one place an AI sentence gets a label.
 *
 * An interpretation is appended under a prefix naming it as an interpretation. That is not
 * decoration: on a public channel, a model's read of a chart and a trader's own confirmed note look
 * identical unless somebody says which is which, and the "somebody" cannot be the model.
 */
function labelAnalysis(text: string, locale: TemplateLocale): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const prefix = locale === "fa" ? "تفسیر AI: " : "AI interpretation: ";
  return trimmed.startsWith(prefix) ? trimmed : `${prefix}${trimmed}`;
}

/** A trade link, only ever to an allowlisted host — the id alone is meaningless without one. */
function tradeLink(tradeId: string, host: string | null): string | null {
  if (host === null) return null;
  const url = `https://${host}/trades/${encodeURIComponent(tradeId)}`;
  return isAllowedLink(url, [host]) ? url : null;
}

/** Exposed for the file-reference rules the bot needs when a chart accompanies a post. */
export function isReusableChartFile(file: TelegramFileRef | null): file is TelegramFileRef {
  return file !== null && file.filePath !== null && file.fileId.length >= 20;
}
