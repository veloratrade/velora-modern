/**
 * One invocation's runtime: which durable store answers, what work is deferred to `waitUntil`,
 * and how the private-test surface on D1 handles an update. The entry module stays thin because
 * workerd rejects any named export besides the handler.
 */
import {
  fail,
  ok,
  telegramUpdateSchema,
  TELEGRAM_WEBHOOK_PATH,
  type TelegramUpdate,
} from "@velora/contracts";

import { PgAuditStore } from "../../api/src/auth/pgAuditStore.js";
import { PgAiCoachStore } from "../../api/src/aicoach/aiCoachRoutes.js";
import { GeminiAiProvider } from "../../api/src/aicoach/geminiProvider.js";
import { AI_PROVIDERS, PgAiAttemptStore, UnconfiguredAiProvider } from "../../api/src/aicoach/aiProvider.js";
import { AiCoachService } from "../../api/src/aicoach/aiCoachService.js";
import { UnconfiguredMediaInterpreter } from "../../api/src/aicoach/mediaInterpreter.js";
import { poolQuery } from "../../api/src/persistence/pg.js";
import { PgRateLimitStore } from "../../api/src/ratelimits/pgRateLimitStore.js";
import { FixedWindowRateLimiter } from "../../api/src/ratelimits/rateLimiter.js";
import { HttpTelegramBotApi } from "../../api/src/telegram/telegramApi.js";
import { TelegramBot } from "../../api/src/telegram/telegramBot.js";
import { resolveTelegramConfig, webhookSecretMatches } from "../../api/src/telegram/telegramConfig.js";
import { PgTelegramStore } from "../../api/src/telegram/pgTelegramStore.js";
import { TelegramLinkService } from "../../api/src/telegram/telegramLinkService.js";
import { TELEGRAM_WEBHOOK_MAX_BODY_BYTES } from "../../api/src/telegram/telegramRoutes.js";
import { TelegramUpdatePipeline } from "../../api/src/telegram/telegramUpdatePipeline.js";
import { JournalAnalysisService } from "../../api/src/journal/journalAnalysisService.js";
import { JournalApplicationService } from "../../api/src/journal/journalApplicationService.js";
import { PgTradeStore } from "../../api/src/trades/pgTradeStore.js";
import { TradeService } from "../../api/src/trades/tradeService.js";
import { poolFor, POOL_MAX, type PoolLike } from "./pgHyperdrive.js";
import { beginProbe, withApiProbe } from "./latencyProbe.js";
import { D1TestStore, excerptOf, zeroCounts, type ClaimResult, type D1Like } from "./d1TestStore.js";
import { planCommand, replyFor } from "./testCommands.js";

/**
 * The Bot API client on workerd must be handed a BOUND fetch.
 *
 * `HttpTelegramBotApi`'s default transport is `fetch as unknown as FetchLike` — a detached
 * reference. Node tolerates that (which is why the tsx harness, which imports this module
 * directly, has always worked), but workerd throws `TypeError: Illegal invocation` for a
 * detached global, and the client maps every throw to `TelegramApiError("NETWORK")`. The
 * measured symptom on the deployed Worker was exactly that: a `NETWORK` code for every
 * outbound call, to api.telegram.org, to example.com and to its own origin alike — three
 * different targets, one code, which is what ruled out a network filter and pointed here.
 * Binding the call in one place fixes both runtimes without touching the shared client.
 */
const botFetch = (url: string, init?: RequestInit): Promise<Response> => globalThis.fetch(url, init as never);


export interface Env {
  /** Hyperdrive binding. Absent => no durable store => the capability is absent. */
  HYPERDRIVE?: Hyperdrive;
  /**
   * D1 binding for PRIVATE TEST MODE only (`velora-telegram-test`). It exists to record a
   * test message, decide redelivery and read the message back — see `storageMode` below and
   * `d1TestStore.ts` for what it deliberately cannot do.
   */
  VELORA_TEST_DB?: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_UPDATE_MODE?: string;
  VELORA_APP_URL?: string;
  APP_ORIGIN?: string;
  APP_ENV?: string;
  GEMINI_API_KEY?: string;
  /** Overrides the Bot API origin for staging/local verification. Unset in production. */
  TELEGRAM_API_BASE?: string;
  /**
   * "1" logs one measured line per invocation (statements, total ms, first-statement ms) through
   * `HyperdrivePool`. Diagnostic only: no behaviour changes when it is absent. Remove once the
   * latency question it was added for is settled.
   */
  LATENCY_PROBE?: string;
  /** Bearer token for the read-only diagnostics route. */
  WORKER_ADMIN_TOKEN?: string;
  /**
   * PRIVATE TEST MODE. The numeric Telegram user id allowed to use this bot, as a
   * SECRET (`wrangler secret put TELEGRAM_TEST_USER_ID`), not a `vars` entry: the
   * account id is personal data, and `vars` are readable in the dashboard.
   * Unset or malformed ⇒ every update is refused. There is deliberately no way to
   * turn the gate off from here; this host is a private test bot by construction.
   */
  TELEGRAM_TEST_USER_ID?: string;
}

const CONFIG_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_USERNAME",
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_UPDATE_MODE",
  "VELORA_APP_URL",
  "APP_ORIGIN",
  "APP_ENV",
] as const;

export const asEnvRecord = (env: Env): Record<string, string | undefined> => {
  const out: Record<string, string | undefined> = {};
  for (const key of CONFIG_KEYS) out[key] = env[key];
  return out;
};

export type StorageMode = "postgres" | "d1-test" | "none";

export const storageMode = (env: Pick<Env, "HYPERDRIVE" | "VELORA_TEST_DB">): StorageMode => {
  const pg = typeof env.HYPERDRIVE?.connectionString === "string" && env.HYPERDRIVE.connectionString !== "";
  if (pg) return "postgres";
  return env.VELORA_TEST_DB === undefined || env.VELORA_TEST_DB === null ? "none" : "d1-test";
};

export const D1_DISABLED_FEATURES = ["journal", "trades", "linking", "ai", "audit"] as const;

export interface BotRuntime {
  readonly pipeline: TelegramUpdatePipeline | null;
  readonly journal: JournalApplicationService | null;
  readonly findings: readonly { code: string; message: string }[];
  readonly configured: boolean;
  readonly reason: "ok" | "UNCONFIGURED" | "NO_DATABASE_BINDING" | "D1_SCHEMA_MISSING";
  readonly pool: PoolLike | null;
  /** Which durable store answered, so a caller can tell "no database" from "test database". */
  readonly storage: StorageMode;
  /** The D1 test surface, and only for `storage === "d1-test"`: store plus the Bot API client. */
  readonly test: { store: D1TestStore; api: HttpTelegramBotApi } | null;
  /** Deferred work owned by THIS invocation only — see `createDeferredWork`. */
  readonly deferred: DeferredWork;
  /** Periodic rate-limit storage cleanup. Postgres branch only; the Cron Trigger calls it. */
  readonly rateSweep?: () => Promise<number>;
}

export interface DeferredWork {
  /** Hand one task to the runtime. Safe to call after a response is built. */
  defer(task: () => Promise<void>): void;
  /** How many tasks this invocation has deferred. */
  readonly handedOff: number;
  /** How many are still running. Non-zero at response time is normal on Workers. */
  readonly outstanding: number;
  /** Resolve when everything deferred so far has finished (tests / local harness). */
  settle(): Promise<void>;
}

export const createDeferredWork = (
  ctx?: Pick<ExecutionContext, "waitUntil">,
  onError?: (err: unknown) => void,
): DeferredWork => {
  let chain: Promise<void> = Promise.resolve();
  let handedOff = 0;
  let finished = 0;
  const fail = onError ?? ((err: unknown): void => {
    // Codes only: a Telegram message body must never reach a log line.
    console.log(JSON.stringify({
      level: "error",
      event: "telegram.deferred_processing_failed",
      code: err instanceof Error ? err.name : "UNKNOWN",
    }));
  });
  return {
    defer(task: () => Promise<void>): void {
      handedOff += 1;
      chain = chain.then(async () => {
        try {
          await task();
        } catch (err) {
          fail(err);
        } finally {
          finished += 1;
        }
      });
      if (ctx !== undefined) ctx.waitUntil(chain);
    },
    get handedOff(): number {
      return handedOff;
    },
    get outstanding(): number {
      return handedOff - finished;
    },
    settle: () => chain,
  };
};

/**
 * One `telegram_identities` read per invocation, not four.
 *
 * WHY. A trace of one `/checklist` message over the live path counted 12 statements and FOUR of them were
 * the same `SELECT * FROM telegram_identities WHERE telegram_user_id = $1` for the same sender, within
 * milliseconds of each other: the dispatcher resolves the sender, the link service resolves it again to
 * authorise, the locale read resolves it a third time, and the `last_seen_at` touch resolves it a fourth.
 * At ~310 ms a round trip that is 1.24 s of the window, 0.93 s of it for rows already in hand. Measured,
 * recorded in 10-NEON-LIVE-PROVISIONING-RESULT.md §22-§23.
 *
 * WHY IT CANNOT GO STALE. The memo lives in this invocation's closure (`composeRuntime` runs per
 * request, so nothing is shared with the next message), and every statement that writes that table is a
 * method on the same object — `insertLiveIdentity`, `revokeIdentity`, `touchIdentity` — so each of them
 * clears the memo when it finishes. That includes `touchIdentity`, and not for tidiness: the debounce in
 * `telegramBot.ts` decides whether to write by reading `lastSeenAt` off the record this memo returns, so
 * a memo that survived a touch would be reading its own stale answer.
 *
 * A write that clears on completion (including one that throws) is deliberately coarser than needed: the
 * cost of clearing too often is one extra SELECT, and the cost of clearing too rarely is serving a
 * revoked identity as linked.
 */
const IDENTITY_WRITES = new Set(["insertLiveIdentity", "revokeIdentity", "touchIdentity"]);

export const withLiveIdentityMemo = (inner: PgTelegramStore): PgTelegramStore => {
  type LiveIdentity = Awaited<ReturnType<PgTelegramStore["findLiveIdentityByTelegramUserId"]>>;
  const memo = new Map<string, { readonly identity: LiveIdentity }>();
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "findLiveIdentityByTelegramUserId") {
        return async (telegramUserId: string): Promise<LiveIdentity> => {
          const hit = memo.get(telegramUserId);
          if (hit !== undefined) return hit.identity;
          const identity = await target.findLiveIdentityByTelegramUserId(telegramUserId);
          memo.set(telegramUserId, { identity });
          return identity;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property === "string" && IDENTITY_WRITES.has(property) && typeof value === "function") {
        const write = value as (...args: unknown[]) => unknown;
        return async (...args: unknown[]) => {
          try {
            return await write.apply(target, args);
          } finally {
            memo.clear();
          }
        };
      }
      return value;
    },
  });
};

export function composeRuntime(env: Env, ctx?: Pick<ExecutionContext, "waitUntil">): BotRuntime {
  const resolution = resolveTelegramConfig(asEnvRecord(env));
  const deferred = createDeferredWork(ctx);
  const findings = resolution.findings.map((f) => ({ code: f.code, message: f.message }));
  const absent = (reason: BotRuntime["reason"]): BotRuntime => ({
    pipeline: null,
    journal: null,
    findings,
    configured: false,
    reason,
    pool: null,
    storage: "none",
    test: null,
    deferred,
  });
  if (!resolution.configured || resolution.botToken === null) return absent("UNCONFIGURED");

  const mode = storageMode(env);
  if (mode === "d1-test") {
    // The private-test surface: one store, the Bot API client, and no services at all. Not
    // building TelegramBot/JournalApplicationService/TradeService is the enforcement of the
    // owner's rule, not a convention in the handler — there is no object here that could write
    // a trade, and no table in D1 for it to write into.
    const api = new HttpTelegramBotApi(resolution.botToken, botFetch as never, undefined, env.TELEGRAM_API_BASE);
    return {
      pipeline: null,
      journal: null,
      findings: [
        ...findings,
        {
          code: "STORAGE_D1_TEST",
          message: "D1 private-test storage: message record/retrieval and dedupe only. "
            + "Journal, trades, linking and AI are disabled until a PostgreSQL (Hyperdrive) binding is attached.",
        },
      ],
      configured: true,
      reason: "ok",
      pool: null,
      storage: "d1-test",
      test: { store: new D1TestStore(env.VELORA_TEST_DB as unknown as D1Like), api },
      deferred,
    };
  }

  const connection = env.HYPERDRIVE?.connectionString;
  if (connection === undefined || connection === "") {
    // Absence is a capability state, never a silent fallback. Every reused store
    // here is Postgres-backed; an in-memory substitute would silently lose a
    // CONFIRMED journal entry between isolates, which is worse than refusing.
    return absent("NO_DATABASE_BINDING");
  }

  // Per invocation, and closed by `ctx.waitUntil` once this invocation's deferred
  // work has settled (below) — never left open for the next request to trip over.
  const durablePool = poolFor(
    connection,
    { HYPERDRIVE: env.HYPERDRIVE },
    POOL_MAX,
    (promise) => {
      if (ctx !== undefined) ctx.waitUntil(promise);
      else void promise;
    },
    env.LATENCY_PROBE === "1",
  );
  const q = poolQuery(durablePool as never);

  const store = withLiveIdentityMemo(new PgTelegramStore(durablePool as never));
  // The probe is decided once, here, and wraps only the outbound Bot API client - the half the database
  // stopwatch could not see (the Postgres branch only: the D1 test branch has no pool to log from).
  beginProbe(env.LATENCY_PROBE === "1");
  const api = withApiProbe(
    new HttpTelegramBotApi(resolution.botToken, botFetch as never, undefined, env.TELEGRAM_API_BASE),
  );
  const links = new TelegramLinkService({
    store,
    audit: new PgAuditStore(durablePool as never),
    botUsername: () => resolveTelegramConfig(asEnvRecord(env)).botUsername,
  });
  /*
   * One profile read per invocation, not three.
   *
   * `getUserLocale`, the journal's `getUserTimezone` and the trades service's `getUserTimezone` all read
   * the SAME row of the SAME user, within the same invocation, and nothing on the bot's paths writes
   * locale or timezone (checked: no `UPDATE users SET` in the telegram/journal code), so the second and
   * third reads were pure latency. A trace of one `/checklist` message counted 16 round trips, 3 of them
   * this query; see 10-NEON-LIVE-PROVISIONING-RESULT.md §17-§18. The memo is per invocation because
   * `composeRuntime` is per invocation — it never leaks a stale profile into the next message.
   */
  const profileCache = new Map<string, { locale: "fa" | "en"; timezone: string } | null>();
  const profileQuery = async (userId: string): Promise<{ locale: "fa" | "en"; timezone: string } | null> => {
    const cached = profileCache.get(userId);
    if (cached !== undefined) return cached;
    const rows = await q("SELECT locale, timezone FROM users WHERE id = $1 LIMIT 1", [userId]);
    const row = rows[0];
    const profile = row === undefined
      ? null
      : { locale: row["locale"] === "en" ? ("en" as const) : ("fa" as const), timezone: String(row["timezone"] ?? "UTC") };
    profileCache.set(userId, profile);
    return profile;
  };
  // The 48 h hygiene sweep used to ride on EVERY `hit()` — one DELETE per message for a job that is
  // periodic by definition. It now belongs to the Cron Trigger, which `scheduled()` already runs.
  const rateStore = new PgRateLimitStore(durablePool as never);
  const attempts = new PgAiAttemptStore(q);
  const geminiKey = (env.GEMINI_API_KEY ?? "").trim();
  const coach = new AiCoachService({
    provider: geminiKey === "" ? new UnconfiguredAiProvider() : new GeminiAiProvider({ apiKey: geminiKey }),
    consent: new PgAiCoachStore(q),
    attempts,
    allowedProviders: AI_PROVIDERS,
  });
  const journal = new JournalApplicationService({
    trades: new TradeService({
      store: new PgTradeStore(durablePool as never),
      getUserTimezone: async (userId) => (await profileQuery(userId))?.timezone ?? "UTC",
      verifyAccountOwnership: async (accountId, userId) =>
        (await q("SELECT 1 FROM trading_accounts WHERE id = $1 AND user_id = $2 LIMIT 1", [accountId, userId])).length > 0,
    }),
    drafts: store,
    getUserTimezone: async (userId) => (await profileQuery(userId))?.timezone ?? "UTC",
  });
  const bot = new TelegramBot({
    api,
    store,
    links,
    journal,
    analysis: new JournalAnalysisService({ coach, journal }),
    media: { interpreter: new UnconfiguredMediaInterpreter(), attempts },
    limiter: new FixedWindowRateLimiter(rateStore),
    appUrl: () => resolveTelegramConfig(asEnvRecord(env)).appUrl,
    getUserLocale: async (userId) => (await profileQuery(userId))?.locale ?? null,
    log: (event) => console.log(JSON.stringify(event)),
  });
  const pipeline = new TelegramUpdatePipeline({
    bot,
    mode: () => resolveTelegramConfig(asEnvRecord(env)).updateMode,
    log: (event) => console.log(JSON.stringify(event)),
    // Workers have no event-loop tail: deferred work must be handed to the runtime,
    // or it is cancelled the moment the response is returned.
    defer: (task: () => Promise<void>) => {
      deferred.defer(task);
    },
  });
  // NOTE on lifetime: this invocation's connections are released by the HANDLER,
  // once its deferred work has settled. Closing here would settle an empty chain and
  // drop the driver before the first query — which is exactly how the Node harness
  // caught that mistake (`CONNECTION_ENDED` on the very first delivery).
  return {
    pipeline,
    journal,
    findings,
    configured: true,
    reason: "ok",
    pool: durablePool,
    rateSweep: () => rateStore.sweepExpired(Date.now()),
    storage: "postgres",
    test: null,
    deferred,
  };
}

export const releasePool = (rt: BotRuntime): Promise<void> =>
  rt.pool === null ? Promise.resolve() : rt.pool.end().then(() => undefined).catch(() => undefined);

export async function handleTestUpdate(
  test: { store: D1TestStore; api: HttpTelegramBotApi },
  update: TelegramUpdate,
  requestId: string,
  log: (event: Record<string, unknown>) => void,
): Promise<Response> {
  const sender = update.message?.from?.id ?? update.callback_query?.from?.id ?? update.edited_message?.from?.id ?? null;
  if (sender === null) return json(200, ok({ dropped: true, private: true, reason: "SENDER_UNVERIFIED" }));
  const kind: "message" | "callback_query" | "edited_message" =
    update.callback_query !== undefined ? "callback_query" : update.edited_message !== undefined ? "edited_message" : "message";
  const chatId = update.message?.chat?.id ?? update.edited_message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? null;
  // `callback_query.data` is untrusted by contract and is not message text: the record keeps
  // the shape of the delivery, never its payload.
  const raw = kind === "callback_query"
    ? null
    : (update.message?.text ?? update.message?.caption ?? update.edited_message?.text ?? update.edited_message?.caption ?? null);

  // Decided before any reply text exists, and after the gate: the claim is what makes a redelivery
  // cheap and a storage failure loud. Two rules are load-bearing here —
  //   • a `claim()` that *throws* must not become a 200. Swallowing it would tell Telegram the
  //     update was processed, stop the redelivery, and leave no row proving it ever arrived;
  //   • a claim that was refused is a duplicate, and the reply for it is the same 200 the product
  //     pipeline gives, so Telegram stops retrying something already finished.
  const plan = planCommand({ kind, text: raw });
  let claim: ClaimResult;
  try {
    claim = await test.store.claim({
      updateId: update.update_id,
      senderId: sender,
      chatId,
      kind,
      textExcerpt: excerptOf(raw),
    });
  } catch (error) {
    log({
      level: "error",
      event: "telegram.test_update_claim_failed",
      kind,
      requestId,
      code: errorCodeOf(error),
    });
    // The status *is* the retry signal — `fail`'s envelope details are `string | number` by the
    // shared contract, and inventing a boolean there would be a contract edit for a test route.
    // 503 says "not acknowledged, redeliver", and `CLAIM_SQL` then re-claims the (absent) row.
    return json(503, fail(
      "D1_UNAVAILABLE",
      "The private-test store could not record this update, so it is deliberately not acknowledged.",
      requestId,
      { code: errorCodeOf(error), command: plan.command },
    ));
  }
  if (!claim.claimed) {
    log({ level: "info", event: "telegram.test_update_duplicate", kind, requestId });
    return json(200, ok({ accepted: false, duplicate: true, storage: "d1-test" }));
  }

  let reply: string;
  try {
    // Only `/stats` pays for a read; the other replies state what they know, never a number that
    // was not fetched, which is why the default here is the zeroed shape rather than a guess.
    const counts = plan.needsCounts ? await test.store.counts() : zeroCounts();
    reply = replyFor({ plan, counts, updateId: update.update_id, kind, storage: "d1-test" });
    if (chatId !== null) {
      if (kind === "callback_query") {
        await test.api.answerCallbackQuery(String(update.callback_query?.id ?? "")).catch(() => undefined);
      }
      // `HttpTelegramBotApi.sendMessage` takes the chat id as a string (Telegram's own
      // form-encoding rule); the number is what the schema attested.
      await test.api.sendMessage(String(chatId), reply);
    }
    await test.store.mark(update.update_id, "handled");
    log({
      level: "info",
      event: "telegram.test_update_handled",
      kind,
      command: plan.command,
      outcome: "handled",
      attempt: claim.attempt,
      requestId,
    });
    return json(200, ok({ accepted: true, storage: "d1-test", command: plan.command, attempt: claim.attempt }));
  } catch (error) {
    // The code is the useful part and it is provider-defined (`NETWORK`, `TIMEOUT`,
    // `MALFORMED_RESPONSE`, `RATE_LIMITED`…); the message is never logged because a Telegram
    // client error can carry the request URL, and the URL carries the bot token.
    const code = errorCodeOf(error);
    await test.store.mark(update.update_id, "failed", code).catch(() => false);
    log({
      level: "error",
      event: "telegram.test_update_failed",
      kind,
      command: plan.command,
      requestId,
      error: (error as Error)?.name ?? "Error",
      code,
      attempt: claim.attempt,
    });
    // 502, not 200: this is the half of the retry story that has to be true. Telegram redelivers a
    // 5xx, and `CLAIM_SQL` now re-claims a `failed` row, so the redelivery is real work (attempt+1)
    // instead of a `duplicate` that buries it.
    return json(502, fail(
      "D1_TEST_HANDLING_FAILED",
      "The private-test update could not be recorded and answered. Not acknowledged: a redelivery "
        + "will re-claim the row and the attempt counter will rise.",
      requestId,
      { code, command: plan.command, attempt: claim.attempt },
    ));
  }
}

/**
 * The stable part of a thrown error. `TelegramApiError.message` is fixed prose and the detail lives
 * in `code`/`status`, so the code is what gets stored; anything unrecognisable collapses to
 * `"unknown"` rather than to a string that might carry a URL.
 */
const errorCodeOf = (error: unknown): string => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && code !== "" ? code.slice(0, 40) : "unknown";
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/**
 * The admin bearer, checked the way the webhook secret is: equal length first, then
 * `timingSafeEqual`, and a token shorter than 16 characters counts as absent rather than
 * as usable. It is what guards `/api/v1/telegram/diagnostics` — the only authenticated route
 * left on this Worker since the egress probe was retired (see
 * `velora-telegram-bot-deploy/retired/egress-probe/`), and the guard is a constant-time bearer
 * compare rather than a `===` so a timing probe cannot narrow a token by its prefix.
 */
export const adminAuthorized = (env: Env, request: Request): boolean => {
  const expected = env.WORKER_ADMIN_TOKEN;
  if (expected === undefined || expected.length < 16) return false;
  return webhookSecretMatches(`Bearer ${expected}`, request.headers.get("authorization"));
};
