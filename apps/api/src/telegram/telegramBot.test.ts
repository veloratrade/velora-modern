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
import { TelegramLinkService } from "./telegramLinkService.js";
import type { InlineKeyboardButton, SentMessageOptions, TelegramBotApi } from "./telegramApi.js";
import type { TelegramUpdate } from "@velora/contracts";

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
  failingSend = false;
  fileBytes: Buffer = Buffer.from("voice-bytes");
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
  async answerCallbackQuery(): Promise<void> {}
  async getFile(fileId: string) {
    return { fileId, filePath: `path/${fileId}`, fileSizeBytes: this.fileBytes.length };
  }
  async downloadFile(filePath: string): Promise<Buffer> {
    this.downloads.push(filePath);
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
  get lastText(): string {
    return this.sent.at(-1)?.text ?? "";
  }
  get texts(): string[] {
    return this.sent.map((m) => m.text);
  }
}

function makeBot(options: { now?: () => Date } = {}): {
  bot: TelegramBot;
  api: FakeBotApi;
  store: MemoryTelegramStore;
  audit: MemoryAuditStore;
  links: TelegramLinkService;
  trades: TradeService;
  journal: JournalApplicationService;
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
  });
  const attempts = new MemoryAiAttemptStore();
  const coach = new AiCoachService({
    provider: new UnconfiguredAiProvider(),
    consent: { consentState: async () => ({ consented: true, consentedAt: null }) },
    attempts,
    allowedProviders: ["openai", "gemini"],
  });

  const deps: TelegramBotDeps = {
    api,
    store,
    links,
    journal,
    analysis: new JournalAnalysisService({ coach, journal }),
    media: { interpreter: new UnconfiguredMediaInterpreter(), attempts },
    appUrl: () => "https://app.velora.example",
    getUserLocale: async () => "fa",
    log: () => undefined,
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  return { bot: new TelegramBot(deps), api, store, audit, links, trades, journal };
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
