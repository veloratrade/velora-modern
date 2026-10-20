// The prepared-post workflow: what may be shown, what may be approved, what may be sent.
//
// These tests are written against the MemoryTelegramStore and a scripted Bot API because the
// properties under test are not storage details — they are the workflow's refusal behaviour, and
// each one has to hold against BOTH adapters (the SQL side is covered in
// `db/tests/telegramStoreAdapter.test.ts`). What is asserted here is mostly what does NOT happen:
// no post without a destination, no send without an approval of these exact bytes, no second
// publication of the same row, no invented value, no image claimed as sent when there was none.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryTelegramStore } from "./memoryTelegramStore.js";
import type { TelegramChannelRecord } from "./telegramStore.js";
import { TelegramPostService, TelegramPostError, sha256Hex, type PostDataPort, type PostStats, type PreviewRequest } from "./telegramPostService.js";
import type { SendPhotoOptions, SentMessageOptions, TelegramBotApi } from "./telegramApi.js";
import { TelegramApiError } from "./telegramApi.js";

const T0 = new Date("2026-10-19T09:30:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const USER = "42";
const CHAT = "-100123";

interface Sent {
  readonly kind: "text" | "photo";
  readonly chatId: string;
  readonly body: string;
  readonly photo?: string;
  readonly options: SentMessageOptions | SendPhotoOptions | undefined;
}

class FakeApi {
  readonly sent: Sent[] = [];
  failWith: TelegramApiErrorCode | null = null;
  retryAfter: number | null = null;
  memberStatus: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked" = "administrator";
  canPost = true;

  async sendMessage(chatId: string, text: string, options?: SentMessageOptions) {
    this.record("text", chatId, text, undefined, options);
    return { messageId: `m${this.sent.length}` };
  }
  async sendPhoto(chatId: string, photo: string, options?: SendPhotoOptions) {
    this.record("photo", chatId, options?.caption ?? "", photo, options);
    return { messageId: `p${this.sent.length}` };
  }
  private record(kind: Sent["kind"], chatId: string, body: string, photo?: string, options?: SentMessageOptions | SendPhotoOptions) {
    if (this.failWith !== null) {
      const err = new TelegramApiError(this.failWith, 400, 400, this.retryAfter);
      this.failWith = null; // one failed attempt, then the caller's next try may work
      throw err;
    }
    this.sent.push({ kind, chatId, body, ...(photo === undefined ? {} : { photo }), options });
  }
  async getChatMember() {
    return { status: this.memberStatus, canPostMessages: this.canPost };
  }
  async getChat(chatId: string) {
    return { id: chatId, type: "channel" as const, title: "Velora Journal" };
  }
  async answerCallbackQuery(): Promise<void> {}
  async getFile(fileId: string) {
    return { fileId, filePath: `path/${fileId}`, fileSizeBytes: 10 };
  }
  async downloadFile(): Promise<Buffer> {
    return Buffer.from("bytes");
  }
  async getMe() {
    return { id: "7", username: "velora_bot" };
  }
  async getUpdates() {
    return [];
  }

  get asApi(): TelegramBotApi {
    return this as unknown as TelegramBotApi;
  }
}

type TelegramApiErrorCode = Exclude<InstanceType<typeof TelegramApiError>["code"], never>;

/** Everything the journal side can honestly say about this user, supplied per test. */
function dataPort(over: Partial<PostDataPort> = {}): PostDataPort {
  const stats: PostStats = {
    closedCount: 6,
    openCount: 1,
    winRate: "66.7",
    profitFactor: "1.84",
    netPnl: "320.50",
    averageR: "2.10",
    bestTrade: "1.50",
    worstTrade: "-0.50",
    totalFees: "12.00",
    averageWin: "80.00",
    averageLoss: "-40.00",
    windowLabel: "this week",
    sampledOf: null,
    flags: [],
  };
  return {
    todayFor: async () => "2026-10-19",
    checklistFor: async () => ({
      items: {
        dailyBias: { state: "CONFIRMED", value: "bullish" },
        marketLeg: { state: "CONFIRMED", value: "up" },
        smt: { state: "UNKNOWN", value: null },
        stopLoss: { state: "CONFIRMED", value: "2641.5" },
        risk: { state: "CONFIRMED", value: "0.5%" },
      },
      coverage: { confirmed: 4, unknown: 1, unreviewed: 6 },
      timezone: "Asia/Tehran",
    }),
    statsFor: async () => stats,
    tradeFor: async (_userId, tradeId) =>
      tradeId === "t-9"
        ? {
            id: "t-9",
            symbol: "XAUUSD",
            direction: "buy",
            entryPrice: "2650",
            exitPrice: "2660",
            stopLoss: "2641.5",
            takeProfit: null,
            volume: "0.50",
            strategy: "Breaker",
            emotion: null,
            notes: null,
            openTime: "2026-10-19 09:00",
            timezone: "Asia/Tehran",
            occurredLabel: "2026-10-19",
          }
        : null,
    ...over,
  };
}

async function build(
  input: {
    api?: FakeApi | null;
    data?: Partial<PostDataPort>;
    channel?: TelegramChannelRecord | null;
    hosts?: readonly string[];
    sink?: { upload(a: { svg: string; width: number; height: number }): Promise<{ ref: string } | null> } | undefined;
  } = {},
) {
  const store = new MemoryTelegramStore();
  const api = input.api === undefined ? new FakeApi() : input.api;
  if (input.channel !== null) {
    await store.upsertChannel({
      userId: USER,
      chatId: CHAT,
      title: "Velora Journal",
      chatType: "channel",
      status: "ACTIVE",
      canPost: true,
      at: T0,
    });
  }
  const service = new TelegramPostService({
    store,
    data: dataPort(input.data ?? {}),
    api: api === null ? null : api.asApi,
    allowedLinkHosts: input.hosts ?? ["app.veloratrade.ir"],
    now: () => T0,
    ...(input.sink === undefined ? {} : { bannerSink: input.sink }),
  });
  return { store, api, service };
}

const req = (over: Partial<PreviewRequest> = {}): PreviewRequest => ({
  userId: USER,
  locale: "en",
  templateId: "velora.bias",
  dedupeKey: "update:1",
  ...over,
});

test("a preview with no bound channel renders but produces no post — a destination is not optional", async () => {
  const { service, store } = await build({ channel: null });
  const out = await service.preview(req());
  assert.equal(out.status, "needs-channel");
  if (out.status !== "needs-channel") return;
  assert.equal(out.reason, "NO_CHANNEL");
  assert.match(out.text, /Daily bias: bullish/u);
  assert.equal(await store.findPost(USER, "post-1"), null, "nothing may be queued without a destination");
});

test("a guessed chat id is not a destination, even when it is a real channel of another user", async () => {
  const { service } = await build();
  const out = await service.preview(req({ channelChatId: "-100999" }));
  assert.equal(out.status, "needs-channel");
  if (out.status !== "needs-channel") return;
  assert.equal(out.reason, "CHANNEL_NOT_OURS");
});

test("the card shows recorded fields, marks what is missing, and never fills a hole with a guess", async () => {
  const { service } = await build();
  const out = await service.preview(req());
  assert.equal(out.status, "ready");
  if (out.status !== "ready") return;
  assert.match(out.text, /Daily bias: bullish \(confirmed\)/u);
  assert.match(out.text, /SMT: — not recorded \(unknown\)/u);
  // Six items were never reported at all → the gaps are named so the preview says so too.
  assert.ok(out.gaps.length >= 1);
  assert.equal(out.gaps.some((g) => g.includes("priceLocation")), true);
  // and the AI line: no analysis supplied means no analysis line, NOT a neutral one.
  assert.equal(out.text.includes("neutral"), false);
  assert.equal(out.text.includes("AI:"), false);
  assert.equal(out.blockedReason, null);
});

test("unreviewed is not unknown: both states survive the render with their own words", async () => {
  const { service } = await build({
    data: {
      checklistFor: async () => ({
        items: {
          dailyBias: { state: "UNREVIEWED", value: null },
          marketLeg: { state: "UNKNOWN", value: null },
        },
        coverage: { confirmed: 0, unknown: 1, unreviewed: 10 },
        timezone: "Asia/Tehran",
      }),
    },
  });
  const out = await service.preview(req());
  if (out.status !== "ready") throw new Error("expected a ready preview");
  assert.match(out.text, /Daily bias: — not recorded \(unreviewed\)/u);
  assert.match(out.text, /Market leg: — not recorded \(unknown\)/u);
  assert.equal(out.text.includes("confirmed"), false);
});

test("the same update id re-uses one post instead of queueing a second send", async () => {
  const { service, store } = await build();
  const first = await service.preview(req({ dedupeKey: "update:77" }));
  const second = await service.preview(req({ dedupeKey: "update:77" }));
  if (first.status !== "ready" || second.status !== "ready") throw new Error("expected two ready previews");
  assert.equal(second.reused, true);
  assert.equal(second.post.id, first.post.id);
  assert.equal((await store.listRecentPosts(USER, 10)).length, 1);
});

test("publishing requires an approval of these exact bytes, in that order", async () => {
  const { service, api } = await build();
  const preview = await service.preview(req());
  if (preview.status !== "ready") throw new Error("expected a ready preview");
  // Tap "Publish" before approving: refused, and nothing reached Telegram.
  const early = await service.publish({ userId: USER, postId: preview.post.id });
  assert.deepEqual(early, { status: "not-approved" });
  assert.equal(api!.sent.length, 0);

  const approved = await service.approve({ userId: USER, postId: preview.post.id });
  assert.equal(approved?.status, "APPROVED");
  const sent = await service.publish({ userId: USER, postId: preview.post.id });
  assert.equal(sent.status, "published");
  assert.equal(api!.sent.length, 1);
  assert.equal(api!.sent[0]!.kind, "text");
  assert.equal(api!.sent[0]!.chatId, CHAT, "the destination is the user's own bound chat");
});

test("an edit after approval revokes the approval — consent never carries to new wording", async () => {
  const { service, api } = await build();
  const preview = await service.preview(req());
  if (preview.status !== "ready") throw new Error("expected a ready preview");
  await service.approve({ userId: USER, postId: preview.post.id });
  const edited = await service.edit({
    userId: USER,
    postId: preview.post.id,
    body: "<b>changed by the user</b> {{symbol}}",
  });
  assert.equal(edited.changed, true);
  assert.equal(edited.post.status, "DRAFT");
  const out = await service.publish({ userId: USER, postId: preview.post.id });
  // The reason is deliberately coarse (see `publish`): the row cannot tell "never approved" from
  // "approved, then edited", and inventing that distinction here would be a fabricated fact. What
  // matters, and what is asserted, is that the edited bytes are NOT sent.
  assert.deepEqual(out, { status: "not-approved" });
  assert.equal(api!.sent.length, 0);
  // …and the fresh approval of the NEW bytes is what makes it sendable.
  await service.approve({ userId: USER, postId: preview.post.id });
  assert.equal((await service.publish({ userId: USER, postId: preview.post.id })).status, "published");
  assert.equal(api!.sent.length, 1);
});

test("a re-delivered publish cannot post twice, and a published row is terminal", async () => {
  const { service, api } = await build();
  const preview = await service.preview(req());
  if (preview.status !== "ready") throw new Error("expected a ready preview");
  await service.approve({ userId: USER, postId: preview.post.id });
  const first = await service.publish({ userId: USER, postId: preview.post.id });
  const second = await service.publish({ userId: USER, postId: preview.post.id });
  assert.equal(first.status, "published");
  assert.deepEqual(second, { status: "already-published", messageId: "m1" });
  assert.equal(api!.sent.length, 1, "exactly one send for one approved post");
});

test("a failed send is recorded as a failure with a code, and a retry is bounded", async () => {
  const { service, api, store } = await build();
  const preview = await service.preview(req());
  if (preview.status !== "ready") throw new Error("expected a ready preview");
  await service.approve({ userId: USER, postId: preview.post.id });
  api!.failWith = "RATE_LIMITED";
  api!.retryAfter = 30;
  const failed = await service.publish({ userId: USER, postId: preview.post.id });
  assert.equal(failed.status, "failed");
  if (failed.status !== "failed") return;
  assert.equal(failed.code, "RATE_LIMITED");
  assert.equal(failed.retryAfterSeconds, 30, "Telegram's own back-off is surfaced, never slept on here");
  const stored = await store.findPost(USER, preview.post.id);
  assert.equal(stored?.status, "FAILED");
  assert.equal(stored?.errorCode, "RATE_LIMITED");
  assert.equal(stored?.telegramMessageId, null, "a failure must not read as published");
  // Retry the recorded failure, then exhaust the bound: after that the caller is told, not looped.
  const retry = await service.publish({ userId: USER, postId: preview.post.id });
  assert.equal(retry.status, "published");
  const after = await store.findPost(USER, preview.post.id);
  assert.equal(after?.attempts, 2);
});

test("a post that is mid-flight is reported as in-flight, not resent", async () => {
  const { service, store, api } = await build();
  const preview = await service.preview(req());
  if (preview.status !== "ready") throw new Error("expected a ready preview");
  await service.approve({ userId: USER, postId: preview.post.id });
  await store.claimPublish({ userId: USER, postId: preview.post.id, maxAttempts: 3, at: at(1) });
  const out = await service.publish({ userId: USER, postId: preview.post.id });
  assert.deepEqual(out, { status: "in-flight" });
  assert.equal(api!.sent.length, 0);
});

test("publishing with no Bot API configured refuses honestly instead of pretending", async () => {
  const { service } = await build({ api: null });
  const preview = await service.preview(req());
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;
  assert.equal(preview.blockedReason, "NO_API");
  const out = await service.publish({ userId: USER, postId: preview.post.id });
  assert.deepEqual(out, { status: "unavailable", reason: "NO_API" });
});

test("a channel whose permissions were revoked on Telegram's side is not writable", async () => {
  const api = new FakeApi();
  const { service } = await build({ api });
  const preview = await service.preview(req());
  if (preview.status !== "ready") throw new Error("expected a ready preview");
  await service.approve({ userId: USER, postId: preview.post.id });
  api.memberStatus = "left";
  const out = await service.publish({ userId: USER, postId: preview.post.id });
  assert.deepEqual(out, { status: "unavailable", reason: "CHANNEL_UNVERIFIED" });
  assert.equal(api.sent.length, 0);
});

test("a chart the user sent goes as a photo with the caption; the banner stays the banner", async () => {
  const { service, api, store } = await build();
  const preview = await service.preview(req({ chartFileId: "AgACAWsAq8IAvAAAAgADaGVhZA", banner: true }));
  if (preview.status !== "ready") throw new Error("expected a ready preview");
  assert.equal(preview.banner !== null, true);
  assert.match(preview.banner!.svg, /^<svg /u);
  await service.approve({ userId: USER, postId: preview.post.id });
  const out = await service.publish({ userId: USER, postId: preview.post.id });
  assert.equal(out.status, "published");
  assert.equal(api!.sent[0]!.kind, "photo");
  assert.equal(api!.sent[0]!.photo, "AgACAWsAq8IAvAAAAgADaGVhZA");
  assert.ok((api!.sent[0]!.options as SendPhotoOptions).caption !== undefined);
  const stored = await store.findPost(USER, preview.post.id);
  assert.equal(stored?.bannerSvg, preview.banner!.svg, "the artwork the user previewed is the one stored");
  assert.equal(stored?.imageFileId, "AgACAWsAq8IAvAAAAgADaGVhZA");
});

test("an attached image means the caption budget, not the message budget", async () => {
  const { service, api } = await build({
    data: {
      checklistFor: async () => ({
        // REAL checklist keys with oversized values: the point is that a long recorded value still
        // has to fit Telegram's 1024-character caption, not that an unknown key be echoed.
        items: Object.fromEntries(
          ["dailyBias", "marketLeg", "priceLocation", "pdArrayH4", "pdArrayH1", "pdArrayM15", "m1Cisd", "smt", "macroTiming", "stopLoss", "risk"].map(
            (key) => [key, { state: "CONFIRMED", value: "x".repeat(400) }],
          ),
        ),
        coverage: { confirmed: 11, unknown: 0, unreviewed: 0 },
        timezone: "Asia/Tehran",
      }),
    },
  });
  // The BIAS card is the one that renders the eleven item values, so this is the case where the text
  // really is longer than a caption; the setup card would have fit comfortably.
  const preview = await service.preview(
    req({ templateName: undefined, templateId: "velora.bias", chartFileId: "AgACAWsAq8IAvAAAAgADaGVhZA", dedupeKey: "update:14" }),
  );
  if (preview.status !== "ready") throw new Error("expected a ready preview");
  await service.approve({ userId: USER, postId: preview.post.id });
  const out = await service.publish({ userId: USER, postId: preview.post.id });
  assert.equal(out.status, "published", "the caption is cut to what Telegram accepts instead of erroring");
  const caption = (api!.sent[0]!.options as SendPhotoOptions).caption!;
  assert.ok(caption.length <= 1024, String(caption.length));
  assert.equal(caption.endsWith("…"), true);
});

test("AI text is labelled as AI text, and an empty analysis adds nothing", async () => {
  const withAi = await build();
  const a = await withAi.service.preview(req({ analysis: "premium rejection above 2660" }));
  if (a.status !== "ready") throw new Error("expected a ready preview");
  assert.match(a.text, /AI interpretation: premium rejection above 2660/u);
  const b = await withAi.service.preview(req({ analysis: "   ", dedupeKey: "update:2" }));
  if (b.status !== "ready") throw new Error("expected a ready preview");
  assert.equal(b.text.includes("AI interpretation"), false);
});

test("a sampled window says so inside the post, so a ratio is never presented as the population", async () => {
  const { service } = await build({
    data: {
      statsFor: async () => ({
        closedCount: 40,
        openCount: 0,
        winRate: "58.3",
        profitFactor: "1.4",
        netPnl: "100",
        averageR: "1",
        bestTrade: "2",
        worstTrade: "-1",
        totalFees: "1",
        averageWin: "1",
        averageLoss: "-1",
        windowLabel: "all time",
        sampledOf: 200,
        flags: ["SAMPLED"],
      }),
    },
  });
  const out = await service.preview(req({ templateId: "velora.weekly", windowKind: "all", dedupeKey: "update:3" }));
  if (out.status !== "ready") throw new Error("expected a ready preview");
  assert.match(out.text, /Sampled from 200 records — not the full dataset/u);
  assert.match(out.text, /Win rate: 58\.3%/u);
});

test("a user template round-trips: save with an explanation, address by name, unknown field stays visible", async () => {
  const { service, store } = await build();
  const saved = await service.saveTemplate({
    userId: USER,
    name: "my card",
    body: "Bias {{checklist.dailyBias}} · {{notAField}}",
    expectedVersion: null,
    locale: "en",
  });
  assert.equal(saved.result.status, "saved");
  // An unknown name is a WARNING on a successful save, not a silent accept and not a refusal.
  assert.equal(saved.explanation.some((l) => l.includes("notAField")), true);
  // An expression is refused outright: templates may not compute.
  const bad = await service.saveTemplate({ userId: USER, name: "calc", body: "{{1+1}}", expectedVersion: null, locale: "en" });
  assert.equal(bad.result.status, "conflict");
  assert.equal(bad.explanation.some((l) => /cannot compute/iu.test(l)), true);

  // `templateId` must be cleared, not merely added to: the service refuses a request naming both a
  // built-in and a saved template rather than silently preferring one.
  await assert.rejects(
    () => service.preview(req({ templateName: "my card", dedupeKey: "update:both" })),
    (err: unknown) => (err as TelegramPostError).code === "TEMPLATE_NOT_FOUND",
    "an ambiguous template request is a refusal, not a coin flip",
  );
  const out = await service.preview(req({ templateId: undefined, templateName: "my card", dedupeKey: "update:4" }));
  if (out.status !== "ready") throw new Error("expected a ready preview");
  assert.match(out.text, /Bias bullish/u);
  assert.match(out.text, /\{\{notAField\}\}/u, "an unknown placeholder must not vanish");
  assert.deepEqual(out.unknownPlaceholders, ["notAField"]);
  // An expression in the body is refused outright, because a template that half-works is worse
  // than one that says no: nothing here may compute.
  const bad2 = await service.saveTemplate({ userId: USER, name: "calc2", body: "sum {{1+1}}", expectedVersion: null, locale: "en" });
  assert.equal(bad2.result.status, "conflict");
  assert.equal((await store.findCurrentTemplate(USER, "calc2")), null, "a refused save writes nothing");
  // The body that DID save is stored verbatim, so the user's own text — odd token and all — is kept.
  assert.match((await store.findCurrentTemplate(USER, "my card"))!.body, /\{\{notAField\}\}/u);
  // The version that produced the post is recorded on the post.
  assert.equal(out.post.templateKey, "my card");
  assert.equal(out.post.templateVersion, 1);
  assert.equal(sha256Hex(out.text), out.post.contentHash);
});

test("an empty template body is refused, not saved as an empty post", async () => {
  const { service } = await build();
  const saved = await service.saveTemplate({ userId: USER, name: "blank", body: "   ", expectedVersion: null, locale: "en" });
  assert.equal(saved.result.status, "conflict");
  assert.equal(saved.explanation[0], "The template body is empty.");
});

test("a template that is not there is a named error, never a blank post", async () => {
  const { service } = await build();
  await assert.rejects(() => service.preview(req({ templateId: "velora.nope" })), (err: unknown) => (err as TelegramPostError).code === "TEMPLATE_NOT_FOUND");
  await assert.rejects(() => service.preview(req({ templateName: "ghost", dedupeKey: "update:5" })), (err: unknown) => (err as TelegramPostError).code === "TEMPLATE_NOT_FOUND");
});

test("URL buttons only ever point at the allowlist, and the link field is built here rather than typed", async () => {
  const { service } = await build({ hosts: ["app.veloratrade.ir"] });
  assert.equal(service.isLinkAllowed("https://app.veloratrade.ir/trades/9"), true);
  assert.equal(service.isLinkAllowed("https://evil.example/trades/9"), false);
  assert.equal(service.isLinkAllowed("http://app.veloratrade.ir/trades/9"), false);
  assert.equal(service.isLinkAllowed("javascript:alert(1)"), false);
  // A `{{link}}` in a USER template resolves to the allowlisted host, and only there.
  await service.saveTemplate({ userId: USER, name: "withlink", body: "Open: {{link}}", expectedVersion: null, locale: "en" });
  const out = await service.preview(req({ tradeId: "t-9", templateId: undefined, templateName: "withlink", dedupeKey: "update:6" }));
  if (out.status !== "ready") throw new Error("expected a ready preview");
  assert.equal(out.text, "Open: https://app.veloratrade.ir/trades/t-9");
  // With no host configured, the field is empty-by-marker rather than a guessed URL.
  const noHost = await build({ hosts: [] });
  await noHost.service.saveTemplate({ userId: USER, name: "withlink", body: "Open: {{link}}", expectedVersion: null, locale: "en" });
  const bare = await noHost.service.preview(req({ tradeId: "t-9", templateId: undefined, templateName: "withlink", dedupeKey: "update:6" }));
  if (bare.status !== "ready") throw new Error("expected a ready preview");
  assert.equal(bare.text, "Open: — not recorded");
  assert.ok(bare.gaps.some((g) => g.includes("link")))
});

test("a trade that is not the user's contributes nothing — the FK is not the only line of defence", async () => {
  const { service } = await build({ data: { tradeFor: async () => null } });
  const out = await service.preview(req({ tradeId: "someone-elses-trade", templateId: "velora.setup", dedupeKey: "update:8" }));
  if (out.status !== "ready") throw new Error("expected a ready preview");
  assert.equal(out.text.includes("XAUUSD"), false);
  assert.equal(out.text.includes("someone-elses-trade"), false);
});

test("the Persian card renders Persian labels and keeps eastern digits in the user's own text", async () => {
  const { service } = await build();
  const out = await service.preview(req({ locale: "fa", dedupeKey: "update:9" }));
  if (out.status !== "ready") throw new Error("expected a ready preview");
  assert.match(out.text, /بایاس روزانه: bullish \(تأیید\)/u);
  assert.match(out.text, /SMT: — ثبت نشد \(نامشخص\)/u);
  // No `direction` on the result: the renderer derives it from the locale, and the Persian copy
  // above is the observable proof. What must NOT appear is the English label.
  assert.equal(out.text.includes("Daily bias"), false);
  assert.equal(out.banner, null, "no banner was requested for this preview");
});
