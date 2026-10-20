// Telegram update processor factory — the EXECUTION half of MG-TG-3.
//
// WHY THIS FILE EXISTS. MG-TG-3 asks for
//   Telegram update → API/webhook boundary → pg-boss → Worker → journal processing
// The queue halves live in `telegramUpdateQueue.ts` (API producer) and
// `apps/worker/src/handlers/telegramUpdateHandler.ts` (worker consumer). What
// the worker needs in order to actually PROCESS an update is a `TelegramBot`,
// and a bot is not a free-standing object: it is the journal application
// service, the AI coaching pipeline, the link service and the notification
// side effects, all composed over one PostgreSQL pool.
//
// THIS IS NOT A SECOND TELEGRAM ARCHITECTURE. There is exactly one
// `TelegramBot`, one `TelegramLinkService`, one `JournalApplicationService` and
// one ADR-002 trade ledger — the same classes `server-main.ts` composes for the
// API process. This file is a second COMPOSITION ROOT, which is unavoidable:
// the worker is a separate process and cannot reach into the API's object
// graph. Every behavioural rule stays where it was; nothing is re-implemented.
//
// CREDENTIAL NOTE (deployment-gated). A worker that runs this composition needs
// `TELEGRAM_BOT_TOKEN` (and, for voice/vision and journal analysis, explicitly
// approved environment-only AI provider settings; for transactional mail,
// `RESEND_API_KEY` + `APP_ORIGIN`). Provisioning these to a second process amends
// the worker's D-2 boundary and remains an OWNER DECISION. This factory never
// reads `CREDENTIAL_MASTER_KEY` or decrypts `ai_platform_secrets`; admin-managed
// AI secrets remain API-only. Until the token is provisioned, this returns null
// and the worker registers no handler. Nothing here is invented to make that
// decision go away.
//
// KNOWN DELIBERATE DIFFERENCE, STATED NOT HIDDEN: `attachments` is not composed
// here (the API composes one from its object-storage capability). `TelegramBot`
// documents the consequence — with no attachment service a journal screenshot is
// recorded as metadata only and the entry still saves. Wiring attachments is a
// deployment step, not a behaviour change.
import type { Pool } from "pg";
import type { TelegramUpdate } from "@velora/contracts";
import { poolQuery } from "../persistence/pg.js";
import { PgTelegramStore } from "./pgTelegramStore.js";
import { HttpTelegramBotApi } from "./telegramApi.js";
import { TelegramLinkService } from "./telegramLinkService.js";
import { TelegramBot } from "./telegramBot.js";
import { TelegramPostService } from "./telegramPostService.js";
import { bannerRasterizer } from "./bannerRaster.js";
import { BANNER_WIDTH } from "@velora/domain";
import { createPostDataPort } from "./telegramPostPort.js";
import { resolveTelegramConfig } from "./telegramConfig.js";
import { PgAuditStore } from "../auth/pgAuditStore.js";
import { PgUserStore } from "../auth/pgUserStore.js";
import { PgTradeStore } from "../trades/pgTradeStore.js";
import { TradeService } from "../trades/tradeService.js";
import { JournalApplicationService } from "../journal/journalApplicationService.js";
import { JournalAnalysisService } from "../journal/journalAnalysisService.js";
import { AiCoachService } from "../aicoach/aiCoachService.js";
import { AI_PROVIDERS, PgAiAttemptStore, UnconfiguredAiProvider } from "../aicoach/aiProvider.js";
import { PgAiCoachStore } from "../aicoach/aiCoachRoutes.js";
import { GeminiAiProvider } from "../aicoach/geminiProvider.js";
import type { MediaInterpreter } from "../aicoach/mediaInterpreter.js";
import { PgAiConfigStore } from "../ai/aiConfigStore.js";
import { AiFeatureGuard } from "../ai/aiFeatureGuard.js";
import { AiFeatureRouter } from "../ai/aiFeatureRouter.js";
import { AiManager } from "../ai/aiManager.js";
import { AiSearchService } from "../ai/aiSearchService.js";
import { AiBrowserService } from "../ai/aiBrowserService.js";
import { AiAgentPlanner } from "../ai/aiAgentPlanner.js";
import nodeCrypto from "node:crypto";
import { AiManagerMediaInterpreter } from "../ai/aiManagerMediaInterpreter.js";
import { AiRouteResolver } from "../ai/aiRouteResolver.js";
import { EnvironmentAiSecretResolver } from "../ai/envAiSecretResolver.js";
import { GeminiExecutor, TesseractExecutor } from "../ai/aiExecutors.js";
import { TesseractProvider } from "../ai/tesseractProvider.js";
import { UnavailableImageAnonymizer } from "../ai/imageAnonymizer.js";
import { FixedWindowRateLimiter } from "../ratelimits/rateLimiter.js";
import { PgRateLimitStore } from "../ratelimits/pgRateLimitStore.js";
import { LogMailProvider } from "../mail/logMailProvider.js";
import { ResendMailProvider } from "../mail/resendMailProvider.js";
import { NotificationService } from "../notifications/notificationService.js";
import { FirstTradeNotifier } from "../notifications/firstTradeNotifier.js";
import { PgAchievementStore, PgEmailNotificationLog } from "../notifications/pgNotificationStores.js";

/**
 * The worker's view of "what processing an update produced".
 *
 * Deliberately a STRUCTURAL type: the worker defines its own identical
 * signature, so neither package has to import the other's types. The values are
 * `TelegramBot`'s own `UpdateOutcome` vocabulary, reported verbatim.
 */
export type TelegramUpdateOutcome = "handled" | "ignored" | "rejected" | "failed";

/** The seam the worker's job handler calls. One update in, one outcome out. */
export type TelegramUpdateProcessor = (update: TelegramUpdate) => Promise<TelegramUpdateOutcome>;

export interface TelegramProcessorFactoryDeps {
  readonly pool: Pool;
  /** Injectable so tests can compose without touching `process.env`. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly log?: ((event: Record<string, unknown>) => void) | undefined;
}

/**
 * Compose the one `TelegramBot` for a non-HTTP process.
 *
 * Returns `null` when Telegram is not configured on this installation, so the
 * caller registers no handler rather than registering one that can only fail.
 */
export function createTelegramUpdateProcessor(deps: TelegramProcessorFactoryDeps): TelegramUpdateProcessor | null {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((event: Record<string, unknown>) => console.log(JSON.stringify(event)));
  const pool = deps.pool;
  const q = poolQuery(pool);

  const resolution = resolveTelegramConfig(env);
  if (!resolution.configured || resolution.botToken === null) return null;

  const telegramStore = new PgTelegramStore(pool);
  const telegramApi = new HttpTelegramBotApi(resolution.botToken);
  // ONE audit store for the whole Telegram surface: the link handshake and the channel publish write to
  // the same trail the credentials do, so an operator reading `audit_log` sees one chronology rather
  // than two that must be joined by hand.
  const telegramAudit = new PgAuditStore(pool);
  const links = new TelegramLinkService({
    store: telegramStore,
    audit: telegramAudit,
    botUsername: () => resolveTelegramConfig(env).botUsername,
  });

  const userStore = new PgUserStore(pool);

  // Profile reads are per call, exactly as in the API: a user who changes
  // timezone or language sees it on their next message, not after a restart.
  const profileQuery = async (userId: string): Promise<{ locale: "fa" | "en"; timezone: string } | null> => {
    const rows = await q("SELECT locale, timezone FROM users WHERE id = $1 LIMIT 1", [userId]);
    const row = rows[0];
    if (row === undefined) return null;
    const locale = row["locale"] === "fa" ? "fa" : "en";
    const timezone = row["timezone"];
    return { locale, timezone: typeof timezone === "string" && timezone !== "" ? timezone : "UTC" };
  };

  // ONE attempt ledger, identical to the API's: coaching, journal extraction,
  // transcription and vision all land in `ai_coaching_logs`.
  const attempts = new PgAiAttemptStore(q);
  const consent = new PgAiCoachStore(q);
  const geminiKey = (env["GEMINI_API_KEY"] ?? "").trim();
  const provider = geminiKey === "" ? undefined : new GeminiAiProvider({ apiKey: geminiKey });
  const coach = new AiCoachService({
    provider: provider ?? new UnconfiguredAiProvider(),
    consent,
    attempts,
    allowedProviders: AI_PROVIDERS,
  });

  // Voice and image media must use the same governed manager as the API path:
  // per-user consent/feature gate, atomic provider budget, fail-closed image
  // anonymization, local Tesseract fallback, and one attempt ledger. Resolving
  // secrets per call preserves admin/env precedence without exposing values.
  const aiConfig = new PgAiConfigStore(pool);
  const aiEnv = (key: string): string | undefined => env[key];
  // The worker is intentionally env-only: no CREDENTIAL_MASTER_KEY, no
  // credential-crypto import, and no read of the encrypted ai_platform_secrets
  // table. Provider secrets must be explicitly supplied within the owner-approved
  // D-2 boundary; routing, feature flags, quotas and attempts remain shared.
  const aiSecrets = new EnvironmentAiSecretResolver(aiEnv);
  const aiRoutes = new AiRouteResolver({ store: aiConfig, env: aiEnv });
  const tesseract = new TesseractProvider();
  const aiRouter = new AiFeatureRouter({
    store: aiConfig,
    secrets: aiSecrets,
    routes: aiRoutes,
    env: aiEnv,
    localOcrAvailable: () => tesseract.isAvailable(),
  });
  const mediaManager = new AiManager({
    router: aiRouter,
    guard: new AiFeatureGuard({ store: aiConfig }),
    store: aiConfig,
    consent,
    attempts,
    anonymizer: new UnavailableImageAnonymizer(),
    executors: {
      gemini: new GeminiExecutor({
        apiKey: async () => (await aiSecrets.resolve("GEMINI_API_KEY")).value,
        relayConfig: async () => ({
          url: (await aiSecrets.resolve("GEMINI_RELAY_URL")).value,
          token: (await aiSecrets.resolve("GEMINI_RELAY_TOKEN")).value,
        }),
      }),
      tesseract: new TesseractExecutor({ provider: tesseract }),
    },
  });
  const interpreter: MediaInterpreter = new AiManagerMediaInterpreter(mediaManager);

  // ── agent tools: the SAME secret resolver and the SAME AiManager as the model providers ──────────
  // Two deliberate choices. (1) `aiSecrets` is whatever this runtime already uses for AI credentials —
  // env-backed here, admin-store-backed in `server-main` — because the worker's AI boundary was fixed by
  // an owner decision (D-2) and a tool must not become a second, looser path to the same keys. (2) The
  // planner rides `mediaManager`, not a new client: one feature guard, one consent gate, one quota, one
  // ledger, one egress. Services that are unconfigured cost nothing and answer `unavailable` with the
  // secret that is missing; they are NOT hidden, because `/help` and the refusal text have to agree.
  const searchTools = new AiSearchService({
    secrets: aiSecrets,
    providerOverride: () => (env["AI_SEARCH_PROVIDER"] ?? "").trim() || null,
  });
  const browserTools = new AiBrowserService({
    secrets: aiSecrets,
    nodeCrypto: nodeCrypto,
  });
  const agentPlanner = new AiAgentPlanner({ manager: mediaManager });

  // MG-EMAIL-TYPES side effects. The FIRST-TRADE email and achievement must
  // fire on the worker path exactly as they do on the HTTP path — Legacy's one
  // TradeService served every ingestion surface, and moving Telegram onto the
  // queue must not silently drop that. Mail is offline (logged, never claimed
  // as delivered) unless RESEND_API_KEY is provisioned, which is the same
  // rule the API applies.
  const resendApiKey = (env["RESEND_API_KEY"] ?? "").trim();
  const mail = resendApiKey === "" ? new LogMailProvider() : new ResendMailProvider({ apiKey: resendApiKey });
  const notifications = new NotificationService({
    mail,
    log: new PgEmailNotificationLog(pool),
    appOrigin: (env["APP_ORIGIN"] ?? "").trim(),
    ...(() => {
      const support = (env["SUPPORT_NOTIFY_EMAIL"] ?? "").trim();
      return support === "" ? {} : { supportDeskEmail: support };
    })(),
  });
  notifications.preferences = async (userId, gate) => {
    const prefs = await userStore.getEmailPreferences(userId);
    switch (gate) {
      case "welcome":
        return prefs.welcomeEmail;
      case "security":
        return prefs.securityAlerts;
      case "trades":
        return prefs.tradeNotifications;
      case "achievements":
        return prefs.achievementNotifications;
    }
  };

  const journalTradeStore = new PgTradeStore(pool);
  const achievementLedger = new PgAchievementStore(pool);
  const firstTradeNotifier = new FirstTradeNotifier({
    notifications,
    achievements: achievementLedger,
    countActiveTrades: async (userId) => (await journalTradeStore.searchTrades({ userId }, 1, 1)).total,
    findUser: (userId) => userStore.findUserById(userId),
  });

  const journalTrades = new TradeService({
    store: journalTradeStore,
    getUserTimezone: async (userId) => (await profileQuery(userId))?.timezone ?? "UTC",
    verifyAccountOwnership: async (accountId, userId) =>
      (await q("SELECT 1 FROM trading_accounts WHERE id = $1 AND user_id = $2 LIMIT 1", [accountId, userId])).length > 0,
    onTradeCreated: (input) => firstTradeNotifier.onTradeCreated(input),
  });

  const journal = new JournalApplicationService({
    trades: journalTrades,
    drafts: telegramStore,
    getUserTimezone: async (userId) => (await profileQuery(userId))?.timezone ?? "UTC",
  });

  // ── prepared channel posts, templates and the agent's tools (0037/0038) ──
  // ONE service, shared by `/post`, `/template`, the inline buttons and the agent, built over the
  // journal service that already exists rather than a parallel data path: every number in a post is
  // the number `/stats` shows. `telegramApi` is null when a deployment has no bot token, and the
  // service then REFUSES to publish instead of faking a send — which is what makes wiring this
  // unconditionally safe in every environment, including the ones with no credentials.
  const posts = new TelegramPostService({
    store: telegramStore,
    data: createPostDataPort({ journal }),
    api: telegramApi,
    // A URL button may only ever point at the app's own host, read from config — never at a host a
    // template body or a user's message mentioned. No app URL configured means no link buttons.
    allowedLinkHosts: allowedLinkHosts(resolveTelegramConfig(env).appUrl),
    // Rasterization is a capability of THIS runtime, probed rather than assumed: the native image
    // module and a Persian-capable TTF both have to be present, and if either is missing the service
    // posts the text card and says so. `bannerRasterizer()` caches the probe, so this costs one
    // module load and one font read for the life of the process, not one per post.
    renderBannerPng: async (svg: string): Promise<Buffer | null> => {
      const raster = await bannerRasterizer();
      return raster === null ? null : await raster.toPng(svg, { width: BANNER_WIDTH });
    },
  });

  const bot = new TelegramBot({
    api: telegramApi,
    posts,
    store: telegramStore,
    links,
    journal,
    analysis: new JournalAnalysisService({ coach, journal }),
    media: { interpreter, attempts },
    tools: { search: searchTools, browser: browserTools, planner: agentPlanner },
    audit: telegramAudit,
    limiter: new FixedWindowRateLimiter(new PgRateLimitStore(pool)),
    appUrl: () => resolveTelegramConfig(env).appUrl,
    getUserLocale: async (userId) => (await profileQuery(userId))?.locale ?? null,
    log,
  });

  // `processClaimed`, not `handleUpdate`: the API has ALREADY claimed the
  // update (that claim is what makes its early 200 safe and what turns a
  // Telegram retry into a duplicate). The worker's job is to finish a claimed
  // update, never to claim it a second time.
  return (update: TelegramUpdate) => bot.processClaimed(update);
}

/**
 * The single host a template's `{{link}}` may point at, or none.
 *
 * Parsed here rather than stored as an env list: the app origin is already configuration, and a
 * second, independently-typed allowlist is a second thing to get wrong — a wildcard or a bare domain
 * in such a list is how a template becomes an open redirect. `URL` decides, and a malformed origin
 * yields an empty list, which disables link buttons rather than enabling arbitrary ones.
 */
function allowedLinkHosts(appUrl: string | null): readonly string[] {
  if (appUrl === null || appUrl.trim() === "") return [];
  try {
    const url = new URL(appUrl);
    if (url.protocol !== "https:") return [];
    return [url.host];
  } catch {
    return [];
  }
}

