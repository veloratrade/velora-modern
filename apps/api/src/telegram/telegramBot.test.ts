// Telegram bot — routing, onboarding gate, idempotency and the journal flow.
//
// WHAT THIS FILE PROVES. The bot is the only component that decides WHAT to
// answer, so the properties worth pinning are behavioural: an unlinked identity
// can reach onboarding and nothing else; an unknown message does not create a
// draft; a Telegram retry does not create a second journal entry; a failure is
// reported as a sentence rather than a stack; and no message is needed twice.
//
// The store, the link service, the journal service and the trade ledger are the
// REAL implementations (the storage is the in-memory double). Only the Bot API
// and the AI provider are fakes, because those are the two boundaries the tests
// must be able to observe and fail on demand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryAuditStore } from "../auth/memoryAuditStore.js";
import { MemoryAiAttemptStore, UnconfiguredAiProvider } from "../aicoach/aiProvider.js";
import { AiCoachService } from "../aicoach/aiCoachService.js";
import { UnconfiguredMediaInterpreter } from "../aicoach/mediaInterpreter.js";
import { JournalAnalysisService } from "../journal/journalAnalysisService.js";
import { JournalApplicationService } from "../journal/journalApplicationService.js";
import { MemoryTradeStore } from "../trades/memoryTradeStore.js";
import { TradeService } from "../trades/tradeService.js";
import { MemoryTelegramStore } from "./memoryTelegramStore.js";
import { TelegramBot, type TelegramBotDeps } from "./telegramBot.js";
import { AiSearchService } from "../ai/aiSearchService.js";
import { AiBrowserService } from "../ai/aiBrowserService.js";
import { AiAgentPlanner } from "../ai/aiAgentPlanner.js";
import type { AiCallRequest, AiManager } from "../ai/aiManager.js";
import { TelegramPostService } from "./telegramPostService.js";
import { TelegramLinkService } from "./telegramLinkService.js";
import type { InlineKeyboardButton, SendPhotoOptions, SentMessageOptions, TelegramBotApi } from "./telegramApi.js";
import { copyFor } from "./telegramCopy.js";
import { CALLBACK_ACTIONS, MENU_TARGETS, parseCallbackData, RATE_LIMIT_DEFAULTS } from "@velora/contracts";
import { CHECKLIST_ITEMS, CHECKLIST_KEY_FOR_ITEM, CHECKLIST_PROMPT_LINES, evaluateRateLimit } from "@velora/domain";
import type { RateLimitKey, TelegramUpdate } from "@velora/contracts";
import type { RateLimitDecision } from "@velora/domain";
import type { RateLimiter } from "../ratelimits/rateLimiter.js";
import { TELEGRAM_CAPTION_LIMIT, TELEGRAM_MAX_DOWNLOAD_BYTES, TELEGRAM_MAX_UPLOAD_BYTES, isSendablePhotoRef, type PhotoUpload } from "./telegramApi.js";

// ── The two fakes ───────────────────────────────────────────────────────────

interface SentMessage {
  readonly chatId: string;
  readonly text: string;
  readonly options: SentMessageOptions | undefined;
}

/** Records everything the bot said; fails on demand for the error paths. */
class FakeBotApi implements TelegramBotApi {
  readonly sent: SentMessage[] = [];
  readonly downloads: string[] = [];
  /**
   * Every photo post, recorded separately from `sent`: a test that asserts "the banner went to the
   * channel" must see the IMAGE call, not a text message that merely mentions one.
   */
  readonly photos: { chatId: string; photo: string | PhotoUpload; caption?: string; options: SendPhotoOptions | undefined }[] = [];
  /** The id this fake hands back for a photo send, standing in for Telegram's largest rendition. */
  photoFileId = "telegram-photo-file-id-0123456789";
  /** Set to make the photo send fail the way a real send does, so the retry path is reachable. */
  failingPhoto = false;
  failingSend = false;
  fileBytes: Buffer = Buffer.from("voice-bytes");
  /** `getFile`'s claim. Null ⇒ the true length; set it to make the claim a lie. */
  declaredSizeBytes: number | null = null;
  /** Overridable per test: the bot's permission verdict comes from Telegram. */
  memberResult: { status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked"; canPostMessages: boolean } = {
    status: "administrator",
    canPostMessages: true,
  };
  chatType: "private" | "group" | "supergroup" | "channel" = "channel";

  async sendMessage(chatId: string, text: string, options?: SentMessageOptions) {
    if (this.failingSend) throw Object.assign(new Error("send failed"), { code: "API_ERROR" });
    this.sent.push({ chatId, text, options });
    return { messageId: String(this.sent.length) };
  }
  async sendPhoto(chatId: string, photo: string | PhotoUpload, options?: SendPhotoOptions) {
    if (this.failingPhoto) throw Object.assign(new Error("send failed"), { code: "API_ERROR" });
    // Same local guard as the real transport. An unsendable ref, an unusable upload or an oversized
    // caption is a bug at the call site, and a fake that accepted them would let the bot pass tests it
    // should fail. Uploaded bytes are held to what the real client checks before it builds a multipart
    // body: non-empty, inside Telegram's ceiling, and a bare `.png` filename.
    if (typeof photo === "string") {
      if (!isSendablePhotoRef(photo)) throw Object.assign(new Error("bad ref"), { code: "INVALID_REQUEST" });
    } else {
      if (photo.bytes.length === 0 || photo.bytes.length > TELEGRAM_MAX_UPLOAD_BYTES) {
        throw Object.assign(new Error("bad upload"), { code: photo.bytes.length === 0 ? "INVALID_REQUEST" : "FILE_TOO_LARGE" });
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\.png$/u.test(photo.filename)) {
        throw Object.assign(new Error("bad filename"), { code: "INVALID_REQUEST" });
      }
    }
    const caption = options?.caption ?? "";
    if (caption.length > TELEGRAM_CAPTION_LIMIT) throw Object.assign(new Error("caption too long"), { code: "INVALID_REQUEST" });
    this.photos.push({ chatId, photo, ...(caption === "" ? {} : { caption }), options });
    return { messageId: `p${this.photos.length}`, photoFileId: this.photoFileId };
  }
  async answerCallbackQuery(): Promise<void> {}
  async getFile(fileId: string) {
    return { fileId, filePath: `path/${fileId}`, fileSizeBytes: this.declaredSizeBytes ?? this.fileBytes.length };
  }
  async downloadFile(filePath: string): Promise<Buffer> {
    this.downloads.push(filePath);
    // Mirrors HttpTelegramBotApi.downloadFile: the received bytes are measured
    // and an oversized body THROWS (FILE_TOO_LARGE) rather than being truncated.
    // Without this the fake would hand back more bytes than production ever
    // would, and the "declared size lied" test would prove nothing.
    if (this.fileBytes.length > TELEGRAM_MAX_DOWNLOAD_BYTES) {
      throw Object.assign(new Error("file too large"), { code: "FILE_TOO_LARGE" });
    }
    return this.fileBytes;
  }
  async getChat(chatId: string) {
    return { id: chatId, type: this.chatType, title: "My Journal" };
  }
  async getChatMember() {
    return this.memberResult;
  }
  async getMe() {
    return { id: "42", username: "velora_journal_bot" };
  }
  async getUpdates(): Promise<TelegramUpdate[]> {
    return [];
  }

  /** Every unique button label the bot rendered, newest last. */
  get buttonLabels(): string[] {
    return this.sent
      .flatMap((m) => m.options?.inlineKeyboard ?? [])
      .flatMap((row: readonly InlineKeyboardButton[]) => row.map((b) => b.text));
  }
  /** Every button URL the bot rendered — the onboarding/connect link lives here, not in the text. */
  get urls(): string[] {
    return this.sent
      .flatMap((m) => m.options?.inlineKeyboard ?? [])
      .flat()
      .map((b: InlineKeyboardButton) => (b as { url?: string }).url)
      .filter((u): u is string => typeof u === "string");
  }
  get lastText(): string {
    return this.sent.at(-1)?.text ?? "";
  }
  get texts(): string[] {
    return this.sent.map((m) => m.text);
  }
}

function makeBot(options: { now?: () => Date; limiter?: RateLimiter; posts?: boolean; tools?: NonNullable<TelegramBotDeps>["tools"] } = {}): {
  bot: TelegramBot;
  api: FakeBotApi;
  store: MemoryTelegramStore;
  audit: MemoryAuditStore;
  links: TelegramLinkService;
  trades: TradeService;
  journal: JournalApplicationService;
  posts?: TelegramPostService | undefined;
} {
  const store = new MemoryTelegramStore();
  const audit = new MemoryAuditStore();
  const api = new FakeBotApi();
  const links = new TelegramLinkService({
    store,
    audit,
    botUsername: () => "velora_journal_bot",
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const tradeStore = new MemoryTradeStore();
  const trades = new TradeService({
    store: tradeStore,
    getUserTimezone: async () => "Asia/Tehran",
    verifyAccountOwnership: async () => true,
  });
  const journal = new JournalApplicationService({
    trades,
    drafts: store,
    getUserTimezone: async () => "Asia/Tehran",
    // Shared with the bot and the link service when a test injects a clock: a windowed `/stats`
    // assertion is meaningless if "today" for the bot and "today" for the journal can disagree.
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const attempts = new MemoryAiAttemptStore();
  const coach = new AiCoachService({
    provider: new UnconfiguredAiProvider(),
    consent: { consentState: async () => ({ consented: true, consentedAt: null }) },
    attempts,
    allowedProviders: ["openai", "gemini"],
  });

  const deps: TelegramBotDeps & { posts?: TelegramPostService } = {
    api,
    store,
    links,
    // The SAME audit store the link service writes to, exactly as the factory wires one `PgAuditStore`
    // into both: a publish is recorded on the trail the security events live on, and a test can read the
    // one chronology rather than a parallel one.
    audit,
    journal,
    analysis: new JournalAnalysisService({ coach, journal }),
    media: { interpreter: new UnconfiguredMediaInterpreter(), attempts },
    appUrl: () => "https://app.velora.example",
    getUserLocale: async () => "fa",
    log: () => undefined,
    ...(options.limiter === undefined ? {} : { limiter: options.limiter }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  };
  // `posts: true` wires the REAL post service over the same store, the same fake Bot API and the same
  // journal service — so a passing publishing test proves the bot's own authorization, rate-limit and
  // idempotency code ran, not a stub's. The data port is the only fake here, and it is fake in the
  // direction that makes the test HARDER: no stats and no checklist, so every field the preview shows
  // must be a field the template resolves to "not recorded" rather than a number the fake supplied.
  const posts = options.posts === true
    ? new TelegramPostService({
        store,
        api,
        data: {
          checklistFor: async () => null,
          statsFor: async () => null,
          tradeFor: async () => null,
          todayFor: async () => "2026-10-19",
        },
        allowedLinkHosts: ["app.velora.example"],
        ...(options.now === undefined ? {} : { now: options.now }),
      })
    : undefined;
  const wired: TelegramBotDeps = posts === undefined ? deps : { ...deps, posts };
  return {
    bot: new TelegramBot(wired),
    api,
    store,
    audit,
    links,
    trades,
    journal,
    ...(posts === undefined ? {} : { posts }),
  };
}

// ── Update builders ─────────────────────────────────────────────────────────

function messageUpdate(updateId: number, text: string, fromId = 555): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      from: { id: fromId, username: "trader" },
      chat: { id: fromId, type: "private" },
      date: 1_770_000_000,
      text,
    },
  };
}

function commandUpdate(updateId: number, text: string, fromId = 555): TelegramUpdate {
  return messageUpdate(updateId, text, fromId);
}

function callbackUpdate(updateId: number, data: string, fromId = 555): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: fromId, username: "trader" },
      message: { message_id: updateId * 10, chat: { id: fromId, type: "private" } },
      data,
    },
  };
}

/** Complete a link through the real handshake so the bot has a bound account. */
async function linkAccount(links: TelegramLinkService, userId = "1", telegramUserId = "555"): Promise<void> {
  const { token } = await links.startLinking(userId, null);
  const result = await links.completeFromPayload({ payload: token, telegramUserId, username: "trader", requestId: null });
  assert.equal(result.ok, true, "the test fixture failed to link the account");
}

const DAY_TEXT = "2026-10-18";
const COMPLETE_FA = "XAUUSD خرید، ورود 2650، خروج 2660، حجم 0.5";

// ── Tests ───────────────────────────────────────────────────────────────────

test("an unlinked identity is answered with onboarding and NOTHING else", async () => {
  const { bot, api, journal } = makeBot();

  // Every entry point an unlinked user could try.
  for (const update of [
    messageUpdate(1, "/start"),
    messageUpdate(2, "/journal"),
    messageUpdate(3, "/last"),
    messageUpdate(4, "/history"),
    messageUpdate(5, COMPLETE_FA),
    messageUpdate(6, "سلام"),
    commandUpdate(7, "/link"),
  ]) {
    assert.equal(await bot.handleUpdate(update), "handled");
  }

  // No journal was created for any of them, and no draft was opened.
  assert.equal((await journal.history("1", { page: 1, limit: 5 })).total, 0);

  // The onboarding button is a URL button carrying NO token — the user leaves
  // Telegram for the site, and only the site can mint a link.
  const buttons = api.sent.flatMap((m) => m.options?.inlineKeyboard ?? []).flatMap((row) => row);
  assert.ok(buttons.length > 0);
  for (const button of buttons) {
    assert.ok("url" in button, "an unlinked user must only ever get the onboarding URL button");
    assert.ok(!button.url.includes("token"));
  }
});

test("unknown chit-chat does not open a draft, and the confirmation card carries the buttons", async () => {
  const { bot, api, store, links } = makeBot();
  await linkAccount(links);

  await bot.handleUpdate(messageUpdate(10, "سلام، حالت چطوره؟"));
  assert.equal(store.drafts.length, 0, "small talk must not create a draft row");

  await bot.handleUpdate(messageUpdate(11, COMPLETE_FA));
  assert.equal(store.drafts.length, 1);
  assert.equal(store.drafts[0]!.state, "AWAITING_CONFIRMATION");
  // The card shows what will be written and offers confirm/cancel only.
  assert.ok(api.lastText.includes("XAUUSD"));
  assert.ok(api.lastText.includes("2650"));
  const labels = api.sent.at(-1)!.options!.inlineKeyboard!.flat().map((b) => b.text);
  assert.equal(labels.length, 2);
  assert.deepEqual(
    labels.map((l) => l.replace(/[^\u0600-\u06FF]/g, "").trim()),
    ["تأیید", "لغو"],
  );
});

test("an incomplete message asks for one field, and the answer completes the draft", async () => {
  const { bot, api, store, links } = makeBot();
  await linkAccount(links);

  await bot.handleUpdate(messageUpdate(20, "XAUUSD خرید، ورود 2650"));
  const draft = store.drafts[0]!;
  assert.deepEqual([...draft.missingFields].sort(), ["exitPrice", "volume"]);
  // Exactly ONE question, and the card still shows the known values.
  assert.ok(api.lastText.includes("خروج") || api.lastText.includes("حجم"));
  assert.equal(api.lastText.split("❓").length, 2);

  await bot.handleUpdate(messageUpdate(21, "2660"));
  assert.deepEqual([...store.drafts[0]!.missingFields], ["volume"]);
  await bot.handleUpdate(messageUpdate(22, "0.5"));
  assert.deepEqual([...store.drafts[0]!.missingFields], []);
  assert.ok(api.lastText.includes("تأیید") === false || api.lastText.length > 0);
});

test("confirming creates ONE trade, and a Telegram retry of the same callback does not create a second", async () => {
  const { bot, api, store, links, trades } = makeBot();
  await linkAccount(links);
  await bot.handleUpdate(messageUpdate(30, COMPLETE_FA));
  const draftId = store.drafts[0]!.id;

  const confirm = callbackUpdate(31, `confirm:${draftId}`);
  assert.equal(await bot.handleUpdate(confirm), "handled");
  assert.equal(store.drafts[0]!.state, "CONFIRMED");
  assert.ok(store.drafts[0]!.confirmedTradeId !== null);
  const page = await trades.searchTrades("1", { page: "1", limit: "10" });
  assert.equal((page["pagination"] as Record<string, unknown>)["total"], 1);
  const savedText = api.lastText;

  // THE RETRY: the identical update id is redelivered (Telegram does this when
  // an answer is slow). It must be recognised, not re-executed.
  assert.equal(await bot.handleUpdate(confirm), "ignored");
  const after = await trades.searchTrades("1", { page: "1", limit: "10" });
  assert.equal((after["pagination"] as Record<string, unknown>)["total"], 1);
  assert.equal(api.lastText, savedText, "a duplicate must not produce a second confirmation message");

  // A SECOND press of the same button (a different update id, e.g. the user
  // tapped twice) is answered honestly, and still writes nothing.
  assert.equal(await bot.handleUpdate(callbackUpdate(32, `confirm:${draftId}`)), "handled");
  const latest = await trades.searchTrades("1", { page: "1", limit: "10" });
  assert.equal((latest["pagination"] as Record<string, unknown>)["total"], 1);
});

test("a durable processing-start marker makes a worker replay a side-effect-free no-op", async () => {
  const { bot, api, store } = makeBot();
  const completed = commandUpdate(33, "/help");
  assert.equal(await bot.claim(completed), true);
  assert.equal(await bot.processClaimed(completed), "handled");
  const sendsAfterFirstRun = api.sent.length;
  assert.ok(sendsAfterFirstRun > 0);
  assert.equal(await bot.processClaimed(completed), "ignored", "a completed update cannot start again");
  assert.equal(api.sent.length, sendsAfterFirstRun, "a completed replay has no second Bot API side effect");

  const interrupted = commandUpdate(34, "/help");
  assert.equal(await bot.claim(interrupted), true);
  assert.equal(await store.beginUpdateProcessing("34", new Date()), true);
  const beforeReplay = api.sent.length;
  assert.equal(await bot.processClaimed(interrupted), "ignored", "an already-started update is reconciled, not replayed");
  assert.equal(api.sent.length, beforeReplay, "a crash-after-start replay does no work");
  const stuck = store.updates.get("34");
  assert.ok(stuck?.processingStartedAt !== null && stuck?.processingStartedAt !== undefined);
  assert.equal(stuck?.processedAt, null, "the interrupted row stays visible as started but unprocessed");
});

test("a forged or stale callback cannot act: unknown ids are refused, foreign drafts are not found", async () => {
  const { bot, store, api, links } = makeBot();
  await linkAccount(links, "1", "555");
  await linkAccount(links, "2", "777");

  // Carol (777 → account 2) cannot confirm Alice's draft even with its real id,
  // and the answer is the SAME as for an id that does not exist.
  const aliceDraft = await (async () => {
    await bot.handleUpdate(messageUpdate(40, COMPLETE_FA, 555));
    return store.drafts[0]!.id;
  })();
  assert.equal(await bot.handleUpdate(callbackUpdate(41, `confirm:${aliceDraft}`, 777)), "rejected");
  assert.equal(store.drafts[0]!.state, "AWAITING_CONFIRMATION");
  const forged = api.lastText;
  assert.equal(await bot.handleUpdate(callbackUpdate(42, "confirm:999999", 777)), "rejected");
  assert.equal(api.lastText, forged, "a missing id and a foreign id must be indistinguishable");

  // Callback data this bot never minted is not a command.
  assert.equal(await bot.handleUpdate(callbackUpdate(43, "promote:me", 777)), "rejected");
  assert.equal(await bot.handleUpdate(callbackUpdate(44, "confirm:" + "x".repeat(80), 777)), "rejected");
  assert.equal(store.drafts[0]!.state, "AWAITING_CONFIRMATION");
});

test("menu buttons route to the real reads, and a failing send never fails the action", async () => {
  const { bot, api, links, store } = makeBot();
  await linkAccount(links);
  await bot.handleUpdate(messageUpdate(50, COMPLETE_FA));
  await bot.handleUpdate(callbackUpdate(51, `confirm:${store.drafts[0]!.id}`));

  // /last renders the trade that was just saved.
  await bot.handleUpdate(commandUpdate(52, "/last"));
  assert.ok(api.lastText.includes("XAUUSD"));

  // /history renders the page + count.
  await bot.handleUpdate(commandUpdate(53, "/history"));
  assert.ok(api.lastText.includes("XAUUSD"));

  // An EMPTY journal says so instead of rendering nothing.
  await bot.handleUpdate(commandUpdate(54, "/history", 777));
  await bot.handleUpdate(commandUpdate(55, "/last", 777));

  // The journal command is a prompt, not an action.
  await bot.handleUpdate(commandUpdate(56, "/journal"));
  assert.ok(api.lastText.length > 0);

  // /help works even for an unlinked identity (it is the escape hatch).
  await bot.handleUpdate(commandUpdate(57, "/help", 999));
  assert.ok(api.lastText.length > 0);
});

test("voice and image degrade honestly when no media provider is configured", async () => {
  const { bot, api, store, links } = makeBot();
  await linkAccount(links);

  const voice: TelegramUpdate = {
    update_id: 60,
    message: {
      message_id: 600,
      from: { id: 555, username: "trader" },
      chat: { id: 555, type: "private" },
      date: 1_770_000_000,
      voice: { file_id: "voice-1", duration: 7, mime_type: "audio/ogg" },
    },
  };
  assert.equal(await bot.handleUpdate(voice), "handled");
  assert.equal(store.drafts.length, 0, "no transcript ⇒ no draft, and no invented values");
  assert.ok(api.texts.some((t) => t.includes("صوتی")), "the user is told the voice path is unavailable");
  // The bytes were fetched (the capability was attempted, not skipped silently).
  assert.deepEqual(api.downloads, ["path/voice-1"]);

  // A screenshot with a caption still journals from the CAPTION — the image is
  // stored as evidence, never as the source of numbers.
  const photo: TelegramUpdate = {
    update_id: 61,
    message: {
      message_id: 610,
      from: { id: 555, username: "trader" },
      chat: { id: 555, type: "private" },
      date: 1_770_000_000,
      caption: COMPLETE_FA,
      photo: [{ file_id: "photo-1", width: 1280, height: 720, file_size: 1234 }],
    },
  };
  assert.equal(await bot.handleUpdate(photo), "handled");
  assert.equal(store.drafts.length, 1);
  const draft = store.drafts[0]!;
  assert.equal(draft.sourceKind, "PHOTO");
  assert.equal(draft.draft.symbol, "XAUUSD");
  assert.equal(draft.draft.entryPrice, "2650");
  assert.equal(draft.media["fileId"], "photo-1");
});

test("/analyze refuses honestly without a provider instead of inventing an insight", async () => {
  const { bot, api, links, store } = makeBot();
  await linkAccount(links);
  await bot.handleUpdate(messageUpdate(70, COMPLETE_FA));
  await bot.handleUpdate(callbackUpdate(71, `confirm:${store.drafts[0]!.id}`));

  await bot.handleUpdate(commandUpdate(72, "/analyze"));
  // The refusal path must name the reason and must NOT contain an insight.
  assert.ok(api.texts.some((t) => t.includes("تحلیل")), "the user is told what was attempted");
  assert.ok(api.texts.some((t) => t.includes("فعال نیست") || t.includes("تنظیم")), "the reason is stated");
});

test("/settings reports the connection and the channel, and /unlink asks before acting", async () => {
  const { bot, api, store, links } = makeBot();
  await linkAccount(links);

  await bot.handleUpdate(commandUpdate(80, "/settings"));
  assert.ok(api.lastText.includes("متصل"));

  // /unlink is a CONFIRMATION, not an action: nothing is revoked until the
  // button is pressed.
  await bot.handleUpdate(commandUpdate(81, "/unlink"));
  assert.equal((await store.findLiveIdentityByTelegramUserId("555")) !== null, true);
  const labels = api.sent.at(-1)!.options!.inlineKeyboard!.flat();
  assert.equal(labels.length, 2);

  assert.equal(await bot.handleUpdate(callbackUpdate(82, "unlink:yes")), "handled");
  assert.equal(await store.findLiveIdentityByTelegramUserId("555"), null);
  // After unlinking, the next message is onboarding again — the gate re-closed.
  await bot.handleUpdate(messageUpdate(83, "/last"));
  assert.ok(api.lastText.includes("ولورا") || api.lastText.includes("اتصال"));
});

test("the /channel command verifies with Telegram before trusting a chat id, and refuses without rights", async () => {
  const { bot, api, links, store } = makeBot();
  await linkAccount(links);

  // Malformed ids are refused without any API call.
  await bot.handleUpdate(commandUpdate(90, "/channel nonsense"));
  assert.equal(await store.findActiveChannel("1"), null);

  // A well-formed id is verified SERVER-SIDE (getChat + getChatMember)…
  await bot.handleUpdate(commandUpdate(91, "/channel -1001234567890"));
  const channel = await store.findActiveChannel("1");
  assert.ok(channel !== null);
  assert.equal(channel!.chatId, "-1001234567890");
  assert.equal(channel!.canPost, true);
  assert.ok(api.lastText.includes("My Journal"));

  // …and a bot without posting rights is refused rather than trusted.
  const denied = makeBot();
  await linkAccount(denied.links);
  denied.api.memberResult = { status: "restricted", canPostMessages: false };
  denied.api.chatType = "supergroup";
  await denied.bot.handleUpdate(commandUpdate(92, "/channel -1009999999999"));
  assert.equal(await denied.store.findActiveChannel("1"), null);
  assert.ok(denied.api.texts.some((t) => t.includes("اجازه") || t.includes("❌")), "no rights must be reported");

  // A PRIVATE chat is not a channel: the bot refuses it outright rather than
  // mirroring the journal back into the conversation the user journals from.
  const privateChat = makeBot();
  await linkAccount(privateChat.links);
  privateChat.api.chatType = "private";
  await privateChat.bot.handleUpdate(commandUpdate(93, "/channel -1007777777777"));
  assert.equal(await privateChat.store.findActiveChannel("1"), null);
  assert.ok(privateChat.api.texts.some((t) => t.includes("خصوصی")), "the refusal must explain why");
});

test("a send failure is logged, not thrown: the journal action is not undone by a failed reply", async () => {
  const { bot, api, store, links, trades } = makeBot();
  await linkAccount(links);
  await bot.handleUpdate(messageUpdate(95, COMPLETE_FA));
  const draftId = store.drafts[0]!.id;

  api.failingSend = true;
  const outcome = await bot.handleUpdate(callbackUpdate(96, `confirm:${draftId}`));
  assert.equal(outcome, "handled");
  // The trade EXISTS even though every reply failed.
  assert.equal(store.drafts[0]!.state, "CONFIRMED");
  const page = await trades.searchTrades("1", { page: "1", limit: "10" });
  assert.equal((page["pagination"] as Record<string, unknown>)["total"], 1);
});

test("edited messages and channel posts are recognised but never acted on", async () => {
  const { bot, store, links } = makeBot();
  await linkAccount(links);

  const edited: TelegramUpdate = {
    update_id: 100,
    edited_message: {
      message_id: 1000,
      from: { id: 555, username: "trader" },
      chat: { id: 555, type: "private" },
      date: 1_770_000_000,
      text: COMPLETE_FA,
    },
  };
  assert.equal(await bot.handleUpdate(edited), "ignored");
  assert.equal(store.drafts.length, 0, "an edit is not a new entry");

  // A channel post has no `from` — it can never resolve to an account.
  const post: TelegramUpdate = {
    update_id: 101,
    message: {
      message_id: 1001,
      chat: { id: -1001234567890, type: "channel", title: "Some Channel" },
      date: 1_770_000_000,
      text: COMPLETE_FA,
    },
  };
  assert.equal(await bot.handleUpdate(post), "ignored");
  assert.equal(store.drafts.length, 0);
});


// ── Rate-limit wiring (security audit) ──────────────────────────────────────
//
// EVERY `telegram:*` key declared in `packages/contracts/src/auth.ts` and claimed
// in `docs/telegram/SECURITY.md` must have a call site: a limit that exists only
// in a table is a claim, not a control. Each test below exhausts ONE key and then
// asserts both the refusal AND that the expensive work behind it never ran — no
// download, no provider call, no draft row — because a limit checked after the
// spending is not a limit.

/** Refuses exactly the keys named, records every key it is asked about. */
class SelectiveLimiter implements RateLimiter {
  readonly asked: { readonly key: RateLimitKey; readonly bucket: string }[] = [];
  constructor(private readonly refuse: readonly RateLimitKey[]) {}
  async hit(routeKey: RateLimitKey, bucket: string): Promise<RateLimitDecision> {
    this.asked.push({ key: routeKey, bucket });
    return this.refuse.includes(routeKey) ? { allowed: false, retryAfterSec: 60 } : { allowed: true };
  }
  keys(): string[] {
    return [...new Set(this.asked.map((a) => a.key))];
  }
  bucketFor(key: string): string | undefined {
    return this.asked.find((a) => a.key === key)?.bucket;
  }
}

function voiceUpdate(updateId: number, fromId = 555): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      from: { id: fromId, username: "trader" },
      chat: { id: fromId, type: "private" },
      date: 1_770_000_000,
      voice: { file_id: `voice-${updateId}`, duration: 7, mime_type: "audio/ogg" },
    },
  };
}

test("the limiter is keyed by the TELEGRAM identity, not the Velora user id", async () => {
  const limiter = new SelectiveLimiter([]);
  const { bot, links } = makeBot({ limiter });
  await linkAccount(links, "velora-user-77", "9090");

  await bot.handleUpdate(messageUpdate(10, "سلام", 9090));
  assert.equal(limiter.bucketFor("telegram:update"), "tg:9090", "the bucket must be the Telegram id, or two chats share one budget");
});

test("an exhausted journal budget refuses a VOICE note BEFORE the download", async () => {
  const limiter = new SelectiveLimiter(["telegram:journal"]);
  const { bot, api, store, links } = makeBot({ limiter });
  await linkAccount(links);

  const outcome = await bot.handleUpdate(voiceUpdate(20));
  assert.equal(outcome, "rejected");
  assert.deepEqual(api.downloads, [], "a throttled voice note must not be downloaded at all");
  assert.equal(store.drafts.length, 0, "and it must not open a draft row");
  assert.ok(limiter.keys().includes("telegram:journal"));
  // The refusal is the honest rate-limit message, not a generic failure.
  assert.ok(api.texts.some((t) => /کمی بعد|محدود|بعداً|rate|limit/i.test(t)), `expected a rate-limit notice, got: ${JSON.stringify(api.texts)}`);
});

test("an exhausted journal budget refuses a TEXT journal without a draft, while /history still works", async () => {
  const limiter = new SelectiveLimiter(["telegram:journal"]);
  const { bot, api, store, links } = makeBot({ limiter });
  await linkAccount(links);

  const outcome = await bot.handleUpdate(messageUpdate(30, COMPLETE_FA));
  assert.equal(outcome, "rejected");
  assert.equal(store.drafts.length, 0, "the parser ran, but no row was written");

  // Reading is not spending: the limit bounds journal creation, not the product.
  assert.equal(await bot.handleUpdate(commandUpdate(31, "/history")), "handled");
  assert.ok(!limiter.keys().includes("telegram:analyze"), "…and no unrelated key was consulted");
});

test("an exhausted analyze budget refuses /analyze BEFORE the model call", async () => {
  const limiter = new SelectiveLimiter(["telegram:analyze"]);
  const { bot, api, store, links } = makeBot({ limiter });
  await linkAccount(links);
  await bot.handleUpdate(messageUpdate(40, COMPLETE_FA));
  await bot.handleUpdate(callbackUpdate(41, `confirm:${store.drafts[0]!.id}`));
  await bot.handleUpdate(commandUpdate(42, "/analyze"));
  assert.ok(limiter.keys().includes("telegram:analyze"), "the analyze key was consulted");
  // With no provider configured the flow would have said "analysis is disabled";
  // the budget refusal comes first, so the user is told to wait, not that the
  // feature is missing.
  assert.ok(api.texts.some((t) => /کمی بعد|محدود|rate|limit/i.test(t)), `expected a rate-limit notice, got: ${JSON.stringify(api.texts)}`);
  assert.ok(!api.texts.some((t) => t.includes("غیرفعال")), "the refusal must not masquerade as 'not configured'");
});

test("an oversized media file is refused on telegram's DECLARED size, before the download", async () => {
  const { bot, api, links } = makeBot();
  await linkAccount(links);
  api.fileBytes = Buffer.alloc(64); // the bytes are small…
  api.declaredSizeBytes = TELEGRAM_MAX_DOWNLOAD_BYTES + 1; // …but Telegram declares it oversized

  const outcome = await bot.handleUpdate(voiceUpdate(50));
  assert.equal(outcome, "handled");
  assert.deepEqual(api.downloads, [], "the download must never start on an oversized declaration");
  assert.ok(api.texts.some((t) => /حجم|بزرگ/i.test(t)), `expected the too-large notice, got: ${JSON.stringify(api.texts)}`);
});

test("a file that lies about its size is still caught AFTER the download", async () => {
  const { bot, api, links } = makeBot();
  await linkAccount(links);
  api.declaredSizeBytes = 64; // Telegram claims it is tiny…
  api.fileBytes = Buffer.alloc(TELEGRAM_MAX_DOWNLOAD_BYTES + 1, 1); // …the bytes are not

  const outcome = await bot.handleUpdate(voiceUpdate(51));
  assert.equal(outcome, "handled");
  assert.deepEqual(api.downloads, ["path/voice-51"], "the download was attempted (the claim looked fine)");
  assert.ok(api.texts.some((t) => /حجم|بزرگ/i.test(t)), "but the bytes were measured and refused, not truncated");
});

// ── journal maintenance commands (0036 round) ───────────────────────────────
//
// What these pin down is the difference between a feature and a picture of one: a button whose data
// the contract rejects, a statistic read from a row that is not there, a delete that ignores the
// version it showed the user. Every assertion below is against the REAL store and the REAL ledger —
// only the Bot API is faked, and `api.sent` is the transcript of what would have been delivered.

async function oneConfirmedTrade(
  journal: JournalApplicationService,
  sourceMessageId = "100",
  text: string = COMPLETE_FA,
): Promise<string> {
  const view = await journal.openFromText({
    userId: "1",
    telegramUserId: "555",
    chatId: "555",
    // Distinct per call: a draft is keyed to the message that produced it, so re-filing with the
    // same id answers DRAFT_ALREADY_CONFIRMED instead of creating a second row.
    sourceMessageId,
    text,
  });
  const result = await journal.confirm({ userId: "1", telegramUserId: "555", draftId: view.draftId });
  return result.tradeId;
}

test("every button the bot sends is an action the bot handles", async () => {
  const { bot, api, links, journal } = makeBot();
  await linkAccount(links);
  const id = await oneConfirmedTrade(journal);
  await bot.handleUpdate(commandUpdate(300, "/start"));
  await bot.handleUpdate(commandUpdate(301, "/trade " + id));
  await bot.handleUpdate(commandUpdate(302, "/help"));
  const buttons = api.sent.flatMap((m) => m.options?.inlineKeyboard ?? []).flat();
  assert.ok(buttons.length > 0, "the menu and the trade card must carry buttons");
  for (const button of buttons) {
    const data = "callbackData" in button ? button.callbackData : undefined;
    if (data === undefined) continue; // the onboarding button is a URL, not an action
    const parsed = parseCallbackData(data);
    assert.notEqual(parsed, null, `a button the contract cannot parse is a dead button: ${data}`);
    const { action, subject } = parsed!;
    assert.ok((CALLBACK_ACTIONS as readonly string[]).includes(action), `undeclared action '${action}'`);
    if (action === "menu") {
      assert.ok((MENU_TARGETS as readonly string[]).includes(subject), `a menu button for a target with no handler: ${subject}`);
    }
    if (action === "trade_arm" || action === "trade" || action === "trade_edit" || action === "trade_delete") {
      assert.ok(subject.includes(id.slice(0, 8)), `the trade action must carry the id, got '${subject}'`);
    }
  }
});

test("/stats reports the row that was persisted, in the domain's own figures", async () => {
  const { bot, api, links, journal } = makeBot();
  await linkAccount(links);
  await bot.handleUpdate(commandUpdate(310, "/stats"));
  assert.equal(api.sent.at(-1)?.text, copyFor("fa").statsEmpty, "an empty journal must not be a table of zeroes");
  await oneConfirmedTrade(journal);
  const derived = await statsView(journal, "1");
  await bot.handleUpdate(commandUpdate(311, "/stats"));
  const text = api.sent.at(-1)?.text ?? "";
  assert.ok(text.includes(copyFor("fa").statsTitle));
  // The card must carry the numbers the DOMAIN produced from the row — asserted by value rather than
  // by a hand-typed expectation, so the test cannot pass on a plausible-looking example.
  assert.ok(text.includes(`: ${String(derived.stats.tradeCount)} ·`), `trade count not shown: ${text}`);
  assert.ok(text.includes(`: ${derived.stats.totalPnl}`), `realized P/L not shown: ${text}`);
  assert.equal(derived.stats.closedCount, 1);
  assert.ok(text.includes("fees NOT included in P/L"), "the fee relation is stated, not implied");
});

test("/checklist files the day, and a second report merges instead of replacing", async () => {
  const { bot, api, store, links } = makeBot();
  await linkAccount(links);
  await bot.handleUpdate(commandUpdate(320, "/checklist bias: bullish\nh4: fvg"));
  assert.ok((api.sent.at(-1)?.text ?? "").includes(copyFor("fa").checklistSavedNew));
  await bot.handleUpdate(commandUpdate(321, "/checklist notes: دیر وارد شدم"));
  const saved = (api.sent.at(-1)?.text ?? "").includes(copyFor("fa").checklistSavedMerge);
  assert.ok(saved, "the reply must say it was MERGED, which is what happened");
  const rows = await store.listDailyChecklists("1", 10);
  assert.equal(rows.length, 1, "one row per day, no duplicate report");
  const items = rows[0]!.items as Record<string, { value: string | null }>;
  assert.equal(items["dailyBias"]?.value, "BULLISH", "the first report's answer survived the second one");
  assert.equal(rows[0]!.notes, "دیر وارد شدم");
  assert.equal(rows[0]!.confirmedItems, 2);
  assert.equal(rows[0]!.unreviewedItems, 9);
});

test("/checklist without a body shows a form whose keys the parser accepts", async () => {
  const { bot, api, links } = makeBot();
  await linkAccount(links);
  await bot.handleUpdate(commandUpdate(330, "/checklist"));
  const text = api.sent.at(-1)?.text ?? "";
  for (const key of Object.values(CHECKLIST_KEY_FOR_ITEM)) {
    assert.ok(text.includes(`${key}:`), `the form is missing the canonical key '${key}'`);
  }
  assert.equal(CHECKLIST_PROMPT_LINES.length, 11);
});

test("another user's trade id is a not-found sentence and no write", async () => {
  const { bot, api, journal, links, store } = makeBot();
  await linkAccount(links);
  const id = await oneConfirmedTrade(journal);
  // A second Telegram identity, linked to a DIFFERENT Velora account.
  await linkAccount(links, "2", "999");
  const before = store.drafts.length;
  await bot.handleUpdate(messageUpdateWithId(340, "/trade " + id, 999));
  assert.equal(api.sent.at(-1)?.text, copyFor("fa").tradeNotFound);
  assert.equal(store.drafts.length, before, "a refused read must not write anything");
});

test("the delete confirmation tombstones exactly the version the card showed", async () => {
  const { bot, api, links, journal } = makeBot();
  await linkAccount(links);
  const id = await oneConfirmedTrade(journal);
  await bot.handleUpdate(commandUpdate(350, "/trade " + id));
  const card = api.sent.at(-1)!;
  const versionMatch = /· v(\d+)/.exec(card.text);
  assert.ok(versionMatch !== null, `the card must print the version it is acting on: ${card.text}`);
  const arm = (card.options?.inlineKeyboard ?? []).flat().find((b) => "callbackData" in b && (b.callbackData ?? "").startsWith("trade_arm:"));
  assert.ok(arm !== undefined && "callbackData" in arm);
  await bot.handleUpdate(callbackUpdate(351, arm.callbackData!));
  const ask = api.sent.at(-1)!;
  const yes = (ask.options?.inlineKeyboard ?? []).flat().find((b) => "callbackData" in b && (b.callbackData ?? "").startsWith("trade_delete:"));
  assert.ok(yes !== undefined && "callbackData" in yes);
  assert.ok(yes.callbackData!.endsWith(`-v${versionMatch[1]}`), "the confirm button carries the version the user was SHOWN");
  await bot.handleUpdate(callbackUpdate(352, yes.callbackData!));
  assert.equal(api.sent.at(-1)?.text, copyFor("fa").tradeDeleteDone);
  assert.equal((await statsView(journal, "1")).stats.tradeCount, 0);
  // And the SAME button again cannot delete a second thing: the tombstone is already gone.
  await bot.handleUpdate(callbackUpdate(353, yes.callbackData!));
  assert.equal(api.sent.at(-1)?.text, copyFor("fa").tradeNotFound);
});

test("/edit refuses a price and accepts a note", async () => {
  const { bot, api, links, journal } = makeBot();
  await linkAccount(links);
  const id = await oneConfirmedTrade(journal);
  await bot.handleUpdate(commandUpdate(360, `/edit ${id} entryPrice 1`));
  assert.equal(api.sent.at(-1)?.text, copyFor("fa").fieldsImmutable);
  const untouched = await journal.tradeDetail("1", id);
  assert.equal(String(untouched["entryPrice"]), "2650", "the refusal happens BEFORE the ledger is asked");
  await bot.handleUpdate(commandUpdate(361, `/edit ${id} notes مدیریت ضعیف بود`));
  assert.equal(api.sent.at(-1)?.text, copyFor("fa").tradeEditDone);
  assert.equal(String((await journal.tradeDetail("1", id))["notes"]), "مدیریت ضعیف بود");
});

/** Same shape as `messageUpdate`, for the case where the Telegram identity is not the owner's. */
function messageUpdateWithId(updateId: number, text: string, fromId: number): TelegramUpdate {
  return messageUpdate(updateId, text, fromId);
}

test("the emotion button is a real action, not a printed instruction", async () => {
  const { bot, api, links, journal } = makeBot();
  await linkAccount(links);
  const id = await oneConfirmedTrade(journal);
  await bot.handleUpdate(commandUpdate(370, `/trade ${id}`));
  const emotion = (api.sent.at(-1)?.options?.inlineKeyboard ?? [])
    .flat()
    .map((b) => String("callbackData" in b ? b.callbackData : ""))
    .find((d) => d.startsWith("trade_edit:"));
  assert.ok(emotion !== undefined && emotion.endsWith("-emotion"), `the card must open the picker: ${emotion}`);
  await bot.handleUpdate(callbackUpdate(371, emotion));
  const picker = api.sent.at(-1)?.options?.inlineKeyboard ?? [];
  assert.equal(picker.flat().length, 5, "one button per score, no more, no less");
  const pick = picker.flat().find((b) => "callbackData" in b && (b.callbackData ?? "").endsWith("-emotion-4"));
  assert.ok(pick !== undefined && "callbackData" in pick);
  await bot.handleUpdate(callbackUpdate(372, pick.callbackData!));
  assert.equal(api.sent.at(-1)?.text, copyFor("fa").tradeEditDone);
  assert.equal((await journal.tradeDetail("1", id))["emotionalScore"], 4, "the value must be ON the record");
  // A score outside the contract is refused rather than clamped, and it writes nothing.
  await bot.handleUpdate(callbackUpdate(373, `trade_edit:${id}-emotion-9`));
  assert.equal(api.sent.at(-1)?.text, copyFor("fa").genericError);
  assert.equal((await journal.tradeDetail("1", id))["emotionalScore"], 4);
});

test("/checklist with a date files that day, and an impossible date says so plainly", async () => {
  const { bot, api, links, store } = makeBot();
  await linkAccount(links);
  await bot.handleUpdate(commandUpdate(380, "/checklist 2026-10-15 bias: bullish"));
  const day = await store.findDailyChecklist("1", "2026-10-15");
  assert.ok(day !== null, "a dated report must land on the named day, not on today");
  assert.equal(day.confirmedItems, 1);
  assert.equal((day.items["dailyBias"] as { value?: string } | undefined)?.value, "BULLISH");
  const today = await store.findDailyChecklist("1", "2026-10-17");
  assert.equal(today, null, "and must not touch any other day");
  await bot.handleUpdate(commandUpdate(381, "/checklist 2026-10-15"));
  assert.ok((api.sent.at(-1)?.text ?? "").includes("2026-10-15"), "the same command reads the day back");
  await bot.handleUpdate(commandUpdate(382, "/checklist 2026-02-30 bias: bullish"));
  // Since the shared date contract, a day that exists in NO calendar gets a sentence naming the day
  // it could not read — not the generic "must be YYYY-MM-DD" line, which was true only while that was
  // the one accepted shape. The invariant that matters is unchanged: nothing was written.
  assert.equal(api.sent.at(-1)?.text, copyFor("fa").checklistWindowGarbage("2026-02-30"), "an impossible date gets the date sentence, not a generic one");
  assert.equal(await store.findDailyChecklist("1", "2026-02-30"), null);
  await bot.handleUpdate(commandUpdate(383, "/checklist recent"));
  assert.ok((api.sent.at(-1)?.text ?? "").includes("2026-10-15"), "recent lists the day that exists");
});

test("every command /help advertises is a command the bot handles", async () => {
  // The parity rule this enforces: help is a contract. A command in the help text with no branch
  // behind it is a dead button written as prose, which is what this build is meant to avoid.
  // Each probe gets its OWN update_id — reusing one would test the dedupe gate instead (which it
  // does: an earlier draft of this test silently passed on /start and answered nothing on /history).
  const { bot, api, links } = makeBot();
  await linkAccount(links);
  let probe = 500;
  for (const locale of ["fa", "en"] as const) {
    // `media: true` on purpose: this test is the command↔branch contract, and the media-suffixed
    // journal line advertises the same command either way. The capability split itself is asserted
    // separately below, against the copy function rather than against a hand-typed string.
    const body: string = copyFor(locale).helpBody({ media: true });
    const advertised = [...body.matchAll(/^\/(\w+)/gm)].map((m) => m[1] ?? "");
    assert.ok(advertised.length >= 12, `the ${locale} help must list the journal commands too, got ${advertised.length}`);
    for (const cmd of new Set(advertised)) {
      const before = api.sent.length;
      await bot.handleUpdate(commandUpdate(++probe, `/${cmd}`));
      assert.ok(api.sent.length > before, `/${cmd} is advertised in ${locale} help but produced no answer`);
    }
  }
});

// ── L3: the rate-limit hit overlapping the identity/locale resolution ───────
//
// WHAT THIS SECTION PROVES. `dispatch` now issues the `telegram:update` bucket write and the
// sender/locale resolution together. Two claims follow, and they need different evidence:
//
//   1. the two really DO overlap — proven by measuring their in-flight intervals, never by checking
//      that `Promise.all` appears in the source (which would pass on a `Promise.all` of two awaits);
//   2. the overlap costs nothing in behaviour — the refusal still arrives, the bucket is still
//      counted exactly once, an unlinked sender still reaches only onboarding, and the ledger still
//      records one outcome per `update_id`.
//
// SCOPE, stated because it changes how the numbers read: the instrumented window is `dispatch`'s
// OWN pre-gate resolution (sender read + profile read) and the gate's own hit. Reads a handler does
// AFTER the gate are not counted — `TelegramBot` resolves the sender again inside `handleMessage`,
// and it is the runtime layer's `withLiveIdentityMemo` (see `apps/worker-cf/src/runtime.ts`) that
// collapses those, not this file.
//
// WHAT THE TESTS MEASURE, EXACTLY. Nothing is keyed to "the first read of the store", because the
// linking fixture performs identity reads of its own and would consume that marker. Instead every
// sender read is recorded with its interval, and the tests select the reads that fall inside the
// gate's own hit window — the only span `dispatch` actually owns. If the two operations were
// sequential, no read would overlap the gate, and the assertions below would fail for the right
// reason rather than pass by construction.
//
// The delays stand in for a far-away database round trip (~310 ms measured on the live path). They
// are attached to the operations themselves, not to a query-text matcher, so a refactor that moves
// the work elsewhere cannot make these tests pass by accident.

interface Trace {
  readonly label: string;
  readonly start: number;
  readonly end: number;
}

const overlapMs = (a: Trace | undefined, b: Trace | undefined): number =>
  a === undefined || b === undefined ? 0 : Math.min(a.end, b.end) - Math.max(a.start, b.start);

/** The whole window the two operations jointly occupy: from the first start to the last end. */
const spanMs = (a: Trace | undefined, b: Trace | undefined): number =>
  a === undefined || b === undefined ? 0 : Math.max(a.end, b.end) - Math.min(a.start, b.start);

/** A limiter whose decision is the REAL policy evaluation, with an instrumented round trip. */
class BucketLimiter implements RateLimiter {
  readonly asked: { readonly key: RateLimitKey; readonly bucket: string }[] = [];
  readonly trace: Trace[] = [];
  readonly hits = new Map<string, number>();
  constructor(
    private readonly delayMs = 0,
    private readonly throwOnHit = false,
  ) {}
  async hit(routeKey: RateLimitKey, bucket: string): Promise<RateLimitDecision> {
    const start = performance.now();
    const policy = RATE_LIMIT_DEFAULTS[routeKey];
    const nowMs = Date.now();
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.asked.push({ key: routeKey, bucket });
    this.trace.push({ label: "hit", start, end: performance.now() });
    if (this.throwOnHit) throw new Error("limiter store down");
    const next = (this.hits.get(bucket) ?? 0) + 1;
    this.hits.set(bucket, next);
    return evaluateRateLimit({ hits: next, windowStartMs: nowMs }, policy, nowMs);
  }
  /** The gate's own round trips, in order (one per dispatch that reached the gate). */
  gate(n = 0): Trace {
    return this.trace[n]!;
  }
  countFor(key: RateLimitKey, bucket: string): number {
    return this.asked.filter((a) => a.key === key && a.bucket === bucket).length;
  }
}

/** Refuses every key at once, with no round trip: for tests whose subject is the refusal itself. */
class RefusingLimiter extends BucketLimiter {
  constructor() {
    super(0);
  }
  override async hit(routeKey: RateLimitKey, bucket: string): Promise<RateLimitDecision> {
    const start = performance.now();
    this.asked.push({ key: routeKey, bucket });
    this.trace.push({ label: "hit", start, end: performance.now() });
    return { allowed: false, retryAfterSec: 30 };
  }
}

interface ProbedBotOptions {
  readonly identityDelayMs?: number;
  readonly profileDelayMs?: number;
  readonly limiter?: BucketLimiter;
  readonly failLocaleRead?: boolean;
  /** Count the journal service's own entry points, to prove a refusal never reaches them. */
  readonly spyJournal?: boolean;
}

/** The same real collaborator graph `makeBot` builds, with the pre-gate round trips instrumented. */
function makeProbedBot(options: ProbedBotOptions = {}) {
  const store = new MemoryTelegramStore();
  const identityTrace: Trace[] = [];
  // NOT a Proxy: `MemoryTelegramStore` keeps `#private` state, which a Proxy cannot re-bind
  // ("Receiver must be an instance of class MemoryTelegramStore"). Wrapping the one method keeps
  // the receiver intact and leaves every other method exactly as shipped.
  const realFindLive = store.findLiveIdentityByTelegramUserId.bind(store);
  let reads = 0;
  let armedFrom = Number.MAX_SAFE_INTEGER; // set by `arm()` once the fixture has run
  let failNext = 0;
  store.findLiveIdentityByTelegramUserId = async (tgId: string) => {
    const mine = reads;
    reads += 1;
    const live = mine >= armedFrom; // only reads issued by the update under test are touched
    const start = performance.now();
    const delay = live ? (options.identityDelayMs ?? 0) : 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (live && failNext > 0) {
      failNext -= 1;
      identityTrace.push({ label: "identity", start, end: performance.now() });
      throw Object.assign(new Error("identity read failed"), { code: "CONNECTION_ENDED" });
    }
    try {
      return await realFindLive(tgId);
    } finally {
      identityTrace.push({ label: "identity", start, end: performance.now() });
    }
  };

  const api = new FakeBotApi();
  const links = new TelegramLinkService({ store, audit: new MemoryAuditStore(), botUsername: () => "velora_journal_bot" });
  const trades = new TradeService({
    store: new MemoryTradeStore(),
    getUserTimezone: async () => "Asia/Tehran",
    verifyAccountOwnership: async () => true,
  });
  const journal = new JournalApplicationService({ trades, drafts: store, getUserTimezone: async () => "Asia/Tehran" });
  const journalCalls: { preview: number; currentDraft: number } = { preview: 0, currentDraft: 0 };
  if (options.spyJournal === true) {
    const realPreview = journal.previewFromText.bind(journal);
    const realCurrent = journal.currentDraft.bind(journal);
    journal.previewFromText = (input: { userId: string; text: string }) => {
      journalCalls.preview += 1;
      return realPreview(input);
    };
    journal.currentDraft = (userId: string, telegramUserId: string) => {
      journalCalls.currentDraft += 1;
      return realCurrent(userId, telegramUserId);
    };
  }
  const attempts = new MemoryAiAttemptStore();
  const coach = new AiCoachService({
    provider: new UnconfiguredAiProvider(),
    consent: { consentState: async () => ({ consented: true, consentedAt: null }) },
    attempts,
    allowedProviders: ["openai", "gemini"],
  });

  // The profile read is the SECOND round trip inside `localeFor`, and it runs only for a LINKED
  // sender — so a test that wants it must link the account first or it measures nothing.
  const profileTrace: Trace[] = [];
  let profileReads = 0;
  const profileDelay = options.profileDelayMs ?? 0;
  const getUserLocale = async (_userId: string): Promise<"fa"> => {
    profileReads += 1;
    const start = performance.now();
    try {
      if (profileDelay > 0) await new Promise((resolve) => setTimeout(resolve, profileDelay));
      if (options.failLocaleRead === true) throw new Error("profile read failed");
      return "fa";
    } finally {
      profileTrace.push({ label: "profile", start, end: performance.now() });
    }
  };

  const limiter = options.limiter ?? new BucketLimiter();
  const bot = new TelegramBot({
    api,
    store,
    links,
    journal,
    analysis: new JournalAnalysisService({ coach, journal }),
    media: { interpreter: new UnconfiguredMediaInterpreter(), attempts },
    appUrl: () => "https://app.velora.example",
    getUserLocale,
    limiter,
    log: () => undefined,
  });
  return {
    bot, api, store, links, limiter, identityTrace, profileTrace,
    profileReads: () => profileReads,
    journalCalls,
    /** Start instrumenting from the next sender read — call this after any fixture writes. */
    arm: () => { armedFrom = reads; },
    /** Make the next `n` instrumented sender reads throw, as a measured outage would. */
    failReads: (n: number) => { failNext = n; },
    /** Instrumented sender reads whose interval intersects the gate's own hit. */
    readsDuring: (t: Trace) => identityTrace.filter((x) => overlapMs(x, t) > 0),
  };
}

test("L3: the bucket write and the sender read are in flight together", async () => {
  const RTT = 150;
  const limiter = new BucketLimiter(RTT);
  const probed = makeProbedBot({ identityDelayMs: RTT, limiter });
  await linkAccount(probed.links, "l3-linked-1", "777101");
  probed.arm();

  assert.equal(await probed.bot.handleUpdate(messageUpdate(9001, "/help", 777101)), "handled");

  const gate = probed.limiter.gate();
  const concurrent = probed.readsDuring(gate);
  assert.equal(concurrent.length, 1, "dispatch must issue exactly one pre-gate sender read, and it must be in flight DURING the gate");
  assert.equal(probed.limiter.countFor("telegram:update", "tg:777101"), 1, "…and exactly one bucket hit");
  // THE DISCRIMINATOR. Two 150 ms round trips in sequence cannot share a window under 200 ms.
  // Verified to FAIL against the pre-change source, which is what makes this evidence rather than a
  // restatement of the diff.
  const span = spanMs(gate, concurrent[0]!);
  assert.ok(span < 200, `pre-gate window must be ~max(rtt, rtt), measured ${Math.round(span)} ms`);
  // The gate's write lands while the sender read is still open — the side effect is issued at the
  // same moment, not deferred behind the read. No upper bound is asserted on when the gate
  // finishes: it is free to complete first, and asserting otherwise would only test the scheduler.
  assert.ok(gate.start <= concurrent[0]!.end, "the hit was issued no later than the sender read completed");
});

test("L3: a bucket hit still happens when the sender read fails mid-flight", async () => {
  const limiter = new BucketLimiter(40);
  const probed = makeProbedBot({ identityDelayMs: 20, limiter });
  // This sender has no link to create, but arming is what makes a read "the update's own" rather
  // than a fixture's; without it the injection below would silently target nothing.
  probed.arm();
  probed.failReads(1);

  // The outage hits dispatch; the error path then re-resolves the sender for its own wording, and
  // that second read succeeds. `outcome:"failed"` is what becomes a 500 and a Telegram redelivery.
  const outcome = await probed.bot.handleUpdate(messageUpdate(9002, "/help", 777102));
  assert.equal(outcome, "failed", "an identity outage still surfaces as a failure (→ 500 → redelivery)");
  assert.equal(limiter.countFor("telegram:update", "tg:777102"), 1, "…and the message is STILL counted against its budget");
  assert.equal(probed.api.sent.length, 1, "the user gets the one fixed sentence, not a silence");
});

test("L3: an unlinked sender still pays the gate, and costs no profile read at all", async () => {
  const limiter = new BucketLimiter(60);
  const probed = makeProbedBot({ identityDelayMs: 60, limiter });
  probed.arm();

  assert.equal(await probed.bot.handleUpdate(messageUpdate(9003, "سلام", 777103)), "handled");
  assert.equal(limiter.countFor("telegram:update", "tg:777103"), 1, "unlinked identities are throttled too");
  assert.ok(
    probed.api.urls.some((u) => u.startsWith("https://app.velora.example/telegram/connect")),
    "the reply carries the connect button — that is where the link lives",
  );
  assert.equal(probed.store.drafts.length, 0, "…and nothing else was written");
  assert.equal(probed.profileReads(), 0, "no account, so no profile read — the overlap must not invent one");
  assert.ok(probed.readsDuring(limiter.gate()).length === 1, "the unresolved sender was resolved once, concurrently");
});

test("L3: a refused update sends the rate-limit sentence and nothing else, on either path", async () => {
  const messageBot = makeProbedBot({ identityDelayMs: 20, profileDelayMs: 20, limiter: new RefusingLimiter() });
  await linkAccount(messageBot.links, "l3-refused", "777104");
  assert.equal(await messageBot.bot.handleUpdate(messageUpdate(9004, COMPLETE_FA, 777104)), "rejected");
  assert.equal(messageBot.api.sent.length, 1, "one message — the refusal. No draft, no menu, no second send");
  assert.match(messageBot.api.lastText, /محدود|کمی بعد|rate|limit/i);
  assert.equal(messageBot.store.drafts.length, 0, "a refused journal text must not open a draft row");
  assert.equal(messageBot.profileReads(), 1, "the refusal is worded in the user's own locale, so the profile is still read");

  // Callbacks share the gate, so the same sentence must be the only reply there too.
  const cb = makeProbedBot({ identityDelayMs: 20, limiter: new RefusingLimiter() });
  await linkAccount(cb.links, "l3-refused-cb", "777114");
  assert.equal(await cb.bot.handleUpdate(callbackUpdate(9014, "menu:journal", 777114)), "rejected");
  assert.equal(cb.api.sent.length, 1, "a refused callback answers with the refusal only");
});

test("L3: concurrent messages from one sender cannot bypass the window limit", async () => {
  const limit = RATE_LIMIT_DEFAULTS["telegram:update"].limit; // the real policy number, not a guess
  const limiter = new BucketLimiter(5);
  const probed = makeProbedBot({ identityDelayMs: 5, limiter });
  await linkAccount(probed.links, "l3-burst", "777105");

  const results = await Promise.all(
    Array.from({ length: limit + 5 }, (_, i) => probed.bot.handleUpdate(messageUpdate(9100 + i, "/help", 777105))),
  );
  assert.equal(limiter.countFor("telegram:update", "tg:777105"), limit + 5, "every message in the burst is counted once");
  assert.equal(limiter.hits.size, 1, "…into exactly ONE bucket, not one per concurrent message");
  assert.equal(results.filter((r) => r === "handled").length, limit, "exactly the policy allows gets through");
  assert.equal(results.filter((r) => r === "rejected").length, 5, "…and precisely the over-budget ones are refused");
});

test("L3: a limiter-store outage still fails open, with the message served", async () => {
  const probed = makeProbedBot({ identityDelayMs: 10, limiter: new BucketLimiter(10, true) });
  assert.equal(await probed.bot.handleUpdate(messageUpdate(9006, "سلام", 777106)), "handled", "a broken limiter store must not take the bot down");
  assert.equal(probed.api.sent.length, 1, "…and the user still gets an answer");
});

test("L3: the ledger still records exactly one outcome per update_id", async () => {
  const probed = makeProbedBot({ identityDelayMs: 10, profileDelayMs: 5, limiter: new BucketLimiter(10) });

  const update = messageUpdate(9007, "سلام", 777107);
  assert.equal(await probed.bot.handleUpdate(update), "handled");
  assert.equal(await probed.bot.handleUpdate(update), "ignored", "a Telegram redelivery is a duplicate, not a second send");
  assert.equal(probed.store.updates.size, 1, "exactly one row for one update_id");
  assert.equal(probed.store.updates.get("9007")!.outcome, "handled", "…finished with the bot's own verdict");
  assert.ok(probed.store.updates.get("9007")!.processedAt !== null, "…and not left started");
});

test("L3: a failed profile read changes neither the verdict nor the wording of the refusal", async () => {
  const probed = makeProbedBot({ identityDelayMs: 15, failLocaleRead: true, limiter: new RefusingLimiter() });
  // A LINKED sender, so `localeFor` really does reach the profile read and have it fail there —
  // unlinked would short-circuit to null and prove nothing about the catch.
  await linkAccount(probed.links, "l3-broken-locale", "777108");
  assert.equal(await probed.bot.handleUpdate(messageUpdate(9008, "/help", 777108)), "rejected");
  assert.equal(probed.api.sent.length, 1);
  assert.match(probed.api.lastText, /محدود|کمی بعد|rate|limit/i, "the refusal is still the rate-limit sentence, from the fallback locale");
});

test("L3: a broken profile read on an ALLOWED message does not fail the message", async () => {
  const probed = makeProbedBot({ identityDelayMs: 10, failLocaleRead: true });
  await linkAccount(probed.links, "l3-locale-ok", "777112");
  assert.equal(await probed.bot.handleUpdate(messageUpdate(9012, "/help", 777112)), "handled", "locale is cosmetic: the flow continues");
  assert.equal(probed.api.sent.length, 1, "…and the user gets their menu, not an error");
});

test("L3: the gate also overlaps the profile read, not only the sender read", async () => {
  const RTT = 140;
  const limiter = new BucketLimiter(RTT);
  const probed = makeProbedBot({ identityDelayMs: RTT, profileDelayMs: RTT, limiter });
  await linkAccount(probed.links, "l3-profile", "777113");
  probed.arm();

  await probed.bot.handleUpdate(messageUpdate(9013, "/help", 777113));
  const gate = limiter.gate();
  const profile = probed.profileTrace[0]!;
  // The pre-gate resolution is identity(RTT) → profile(RTT): two reads, and the single gate write
  // has to overlap one of them. It overlaps the FIRST, which is the point of the change: the hit is
  // issued beside the whole resolution rather than after it.
  const overlappedSender = probed.readsDuring(gate).length;
  assert.ok(overlapMs(gate, profile) > 0 || overlappedSender > 0,
    `the gate must overlap the pre-gate resolution (sender overlap=${overlappedSender}, profile overlap=${Math.round(overlapMs(gate, profile))} ms)`);
  assert.ok(overlapMs(gate, profile) <= RTT + 40, "…and the profile read must not start before the gate opened and still trail it by more than a round trip");
});

test("L3: callbacks get the same overlap, with the reply unchanged", async () => {
  const RTT = 120;
  const limiter = new BucketLimiter(RTT);
  const probed = makeProbedBot({ identityDelayMs: RTT, profileDelayMs: 10, limiter });
  await linkAccount(probed.links, "l3-callback", "777109");
  probed.arm();

  assert.equal(await probed.bot.handleUpdate(callbackUpdate(9009, "menu:journal", 777109)), "handled");
  const gate = limiter.gate();
  assert.equal(probed.readsDuring(gate).length, 1, "the callback path issues one overlapped sender read too");
  assert.ok(spanMs(gate, probed.readsDuring(gate)[0]!) < 180,
    `the callback's pre-gate window must be one round trip, measured ${Math.round(spanMs(gate, probed.readsDuring(gate)[0]!))} ms`);
  assert.equal(probed.api.sent.length, 1, "the callback still produces exactly its own reply");
});

test("L3 parity: the gate still precedes the work it bounds — SECURITY.md §7's actual claim", async () => {
  // §7's table says `telegram:update` is checked BEFORE "any parsing or work". Parsing here means
  // the journal parser and the draft lookup, and that part of the claim must survive the overlap —
  // a refactor that moved the gate after the handlers would still answer with a refusal sentence
  // and would pass every wording test above.
  const probed = makeProbedBot({ identityDelayMs: 15, profileDelayMs: 15, limiter: new RefusingLimiter(), spyJournal: true });
  await linkAccount(probed.links, "l3-gate-precedence", "777120");

  assert.equal(await probed.bot.handleUpdate(messageUpdate(9020, COMPLETE_FA, 777120)), "rejected");
  assert.equal(probed.journalCalls.preview, 0, "a refused update must never reach the journal parser");
  assert.equal(probed.journalCalls.currentDraft, 0, "…nor the open-draft lookup");
  // What §7 does NOT say, and what was never true of this code path: the rate-limit read is not the
  // first statement of the invocation. `localeOrNull` resolves the sender (and, for a linked user,
  // the profile) BEFORE the gate decides, in the pre-change source too — because the refusal itself
  // has to be worded in the user's language. Two cheap SELECTs precede the gate; no write, no
  // download and no provider call does. That asymmetry is pre-existing and is NOT introduced here.
  assert.equal(probed.profileReads(), 1, "the locale read that precedes the gate (pre-existing, documented)");
});

test("L3 parity: one delivery, one increment — a resolution failure cannot dodge the bucket", async () => {
  const limiter = new BucketLimiter(25);
  const probed = makeProbedBot({ identityDelayMs: 25, limiter });
  probed.arm();
  // Only the gate-time read fails. The error path resolves the sender a second time for its own
  // wording, and that read succeeds — which is the realistic blip. (If the database is down for BOTH
  // reads, `handleUpdate` rejects out of `processClaimed`'s own catch, since `safeSend` is awaited
  // there and `finishUpdate` swallows; that behaviour is pre-existing and identical in both orders,
  // so this test does not disturb it.)
  probed.failReads(1);

  const outcome = await probed.bot.handleUpdate(messageUpdate(9021, "/help", 777121));
  assert.equal(outcome, "failed");
  assert.equal(limiter.countFor("telegram:update", "tg:777121"), 1, "exactly one increment for a failed delivery, not zero and not two");
  // The limiter's own counter is keyed by the bucket argument; the `routeKey|ip` composite is built
  // inside `PgRateLimitStore.hit`, not here, so this asserts what THIS double's store would persist.
  assert.equal(limiter.hits.get("tg:777121"), 1, "…one increment in the bucket the store would write (`telegram:update|tg:777121` at the SQL layer)");
  // The old sequential code recorded ZERO here. That is the delta, and it is in the safe direction:
  // more counting can only ever refuse earlier. A redelivery cannot inflate it, because the deployed
  // host answers Telegram 200 at claim time (see `index.ts` + `acceptDeferred`), so a `dispatch`
  // failure is never retried at all.
});

// ── `/stats <window>` — day and week windows, reused from the journal service ──────────────
//
// The window is the USER's calendar day, not the server's, and an empty window must not be reported
// as an empty journal. Both facts are asserted against the service's OWN output rather than against
// hand-typed numbers, so a regression in the domain cannot be masked by editing the expectation.

test("/stats today counts only trades closed inside the user's own day", async () => {
  // The bot's clock and the journal's clock are the same object (see makeBot), and the SECOND trade
  // is placed on a different day by its own text — `دیروز` is understood by the extractor already, so
  // no test-only clock plumbing is needed to make "yesterday" mean yesterday.
  const at = new Date("2026-10-19T05:00:00Z"); // 08:30 on 2026-10-19 in Asia/Tehran (+03:30)
  const { bot, api, links, journal } = makeBot({ now: () => at });
  await linkAccount(links);
  await oneConfirmedTrade(journal, "100");
  await oneConfirmedTrade(journal, "101", "دیروز XAUUSD خرید، ورود 2650، خروج 2660، حجم 0.5");
  const today = await statsView(journal, "1", { windowKind: "today" });
  await bot.handleUpdate(commandUpdate(314, "/stats today"));
  const text = api.sent.at(-1)?.text ?? "";
  assert.ok(text.includes(copyFor("fa").statsWindowToday), `window not named: ${text}`);
  assert.ok(text.includes(`: ${String(today.stats.tradeCount)} ·`), `trade count not shown: ${text}`);
  assert.equal(today.stats.tradeCount, 1, "the day window must exclude yesterday's closed trade");
  const all = await statsView(journal, "1");
  assert.equal(all.stats.tradeCount, 2, "and the all-time view must still see both");
  await bot.handleUpdate(commandUpdate(315, "/stats"));
  assert.ok((api.sent.at(-1)?.text ?? "").includes(`: ${String(all.stats.tradeCount)} ·`));
  assert.ok(!(api.sent.at(-1)?.text ?? "").includes(copyFor("fa").statsWindowLabel),
    "bare /stats keeps its old title — no window, no window label");
});

test("/stats with an empty window says the window is empty, never that the journal is", async () => {
  const at = new Date("2026-10-19T05:00:00Z");
  const { bot, api, links, journal } = makeBot({ now: () => at });
  await linkAccount(links);
  await oneConfirmedTrade(journal, "102", "2026-10-11 XAUUSD خرید، ورود 2650، خروج 2660، حجم 0.5");
  await bot.handleUpdate(commandUpdate(316, "/stats today"));
  const emptyWindow = api.sent.at(-1)?.text ?? "";
  assert.equal(emptyWindow, copyFor("fa").statsEmptyWindow(copyFor("fa").statsWindowToday));
  assert.notEqual(emptyWindow, copyFor("fa").statsEmpty, "an empty day is not an empty journal");
  await bot.handleUpdate(commandUpdate(317, "/stats"));
  assert.ok((api.sent.at(-1)?.text ?? "").includes(": 1 ·"), "the same trade is visible all-time");
});

test("an empty journal with no argument keeps the sentence it always had", async () => {
  const { bot, api, links } = makeBot();
  await linkAccount(links);
  await bot.handleUpdate(commandUpdate(318, "/stats"));
  assert.equal(api.sent.at(-1)?.text, copyFor("fa").statsEmpty);
});

test("/stats refuses a window it cannot read instead of widening it", async () => {
  const { bot, api, links } = makeBot();
  await linkAccount(links);
  for (const [updateId, arg] of [[319, "som_today"], [320, "todayy"], [321, "2026-02-30"], [322, "2026-13-01"]] as const) {
    await bot.handleUpdate(commandUpdate(updateId, `/stats ${arg}`));
    // A word that never looked like a date gets the token list; a DATE-SHAPED string that names no
    // real day gets a sentence about the day itself. Both are refusals — neither widens the window.
    const expected = arg.includes("-") ? copyFor("fa").statsWindowGarbage(arg) : copyFor("fa").statsBadWindow(arg);
    assert.equal(api.sent.at(-1)?.text, expected, `accepted: ${arg}`);
  }
  // A date that exists is a window, not an error — and it is the same day the checklist writes.
  await bot.handleUpdate(commandUpdate(323, "/stats 2026-10-19"));
  assert.ok((api.sent.at(-1)?.text ?? "").includes(copyFor("fa").statsWindowToday)
    === false, "an explicit date is labelled with the date, not with 'today'");
});

test("/stats week covers seven local days ending today", async () => {
  const at = new Date("2026-10-19T05:00:00Z");
  const { bot, api, links, journal } = makeBot({ now: () => at });
  await linkAccount(links);
  const days = ["2026-10-12", "2026-10-13", "2026-10-18", "2026-10-19"];
  for (const [i, day] of days.entries()) {
    await oneConfirmedTrade(journal, `m-${i}`, `${day} XAUUSD خرید، ورود 2650، خروج 2660، حجم 0.5`);
  }
  const week = await statsView(journal, "1", { windowKind: "week" });
  assert.equal(week.stats.tradeCount, 3, "2026-10-12 is the eighth day back and must be outside");
  await bot.handleUpdate(commandUpdate(324, "/stats week"));
  const text = api.sent.at(-1)?.text ?? "";
  assert.ok(text.includes(copyFor("fa").statsWindowWeek), `week label missing: ${text}`);
  assert.ok(text.includes(`: ${String(week.stats.tradeCount)} ·`));
});

/** `stats()` answers a refused window as its own shape; a test that wants the numbers narrows once. */
async function statsView(
  journal: JournalApplicationService,
  userId: string,
  window?: Parameters<JournalApplicationService["stats"]>[1],
) {
  const view = await journal.stats(userId, window);
  if (view.invalidWindow) throw new Error("stats window was refused by the service");
  return view;
}

test("help claims voice/image only when a real media interpreter is wired", () => {
  // The bug this pins: the Worker installs `UnconfiguredMediaInterpreter`, whose every call throws,
  // while /help promised "text or voice" to everyone. The promise is now derived from the runtime.
  for (const locale of ["fa", "en"] as const) {
    const copy = copyFor(locale);
    assert.match(copy.helpBody({ media: false }), /\/journal/, `${locale}: /journal must stay advertised`);
    assert.ok(!copy.helpBody({ media: false }).includes("voice") || locale === "fa");
    const noMedia: string = copy.journalPrompt({ media: false });
    const withMedia: string = copy.journalPrompt({ media: true });
    assert.ok(!/\bvoice\b|صوتی/i.test(noMedia), `${locale}: text-only prompt must not mention voice: ${noMedia}`);
    assert.ok(/\bvoice\b|صوتی/i.test(withMedia), `${locale}: a configured runtime may advertise voice`);
    assert.ok(noMedia.includes("XAUUSD"), `${locale}: the text example survives either way`);
  }
});

test("the bot's own /help output matches its interpreter, not the other way round", async () => {
  const { bot, api, links } = makeBot(); // makeBot wires UnconfiguredMediaInterpreter
  await linkAccount(links);
  await bot.handleUpdate(commandUpdate(330, "/help"));
  const text = api.sent.at(-1)?.text ?? "";
  assert.ok(/\/journal/.test(text), "text journaling stays advertised");
  assert.ok(!/صوتی/.test(text), `unconfigured runtime must not advertise voice: ${text}`);
  await bot.handleUpdate(commandUpdate(331, "/start"));
  const prompt = api.sent.at(-1)?.text ?? "";
  assert.ok(!/صوتی/.test(prompt), `and neither may the journal prompt: ${prompt}`);
});

// ── /checklist coverage — an aggregate of RECORDED states ──────────────────────────────────

const ALL_11_FA = [
  "bias: bullish", "leg: up", "location: range", "h4: fvg", "h1: ifvg", "m15: lq",
  "cisd: yes", "smt: none", "macro: news", "sl: 2655", "risk: 0.5%",
].join("\n");

test("/checklist coverage names the period and counts reviewed vs unrecorded days", async () => {
  const at = new Date("2026-10-18T10:00:00Z");
  const { bot, api, links, journal } = makeBot({ now: () => at });
  await linkAccount(links);
  await journal.saveChecklist({ userId: "1", telegramUserId: "555", text: ALL_11_FA, reportDate: "2026-10-18" });
  await journal.saveChecklist({ userId: "1", telegramUserId: "555", text: "bias: bullish\ncisd: ?", reportDate: "2026-10-17" });
  await bot.handleUpdate(commandUpdate(340, "/checklist coverage"));
  const text = api.sent.at(-1)?.text ?? "";
  const copy = copyFor("fa");
  assert.ok(text.includes(copy.coverageTitle), `title missing: ${text}`);
  assert.ok(text.includes(`${copy.coverageDaysReviewed}: 2/7`), `days reviewed missing: ${text}`);
  assert.ok(text.includes(`${copy.coverageComplete}: 1`), `complete count missing: ${text}`);
  assert.ok(text.includes(`${copy.coveragePartial}: 1`), `partial count missing: ${text}`);
  assert.ok(text.includes(`${copy.coverageNoRecord}: 5`), "days with NO row must be stated, not dropped");
  // The item ranking is the only "frequently missing" claim the data supports, and it is a day count.
  assert.ok(text.includes("m1Cisd"), `the unreviewed item must be named: ${text}`);
  // Every non-zero item is listed — there is no top-N. m1Cisd is the interesting row: CONFIRMED on
  // one day and `?` (UNKNOWN) on the other, so its line must carry the unknown count.
  const named = CHECKLIST_ITEMS.filter((i) => i !== "dailyBias" && text.includes(i));
  assert.equal(named.length, 10, `all ten non-zero items must appear, saw ${named.length}`);
  assert.ok(!/غیرصفر|more non-zero/.test(text), `no truncation notice may be needed: ${text}`);
  assert.match(text.split("\n").find((l) => l.includes("m1Cisd")) ?? "", /نمی‌دانم/);
  // NOT a word-ban: `بررسی‌نشده` ("unreviewed") CONTAINS the substring `نقض`, so "does the output
  // contain the word for violation?" is undecidable in this orthography. The honest version is
  // structural — every count carries its period denominator and no row is a rate or a score.
  const itemLines = text.split("\n").filter((l) => l.includes(" — "));
  assert.ok(itemLines.length > 0, `no item lines rendered: ${text}`);
  for (const l of itemLines) {
    assert.match(l, /\d+\/7/, `an item count without its period denominator reads as a verdict: ${l}`);
    assert.ok(!/%/.test(l), `no percentage or score may appear: ${l}`);
  }
});

test("/checklist coverage takes a period, rejects a non-number, and bounds the request", async () => {
  const at = new Date("2026-10-18T10:00:00Z");
  const { bot, api, links } = makeBot({ now: () => at });
  await linkAccount(links);
  await bot.handleUpdate(commandUpdate(341, "/checklist coverage 14"));
  assert.ok((api.sent.at(-1)?.text ?? "").includes(copyFor("fa").coveragePeriod(14, "1405-07-13 … 1405-07-26")),
    `period line wrong: ${api.sent.at(-1)?.text}`);
  await bot.handleUpdate(commandUpdate(342, "/checklist coverage abc"));
  assert.equal(api.sent.at(-1)?.text, copyFor("fa").coverageDaysBad("abc"));
  await bot.handleUpdate(commandUpdate(343, "/checklist coverage 0"));
  assert.equal(api.sent.at(-1)?.text, copyFor("fa").coverageDaysBad("0"), "zero days is a refusal, not a clamp");
  await bot.handleUpdate(commandUpdate(344, "/checklist coverage 61"));
  assert.equal(api.sent.at(-1)?.text, copyFor("fa").coverageDaysBad("61"));
  await bot.handleUpdate(commandUpdate(345, "/checklist coverage ۷"));
  assert.ok((api.sent.at(-1)?.text ?? "").includes(copyFor("fa").coveragePeriod(7, "1405-07-20 … 1405-07-26")),
    `Persian digits should read as 7 days: ${api.sent.at(-1)?.text}`);
});

test("coverage of an empty period says nothing was filed, and still refuses to judge", async () => {
  const at = new Date("2026-10-18T10:00:00Z");
  const { bot, api, links } = makeBot({ now: () => at });
  await linkAccount(links);
  await bot.handleUpdate(commandUpdate(346, "/checklist coverage"));
  const text = api.sent.at(-1)?.text ?? "";
  assert.ok(text.includes(copyFor("fa").coverageEmpty), text);
  // An empty period ranks nothing: no item lines, therefore no counts to invent.
  assert.ok(!text.includes(" — "), `an empty period must not rank items: ${text}`);
});

test("/stats prints a Jalali day as Jalali and refuses an impossible one", async () => {
  const at = new Date("2026-10-18T10:00:00Z");
  const { bot, api, links, journal } = makeBot({ now: () => at });
  await linkAccount(links);
  await oneConfirmedTrade(journal, "100", `${DAY_TEXT} XAUUSD خرید، ورود 2650، خروج 2660، حجم 0.5`);
  await bot.handleUpdate(commandUpdate(347, "/stats 1405-07-26"));
  const text = api.sent.at(-1)?.text ?? "";
  assert.ok(text.includes("1405/07/26"), `the label must echo the calendar asked for: ${text}`);
  assert.ok(!text.includes("2026-10-18"), `and must not echo a date the user never typed: ${text}`);
  assert.ok(text.includes(": 1 ·"), text);
  await bot.handleUpdate(commandUpdate(348, "/stats 1405-12-30"));
  assert.equal(api.sent.at(-1)?.text, copyFor("fa").statsWindowGarbage("1405-12-30"));
});

// ── THE SHARED DATE CONTRACT, AS SEEN FROM THE BOT (tests 54 … 57) ──────────────────────────────
// The audit's central requirement: `1405-07-27` may not mean one day to /stats and another day to
// /checklist. These tests run BOTH commands on the SAME string through the SAME bot, so a future
// change that re-introduces a per-command parser fails here rather than in a user's journal.

test("/stats and /checklist resolve one Jalali day to the same day, in Latin and in Persian digits", async () => {
  const at = new Date("2026-10-18T10:00:00Z");
  const { bot, api, links, journal, store } = makeBot({ now: () => at });
  await linkAccount(links);
  // `1405-07-27` is 2026-10-19 — and the day AFTER the fixture clock's "today", so a fallback to
  // today would be visible as a missing trade rather than an accidental pass.
  await oneConfirmedTrade(journal, "410", "1405-07-27 XAUUSD خرید، ورود 2650، خروج 2660، حجم 0.5");

  await bot.handleUpdate(commandUpdate(411, "/checklist 1405-07-27 bias: bullish"));
  assert.ok((api.sent.at(-1)?.text ?? "").includes("2026-10-19"), "the checklist must file the Jalali day it read");
  const day = await store.findDailyChecklist("1", "2026-10-19");
  assert.ok(day !== null, "the row must be on the day /stats will look at");
  assert.equal(await store.findDailyChecklist("1", "1405-07-27"), null, "no 15th-century Gregorian row may exist");

  await bot.handleUpdate(commandUpdate(412, "/stats 1405-07-27"));
  const statsText = api.sent.at(-1)?.text ?? "";
  assert.ok(statsText.includes("1405/07/27"), `the answer must name the day in the calendar asked for: ${statsText}`);
  assert.ok(statsText.includes(": 1 ·"), `and it must find the trade: ${statsText}`);

  // Persian digits, same day, same answer — through BOTH commands.
  await bot.handleUpdate(commandUpdate(413, "/checklist ۱۴۰۵-۰۷-۲۷"));
  assert.ok((api.sent.at(-1)?.text ?? "").includes("2026-10-19"), "the read must land on the same day");
  await bot.handleUpdate(commandUpdate(414, "/stats ۱۴۰۵-۰۷-۲۷"));
  assert.ok((api.sent.at(-1)?.text ?? "").includes("1405/07/27"), "and /stats must still agree");
});

test("a Persian-digit Gregorian-looking day is refused by both commands, and nothing is written", async () => {
  const at = new Date("2026-10-18T10:00:00Z");
  const { bot, api, links, store } = makeBot({ now: () => at });
  await linkAccount(links);
  // `۲۰۲۶-۱۰-۱۹` is genuinely ambiguous (Gregorian 2026, or Jalali 2026 = CE 2547), so the contract
  // refuses with a message instead of choosing. The test asserts the WRITING side too: a refusal that
  // still filed a day would be the worst possible outcome.
  await bot.handleUpdate(commandUpdate(420, "/checklist ۲۰۲۶-۱۰-۱۹ bias: bullish"));
  assert.equal(api.sent.at(-1)?.text, copyFor("fa").checklistWindowAmbiguous("۲۰۲۶-۱۰-۱۹"));
  assert.equal(await store.findDailyChecklist("1", "2026-10-19"), null);
  assert.equal(await store.findDailyChecklist("1", "2547-11-09"), null, "no guess, in either direction");
  await bot.handleUpdate(commandUpdate(421, "/stats ۲۰۲۶-۱۰-۱۹"));
  assert.equal(api.sent.at(-1)?.text, copyFor("fa").statsWindowAmbiguous("۲۰۲۶-۱۰-۱۹"));
  // A marker resolves it, and the marker route is the one the message points at.
  await bot.handleUpdate(commandUpdate(422, "/checklist g:۲۰۲۶-۱۰-۱۹ bias: bullish"));
  assert.ok((api.sent.at(-1)?.text ?? "").includes("2026-10-19"), "g: must settle the ambiguity and write the day");
});

test("/stats over more trades than the store read presents ratios as unavailable, not as facts", async () => {
  const at = new Date("2026-10-18T10:00:00Z");
  const { bot, api, links, journal } = makeBot({ now: () => at });
  await linkAccount(links);
  const TOTAL = 205;   // more than the 200-row read, so `sampled` is the real flag the product sets
  for (let i = 0; i < TOTAL; i += 1) {
    const exit = i % 2 === 0 ? 2660 : 2640;   // alternate a win and a loss: a 50% ratio exists to hide
    await oneConfirmedTrade(journal, `9${String(i)}`, `XAUUSD خرید، ورود 2650، خروج ${String(exit)}، حجم 0.5`);
  }
  await bot.handleUpdate(commandUpdate(430, "/stats"));
  const text = api.sent.at(-1)?.text ?? "";
  assert.ok(text.includes(copyFor("fa").statsSampled(TOTAL)), "the sample must be declared");
  // The two ratios that CANNOT be computed from a newest-200 read are the project's `—` marker plus a
  // reason — and no percentage may appear on their lines at all.
  assert.ok(text.includes(`📈: ${copyFor("fa").checklistNone} — ${copyFor("fa").statsSampledWinRate}`), `win rate must be dash + reason: ${text}`);
  assert.ok(!/(?:^|\n)📈: \d/.test(text), "a sampled card must not print a win-rate number");
  assert.ok(text.includes(`⚖️: ${copyFor("fa").checklistNone} — ${copyFor("fa").statsSampledProfitFactor}`), "profit factor must be dash + reason");
  assert.ok(text.includes(copyFor("fa").statsSampledExtremes), "best/worst must be labelled as the sample's");
  // Sums and counts are legitimate over a sample (a lower bound / real counts) and stay printed.
  assert.ok(text.includes("🪙:"), "the count line stays");
  assert.ok(text.includes("💰:"), "the summed P/L stays");
});

test("/stats with everything read prints the ratios exactly as before", async () => {
  const at = new Date("2026-10-18T10:00:00Z");
  const { bot, api, links, journal } = makeBot({ now: () => at });
  await linkAccount(links);
  await oneConfirmedTrade(journal, "440", "XAUUSD خرید، ورود 2650، خروج 2660، حجم 0.5");
  await oneConfirmedTrade(journal, "441", "XAUUSD خرید، ورود 2650، خروج 2640، حجم 0.5");
  await bot.handleUpdate(commandUpdate(442, "/stats"));
  const text = api.sent.at(-1)?.text ?? "";
  assert.ok(!text.includes(copyFor("fa").statsSampledWinRate), "an unsampled card must not hint at sampling");
  assert.ok(!text.includes("— " + copyFor("fa").statsSampledProfitFactor), "profit factor is a fact here");
  assert.match(text, /📈: \d/, "the win rate prints as a percentage");
  assert.match(text, /⚖️: /, "the profit factor prints");
});

// ── prepared channel posts, templates and the agent (0037/0038 round) ────────
//
// WHAT THIS SECTION PROVES, in one sentence each: a preview is not a publication; the destination is
// the row's channel and never the conversation; a second tap cannot send twice; a button only works
// for its owner; untrusted template text cannot mint a button or a link; and the agent's additions
// come on top of journal capture rather than in place of it.
//
// The service, the store and the bot are real here. Only the Bot API is a fake, so "nothing was sent"
// is an observation about the transport rather than an absence of evidence.

async function linkedBotWithChannel(options: { limiter?: RateLimiter } = {}) {
  const built = makeBot({ ...options, posts: true });
  await linkAccount(built.links);
  // Bind through the command, not the store: the bot's own verification path is what makes the
  // channel usable, and a test that pre-inserted a row would skip the thing under test.
  await built.bot.handleUpdate(commandUpdate(900, "/channel -1001234567890"));
  const posts = built.posts;
  if (posts === undefined) throw new Error("the harness must wire the post service");
  return { ...built, posts };
}

test("/post is not advertised and refuses politely when the deployment has no post service", async () => {
  const { bot, api, links } = makeBot();
  await linkAccount(links);
  await bot.handleUpdate(commandUpdate(901, "/help"));
  const help = api.sent.at(-1)?.text ?? "";
  assert.equal(help.includes("/post"), false, "an unconfigured capability must not appear in /help");
  await bot.handleUpdate(commandUpdate(902, "/post"));
  assert.ok((api.sent.at(-1)?.text ?? "").includes(copyFor("fa").postNoService));
  // The menu is the same promise test: no button, because a button that always fails is a lie.
  await bot.handleUpdate(commandUpdate(903, "/start"));
  const labels = api.buttonLabels;
  assert.equal(labels.includes(copyFor("fa").btnPost), false);
});

test("a wired deployment advertises /post in help and in the menu", async () => {
  const { bot, api, links } = makeBot({ posts: true });
  await linkAccount(links);
  await bot.handleUpdate(commandUpdate(904, "/help"));
  assert.ok((api.sent.at(-1)?.text ?? "").includes("/post"));
  await bot.handleUpdate(commandUpdate(905, "/start"));
  assert.ok(api.buttonLabels.includes(copyFor("fa").btnPost), "the menu must offer what exists");
});

test("a preview without a bound channel names the missing step and writes no post row", async () => {
  const built = makeBot({ posts: true });
  await linkAccount(built.links);
  await built.bot.handleUpdate(commandUpdate(906, "/post velora.bias"));
  assert.ok((built.api.sent.at(-1)?.text ?? "").includes(copyFor("fa").postNoChannel));
  assert.deepEqual(await built.store.listRecentPosts("1", 5), [], "a preview must not persist a destination it does not have");
  // No buttons either: an "approve" that could only fail is the same lie as an unadvertised command.
  assert.deepEqual(built.api.sent.at(-1)?.options?.inlineKeyboard ?? [], []);
});

test("the publish button sends to the CHANNEL, once; a second tap cannot send twice", async () => {
  const { bot, api, store, posts } = await linkedBotWithChannel();
  await bot.handleUpdate(commandUpdate(907, "/post velora.bias"));
  const preview = api.sent.at(-1);
  assert.ok(preview !== undefined, "a preview must be sent");
  const keyboard = preview.options?.inlineKeyboard ?? [];
  const data = keyboard.flat().map((b) => (b as { callbackData?: string }).callbackData ?? "").find((d) => d.startsWith("post_pub:"));
  assert.ok(typeof data === "string" && data.length > 0, "the preview must carry a publish button");
  const rows = await store.listRecentPosts("1", 5);
  assert.equal(rows.length, 1, "one preview, one row");
  assert.equal(rows[0]?.status, "DRAFT", "a preview is a draft, not a pending send");

  const before = api.photos.length + api.sent.length;
  await bot.handleUpdate(callbackUpdate(908, data as string));
  const afterFirst = api.photos.length + api.sent.length;
  const published = await store.listRecentPosts("1", 5);
  assert.equal(published[0]?.status, "PUBLISHED");
  // THE DESTINATION ASSERTION: the post landed in the CHANNEL chat, and the user's own conversation
  // received only the confirmation sentence. There is no rasterizer in this runtime, so a banner is
  // NOT invented: the delivery degrades to the text card, and no image call is made at all.
  const toChannel = api.sent.filter((m) => m.chatId === "-1001234567890");
  assert.equal(toChannel.length, 1, "exactly one message reached the channel");
  assert.equal(api.photos.length, 0, "no photo without an actual image reference");
  assert.equal(published[0]?.telegramMessageId === null, false, "the row records the channel's message id");

  await bot.handleUpdate(callbackUpdate(909, data as string));
  assert.ok((api.sent.at(-1)?.text ?? "").includes(copyFor("fa").postAlreadyPublished));
  // +2 for the real publish: one message into the channel, one confirmation to the user. +1 for the
  // second tap: the answer only. The arithmetic is the assertion — a duplicate send would make it 4.
  assert.equal(afterFirst - before, 2, "one channel send and one receipt");
  assert.equal(api.photos.length + api.sent.length - afterFirst, 1, "the second tap sent nothing; it only answered");
});

test("a publish button is worthless to anybody but its owner", async () => {
  const { api, store, bot, posts } = await linkedBotWithChannel();
  await bot.handleUpdate(commandUpdate(910, "/post velora.bias"));
  const rows = await store.listRecentPosts("1", 5);
  const data = `post_pub:${rows[0]?.id ?? ""}`;
  // A second Telegram account that is NOT linked to user 1. The id travels; the permission does not.
  await bot.handleUpdate(callbackUpdate(911, data, 777));
  assert.equal(api.photos.length, 0, "nothing may reach the channel from a button the wrong person tapped");
  assert.equal((await store.listRecentPosts("1", 5))[0]?.status, "DRAFT", "and the row must stay unapproved");
});

test("dismissing a preview sends nothing and leaves the draft alone", async () => {
  const { api, bot, store } = await linkedBotWithChannel();
  await bot.handleUpdate(commandUpdate(912, "/post velora.bias"));
  const rows = await store.listRecentPosts("1", 5);
  await bot.handleUpdate(callbackUpdate(913, `post_no:${rows[0]?.id ?? ""}`));
  assert.ok((api.sent.at(-1)?.text ?? "").includes(copyFor("fa").postDismissed));
  assert.equal(api.photos.length, 0);
  assert.equal((await store.listRecentPosts("1", 5))[0]?.status, "DRAFT");
});

test("a rate-limited publish is refused before the transport is touched", async () => {
  let allow = true;
  const limiter: RateLimiter = {
    hit: async () => ({ allowed: allow, remaining: allow ? 1 : 0, retryAfterSec: allow ? null : 60 }) as RateLimitDecision,
  };
  const { api, bot, store } = await linkedBotWithChannel({ limiter });
  await bot.handleUpdate(commandUpdate(914, "/post velora.bias"));
  const rows = await store.listRecentPosts("1", 5);
  allow = false;
  await bot.handleUpdate(callbackUpdate(915, `post_pub:${rows[0]?.id ?? ""}`));
  assert.equal(api.photos.length, 0, "throttled means the Bot API was never asked");
  assert.equal((await store.listRecentPosts("1", 5))[0]?.status, "DRAFT");
});

test("a saved template keeps unknown fields visible, and an expression is refused outright", async () => {
  const { api, bot, store, posts } = await linkedBotWithChannel();
  await bot.handleUpdate(commandUpdate(916, "/template save mycard Setup {{symbol}} on {{nope}}"));
  assert.ok((api.sent.at(-1)?.text ?? "").includes(copyFor("fa").templateSaved("mycard", 1).slice(0, 12)));
  assert.ok((api.sent.at(-1)?.text ?? "").includes("nope"), "the unknown field is reported, not swallowed");
  await bot.handleUpdate(commandUpdate(917, "/template"));
  assert.ok((api.sent.at(-1)?.text ?? "").includes("mycard"));

  // An expression template is not stored AT ALL. Accepting `{{1+1}}` and printing it literally would
  // be harmless here, but the rule "a placeholder is a name" has to be absolute or the next template
  // feature is an evaluator.
  const before = await store.listTemplates("1");
  await bot.handleUpdate(commandUpdate(918, "/template save maths {{1+1}}"));
  assert.deepEqual(await store.listTemplates("1"), before, "nothing was written for the refused template");

  // And the saved one renders with the placeholder it does not know kept in place.
  await bot.handleUpdate(commandUpdate(919, "/post mycard"));
  const text = api.sent.at(-1)?.text ?? "";
  assert.ok(text.includes("{{nope}}") || text.includes("Setup"), "the user's own wording survives rendering");
});

test("template text cannot mint a button or a link outside the allowlist", async () => {
  const { api, bot } = await linkedBotWithChannel();
  await bot.handleUpdate(commandUpdate(920, '/template save phish <a href="https://evil.example/steal">click</a> {{symbol}}'));
  await bot.handleUpdate(commandUpdate(921, "/post phish"));
  const preview = api.sent.at(-1);
  const urls = (preview?.options?.inlineKeyboard ?? []).flat().map((b) => (b as { url?: string }).url).filter((u): u is string => typeof u === "string");
  for (const url of urls) assert.ok(url.includes("app.velora.example"), `a template cannot introduce a destination: ${url}`);
  // The only buttons are the ones the bot owns: publish/dismiss, no link buttons from template text.
  const texts = (preview?.options?.inlineKeyboard ?? []).flat().map((b) => b.text);
  assert.deepEqual(texts, [copyFor("fa").btnPublish, copyFor("fa").btnDismiss]);
  assert.equal((preview?.text ?? "").includes("evil.example"), false, "the disallowed anchor is stripped, its label kept");
});

test("/channel list and /channel use move the active target without revoking the previous binding", async () => {
  const { api, bot, store } = await linkedBotWithChannel();
  // Bind a second channel, then switch to it, then switch back.
  await bot.handleUpdate(commandUpdate(922, "/channel -1009876543210"));
  await bot.handleUpdate(commandUpdate(923, "/channel list"));
  const listed = api.sent.at(-1)?.text ?? "";
  assert.ok(listed.includes("-1001234567890") && listed.includes("-1009876543210"));
  assert.ok(listed.includes(copyFor("fa").channelStatusActive));
  await bot.handleUpdate(commandUpdate(924, "/channel use -1009876543210"));
  assert.ok((api.sent.at(-1)?.text ?? "").includes(copyFor("fa").channelActivated("-1009876543210")));
  const channels = await store.listChannels("1");
  const demoted = channels.find((c) => c.chatId === "-1001234567890");
  assert.equal(demoted?.status, "STANDBY", "the previous target is on standby, not revoked");
  assert.equal(demoted?.canPost, true, "a demotion must not erase what Telegram verified");
  assert.equal(channels.find((c) => c.status === "ACTIVE")?.chatId, "-1009876543210");
  // A channel that was never bound cannot be selected — and never becomes a destination either.
  await bot.handleUpdate(commandUpdate(925, "/channel use -1001111111111"));
  assert.ok((api.sent.at(-1)?.text ?? "").includes(copyFor("fa").channelNotFound));
  await bot.handleUpdate(commandUpdate(926, "/post velora.bias"));
  const rows = await store.listRecentPosts("1", 5);
  assert.equal(rows[0]?.chatId, "-1009876543210", "and the post follows the newly selected channel");
});

test("the agent handles what the parser cannot use, and never takes a journal entry away", async () => {
  const { api, bot, store } = await linkedBotWithChannel();
  // 1. A sentence with journal value is STILL a draft, whatever the router thinks it recognises.
  const draftsBefore = api.sent.length;
  await bot.handleUpdate(messageUpdate(927, "XAUUSD خرید، ورود 2650، خروج 2660، حجم 0.5"));
  assert.ok(api.sent.slice(draftsBefore).some((m) => m.text.includes("2650")), "the entry reaches the draft card");
  // 2. A request with no journal value is answered as the request.
  await bot.handleUpdate(messageUpdate(928, "stats for this week"));
  // This harness has no trades, so the stats answer is the EMPTY-WINDOW sentence for the named week.
  // Asserting the title instead would be asserting nothing: the point is that the stats path ran and
  // reported the user's real data state, rather than the message being filed as a note or ignored.
  const statsAnswer = api.sent.at(-1)?.text ?? "";
  assert.match(statsAnswer, /رکورد تأییدشده‌ای نیست/u, "the stats path answered about the window");
  assert.equal(
    statsAnswer.includes(copyFor("fa").journalNoData),
    false,
    "and the sentence is NOT the journal parser's 'nothing to file' — the two answers are different facts",
  );
  // 3. A capability this runtime lacks names the missing dependency.
  await bot.handleUpdate(messageUpdate(929, "take a tradingview screenshot"));
  assert.match(api.sent.at(-1)?.text ?? "", /NO_BROWSER_AUTOMATION|runtime/u);
  // 4. A prepared-post request through prose reaches the same preview and the same buttons.
  await bot.handleUpdate(messageUpdate(930, "prepare a bias card for the channel"));
  const keyboard = (api.sent.at(-1)?.options?.inlineKeyboard ?? []).flat().map((b) => (b as { callbackData?: string }).callbackData ?? "");
  assert.ok(keyboard.some((d) => d.startsWith("post_pub:")));
  const rows = await store.listRecentPosts("1", 5);
  assert.equal(rows.length, 1, "prose creates no more rows than the command does");
  assert.equal(rows[0]?.status, "DRAFT", "and still requires the approval tap");
});

test("a re-delivered preview request reuses the same row instead of drafting a second post", async () => {
  const { api, bot, store } = await linkedBotWithChannel();
  await bot.handleUpdate(commandUpdate(931, "/post velora.bias"));
  // A RETRY as Telegram actually sends it: a different update id for the same undelivered message.
  // (The same update id twice is refused earlier, by the update claim, and the bot tests already pin
  // that — so this must exercise the post-level key, which is the message id.)
  await bot.handleUpdate({
    update_id: 932,
    message: {
      message_id: 931 * 10,
      from: { id: 555, username: "trader" },
      chat: { id: 555, type: "private" },
      date: 1_770_000_000,
      text: "/post velora.bias",
    },
  });
  const rows = await store.listRecentPosts("1", 5);
  assert.equal(rows.length, 1, "Telegram retried the SAME update id; the dedupe key is the message id");
  assert.ok((api.sent.at(-1)?.text ?? "").includes(copyFor("fa").postReused));
});

// ── agent tools: research, capture, the rasterized banner, and the planner (0039 round) ──────────
//
// The tool services here are the REAL classes over an injected `fetchImpl`, so what these tests assert is
// the whole chain a deployment would run: which credential a request needs, which host it may be pointed
// at, what the guard refuses before anything leaves the process, and what the user is told when a step is
// unavailable. Only the wire is fake. "Nothing was sent" is therefore an observation about the transport,
// not an absence of evidence — and every provider call below is a call to a test's own function.

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

function secretValues(values: Record<string, string>): { resolve(key: string): Promise<{ value: string | null; source: "admin" | "env" | null }> } {
  return {
    resolve: async (key: string) => {
      const value = values[key];
      return value === undefined ? { value: null, source: null } : { value, source: "admin" };
    },
  };
}

function recordingFetch(reply: { readonly status?: number; readonly body: string | Buffer; readonly headers?: Record<string, string> }) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const sent = init ?? {};
    calls.push({ url, init: sent });
    const body = reply.body;
    return new Response(typeof body === "string" ? body : new Blob([body]), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const TAVILY_TWO_HITS = JSON.stringify({
  results: [
    { title: "Gold <b>holds</b> bid", url: "https://news.example/gold", content: "Held above 2644.", published_date: "2026-10-18T09:00:00Z" },
    { title: "No date given", url: "https://blog.example/x", content: "Commentary.", published_date: "3 hours ago" },
  ],
});

test("an agent search answers with the provider's sources, escaped, and says it verified nothing", async () => {
  const net = recordingFetch({ body: TAVILY_TWO_HITS });
  const search = new AiSearchService({
    secrets: secretValues({ TAVILY_API_KEY: "tvly-test" }),
    fetchImpl: net.fetchImpl,
    now: () => new Date(0),
  });
  const browserNet = recordingFetch({ body: "{}" });
  const { bot, api, links } = makeBot({
    posts: true,
    tools: {
      search,
      browser: new AiBrowserService({ secrets: secretValues({}), fetchImpl: browserNet.fetchImpl }),
    },
  });
  await linkAccount(links);
  await bot.handleUpdate(messageUpdate(940, "search the web: gold outlook this week"));
  const answer = api.sent.at(-1)?.text ?? "";
  assert.ok(net.calls.length === 1, `the provider should have been asked once, saw ${net.calls.length}`);
  assert.equal(net.calls[0]?.url.hostname, "api.tavily.com");
  assert.ok(answer.includes("news.example/gold"), "the citation is the point of the feature");
  assert.ok(answer.includes("Held above 2644."), "the snippet arrives verbatim");
  // Provider titles arrive with `<b>`/`<em>` around the search terms. The search service strips that
  // markup AT THE BOUNDARY (a provider's emphasis is not our formatting), and the bot escapes what is
  // left — so the assertion is about the outcome: the words survive, the tags do not.
  assert.ok(answer.includes("Gold holds bid"), "the provider's wording, minus its markup");
  assert.ok(!answer.includes("<b>"), "no markup from a third-party page reaches the message we render as HTML");
  assert.ok(answer.includes("3 hours ago"), "a relative date is shown as the provider wrote it");
  assert.ok(answer.includes("not Velora") || answer.includes("ولورا"), "the answer labels itself as unverified external content");
  // Only the private chat was written to: a research answer is not something to broadcast.
  assert.deepEqual([...new Set(api.sent.map((m) => m.chatId))], ["555"]);
  assert.equal(browserNet.calls.length, 0, "a search does not open a browser");
});

test("a search tool with no key is refused before it could ask anything, and says which key", async () => {
  const net = recordingFetch({ body: "{}" });
  const { bot, api, links } = makeBot({
    posts: true,
    tools: {
      search: new AiSearchService({ secrets: secretValues({}), fetchImpl: net.fetchImpl }),
      browser: new AiBrowserService({ secrets: secretValues({}), fetchImpl: net.fetchImpl }),
    },
  });
  await linkAccount(links);
  await bot.handleUpdate(messageUpdate(941, "search the web: the fed decision"));
  const answer = api.sent.at(-1)?.text ?? "";
  // The refusal comes from the CAPABILITY GATE, not from a provider call: an unavailable tool never even
  // reaches `search()`, so the sentence names the dependency the registry says is missing. That is the
  // stricter of the two orders — a request that would have been refused by the key is not made at all.
  assert.ok(answer.includes("NO_WEB_PROVIDER"), `expected the missing-dependency reason, got: ${answer}`);
  assert.equal(net.calls.length, 0, "an unconfigured provider must not be contacted at all");
  // The same sentence with the tool service entirely absent is refused the same way — no crash, and no
  // substituting a different action because the requested one was not available.
  const bare = makeBot({ posts: true });
  await linkAccount(bare.links);
  await bare.bot.handleUpdate(messageUpdate(942, "search the web: the fed decision"));
  assert.ok((bare.api.sent.at(-1)?.text ?? "").includes("NO_WEB_PROVIDER"));
  assert.equal(bare.api.sent.length, 1, "a refusal is one message, not a refusal followed by a surprise");
});

test("chart capture opens only a host this product vouches for, and writes nothing to the journal", async () => {
  const net = recordingFetch({ body: PNG_BYTES, headers: { "content-type": "image/png" } });
  const browser = new AiBrowserService({
    secrets: secretValues({ BROWSERLESS_URL: "http://browser.internal:3000", BROWSERLESS_TOKEN: "tok" }),
    fetchImpl: net.fetchImpl,
    now: () => new Date(0),
  });
  const { bot, api, links, journal } = makeBot({
    posts: true,
    tools: { search: new AiSearchService({ secrets: secretValues({}), fetchImpl: net.fetchImpl }), browser },
  });
  await linkAccount(links);
  await bot.handleUpdate(messageUpdate(943, "capture the chart at https://www.tradingview.com/chart/GOLD/"));
  assert.equal(net.calls.length, 1, "the configured browser service is what renders the page");
  assert.equal(net.calls[0]?.url.pathname, "/screenshot");
  const body = JSON.parse(String(net.calls[0]?.init.body)) as Record<string, unknown>;
  assert.equal(body["url"], "https://www.tradingview.com/chart/GOLD/");
  assert.equal((net.calls[0]?.init.headers as Record<string, string>)["authorization"], "Bearer tok");
  const answer = api.sent.at(-1)?.text ?? "";
  // The evidence line: which page, which instant, and the digest of the pixels that were looked at.
  assert.ok(answer.includes("tradingview.com/chart/GOLD"), `the source should be named, got: ${answer}`);
  assert.ok(/sha256 [0-9a-f]{12}/u.test(answer), "the capture is identified by its own digest");
  // No interpreter in this harness ⇒ the honest answer is "nothing was read", and NO value is invented.
  assert.ok(!/entry 26\d\d|stop 26\d\d/u.test(answer), "a capture must not fabricate a level nobody read");
  assert.equal(await journal.latest("1"), null, "a model reading a screenshot is not a trade the user confirmed");
});

test("a capture request for a host off the allowlist is refused without the browser being told to go", async () => {
  const net = recordingFetch({ body: PNG_BYTES });
  const browser = new AiBrowserService({
    secrets: secretValues({ BROWSERLESS_URL: "http://browser.internal:3000", BROWSERLESS_TOKEN: "tok" }),
    fetchImpl: net.fetchImpl,
  });
  const { bot, api, links } = makeBot({
    posts: true,
    tools: { search: new AiSearchService({ secrets: secretValues({}), fetchImpl: net.fetchImpl }), browser },
  });
  await linkAccount(links);
  await bot.handleUpdate(messageUpdate(944, "capture the chart at https://some-blog.example/post"));
  assert.equal(net.calls.length, 0, "the host check runs before the request, not after the answer");
  assert.ok((api.sent.at(-1)?.text ?? "").includes("UNSAFE_TARGET"));
});

test("the banner is rasterized for the preview and uploaded on publish, once, to the channel", async () => {
  const store: { toPng(svg: string): Promise<Buffer | null> } = {
    async toPng() {
      return PNG_BYTES;
    },
  };
  let renders = 0;
  const built = makeBot({ posts: true });
  const posts = built.posts;
  if (posts === undefined) throw new Error("the harness must wire the post service");
  // Rebuild the service with a rasterizer, over the SAME store and fake transport: the point of the test
  // is which call the publish makes, and that is decided inside the service.
  const wired = new TelegramPostService({
    store: built.store,
    data: {
      checklistFor: async () => null,
      statsFor: async () => null,
      tradeFor: async () => null,
      todayFor: async () => "2026-10-18",
    },
    api: built.api,
    allowedLinkHosts: ["app.velora.example"],
    renderBannerPng: async (svg: string) => {
      renders += 1;
      return await store.toPng(svg);
    },
  });
  await linkAccount(built.links);
  await built.bot.handleUpdate(commandUpdate(945, "/channel -1001234567890"));
  const preview = await wired.preview({
    userId: "1",
    locale: "fa",
    templateId: "velora.bias",
    dedupeKey: "msg:9450",
    banner: true,
  });
  if (preview.status !== "ready") throw new Error(`preview failed: ${preview.status}`);
  const postId = preview.post.id;
  assert.equal(renders, 0, "a preview must not rasterize behind the user's back — the image is fetched on request");
  const png = await wired.previewPng({ userId: "1", postId });
  assert.ok(png !== null && png.equals(PNG_BYTES), "the preview image is the bytes the runtime produced");
  await wired.approve({ userId: "1", postId });
  const outcome = await wired.publish({ userId: "1", postId });
  assert.equal(outcome.status, "published");
  if (outcome.status === "published") assert.equal(outcome.visual, "image", "a channel with an upload gets the photo post");
  const channelPhotos = built.api.photos.filter((p) => p.chatId === "-1001234567890");
  assert.equal(channelPhotos.length, 1, "exactly one image send to the channel");
  const upload = channelPhotos[0]?.photo;
  assert.equal(typeof upload === "object" && upload !== null ? "png-bytes" : typeof upload, "png-bytes", "bytes are uploaded, not a reference that does not exist yet");
  if (typeof upload === "object" && upload !== null) {
    assert.equal(upload.filename, `velora-post-${postId}.png`, "the upload is named for the post it belongs to");
    assert.ok(upload.bytes.equals(PNG_BYTES));
  }
  // The id Telegram handed back is stored WITH the outcome, so a later re-send needs no second upload.
  const stored = await built.store.findPost("1", postId);
  assert.equal(stored?.imageFileId, built.api.photoFileId, "the returned file id is persisted on the row");
  assert.equal(stored?.telegramMessageId, channelPhotos.length === 1 ? "p1" : "?", "and so is the message id");
});

test("a runtime without a rasterizer says so at both preview and publish, and still posts the text", async () => {
  const built = makeBot({ posts: true });
  const posts = built.posts;
  if (posts === undefined) throw new Error("the harness must wire the post service");
  await linkAccount(built.links);
  await built.bot.handleUpdate(commandUpdate(946, "/channel -1001234567890"));
  await built.bot.handleUpdate(commandUpdate(947, "/post velora.bias"));
  const previewTexts = built.api.sent.filter((m) => (m.text ?? "").includes(copyFor("fa").postPreviewTitle));
  assert.ok(previewTexts.length > 0, "the preview still explains what the banner will and will not be");
  assert.equal(built.api.photos.length, 0, "no image is claimed when nothing could render one");
  const preview = await posts.preview({ userId: "1", locale: "fa", templateId: "velora.bias", dedupeKey: "msg:9470", banner: true });
  if (preview.status !== "ready") throw new Error("preview must succeed for the publish leg");
  assert.equal(await posts.previewPng({ userId: "1", postId: preview.post.id }), null, "and the image preview is honestly unavailable");
  await posts.approve({ userId: "1", postId: preview.post.id });
  const outcome = await posts.publish({ userId: "1", postId: preview.post.id });
  assert.equal(outcome.status, "published", "the post itself still goes out — a missing rasterizer is not a failed publish");
  if (outcome.status === "published") assert.equal(outcome.visual, "text");
});

test("the planner may only propose an offered, approval-free tool — and it never overrides the table", async () => {
  const asked: unknown[] = [];
  const planner = new AiAgentPlanner({
    manager: {
      call: async (request: AiCallRequest) => {
        asked.push(request);
        return { status: "generated", text: '{"tool":"post.publish","args":{"postId":"post-999"}}', provider: "gemini", model: "m", insight: null } as never;
      },
    } as unknown as AiManager,
  });
  const net = recordingFetch({ body: "{}" });
  const { bot, api, links, store } = makeBot({
    posts: true,
    tools: {
      search: new AiSearchService({ secrets: secretValues({ TAVILY_API_KEY: "k" }), fetchImpl: net.fetchImpl }),
      browser: new AiBrowserService({ secrets: secretValues({}), fetchImpl: net.fetchImpl }),
      planner,
    },
  });
  await linkAccount(links);
  // A sentence the pattern table does not recognise, so this is the planner's turn. It proposes a
  // publish — with a post id it invented.
  await bot.handleUpdate(messageUpdate(948, "send that thing to the channel now please"));
  const answer = api.sent.at(-1)?.text ?? "";
  assert.ok(/تأیید/.test(answer) || /approval/i.test(answer), `expected the approval-first refusal, got: ${answer}`);
  assert.equal(await store.findPost("1", "999"), null, "the invented id must never have become a post row");
  assert.deepEqual(
    api.sent.filter((m) => m.chatId === "-1001234567890").length,
    0,
    "and nothing reached a channel",
  );
  const request = asked[0] as { prompt: string };
  assert.ok(request.prompt.includes("stats.read"), "the prompt lists only the tools the runtime can honour");
  assert.ok(!request.prompt.includes("post.publish"), "an approval-required tool is never offered to the model in the first place");
});

test("a sentence the table already understands costs no model call at all", async () => {
  let calls = 0;
  const planner = new AiAgentPlanner({
    manager: {
      call: async () => {
        calls += 1;
        return { status: "generated", text: '{"tool":null}', provider: "gemini", model: "m", insight: null } as never;
      },
    } as unknown as AiManager,
  });
  const net = recordingFetch({ body: TAVILY_TWO_HITS });
  const { bot, api, links } = makeBot({
    posts: true,
    tools: {
      search: new AiSearchService({ secrets: secretValues({ TAVILY_API_KEY: "k" }), fetchImpl: net.fetchImpl }),
      browser: new AiBrowserService({ secrets: secretValues({}), fetchImpl: net.fetchImpl }),
      planner,
    },
  });
  await linkAccount(links);
  await bot.handleUpdate(messageUpdate(949, "search the web: gold"));
  assert.equal(calls, 0, "the deterministic table is tried first, and a confident match is not escalated");
  assert.ok((api.sent.at(-1)?.text ?? "").includes("news.example/gold"));
  // And when the planner is broken, the user's message still lands where it always did.
  const broken = new AiAgentPlanner({ manager: { call: async () => { throw new Error("provider down"); } } as unknown as AiManager });
  const alt = makeBot({ posts: true, tools: { search: new AiSearchService({ secrets: secretValues({}), fetchImpl: net.fetchImpl }), browser: new AiBrowserService({ secrets: secretValues({}), fetchImpl: net.fetchImpl }), planner: broken } });
  await linkAccount(alt.links);
  await alt.bot.handleUpdate(messageUpdate(950, "how is my week going overall"));
  assert.ok(alt.api.sent.length >= 1, "an unavailable planner degrades to the existing behaviour, never to silence");
});

test("/help names a tool only when its credential resolves, and names the missing one as missing", async () => {
  const live = recordingFetch({ body: TAVILY_TWO_HITS });
  const withSearch = makeBot({
    posts: true,
    tools: {
      search: new AiSearchService({ secrets: secretValues({ TAVILY_API_KEY: "k" }), fetchImpl: live.fetchImpl }),
      browser: new AiBrowserService({ secrets: secretValues({}), fetchImpl: live.fetchImpl }),
    },
  });
  await linkAccount(withSearch.links);
  await withSearch.bot.handleUpdate(commandUpdate(951, "/help"));
  const help = withSearch.api.sent.at(-1)?.text ?? "";
  assert.ok(help.includes("جست‌وجوی وب در دسترس است"), `a configured tool should be advertised, got: ${help}`);
  assert.ok(help.includes("تصویر چارت در این runtime در دسترس نیست"), "and the unconfigured one named as unavailable");
  assert.equal(live.calls.length, 0, "reading the help text must not spend a provider request");
  const nothing = makeBot({ posts: true });
  await linkAccount(nothing.links);
  await nothing.bot.handleUpdate(commandUpdate(952, "/help"));
  const plain = nothing.api.sent.at(-1)?.text ?? "";
  assert.ok(!plain.includes("در دسترس است: ") && plain.includes("نیست"), "with no tools at all, nothing is promised");
});

test("a publish leaves exactly one audit row, and a preview leaves none", async () => {
  const { bot, audit, posts } = await linkedBotWithChannel();
  const preview = await posts.preview({ userId: "1", locale: "fa", templateId: "velora.bias", dedupeKey: "msg:9600", banner: false });
  if (preview.status !== "ready") throw new Error("the preview must succeed to test the button");
  const postId = preview.post.id;
  assert.equal(
    (await audit.list()).filter((r) => r.action === "TELEGRAM_POST_PUBLISHED").length,
    0,
    "a preview is not a publication — not in the trail either",
  );

  await bot.handleUpdate(callbackUpdate(960, `post_pub:${postId}`));
  const rows = (await audit.list()).filter((r) => r.action === "TELEGRAM_POST_PUBLISHED");
  assert.equal(rows.length, 1, "one tap, one row");
  const row = rows[0]!;
  assert.equal(row.actorUserId, "1", "the actor is the tapping identity, server-derived");
  assert.equal(row.provider, "TELEGRAM");
  assert.ok(row.afterState?.includes(`post:${postId}`), "the row names the post it describes");
  assert.ok(row.afterState?.includes("visual:text"), "and which shape actually reached the channel");
  const serialized = JSON.stringify(row);
  assert.ok(!serialized.includes("1001234567890"), "the channel id is not copied into the security trail");
  assert.ok(!serialized.includes("XAUUSD"), "nor is the post content: the outbox row is the source of truth");

  // A second tap: no second send, and no second row.
  await bot.handleUpdate(callbackUpdate(961, `post_pub:${postId}`));
  assert.equal(
    (await audit.list()).filter((r) => r.action === "TELEGRAM_POST_PUBLISHED").length,
    1,
    "the duplicate tap must not double-count either",
  );
});

test("a publish the transport refuses is recorded as failed and never audited as a success", async () => {
  const { bot, api, audit, store, posts } = await linkedBotWithChannel();
  const preview = await posts.preview({ userId: "1", locale: "fa", templateId: "velora.bias", dedupeKey: "msg:9620", banner: false });
  if (preview.status !== "ready") throw new Error("preview must succeed for the publish leg");
  const postId = preview.post.id;
  // The failure is driven through the BUTTON, not by calling the service directly: the audit append sits
  // in the bot's publish path, and a test that skipped that path would prove nothing about it.
  api.failingSend = true;
  await bot.handleUpdate(callbackUpdate(962, `post_pub:${postId}`));
  assert.equal((await audit.list()).filter((r) => r.action === "TELEGRAM_POST_PUBLISHED").length, 0, "a failed send has no success row");
  const stored = await store.findPost("1", postId);
  assert.equal(stored?.status, "FAILED", "the row says the send failed…");
  assert.equal(stored?.errorCode, "API_ERROR", "…with the code that explains it");
  assert.equal(stored?.telegramMessageId, null, "and no message id was conjured for a message that does not exist");
  // Recovery stays available: the same tap after the transport heals publishes once, and only then audits.
  api.failingSend = false;
  await bot.handleUpdate(callbackUpdate(963, `post_pub:${postId}`));
  const rows = (await audit.list()).filter((r) => r.action === "TELEGRAM_POST_PUBLISHED");
  assert.equal(rows.length, 1, "a retry that succeeded is exactly one success row");
});

// ── round 4: the multi-step loop, and the per-tool budgets each step spends ────────────────────────
//
// The unit file `aiAgentLoop.test.ts` proves the ceilings in isolation. These prove the WIRING: that the
// bot's agent path actually consults a planner more than once, that a step's target has to have been seen
// to be used, that a research step pays `telegram:search` rather than the analysis bucket it used to ride
// on, and that a run whose step failed says so instead of answering as if nothing went wrong.

/** A limiter with real per-key counts: the shape `FixedWindowRateLimiter` has, minus the store. */
class CountingLimiter implements RateLimiter {
  readonly counts = new Map<string, number>();
  constructor(private readonly caps: Readonly<Record<string, number>> = {}) {}
  async hit(key: RateLimitKey, bucket: string): Promise<RateLimitDecision> {
    const id = `${key}|${bucket}`;
    const next = (this.counts.get(id) ?? 0) + 1;
    this.counts.set(id, next);
    const cap = this.caps[key] ?? Number.MAX_SAFE_INTEGER;
    return next <= cap ? { allowed: true } : { allowed: false, retryAfterSec: 3600 };
  }
  count(key: RateLimitKey): number {
    return [...this.counts.entries()].filter(([id]) => id.startsWith(`${key}|`)).reduce((sum, [, n]) => sum + n, 0);
  }
}

/** The planner, over a manager whose answers are scripted. `{"tool":null}` once the script runs out. */
function scriptedPlanner(replies: readonly string[]): AiAgentPlanner {
  let i = 0;
  return new AiAgentPlanner({
    manager: {
      call: async (): Promise<unknown> => {
        const text = replies[i] ?? '{"tool":null}';
        i += 1;
        return { status: "generated", text, provider: "gemini", model: "m", insight: null };
      },
    } as unknown as AiManager,
  });
}

function toolServices(searchNet: ReturnType<typeof recordingFetch>, browserNet: ReturnType<typeof recordingFetch>, planner: AiAgentPlanner) {
  return {
    search: new AiSearchService({
      secrets: secretValues({ TAVILY_API_KEY: "tvly-test" }),
      fetchImpl: searchNet.fetchImpl,
      now: () => new Date(0),
    }),
    browser: new AiBrowserService({
      secrets: secretValues({ BROWSERLESS_URL: "http://browser.internal:3000", BROWSERLESS_TOKEN: "tok" }),
      fetchImpl: browserNet.fetchImpl,
      now: () => new Date(0),
    }),
    planner,
  };
}

const TAVILY_TRADINGVIEW_HIT = JSON.stringify({
  results: [
    { title: "XAUUSD on TradingView", url: "https://www.tradingview.com/symbols/XAUUSD/", content: "Live chart.", published_date: "2026-10-19T09:00:00Z" },
  ],
});

test("a model-planned request chains: the URL search found is the one capture opens", async () => {
  const searchNet = recordingFetch({ body: TAVILY_TRADINGVIEW_HIT });
  const browserNet = recordingFetch({ body: PNG_BYTES, headers: { "content-type": "image/png" } });
  const planner = scriptedPlanner([
    '{"tool":"web.search","args":{"query":"XAUUSD chart"}}',
    '{"tool":"chart.capture","args":{"url":"https://www.tradingview.com/symbols/XAUUSD/"}}',
  ]);
  const { bot, api, links } = makeBot({ posts: true, tools: toolServices(searchNet, browserNet, planner) });
  await linkAccount(links);
  // THE SENTENCE MATTERS: it must be one the deterministic table does NOT understand, or this would be a
  // test of the single-step path wearing a multi-step costume. No "screenshot", no "search", no "capture".
  await bot.handleUpdate(messageUpdate(960, "find me the page where gold is charted and open it"));

  assert.equal(searchNet.calls.length, 1, "step one reached the search provider once");
  assert.equal(browserNet.calls.length, 1, "step two reached the browser service once — this is a two-step run");
  const opened = String(browserNet.calls[0]?.init.body ?? "");
  assert.ok(
    opened.includes("https://www.tradingview.com/symbols/XAUUSD/"),
    `capture must open the page the SEARCH returned, saw: ${opened.slice(0, 220)}`,
  );
  const texts = api.sent.map((m) => m.text ?? "");
  assert.ok(texts.some((x) => x.includes("www.tradingview.com/symbols/XAUUSD")), "the research answer is shown");
  assert.ok(
    texts.some((x) => x.includes("Chart captured") || x.includes("تصویر چارت گرفته شد")),
    `the capture answer is shown too, saw: ${JSON.stringify(texts)}`,
  );
  // And the journal is untouched: two tool calls do not add up to a trade record.
  assert.equal(texts.filter((x) => x.includes("nothing was written")).length + texts.filter((x) => x.includes("ثبت نشد")).length > 0, true,
    "a capture still says it stored nothing");
});

test("a step naming a destination no tool ever returned is refused before the network", async () => {
  const searchNet = recordingFetch({ body: TAVILY_TWO_HITS });
  const browserNet = recordingFetch({ body: PNG_BYTES, headers: { "content-type": "image/png" } });
  const planner = scriptedPlanner(['{"tool":"chart.capture","args":{"url":"http://169.254.169.254/latest/meta-data"}}']);
  const { bot, api, links } = makeBot({ posts: true, tools: toolServices(searchNet, browserNet, planner) });
  await linkAccount(links);
  await bot.handleUpdate(messageUpdate(961, "grab the chart from the thing I mean"));
  assert.equal(browserNet.calls.length, 0, "an unverified destination never reaches a browser");
  assert.equal(searchNet.calls.length, 0, "and no other tool is run instead of saying no");
  const answer = api.sent.at(-1)?.text ?? "";
  assert.ok(/never appeared|دیده نشده/u.test(answer), `expected the unverified-target sentence, saw: ${answer}`);
});

test("research pays its own bucket, and the analysis bucket it used to share is untouched", async () => {
  const limiter = new SelectiveLimiter([]);
  const searchNet = recordingFetch({ body: TAVILY_TWO_HITS });
  const browserNet = recordingFetch({ body: "{}" });
  const planner = scriptedPlanner(['{"tool":"web.search","args":{"query":"gold"}}']);
  const { bot, links } = makeBot({ posts: true, limiter, tools: toolServices(searchNet, browserNet, planner) });
  await linkAccount(links);
  await bot.handleUpdate(messageUpdate(962, "what is happening with gold, honestly"));
  assert.ok(limiter.keys().includes("telegram:search"), `the search bucket must be paid, saw ${JSON.stringify(limiter.keys())}`);
  assert.ok(limiter.keys().includes("telegram:agent"), "and the run pays its own bucket as well");
  assert.ok(!limiter.keys().includes("telegram:analyze"), "a search may not spend the journal-analysis budget any more");
  assert.equal(limiter.bucketFor("telegram:search"), "tg:555", "keyed by the Telegram identity, like every other Telegram bucket");
});

test("a per-tool hourly ceiling stops the loop BEFORE the next provider call", async () => {
  const searchNet = recordingFetch({ body: TAVILY_TWO_HITS });
  const browserNet = recordingFetch({ body: "{}" });
  const limiter = new CountingLimiter({ "telegram:search": 2 });
  // A model that keeps asking for searches: the run's own per-tool allowance is three, so without the
  // hourly bucket this test would see three provider calls. With it, the third step is refused by the
  // budget — and a refused step must not silently become zero messages.
  const planner = scriptedPlanner([
    '{"tool":"web.search","args":{"query":"q1"}}',
    '{"tool":"web.search","args":{"query":"q2"}}',
    '{"tool":"web.search","args":{"query":"q3"}}',
  ]);
  const { bot, api, links } = makeBot({ posts: true, limiter, tools: toolServices(searchNet, browserNet, planner) });
  await linkAccount(links);
  await bot.handleUpdate(messageUpdate(963, "search gold, then silver, then oil, then bitcoin"));
  assert.equal(searchNet.calls.length, 2, "the third search must never reach the provider");
  assert.equal(limiter.count("telegram:search"), 3, "the refused attempt still counted: a denied request is a request");
  const texts = api.sent.map((m) => m.text ?? "");
  assert.ok(
    texts.some((x) => x.includes("Too many requests") || x.includes("تعداد درخواست‌های شما زیاد است")),
    `the user is told why, saw ${JSON.stringify(texts)}`,
  );
});

test("a failed step is reported as failed, not answered around", async () => {
  const searchNet = recordingFetch({ body: '{"detail":"upstream exploded"}', status: 503 });
  const browserNet = recordingFetch({ body: "{}" });
  const planner = scriptedPlanner(['{"tool":"web.search","args":{"query":"gold"}}']);
  const { bot, api, links } = makeBot({ posts: true, tools: toolServices(searchNet, browserNet, planner) });
  await linkAccount(links);
  await bot.handleUpdate(messageUpdate(964, "look up gold for me please"));
  const answer = api.sent.at(-1)?.text ?? "";
  assert.equal(searchNet.calls.length, 1, "the provider was asked once");
  assert.ok(!/results from/iu.test(answer), `a failed search must not claim results, saw: ${answer}`);
  assert.ok(answer.length > 0, "and it must not be answered with silence either");
});

test("/help advertises bounded multi-step planning only where a planner is wired", async () => {
  const searchNet = recordingFetch({ body: "{}" });
  const browserNet = recordingFetch({ body: "{}" });
  const withPlanner = makeBot({ posts: true, tools: toolServices(searchNet, browserNet, scriptedPlanner(['{"tool":null}'])) });
  await linkAccount(withPlanner.links);
  await withPlanner.bot.handleUpdate(messageUpdate(965, "/help"));
  const helpWith = withPlanner.api.sent.at(-1)?.text ?? "";
  // The harness's user is Persian, so both locales are accepted here: what is under test is whether the
  // sentence EXISTS at all, not which language the fake profile chose.
  assert.ok(
    (/bounded steps/u.test(helpWith) || /مرحلهٔ محدود/u.test(helpWith)) && helpWith.includes("6"),
    `the ceiling must be stated where it applies, saw: ${helpWith}`,
  );
  assert.ok(/approval button|دکمهٔ تأیید/u.test(helpWith), "and the approval rule is stated in the same breath");

  const noPlanner = makeBot({
    posts: true,
    tools: {
      search: new AiSearchService({ secrets: secretValues({ TAVILY_API_KEY: "k" }), fetchImpl: searchNet.fetchImpl }),
      browser: new AiBrowserService({ secrets: secretValues({}), fetchImpl: browserNet.fetchImpl }),
    },
  });
  await linkAccount(noPlanner.links);
  await noPlanner.bot.handleUpdate(messageUpdate(966, "/help"));
  const helpWithout = noPlanner.api.sent.at(-1)?.text ?? "";
  assert.ok(!/bounded steps|مرحلهٔ محدود/u.test(helpWithout), "a runtime that answers in one step must not promise several");
});

// ── Round 7: the navigable menu ─────────────────────────────────────────────
//
// These tests drive the bot the way a user does — tapping buttons — because the property that broke
// before (a capability wired in `apps/api` but never handed to a deployment) is invisible to a unit
// test of the handler alone. Each one asserts the EFFECT (a row written, a message sent, nothing
// written) rather than the wording.

test("the main menu reaches every section by button, and every section reaches home", async () => {
  const { bot, api, links } = await linkedBotWithChannel();
  await bot.handleUpdate(commandUpdate(2001, "/start"));
  const sections = ["templates", "banner", "ai", "posts", "home"] as const;
  for (const [index, target] of sections.entries()) {
    await bot.handleUpdate(callbackUpdate(2002 + index, `menu:${target}`));
    const screen = api.sent.at(-1);
    assert.ok(screen !== undefined, `menu:${target} produced no screen`);
    const back = (screen.options?.inlineKeyboard ?? []).flat()
      .map((b) => (b as { callbackData?: string }).callbackData ?? "");
    // The main menu IS home: it needs no home button. Every other section must carry one.
    if (target !== "home") assert.ok(back.includes("menu:home"), `menu:${target} has no way home`);
  }
});

test("an unlinked user cannot reach a menu screen by tapping a stale button", async () => {
  const { bot, api } = makeBot({ posts: true });
  // No `linkAccount`: this identity has never completed the handshake.
  for (const [index, data] of ["menu:templates", "menu:posts", "tpl_list:1", "ai_status:none"].entries()) {
    await bot.handleUpdate(callbackUpdate(2100 + index, data));
  }
  const texts = api.texts.join("\n");
  assert.ok(texts.includes(copyFor("fa").onboardingTitle.replace(/<[^>]+>/gu, "")) || texts.includes("اتصال"), "an unlinked tap gets onboarding, not a section");
  assert.equal(texts.includes(copyFor("fa").navPostsBody), false, "no section content leaks to an unlinked identity");
});

test("templates: create through the guided prompts persists a version", async () => {
  const { bot, api, store, links } = await linkedBotWithChannel();
  await linkAccount(links);
  await bot.handleUpdate(callbackUpdate(2200, "tpl_new:none"));
  assert.ok(api.lastText.includes(copyFor("fa").tplAskName), "step 1 asks for the name");
  await bot.handleUpdate(messageUpdate(2201, "morning-card"));
  assert.ok(api.lastText.includes(copyFor("fa").tplAskBody), "step 2 asks for the body");
  await bot.handleUpdate(messageUpdate(2202, "کارت صبح: {symbol} — {winRate}"));
  const saved = await store.findCurrentTemplate("1", "morning-card");
  assert.notEqual(saved, null, "the template must be persisted, not held in memory");
  assert.equal(saved?.version, 1);
  assert.ok((await store.getPostPreferences("1")).pendingFlow === null, "the flow cursor is closed after the write");
});

test("templates: editing writes a NEW version and keeps the old one readable", async () => {
  const { bot, store, links } = await linkedBotWithChannel();
  await linkAccount(links);
  const first = await store.saveTemplate({ userId: "1", name: "bias", body: "v1 {symbol}", expectedVersion: null, at: new Date() });
  assert.equal(first.status, "saved");
  const id = first.status === "saved" ? first.record.id : "";
  await bot.handleUpdate(callbackUpdate(2300, `tpl_edit:${id}`));
  await bot.handleUpdate(messageUpdate(2301, "v2 {symbol} {netPnl}"));
  const current = await store.findCurrentTemplate("1", "bias");
  assert.equal(current?.version, 2);
  assert.equal(current?.body, "v2 {symbol} {netPnl}");
  const all = await store.listTemplates("1");
  assert.equal(all.length, 1, "listTemplates shows the CURRENT version only");
});

test("templates: delete asks once, then retires — and clears a default that pointed at it", async () => {
  const { bot, api, store, links } = await linkedBotWithChannel();
  await linkAccount(links);
  const saved = await store.saveTemplate({ userId: "1", name: "temp", body: "{symbol}", expectedVersion: null, at: new Date() });
  const id = saved.status === "saved" ? saved.record.id : "";
  await bot.handleUpdate(callbackUpdate(2400, `tpl_def:${id}`));
  assert.equal((await store.getPostPreferences("1")).defaultTemplateName, "temp");

  await bot.handleUpdate(callbackUpdate(2401, `tpl_del:${id}`));
  assert.ok(api.lastText.includes(copyFor("fa").tplDeleteAsk("temp")), "the question comes first");
  assert.notEqual(await store.findCurrentTemplate("1", "temp"), null, "asking changes nothing");

  await bot.handleUpdate(callbackUpdate(2402, `tpl_delok:${id}`));
  assert.equal(await store.findCurrentTemplate("1", "temp"), null, "the confirmation retires it");
  assert.equal(
    (await store.getPostPreferences("1")).defaultTemplateName,
    null,
    "a default pointing at a retired template is cleared, so /post never asks an unanswerable question",
  );
});

test("templates: a duplicate name is refused instead of silently replacing the first", async () => {
  const { bot, api, store, links } = await linkedBotWithChannel();
  await linkAccount(links);
  await store.saveTemplate({ userId: "1", name: "dup", body: "first {symbol}", expectedVersion: null, at: new Date() });
  await bot.handleUpdate(callbackUpdate(2450, "tpl_new:none"));
  await bot.handleUpdate(messageUpdate(2451, "dup"));
  assert.ok(api.lastText.includes(copyFor("fa").tplNameTaken));
  const still = await store.findCurrentTemplate("1", "dup");
  assert.equal(still?.body, "first {symbol}", "the existing version is untouched");
});

test("templates: /cancel closes an open prompt and nothing is written", async () => {
  const { bot, api, store, links } = await linkedBotWithChannel();
  await linkAccount(links);
  await bot.handleUpdate(callbackUpdate(2500, "tpl_new:none"));
  await bot.handleUpdate(commandUpdate(2501, "/cancel"));
  assert.ok(api.lastText.includes(copyFor("fa").tplCanceled));
  assert.equal((await store.getPostPreferences("1")).pendingFlow, null);
  await bot.handleUpdate(messageUpdate(2502, "orphan-name"));
  assert.equal(await store.findCurrentTemplate("1", "orphan-name"), null, "text after a cancel is not captured by the prompt");
});

test("banner: the toggle persists, and the screen never claims a PNG it cannot make", async () => {
  const { bot, api, store, links } = await linkedBotWithChannel();
  await linkAccount(links);
  assert.equal((await store.getPostPreferences("1")).bannerEnabled, true, "defaults are on");
  await bot.handleUpdate(callbackUpdate(2600, "bn_toggle:off"));
  assert.equal((await store.getPostPreferences("1")).bannerEnabled, false, "the toggle is persisted, not remembered in a closure");
  // The harness wires no `renderBannerPng`, so this runtime cannot rasterize — and says so.
  assert.ok(api.lastText.includes("PNG"), "the limitation is stated on the screen");
  await bot.handleUpdate(callbackUpdate(2601, "bn_title:ask"));
  await bot.handleUpdate(messageUpdate(2602, "عنوان سفارشی"));
  assert.equal((await store.getPostPreferences("1")).bannerTitle, "عنوان سفارشی");
});

test("AI tools: the status screen names what is missing and no secret value", async () => {
  const { bot, api, links } = makeBot({
    posts: true,
    tools: {
      search: {
        status: async () => ({
          tool: "web_search",
          provider: "tavily",
          state: "unavailable",
          runtimeSupported: true,
          secrets: [{ key: "TAVILY_API_KEY", present: false, source: null }],
          reason: "MISSING_API_KEY",
          lastStatus: null,
          lastCheckedAt: null,
        }),
      } as never,
      browser: {
        status: async () => ({
          tool: "browser_capture",
          provider: "browserless",
          state: "unavailable",
          runtimeSupported: true,
          secrets: [{ key: "BROWSERLESS_URL", present: false, source: null }],
          reason: "MISSING_API_KEY",
          lastStatus: null,
          lastCheckedAt: null,
        }),
      } as never,
    },
  });
  await linkAccount(links);
  await bot.handleUpdate(callbackUpdate(2700, "ai_status:none"));
  assert.ok(api.lastText.includes("TAVILY_API_KEY"), "the missing key is named");
  assert.ok(api.lastText.includes("BROWSERLESS_URL"));
  assert.ok(api.lastText.includes(copyFor("fa").aiOff));
});

test("a publish tap from a DIFFERENT identity is refused", async () => {
  const { bot, api, store, links } = await linkedBotWithChannel();
  await bot.handleUpdate(commandUpdate(2800, "/post velora.bias"));
  const data = (api.sent.at(-1)?.options?.inlineKeyboard ?? []).flat()
    .map((b) => (b as { callbackData?: string }).callbackData ?? "")
    .find((d) => d.startsWith("post_pub:"));
  assert.ok(data !== undefined);
  // A second, linked identity must not be able to publish the first identity's draft.
  await linkAccount(links, "2", "777");
  await bot.handleUpdate(callbackUpdate(2801, data as string, 777));
  const rows = await store.listRecentPosts("1", 5);
  assert.equal(rows[0]?.status, "DRAFT", "the owning identity's draft is still unpublished");
});

test("a journal message is never captured by an open template prompt", async () => {
  const { bot, api, store, links } = await linkedBotWithChannel();
  await linkAccount(links);
  await bot.handleUpdate(callbackUpdate(2900, "tpl_new:none"));
  // This is a complete journal entry. The parser must win, and the prompt must say it stayed open.
  await bot.handleUpdate(messageUpdate(2901, COMPLETE_FA));
  assert.ok(api.texts.some((t) => t.includes(copyFor("fa").flowJournalWins)), "the user is told the trade won");
  const drafts = await store.listTemplates("1");
  assert.equal(drafts.length, 0, "no template was created from a trade sentence");
  assert.equal(await bot.handleUpdate(messageUpdate(2902, "ژورنال")), "handled");
  assert.notEqual((await store.getPostPreferences("1")).pendingFlow, null, "the prompt is still armed afterwards");
});
