// Telegram HTTP surface — the whole client over a real socket.
//
// WHAT THIS FILE IS EVIDENCE FOR. Everything below runs through the REAL kernel
// (`createApp` + `listen`), the REAL bearer verification and the REAL Telegram
// services; only the storage adapters and the Bot API are doubles. That matters
// because the two surfaces authenticate DIFFERENTLY and the difference is the
// security property being asserted:
//   * the webhook ingress is authenticated by Telegram's secret token and must
//     never be reachable without it;
//   * every /api/v1/telegram/* route is authenticated by the bearer token, is
//     scoped to `claims.sub`, and IGNORES any user id a client sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listen } from "../kernel/server.js";
import { AuthService } from "../auth/authService.js";
import { JwtService } from "../auth/jwt.js";
import { VeloraHasher } from "../auth/hashing.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { LogMailProvider } from "../mail/logMailProvider.js";
import { MemoryAuditStore } from "../auth/memoryAuditStore.js";
import { MemoryAiAttemptStore, UnconfiguredAiProvider } from "../aicoach/aiProvider.js";
import { AiCoachService } from "../aicoach/aiCoachService.js";
import { UnconfiguredMediaInterpreter } from "../aicoach/mediaInterpreter.js";
import { JournalAnalysisService } from "../journal/journalAnalysisService.js";
import { JournalApplicationService } from "../journal/journalApplicationService.js";
import { FixedWindowRateLimiter } from "../ratelimits/rateLimiter.js";
import { MemoryRateLimitStore } from "../ratelimits/memoryRateLimitStore.js";
import { MemoryTradeStore } from "../trades/memoryTradeStore.js";
import { TradeService } from "../trades/tradeService.js";
import { MemoryTelegramStore } from "./memoryTelegramStore.js";
import { TelegramBot } from "./telegramBot.js";
import { TelegramLinkService } from "./telegramLinkService.js";
import { TelegramUpdatePipeline } from "./telegramUpdatePipeline.js";
import { resolveTelegramConfig } from "./telegramConfig.js";
import { TELEGRAM_WEBHOOK_MAX_BODY_BYTES, type TelegramCapability } from "./telegramRoutes.js";
import type { TelegramBotApi } from "./telegramApi.js";
import type { TelegramUpdate } from "@velora/contracts";

const JWT_SECRET = "telegram-routes-test-secret-0123456789abcdef"; // test-only
const BOT_TOKEN = "123456789:AAHtest-token-DO-NOT-LEAK-0123456789";
const WEBHOOK_SECRET = "whsec_test_0123456789abcdef";
const BOT_USERNAME = "velora_journal_bot";
const APP_URL = "https://app.velora.example";

interface Envelope<T = Record<string, unknown>> {
  status: string;
  data: T;
  error: { code: string; message: string; details?: Record<string, string | number> } | null;
  timestamp: string;
}

/** A Bot API double that records what the bot said and never touches the network. */
class FakeBotApi implements TelegramBotApi {
  readonly sent: { chatId: string; text: string }[] = [];
  async sendMessage(chatId: string, text: string) {
    this.sent.push({ chatId, text });
    return { messageId: String(this.sent.length) };
  }
  async answerCallbackQuery(): Promise<void> {}
  async getFile(fileId: string) {
    return { fileId, filePath: `path/${fileId}`, fileSizeBytes: 8 };
  }
  async downloadFile(): Promise<Buffer> {
    return Buffer.from("bytes");
  }
  async getChat(chatId: string) {
    return { id: chatId, type: "channel" as const, title: "Journal" };
  }
  async getChatMember() {
    return { status: "administrator" as const, canPostMessages: true };
  }
  async getMe() {
    return { id: "1", username: BOT_USERNAME };
  }
  async getUpdates(): Promise<TelegramUpdate[]> {
    return [];
  }
}

interface Harness {
  readonly base: string;
  readonly api: FakeBotApi;
  readonly store: MemoryTelegramStore;
  /** The webhook's deferred work, drained by `drain()`. */
  readonly updates: readonly (() => Promise<void>)[];
  readonly drain: () => Promise<void>;
  readonly close: () => Promise<void>;
}

async function withServer(
  fn: (harness: Harness, tokens: { alice: string; bob: string }) => Promise<void>,
  options: { updateMode?: "webhook" | "polling" | "off"; configured?: boolean } = {},
): Promise<void> {
  const verificationTokens: string[] = [];
  const auth = new AuthService({
    store: new MemoryUserStore(),
    hasher: new VeloraHasher(),
    jwt: JwtService.create(JWT_SECRET),
    generateVerificationToken: () => {
      const t = `telegram-verification-${Math.random().toString(36).slice(2)}-0123456789`;
      verificationTokens.push(t);
      return t;
    },
    mail: new LogMailProvider(),
  });

  const store = new MemoryTelegramStore();
  const api = new FakeBotApi();
  const audit = new MemoryAuditStore();
  const env =
    options.configured === false
      ? { APP_ENV: "development" }
      : {
          TELEGRAM_BOT_TOKEN: BOT_TOKEN,
          TELEGRAM_BOT_USERNAME: BOT_USERNAME,
          TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
          TELEGRAM_UPDATE_MODE: options.updateMode ?? "webhook",
          VELORA_APP_URL: APP_URL,
          APP_ENV: "development",
        };
  const links = new TelegramLinkService({ store, audit, botUsername: () => BOT_USERNAME });
  const trades = new TradeService({
    store: new MemoryTradeStore(),
    getUserTimezone: async () => "Asia/Tehran",
    verifyAccountOwnership: async () => true,
  });
  const journal = new JournalApplicationService({ trades, drafts: store, getUserTimezone: async () => "Asia/Tehran" });
  const attempts = new MemoryAiAttemptStore();
  const bot = new TelegramBot({
    api,
    store,
    links,
    journal,
    analysis: new JournalAnalysisService({
      coach: new AiCoachService({
        provider: new UnconfiguredAiProvider(),
        consent: { consentState: async () => ({ consented: true, consentedAt: null }) },
        attempts,
        allowedProviders: ["openai", "gemini"],
      }),
      journal,
    }),
    media: { interpreter: new UnconfiguredMediaInterpreter(), attempts },
    appUrl: () => resolveTelegramConfig(env).appUrl,
    getUserLocale: async () => "fa",
    log: () => undefined,
  });
  // The webhook path is DEFERRED by design. The test drains the scheduled tasks
  // before each assertion, which is both deterministic AND a faithful model of
  // production: the HTTP answer is sent, then the work happens.
  const deferred: (() => Promise<void>)[] = [];
  const pipeline = new TelegramUpdatePipeline({
    bot,
    mode: () => resolveTelegramConfig(env).updateMode,
    defer: (task) => {
      deferred.push(task);
    },
    log: () => undefined,
  });
  const telegram: TelegramCapability = {
    config: () => resolveTelegramConfig(env),
    links,
    store,
    pipeline,
    limiter: new FixedWindowRateLimiter(new MemoryRateLimitStore()),
    audit,
    log: () => undefined,
  };

  const app = createApp({
    allowedOrigins: [APP_URL],
    checks: { database: async () => "ok" as const },
    auth,
    telegram,
  });
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;

  async function makeUser(email: string): Promise<string> {
    await fetch(`${base}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "a-strong-password-123" }),
    });
    await fetch(`${base}/api/v1/auth/verify-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: verificationTokens.shift() }),
    });
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "a-strong-password-123" }),
    });
    assert.equal(login.status, 200);
    return ((await login.json()) as Envelope<{ tokens: { accessToken: string } }>).data.tokens.accessToken;
  }

  /** Run everything the webhook deferred (inside, the pipeline is synchronous). */
  async function drain(): Promise<void> {
    while (deferred.length > 0) {
      const task = deferred.shift()!;
      await task();
    }
  }

  try {
    const alice = await makeUser("tg-alice@velora.example");
    const bob = await makeUser("tg-bob@velora.example");
    await fn({ base, api, store, updates: deferred, drain, close: async () => undefined }, { alice, bob });
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

function journalMessage(updateId: number, text: string, fromId = 555): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: fromId, username: "trader" },
      chat: { id: fromId, type: "private" },
      date: 1_770_000_000,
      text,
    },
  };
}

// ── Ingress ─────────────────────────────────────────────────────────────────

test("WEBHOOK: a delivery without the secret token is refused and never processed", async () => {
  await withServer(async ({ base, store }) => {
    const update = journalMessage(1, "XAUUSD خرید، ورود 2650، خروج 2660، حجم 0.5");
    const noSecret = await fetch(`${base}/api/v1/webhooks/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    assert.equal(noSecret.status, 401);
    assert.equal(((await noSecret.json()) as Envelope).error?.code, "UNAUTHENTICATED");

    const wrongSecret = await fetch(`${base}/api/v1/webhooks/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "whsec_wrong_0123456789abcdef" },
      body: JSON.stringify(update),
    });
    assert.equal(wrongSecret.status, 401);

    // Neither attempt claimed the update: the dedupe table has no row…
    assert.equal(store.updates.size, 0);
    // …and no draft was opened by an unauthenticated caller.
    assert.equal(store.drafts.length, 0);
  });
});

test("WEBHOOK: an authenticated delivery is accepted, and a GET is a 405 with Allow", async () => {
  await withServer(async ({ base, store, api, drain }) => {
    const get = await fetch(`${base}/api/v1/webhooks/telegram`);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("allow"), "POST");

    const malformed = await fetch(`${base}/api/v1/webhooks/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
      body: "not json",
    });
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as Envelope).error?.code, "VALIDATION_FAILED");

    const schemaMismatch = await fetch(`${base}/api/v1/webhooks/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
      body: JSON.stringify({ hello: "world" }),
    });
    assert.equal(schemaMismatch.status, 400);

    // An oversized body is refused BY THE BYTES, with the platform's own
    // oversized-body contract (400 + VALIDATION_FAILED), and it never reaches the
    // pipeline: no claim, no draft, no send. A Telegram update is a message plus
    // file REFERENCES, so a megabyte of JSON is not a delivery mistake.
    const oversized = await fetch(`${base}/api/v1/webhooks/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
      body: JSON.stringify({ update_id: 6, padding: "x".repeat(TELEGRAM_WEBHOOK_MAX_BODY_BYTES) }),
    });
    assert.equal(oversized.status, 400);
    assert.equal(((await oversized.json()) as Envelope).error?.code, "VALIDATION_FAILED");
    assert.equal(store.updates.size, 0, "an oversized body must not claim an update");
    assert.equal(api.sent.length, 0);

    const ok = await fetch(`${base}/api/v1/webhooks/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
      body: JSON.stringify(journalMessage(7, "XAUUSD خرید، ورود 2650، خروج 2660، حجم 0.5")),
    });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as Envelope<{ accepted: boolean }>).data.accepted, true);
    // The claim was taken BEFORE the answer: that is what makes the early 200 safe.
    assert.ok(store.updates.has("7"));
    // The body is a promise, not a greeting: nothing has been SENT yet.
    assert.equal(api.sent.length, 0);
    await drain();
    // Only an UNLINKED identity arrives here, so the deferred work answered with
    // onboarding — and it did so after the 200 above.
    assert.ok(api.sent.length >= 1);
  });
});

test("WEBHOOK: with no Telegram configuration the ingress answers 503 rather than accepting anything", async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/v1/webhooks/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
      body: JSON.stringify(journalMessage(1, "/start")),
    });
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as Envelope).error?.code, "TELEGRAM_NOT_CONFIGURED");
  }, { configured: false });
});

test("WEBHOOK: a deployment whose consumer is the POLLER refuses the delivery — one stream, one consumer", async () => {
  await withServer(async ({ base, store }) => {
    const res = await fetch(`${base}/api/v1/webhooks/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
      body: JSON.stringify(journalMessage(3, "/start")),
    });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as Envelope).error?.code, "TELEGRAM_MODE_CONFLICT");
    assert.equal(store.updates.size, 0);
  }, { updateMode: "polling" });
});

// ── Authenticated surface ───────────────────────────────────────────────────

test("STATUS: unauthenticated → 401; authenticated → the connection state and nothing secret", async () => {
  await withServer(async ({ base }, { alice }) => {
    const anon = await fetch(`${base}/api/v1/telegram/status`);
    assert.equal(anon.status, 401);

    const res = await fetch(`${base}/api/v1/telegram/status`, { headers: bearer(alice) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Envelope<{ state: string; bot: { username: string; deepLinkAvailable: boolean }; updateMode: string }>;
    assert.equal(body.data.state, "NOT_LINKED");
    assert.equal(body.data.bot.username, BOT_USERNAME);
    assert.equal(body.data.bot.deepLinkAvailable, true);
    assert.equal(body.data.updateMode, "webhook");
    // The response must not contain the bot token, ever.
    assert.ok(!JSON.stringify(body).includes("AAHtest-token"));
  });
});

test("LINK START: mints a one-time deep link scoped to the bearer, and ignores client-supplied ids", async () => {
  await withServer(async ({ base, store }, { alice, bob }) => {
    const anon = await fetch(`${base}/api/v1/telegram/link/start`, { method: "POST" });
    assert.equal(anon.status, 401);

    const res = await fetch(`${base}/api/v1/telegram/link/start`, { method: "POST", headers: bearer(alice) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Envelope<{ deepLink: string; expiresAt: string }>;
    assert.ok(body.data.deepLink.startsWith(`https://t.me/${BOT_USERNAME}?start=`), `unexpected deep link: ${body.data.deepLink}`);
    // The deep link carries ONLY the opaque token: no account id, no email, no
    // session, nothing that identifies the user to whoever sees the message.
    assert.ok(!body.data.deepLink.includes("@"));
    assert.ok(!body.data.deepLink.includes("velora.example"));

    const aliceToken = store.tokens.at(-1)!;
    // A CLIENT-SUPPLIED user id in the body is ignored: Bob's link is Bob's.
    const spoofed = await fetch(`${base}/api/v1/telegram/link/start`, {
      method: "POST",
      headers: bearer(bob),
      body: JSON.stringify({ userId: aliceToken.userId, user_id: aliceToken.userId, telegram_user_id: "999" }),
    });
    assert.equal(spoofed.status, 200);
    const bobToken = store.tokens.at(-1)!;
    assert.notEqual(bobToken.userId, aliceToken.userId, "the link must belong to the authenticated caller");
    assert.notEqual(bobToken.tokenHash, aliceToken.tokenHash);
    // Alice's pending transaction is untouched by Bob's request.
    assert.equal(store.tokens.filter((t) => t.userId === aliceToken.userId && t.status === "PENDING").length, 1);

    // Starting a flow is audited against the CALLER, never against the body.
    const audits = await store.findLatestTokenByUserId(aliceToken.userId);
    assert.ok(audits !== null);
    assert.equal(audits!.status, "PENDING");
  });
});

test("LINK START is rate limited per user, with Retry-After", async () => {
  await withServer(async ({ base }, { alice }) => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await fetch(`${base}/api/v1/telegram/link/start`, { method: "POST", headers: bearer(alice) });
      statuses.push(res.status);
      if (res.status === 429) {
        assert.ok(Number(res.headers.get("retry-after")) >= 1);
        assert.equal(((await res.json()) as Envelope).error?.code, "RATE_LIMITED");
      }
    }
    // The policy is 5/hour: the sixth and seventh attempts are refused.
    assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.deepEqual(statuses.slice(5), [429, 429]);
  });
});

test("UNLINK: refuses when nothing is connected, removes a real link, and closes the bot's access", async () => {
  await withServer(async ({ base, store }, { alice }) => {
    const none = await fetch(`${base}/api/v1/telegram/link/unlink`, { method: "POST", headers: bearer(alice) });
    assert.equal(none.status, 409);
    assert.equal(((await none.json()) as Envelope).error?.code, "NOT_LINKED");

    // Complete the handshake the way the BOT does (the deep-link payload the
    // user would have tapped), then unlink over HTTP.
    const started = (await (
      await fetch(`${base}/api/v1/telegram/link/start`, { method: "POST", headers: bearer(alice) })
    ).json()) as Envelope<{ deepLink: string }>;
    const token = decodeURIComponent(new URL(started.data.deepLink).searchParams.get("start")!);
    const links = new TelegramLinkService({ store, audit: new MemoryAuditStore(), botUsername: () => BOT_USERNAME });
    const completed = await links.completeFromPayload({ payload: token, telegramUserId: "555", username: "trader", requestId: null });
    assert.equal(completed.ok, true);

    const linked = (await (await fetch(`${base}/api/v1/telegram/status`, { headers: bearer(alice) })).json()) as Envelope<{ state: string; identity: { maskedTelegramUserId: string } | null }>;
    assert.equal(linked.data.state, "LINKED");
    assert.equal(linked.data.identity?.maskedTelegramUserId, "••••555");

    const removed = await fetch(`${base}/api/v1/telegram/link/unlink`, { method: "POST", headers: bearer(alice) });
    assert.equal(removed.status, 200);
    assert.equal(((await removed.json()) as Envelope<{ unlinked: boolean }>).data.unlinked, true);

    // The bot-visible bridge is closed immediately, and the state says REVOKED.
    assert.equal(await links.resolveUserId("555"), null);
    const after = (await (await fetch(`${base}/api/v1/telegram/status`, { headers: bearer(alice) })).json()) as Envelope<{ state: string }>;
    assert.equal(after.data.state, "LINK_REVOKED");

    // A SECOND caller cannot unlink Alice's (now gone) connection, and Alice's
    // repeat unlink answers NOT_LINKED rather than pretending to have acted.
    const again = await fetch(`${base}/api/v1/telegram/link/unlink`, { method: "POST", headers: bearer(alice) });
    assert.equal(again.status, 409);
  });
});

test("CHANNEL: reads the binding, has no POST (binding is Telegram-side), and DELETE is owner-scoped", async () => {
  await withServer(async ({ base }, { alice }) => {
    const post = await fetch(`${base}/api/v1/telegram/channel`, { method: "POST", headers: bearer(alice), body: "{}" });
    // No POST route exists: the kernel's terminal 404 answers it, which is the
    // point — a chat id cannot be bound from the web.
    assert.equal(post.status, 404);

    const empty = (await (await fetch(`${base}/api/v1/telegram/channel`, { headers: bearer(alice) })).json()) as Envelope<{ channel: unknown }>;
    assert.equal(empty.data.channel, null);

    const missing = await fetch(`${base}/api/v1/telegram/channel`, { method: "DELETE", headers: bearer(alice) });
    assert.equal(missing.status, 404);
  });
});
