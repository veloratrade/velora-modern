// API process entrypoint. BOOT IS FAIL-CLOSED (Phase B, S2/S8): kernel/boot.ts
// validates environment identity + origin binding (ADR-013) and the security
// configuration (S1/S2/S8) BEFORE anything starts. Any BLOCK finding — e.g.
// APP_ENV=production with PERSISTENCE=memory, a missing JWT_SECRET, or missing
// production configuration — logs the finding codes/messages (never values)
// and exits 1. Deterministic startup failure; never a silent fallback.
//
// Dev invocation (everything explicit — no implicit defaults):
//   APP_ENV=development APP_ORIGIN=http://127.0.0.1:8080 \
//   PERSISTENCE=memory JWT_SECRET=<32+ chars> \
//   npx tsx apps/api/src/server-main.ts
//
// Persistence posture (S8): when a durable store is configured, the DB probe
// connects lazily and reconnects on loss — the process stays up with RED
// readiness while the database is unavailable, and there is NO code path that
// could ever substitute memory persistence in staging/production (the boot
// gate rejects that configuration outright). PERSISTENCE=postgres boots the
// real-PostgreSQL adapters (Phase D D2): `pg` is a declared apps/api
// dependency and the four Pg* stores in this tree are the durable adapters.
import { readdirSync } from "node:fs";
import { createApp, listen } from "./kernel/server.js";
import { assertBootable, BootError } from "./kernel/boot.js";
import { AuthService } from "./auth/authService.js";
import { JwtService } from "./auth/jwt.js";
import { VeloraHasher } from "./auth/hashing.js";
import { MemoryUserStore } from "./auth/memoryUserStore.js";
import { PgUserStore } from "./auth/pgUserStore.js";
import { PgAuthEventStore } from "./auth/pgAuthEventStore.js";
import { MemoryAuthEventStore } from "./auth/memoryAuthEventStore.js";
import type { AuthEventStore } from "./auth/authEventStore.js";
import { AccountService } from "./accounts/accountService.js";
import { MemoryAccountStore } from "./accounts/memoryAccountStore.js";
import { PgAccountStore } from "./accounts/pgAccountStore.js";
import { TradeService } from "./trades/tradeService.js";
import { MemoryTradeStore } from "./trades/memoryTradeStore.js";
import { PgTradeStore } from "./trades/pgTradeStore.js";
import { emitCopySignal, tradeExitSignal, tradeOpenedSignal } from "./tenancy/copySignalEmitter.js";
import { DeveloperKeyAuth, PgDeveloperKeyLookup } from "./developer/developerAuth.js";
import { FixedWindowRateLimiter } from "./ratelimits/rateLimiter.js";
import { MemoryRateLimitStore } from "./ratelimits/memoryRateLimitStore.js";
import { PgRateLimitStore } from "./ratelimits/pgRateLimitStore.js";
import { EntitlementService } from "./entitlements/entitlementService.js";
import { AdminUserService } from "./auth/adminUserService.js";
import { OwnershipService } from "./auth/ownershipService.js";
import { MemoryOwnershipStore } from "./auth/memoryOwnershipStore.js";
import { PgOwnershipStore } from "./auth/pgOwnershipStore.js";
import { MemoryAuditStore } from "./auth/memoryAuditStore.js";
import { PgAuditStore } from "./auth/pgAuditStore.js";
import { resolveCredentialKey } from "./credentials/credentialConfig.js";
import { canAct } from "@velora/contracts";
import { resolveMetaApiConfig } from "./metaapi/metaApiConfig.js";
import { MetaApiProvisioningService } from "./metaapi/provisioningService.js";
import { PgProvisioningStore } from "./metaapi/pgProvisioningStore.js";
import { MemoryCredentialStore } from "./credentials/memoryCredentialStore.js";
import { PgCredentialStore } from "./credentials/pgCredentialStore.js";
import type { CredentialStore } from "./credentials/credentialStore.js";
import { CredentialService } from "./credentials/credentialService.js";
import { makeDbProbe } from "./kernel/dbProbe.js";
import type { MailPort } from "./mail/mailPort.js";
import { ResendMailProvider } from "./mail/resendMailProvider.js";
import { LogMailProvider } from "./mail/logMailProvider.js";
// AUD-03: the single transaction primitive used across the API adapters.
import { withTransaction, poolQuery } from "./persistence/pg.js";
// ---------------------------------------------------------------------------
// Backend migration (directive t) — capability composition.
//
// RESTRICTED TO PERSISTENCE=postgres, DELIBERATELY. Every migrated capability
// reads or writes tables the memory posture does not model; wiring them over
// memory stores would produce a server that LOOKS complete while its state
// evaporates on restart. Under the memory posture they are simply absent, and
// every migrated route answers its documented fail-closed 503 — which is the
// same contract the Phase C capabilities already use.
// ---------------------------------------------------------------------------
import { MetaApiWebhookService } from "./webhooks/metaApiWebhookService.js";
import { PgWebhookEventStore } from "./webhooks/pgWebhookStore.js";
import { PgBossSyncTrigger, DurableOnlySyncTrigger, type SyncTrigger } from "./webhooks/syncTrigger.js";
import type { WebhookAccountRef } from "./webhooks/metaApiWebhookService.js";
import { PgSyncStatusStore } from "./accounts/syncStatusService.js";
import { ManualSyncService, PgManualSyncStore } from "./accounts/manualSyncService.js";
import { makeSyncPendingMarker } from "./accounts/syncPending.js";
import { PgAnalyticsStore } from "./analytics/analyticsStore.js";
import { PgTagStore } from "./tags/tagService.js";
import { PgSupportStore, SupportService } from "./support/supportService.js";
import { AttachmentService, PgAttachmentStore, LocalAttachmentStorage } from "./attachments/attachmentService.js";
import { PgSubscriptionStore } from "./billing/subscriptionService.js";
import { PgAiCoachStore } from "./aicoach/aiCoachRoutes.js";
import { PgAdminStore } from "./admin/adminRoutes.js";
import { PgAdminConsoleStore } from "./admin/adminConsoleStore.js";
// Phase 7 — the AI capability: configuration substrate, routing, the n8n relay,
// the local OCR fallback, the chain walker and the two HTTP surfaces.
import { PgAiConfigStore } from "./ai/aiConfigStore.js";
import { AiSecretService } from "./ai/aiSecrets.js";
import { AiRouteResolver } from "./ai/aiRouteResolver.js";
import { AiFeatureRouter } from "./ai/aiFeatureRouter.js";
import { AiFeatureGuard } from "./ai/aiFeatureGuard.js";
import { UnavailableImageAnonymizer } from "./ai/imageAnonymizer.js";
import { GeminiExecutor, TesseractExecutor, type AiExecutor } from "./ai/aiExecutors.js";
import { AiManager } from "./ai/aiManager.js";
import { AiAnalysisService } from "./ai/aiAnalysisService.js";
import { PgAiLedger } from "./ai/aiLedger.js";
import { AiAdminService } from "./ai/aiAdminService.js";
import { TesseractProvider, findTesseractBinary } from "./ai/tesseractProvider.js";
import type { AiCatalogProvider } from "./ai/aiCatalog.js";
import { AdminConsoleService } from "./admin/adminConsoleService.js";
import { PgPortfolioStore } from "./portfolio/portfolioRoutes.js";
import { PgEaStore } from "./ea/eaRoutes.js";
import { PgTenancyStore } from "./tenancy/tenancyRoutes.js";
import { PgDeveloperStore } from "./developer/developerRoutes.js";
// Telegram journal client (ADR-018 / migration 0023). Composed here like every
// other migrated capability: one place where its dependencies are visible.
import { resolveTelegramConfig } from "./telegram/telegramConfig.js";
import { HttpTelegramBotApi } from "./telegram/telegramApi.js";
import { PgTelegramStore } from "./telegram/pgTelegramStore.js";
import { TelegramLinkService } from "./telegram/telegramLinkService.js";
import { TelegramBot } from "./telegram/telegramBot.js";
import { TelegramUpdatePipeline } from "./telegram/telegramUpdatePipeline.js";
import { TelegramPoller } from "./telegram/telegramPoller.js";
import { JournalApplicationService } from "./journal/journalApplicationService.js";
import { JournalAnalysisService } from "./journal/journalAnalysisService.js";
import { UnconfiguredMediaInterpreter, GeminiMediaInterpreter, type MediaInterpreter } from "./aicoach/mediaInterpreter.js";
import { GeminiAiProvider } from "./aicoach/geminiProvider.js";
import { AiCoachService } from "./aicoach/aiCoachService.js";
import { PgAiAttemptStore, UnconfiguredAiProvider, AI_PROVIDERS } from "./aicoach/aiProvider.js";


async function main(): Promise<void> {
  let boot;
  try {
    boot = assertBootable(process.env);
  } catch (err) {
    if (err instanceof BootError) {
      console.error(
        JSON.stringify({
          level: "error",
          service: "api",
          event: "boot_blocked",
          blocking: err.findings
            .filter((f) => f.severity === "BLOCK")
            .map((f) => f.code),
          findings: err.findings,
        }),
      );
      process.exit(1); // deterministic startup failure
    }
    throw err;
  }
  for (const w of boot.warnings) {
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "api",
        event: "boot_warning",
        code: w.code,
        message: w.message,
      }),
    );
  }

  const dbProbe = makeDbProbe(boot.persistence.databaseUrl);

  // Persistence wiring (Phase D D2, direct pg — no ORM, owner decision
  // 2026-09-13): PERSISTENCE=postgres boots the real-PostgreSQL adapters over
  // ONE shared pool; memory adapters remain the dev-only posture. The S8 boot
  // gate already rejects memory persistence outside development, so no code
  // path can substitute memory persistence in staging/production.
  let pool: import("pg").Pool | undefined;
  if (boot.persistence.kind === "postgres" && boot.persistence.databaseUrl !== undefined) {
    const { Pool } = (await import("pg")) as typeof import("pg");
    pool = new Pool({ connectionString: boot.persistence.databaseUrl });
    // Idle-client socket errors must never crash the process (S2/S8 posture:
    // stay up, readiness red, reconnect on the next probe).
    pool.on("error", (err: Error) => {
      console.error(
        JSON.stringify({ level: "error", service: "api", event: "pg_pool_error", message: err.message }),
      );
    });
  }
  const userStore = pool !== undefined ? new PgUserStore(pool) : new MemoryUserStore();
  // SEC-03 — authentication-attempt history. Same posture as every other store:
  // the real adapter on the PostgreSQL posture, the in-memory one otherwise, so
  // dev and PG cannot diverge in behaviour.
  const authEventStore: AuthEventStore =
    pool !== undefined ? new PgAuthEventStore(pool) : new MemoryAuthEventStore();
  const accountStore = pool !== undefined ? new PgAccountStore(pool) : new MemoryAccountStore();
  // v2.5 COPY TRADING — the producer half of the dispatch pipeline.
  //
  // The hooks are the transactional-outbox seam: they receive the trade
  // transaction's own executor, so a leader's signal is written atomically with
  // the leader's trade. They are wired ONLY on the PostgreSQL posture, because
  // the copy-relationship capability itself is only composed there — with
  // PERSISTENCE=memory no relationship can exist, so there is nothing to emit
  // and no reason to fake a queue row.
  const tradeStore =
    pool !== undefined
      ? new PgTradeStore(pool, {
          onTradeCreated: async (q, trade) => {
            const signal = tradeOpenedSignal(trade);
            if (signal !== null) await emitCopySignal(q, signal);
          },
          onExitRecorded: async (q, trade, exit) => {
            const signal = tradeExitSignal(trade, exit);
            if (signal !== null) await emitCopySignal(q, signal);
          },
        })
      : new MemoryTradeStore();
  const rateLimitStore = pool !== undefined ? new PgRateLimitStore(pool) : new MemoryRateLimitStore();

  // C-41 — outbound transactional email.
  //
  // Provider selection is explicit and has no silent third state: with
  // RESEND_API_KEY set the real HTTPS adapter is used; without it the offline
  // LogMailProvider keeps an in-memory outbox. The log adapter does NOT claim
  // delivery to any external system and never prints message bodies (reset and
  // verification links are bearer-equivalent secrets), so nothing here can be
  // mistaken for a real send. The key itself is read from the environment,
  // passed straight to the adapter, and never logged, echoed or stored.
  const resendApiKey = process.env.RESEND_API_KEY;
  const mail: MailPort =
    resendApiKey !== undefined && resendApiKey.trim() !== ""
      ? new ResendMailProvider({ apiKey: resendApiKey })
      : new LogMailProvider();
  // Provider NAME only — never the key, and never the message contents.
  console.log(JSON.stringify({ level: "info", event: "mail.provider", provider: mail.name }));

  // Without a boot JWT secret every capability route stays fail-closed (503).
  // C-22 store; B-1 wraps it in a CredentialService and exposes authenticated
  // self-service routes. The store itself is still never handed to createApp —
  // only the service is — so the route layer cannot reach reveal()/findById()
  // and no secret-disclosure path exists over HTTP.
  let credentialStore: CredentialStore | undefined;
  const capabilities: {
    auth?: AuthService;
    accounts?: AccountService;
    trades?: TradeService;
    adminUsers?: AdminUserService;
    /** SEC-03 — authentication-attempt history (read surface + recorder). */
    authEvents?: AuthEventStore;
    ownership?: OwnershipService;
    credentials?: CredentialService;
    provisioning?: MetaApiProvisioningService;
    // --- backend migration (directive t) ---
    webhooks?: MetaApiWebhookService;
    syncStatus?: import("./accounts/syncStatusService.js").SyncStatusStore;
    /** TRD-06 — user-triggered MetaAPI sync (POST /accounts/{id}/sync). */
    manualSync?: import("./accounts/manualSyncService.js").ManualSyncService;
    analytics?: import("./analytics/analyticsStore.js").AnalyticsStore;
    tags?: import("./tags/tagService.js").TagStore;
    attachments?: AttachmentService;
    subscriptions?: import("./billing/subscriptionService.js").SubscriptionStore;
    aiCoach?: import("./aicoach/aiCoachRoutes.js").AiCoachStore;
    admin?: import("./admin/adminRoutes.js").AdminStore;
    /** Phase 6 — the admin console (overview, analytics, health, feeds, per-user). */
    adminConsole?: import("./admin/adminConsoleRoutes.js").AdminConsoleCapability;
    /** Phase 7 — the user-facing AI capability. */
    ai?: import("./ai/aiRoutes.js").AiCapability;
    /** Phase 7 — the admin AI configuration surface. */
    aiAdmin?: import("./ai/aiAdminRoutes.js").AiAdminCapability;
    /** Phase 7 — the support console's AI assists. */
    supportAi?: import("./support/supportAiRoutes.js").SupportAiCapability;
    portfolio?: import("./portfolio/portfolioRoutes.js").PortfolioStore;
    ea?: import("./ea/eaRoutes.js").EaStore;
    eaSync?: import("./ea/eaRoutes.js").SyncTriggerPort;
    deviceTokens?: import("./ea/eaRoutes.js").DeviceTokenEncryptor;
    tenancy?: import("./tenancy/tenancyRoutes.js").TenancyStore;
    developer?: import("./developer/developerRoutes.js").DeveloperStore;
    developerKeys?: import("./developer/developerAuth.js").DeveloperKeyAuth;
    telegram?: import("./telegram/telegramRoutes.js").TelegramCapability;
    support?: import("./support/supportService.js").SupportService;
  } = {};
  if (boot.jwtSecret !== undefined) {
    capabilities.auth = new AuthService({
      store: userStore,
      hasher: new VeloraHasher(),
      jwt: JwtService.create(boot.jwtSecret),
      mail,
      authEvents: authEventStore,
      // Verification/reset links must point at this environment's validated
      // origin (ADR-013); boot already guarantees it is present and canonical.
      appOrigin: boot.appOrigin,
    });
    // Plan lookup through the entitlement module — fail-closed (503 on store
    // errors, never a silent 'free') per the Remote EntitlementService invariant.
    const entitlements = new EntitlementService({
      findUserById: (userId) => userStore.findUserById(userId),
    });
    capabilities.accounts = new AccountService({
      store: accountStore,
      getPlan: (userId) => entitlements.getUserPlan(userId),
    });
    capabilities.trades = new TradeService({
      store: tradeStore,
      getUserTimezone: async (userId) => (await userStore.findUserById(userId))?.timezone ?? "UTC",
      verifyAccountOwnership: async (accountId, userId) =>
        (await accountStore.findByIdForUser(accountId, userId)) !== null,
    });
    // Installation ownership (System Owner) and the admin user surface. The
    // admin service resolves the owner from AUTHORITATIVE STORAGE so the owner
    // can never be suspended or demoted through user management.
    const ownershipStore =
      pool !== undefined ? new PgOwnershipStore(pool) : new MemoryOwnershipStore();
    // C-34: one append-only audit trail shared by every privileged mutation.
    const auditStore = pool !== undefined ? new PgAuditStore(pool) : new MemoryAuditStore();
    capabilities.ownership = new OwnershipService({
      ownership: ownershipStore,
      users: userStore,
      hasher: new VeloraHasher(),
      audit: auditStore,
    });
    capabilities.adminUsers = new AdminUserService({
      store: userStore,
      getSystemOwnerUserId: async () => (await ownershipStore.getOwnership())?.ownerUserId ?? null,
      audit: auditStore,
    });
    // SEC-03: the login-history read surface. Wired ONLY here (inside the
    // auth-configured branch) so a deployment without authentication cannot
    // expose an authentication-history endpoint.
    capabilities.authEvents = authEventStore;

    // C-22 encrypted credential store. FAIL-CLOSED: without a valid
    // CREDENTIAL_MASTER_KEY the capability is simply ABSENT — it is never
    // constructed with a generated key and never degrades to plaintext, so a
    // misconfigured deployment cannot silently store unencrypted secrets.
    // B-1 exposes authenticated self-service routes over this store; B-3 makes
    // create/delete emit audit events in the same transaction. There is still
    // no reveal route, so no secret-disclosure path exists over HTTP.
    const credentialKey = resolveCredentialKey(process.env);
    if (credentialKey.key !== null) {
      credentialStore =
        pool !== undefined
          ? new PgCredentialStore(pool, credentialKey.key)
          : new MemoryCredentialStore(credentialKey.key);
      // B-1: the authenticated access layer. Only constructed when a valid key
      // produced a store, so a misconfigured deployment leaves the routes
      // fail-closed (503) instead of exposing an unusable capability.
      capabilities.credentials = new CredentialService({
        store: credentialStore,
        // B-3: the same append-only trail used by every other privileged
        // mutation. Credential create/delete and their audit rows commit in
        // ONE transaction.
        audit: auditStore,
      });
      // Key VERSION only — never the key, never a credential.
      console.log(
        JSON.stringify({
          level: "info",
          event: "credentials.enabled",
          keyVersion: credentialKey.key.version,
        }),
      );
    } else {
      // CODES and fixed messages only; the configured value is never logged.
      for (const f of credentialKey.findings) {
        console.log(
          JSON.stringify({
            level: "warn",
            event: "credentials.disabled",
            code: f.code,
            message: f.message,
          }),
        );
      }
    }
  }
  // MetaAPI platform token (ADR-014 / D-19). Resolution is reported at boot so
  // a misconfiguration is visible, but absence is NOT fatal: MetaAPI is an
  // integration, and hard-exiting here would let a third-party configuration
  // gap take down authentication and trades. Deliberately absent from /ready
  // for the same reason. Codes and fixed messages only — never the token.
  const metaApi = resolveMetaApiConfig(process.env);
  if (metaApi.configured) {
    // The base URL is non-secret configuration; the token is never logged.
    console.log(
      JSON.stringify({ level: "info", event: "metaapi.configured", baseUrl: metaApi.baseUrl }),
    );
  } else {
    for (const f of metaApi.findings) {
      console.log(
        JSON.stringify({
          level: "warn",
          event: "metaapi.unavailable",
          code: f.code,
          message: f.message,
        }),
      );
    }
  }

  // OD-MP-1: MetaAPI provisioning / account binding.
  //
  // FAIL-CLOSED COMPOSITION. The capability is constructed ONLY when all four
  // preconditions hold: a database pool, a valid CREDENTIAL_MASTER_KEY (which
  // is what produced `credentialStore`), a configured platform token, and the
  // audit trail. Any gap leaves the routes 503 rather than half-built — a
  // provisioning path that could not decrypt, or could not audit, must not
  // exist at all.
  //
  // The credential STORE is handed to this service and to nothing else. No
  // route receives it, so `reveal()` remains unreachable from HTTP except
  // through this one owner-scoped flow.
  if (
    pool !== undefined &&
    credentialStore !== undefined &&
    metaApi.configured &&
    metaApi.token !== null
  ) {
    const platformToken = metaApi.token;
    // Optional operator override for the provisioning host. Absent → the
    // client library default. Rejected unless absolute https.
    const rawProvisioningBase = process.env.METAAPI_PROVISIONING_BASE_URL;
    let provisioningBaseUrl: string | null = null;
    if (rawProvisioningBase !== undefined && rawProvisioningBase.trim() !== "") {
      try {
        const parsed = new URL(rawProvisioningBase.trim());
        if (parsed.protocol === "https:") {
          provisioningBaseUrl = parsed.href.replace(/\/+$/, "");
        } else {
          console.log(
            JSON.stringify({
              level: "warn",
              event: "metaapi.provisioning.base_url_rejected",
              code: "MA-004",
              message: "METAAPI_PROVISIONING_BASE_URL must be an absolute https:// URL.",
            }),
          );
        }
      } catch {
        console.log(
          JSON.stringify({
            level: "warn",
            event: "metaapi.provisioning.base_url_rejected",
            code: "MA-004",
            message: "METAAPI_PROVISIONING_BASE_URL must be an absolute https:// URL.",
          }),
        );
      }
    }
    capabilities.provisioning = new MetaApiProvisioningService({
      accounts: accountStore,
      credentials: credentialStore,
      operations: new PgProvisioningStore(pool),
      audit: new PgAuditStore(pool),
      // Read through the holder at call time; never captured as a bare string
      // in module scope and never logged.
      platformToken: () => platformToken.reveal(),
      // DELIBERATELY NOT `metaApi.baseUrl`. That value is the CLIENT/history
      // host (mt-client-api-v1…); provisioning lives on a DIFFERENT host
      // (mt-provisioning-api-v1…). The legacy system derives one from the
      // other by string replacement (MetaApiService.php:55-56), which silently
      // breaks for any host that does not contain the expected substring.
      // Modern states the provisioning host explicitly: an operator override,
      // else the client's documented default. Validated https-only, because a
      // bearer token and a broker password travel on this connection.
      clientOptions: provisioningBaseUrl !== null ? { baseUrl: provisioningBaseUrl } : {},
      // AUD-03: the binding UPDATE, the terminal operation state and the
      // ACCOUNT_BINDING_CHANGED audit row commit or roll back together. Uses
      // the repository's single transaction primitive — no second abstraction.
      runInTransaction: (fn) => withTransaction(pool, fn),
    });
    console.log(JSON.stringify({ level: "info", event: "metaapi.provisioning.enabled" }));
  }

  // -------------------------------------------------------------------------
  // Backend migration (directive t): capability wiring.
  //
  // Each block states its own precondition and logs whether it is ENABLED, so a
  // deployment's real capability set is visible at boot instead of being
  // inferred from which routes happen to answer 503.
  // -------------------------------------------------------------------------
  if (pool !== undefined) {
    // ONE executor over the pool, shared by every migrated store — the same
    // `QueryFn` shape the Phase C stores already receive (persistence/pg.ts).
    const q = poolQuery(pool);
    capabilities.syncStatus = new PgSyncStatusStore(q);
    capabilities.analytics = new PgAnalyticsStore(q);
    capabilities.tags = new PgTagStore(q);
    capabilities.subscriptions = new PgSubscriptionStore(q);
    capabilities.aiCoach = new PgAiCoachStore(q);
    capabilities.admin = new PgAdminStore(q);
    // Phase 6: the admin console. It reuses the SAME AdminUserService the
    // kernel's user routes use (`capabilities.adminUsers`, constructed above with
    // the ownership resolver and the audit store) so the console cannot hold a
    // second, differently-guarded copy of the per-user operations.
    if (capabilities.adminUsers !== undefined) {
      capabilities.adminConsole = {
        console: new AdminConsoleService({
          store: new PgAdminConsoleStore(q, countMigrationManifest()),
          users: capabilities.adminUsers,
        }),
        users: capabilities.adminUsers,
      };
    }
    // ---------------------------------------------------------------------
    // Phase 7 — AI. ONE substrate, ONE ledger, ONE chain walker.
    //
    // The composition order matters: secrets resolve per call (so an
    // admin-saved key or relay config takes effect without a redeploy), the
    // router asks the secrets whether a provider is usable, and the manager
    // records every attempt — success, refusal and error — in the ledger 0017
    // created and 0028 extended. Nothing here fabricates: with no credential
    // the answer is a typed refusal, and the local OCR fallback is the only
    // provider that works with no network at all.
    // ---------------------------------------------------------------------
    {
      const aiConfig = new PgAiConfigStore(pool);
      const aiMasterKey = resolveCredentialKey(process.env).key;
      const envOf = (key: string): string | undefined => process.env[key];
      const aiSecrets = new AiSecretService({ store: aiConfig, masterKey: aiMasterKey, env: envOf });
      const aiRouteResolver = new AiRouteResolver({ store: aiConfig, env: envOf });
      const tesseract = new TesseractProvider();
      const aiRouter = new AiFeatureRouter({
        store: aiConfig,
        secrets: aiSecrets,
        routes: aiRouteResolver,
        env: envOf,
        localOcrAvailable: () => tesseract.isAvailable(),
      });
      const aiGuard = new AiFeatureGuard({ store: aiConfig });
      const aiAttempts = new PgAiAttemptStore(q);
      const aiLedger = new PgAiLedger(q);
      // The consent reader is the coach's own store: ONE consent column
      // (users.ai_consent_at), one reader, no second notion of consent.
      const aiConsent = capabilities.aiCoach ?? new PgAiCoachStore(q);
      const aiExecutors: Partial<Record<AiCatalogProvider, AiExecutor>> = {
        gemini: new GeminiExecutor({
          apiKey: async () => (await aiSecrets.resolve("GEMINI_API_KEY")).value,
          relayConfig: async () => ({
            url: (await aiSecrets.resolve("GEMINI_RELAY_URL")).value,
            token: (await aiSecrets.resolve("GEMINI_RELAY_TOKEN")).value,
          }),
        }),
        tesseract: new TesseractExecutor({ provider: tesseract }),
        // `openai` is in the ledger vocabulary (0017) but Modern has no
        // transport for it: it is deliberately absent here, so the router
        // reports it unavailable instead of the executor pretending.
      };
      const aiManager = new AiManager({
        router: aiRouter,
        guard: aiGuard,
        store: aiConfig,
        consent: aiConsent,
        attempts: aiAttempts,
        // No image library in this repository, so the anonymizer reports
        // "cannot guarantee" — and the manager's fail-closed rule then keeps
        // every image on this machine (local OCR) instead of sending an
        // unredacted screenshot to a third party. See imageAnonymizer.ts.
        anonymizer: new UnavailableImageAnonymizer(),
        executors: aiExecutors,
      });
      const aiTradeStore = new PgTradeStore(pool);
      capabilities.ai = {
        analysis: new AiAnalysisService({
          manager: aiManager,
          store: aiConfig,
          trades: {
            findActiveByIdForUser: async (id, userId) => {
              const row = await aiTradeStore.findActiveByIdForUser(id, userId);
              return row === null ? null : {
                id: row.id, symbol: row.symbol, direction: row.direction, status: row.status,
                entryPrice: row.entryPrice, exitPrice: row.exitPrice, volume: row.volume,
                netPnl: row.netPnl, rMultiple: row.rMultiple, stopLoss: row.stopLoss,
                takeProfit: row.takeProfit, strategy: row.strategy, emotion: row.emotion,
                openAtUtc: row.openAtUtc, closeAtUtc: row.closeAtUtc,
              };
            },
          },
          userLocale: async (userId) => {
            const rows = await q("SELECT locale FROM users WHERE id = $1 LIMIT 1", [userId]);
            const value = rows[0]?.["locale"];
            return value === null || value === undefined ? null : String(value);
          },
        }),
        config: aiConfig,
        ledger: aiLedger,
        consent: aiConsent,
        guard: aiGuard,
        providerConfigured: async () => (await aiRouter.buildDefaultChain(null)).entries.length > 0,
      };
      // The support console's assists share the SAME manager (one chain walker,
      // one ledger, one consent rule) and answer to the support module's own
      // permission, because they act on a ticket.
      capabilities.supportAi = {
        manager: aiManager,
        ticket: async (ticketId: string) => {
          // markRead:false — an AI assist must not have the side effect of
          // marking a ticket read; that belongs to the operator opening it.
          let view: Awaited<ReturnType<SupportService["supportTicket"]>>;
          try {
            view = await capabilities.support!.supportTicket(ticketId, { markRead: false });
          } catch {
            return null;
          }
          return {
            id: view.conversation.id,
            subject: view.conversation.subject,
            status: view.conversation.status,
            messages: view.messages.map((m) => ({
              id: m.id, senderType: m.senderType, body: m.body, createdAt: m.createdAt,
            })),
          };
        },
        mayManage: async (routeCtx: import("./routes/types.js").ExtendedRouteContext) => {
          const supportClaims = routeCtx.authenticate(routeCtx.req);
          if (supportClaims === null) return false;
          return canAct(
            { role: supportClaims.role, isSystemOwner: await routeCtx.isSystemOwner(supportClaims.sub) },
            "support.tickets.manage",
          );
        },
      };
      capabilities.aiAdmin = {
        admin: new AiAdminService({
          store: aiConfig,
          secrets: aiSecrets,
          routes: aiRouteResolver,
          router: aiRouter,
          guard: aiGuard,
          anonymizer: new UnavailableImageAnonymizer(),
          ledger: aiLedger,
          executors: aiExecutors,
          localOcrAvailable: () => tesseract.isAvailable(),
          env: envOf,
        }),
      };
      // One line at boot, no values: an operator reading the log can see whether
      // the local OCR fallback is really there, which is the only AI provider
      // whose availability this process can prove without a credential.
      console.log(JSON.stringify({
        level: "info",
        event: "ai.composed",
        tesseract: findTesseractBinary() !== null,
        masterKey: aiMasterKey !== null,
      }));
    }
    capabilities.portfolio = new PgPortfolioStore(q);
    capabilities.ea = new PgEaStore(q);
    capabilities.tenancy = new PgTenancyStore(q);
    capabilities.developer = new PgDeveloperStore(q);
    // Phase 5: the support ticket capability. The SERVICE wraps the store so the
    // lifecycle rules (who may reply, what a reopen does, the note-never-moves
    // rule) live in ONE place — the admin surface in phase 6 reuses it unchanged.
    capabilities.support = new SupportService({ store: new PgSupportStore(q) });
    // v3.0 developer-key AUTHENTICATION. Its own lookup (hash → live key) and
    // the SAME durable limiter store the auth routes use, so the per-key
    // requests/minute limit holds across processes instead of per instance.
    capabilities.developerKeys = new DeveloperKeyAuth({
      lookup: new PgDeveloperKeyLookup(q),
      limiter: rateLimitStore,
      log: (event) => console.log(JSON.stringify(event)),
    });

    // -----------------------------------------------------------------------
    // ONE sync trigger for EVERY producer that can ask for a MetaAPI sync.
    //
    // There are three: the worker's scheduled tick (its own process), the
    // webhook ingress, and — new in TRD-06 — the user-triggered
    // POST /accounts/{id}/sync. They must hand the queue the SAME job shape and
    // the SAME window, because the idempotency key `sync:{accountId}:{from}`
    // only deduplicates jobs that agree on the window. The trigger used to be
    // constructed inside the webhook block, which is why the ingress could
    // drift to a 24-hour window while the tick asked for 12 months; it is now
    // built once here and injected into both callers.
    //
    // Failure to start degrades to `DurableOnlySyncTrigger` (logged, code only —
    // a queue error can carry a connection string). That is a DELAY, never a
    // loss: the account is marked CONNECTING durably and the tick converges.
    // -----------------------------------------------------------------------
    let syncTrigger: SyncTrigger = new DurableOnlySyncTrigger();
    const databaseUrl = boot.persistence.databaseUrl;
    if (databaseUrl !== undefined) {
      try {
        syncTrigger = await PgBossSyncTrigger.create(databaseUrl);
      } catch {
        console.log(JSON.stringify({ level: "warn", event: "sync.trigger_unavailable" }));
      }
    }
    console.log(JSON.stringify({ level: "info", event: "sync.trigger", trigger: syncTrigger.name }));

    // The durable "awaiting sync" marker: ONE implementation, shared with the
    // webhook ingress (see accounts/syncPending.ts for why it is conditional).
    const markSyncPending = makeSyncPendingMarker(q);

    // TRD-06 — the user-triggered sync the Legacy accounts page had and Modern
    // did not. Wired whenever the database is: the queue is optional and the
    // service says so truthfully in its `dispatched` field.
    capabilities.manualSync = new ManualSyncService({
      store: new PgManualSyncStore(q),
      markSyncPending,
      trigger: syncTrigger,
      log: (event) => console.log(JSON.stringify(event)),
    });
    console.log(JSON.stringify({ level: "info", event: "accounts.manual_sync.enabled" }));

    // v0.2 webhook ingress. The SECRET decides whether the capability exists at
    // all: with no secret the route answers 503 WEBHOOK_SECRET_MISSING (the
    // Legacy contract), never an unverified accept. The secret is read through a
    // thunk so a rotation takes effect without a restart and no module-scope
    // binding ever holds it.
    const webhookSecret = (process.env["METAAPI_WEBHOOK_SECRET"] ?? "").trim();
    if (webhookSecret !== "") {
      const webhookStore = new PgWebhookEventStore(pool);
      capabilities.webhooks = new MetaApiWebhookService({
        store: webhookStore,
        secret: () => (process.env["METAAPI_WEBHOOK_SECRET"] ?? "").trim() || null,
        resolveAccount: async (metaapiAccountId): Promise<WebhookAccountRef | null> => {
          const rows = await q(
            `SELECT id::text AS id, user_id::text AS user_id, metaapi_account_id, sync_cursor
               FROM trading_accounts WHERE metaapi_account_id = $1 LIMIT 1`,
            [metaapiAccountId],
          );
          const row = rows[0];
          if (row === undefined) return null;
          return {
            accountId: String(row.id),
            userId: String(row.user_id),
            metaapiAccountId: String(row.metaapi_account_id),
            syncCursor: row.sync_cursor === null ? null : String(row.sync_cursor),
          };
        },
        markSyncPending,
        trigger: syncTrigger,
      });
      console.log(JSON.stringify({ level: "info", event: "webhooks.enabled", trigger: syncTrigger.name }));
    } else {
      console.log(JSON.stringify({ level: "warn", event: "webhooks.secret_absent" }));
    }

    // Attachments: only with an explicitly configured storage root. A container
    // filesystem is ephemeral, so this is never enabled implicitly — the local
    // adapter is for staging/dev, and the production object store is an Owner
    // decision recorded in the migration report.
    const attachmentDir = (process.env["ATTACHMENT_STORAGE_DIR"] ?? "").trim();
    if (attachmentDir !== "" && boot.environment === "production") {
      // FAIL CLOSED IN PRODUCTION. A container filesystem is ephemeral: enabling
      // a local-disk attachment store in production would accept uploads and
      // silently lose the bytes at the next deploy — a data-integrity failure,
      // not a configuration preference. The capability is therefore ABSENT until
      // a real object store is configured (Owner decision D-3).
      console.log(JSON.stringify({ level: "error", event: "attachments.local_disk_refused_in_production" }));
    } else if (attachmentDir !== "") {
      capabilities.attachments = new AttachmentService(
        new PgAttachmentStore(q),
        new LocalAttachmentStorage(attachmentDir),
      );
      console.log(JSON.stringify({ level: "info", event: "attachments.enabled", storage: "local-disk" }));
    } else {
      console.log(JSON.stringify({ level: "warn", event: "attachments.storage_absent" }));
    }

    // -----------------------------------------------------------------------
    // Telegram journal client (ADR-018 / migration 0023).
    //
    // FAIL-CLOSED AND PARTIAL BY DESIGN. The capability is composed from what is
    // actually configured, and every missing piece removes exactly the surface it
    // belongs to:
    //   * no bot token        → no Telegram capability at all (503 everywhere);
    //   * no webhook secret   → no ingress (and `TELEGRAM_UPDATE_MODE=webhook`
    //                           is refused by the resolver);
    //   * no bot username or
    //     no public app URL   → the bot runs, the web surface runs, but the
    //                           onboarding button is unavailable and the API says
    //                           so rather than returning a broken link;
    //   * no update mode      → nobody consumes the stream (TG-006).
    // The bot token itself is never logged, never placed on an error, and its
    // `SecretValue` holder prints as `[redacted]`.
    // -----------------------------------------------------------------------
    const telegram = resolveTelegramConfig(process.env);
    for (const finding of telegram.findings) {
      // Finding CODE + fixed message only; the messages never embed a value.
      console.log(JSON.stringify({ level: telegram.configured ? "warn" : "info", event: "telegram.finding", code: finding.code, message: finding.message }));
    }
    if (telegram.configured && telegram.botToken !== null) {
      const telegramStore = new PgTelegramStore(pool);
      const telegramApi = new HttpTelegramBotApi(telegram.botToken);
      // The SAME append-only audit trail every other privileged mutation writes
      // to (a second PgAuditStore over the same table — the store is stateless
      // beyond its executor, so this is one trail, not two).
      const telegramAudit = new PgAuditStore(pool);
      const links = new TelegramLinkService({
        store: telegramStore,
        audit: telegramAudit,
        botUsername: () => resolveTelegramConfig(process.env).botUsername,
      });

      // Profile lookups. Both are read per call: a user who changes their
      // timezone or language sees the change on their next message.
      const profileQuery = async (userId: string): Promise<{ locale: "fa" | "en"; timezone: string } | null> => {
        const rows = await q("SELECT locale, timezone FROM users WHERE id = $1 LIMIT 1", [userId]);
        const row = rows[0];
        if (row === undefined) return null;
        return { locale: row["locale"] === "en" ? "en" : "fa", timezone: String(row["timezone"] ?? "UTC") };
      };

      // ONE attempt ledger for the whole AI surface: coaching, journal
      // extraction, transcription and vision all land in `ai_coaching_logs`
      // tagged by `feature`, which is what makes the cost/outcome answerable in
      // one query instead of several partial ones.
      const attempts = new PgAiAttemptStore(q);
      const consent = capabilities.aiCoach ?? new PgAiCoachStore(q);

      // Journal analysis reuses the PLATFORM's coaching pipeline: consent gate,
      // payload bound, provider port, output validation, durable attempt record.
      // Nothing about that governance is re-implemented for Telegram.
      const geminiKey = (process.env["GEMINI_API_KEY"] ?? "").trim();
      const provider = geminiKey === "" ? undefined : new GeminiAiProvider({ apiKey: geminiKey });
      const coach = new AiCoachService({
        provider: provider ?? new UnconfiguredAiProvider(),
        consent,
        attempts,
        allowedProviders: AI_PROVIDERS,
      });

      // Media interpretation is a SEPARATE capability with its own key decision:
      // a deployment may enable journal analysis and decline voice/vision, and
      // the bot degrades to "send it as text" instead of failing.
      let interpreter: MediaInterpreter = new UnconfiguredMediaInterpreter();
      if (geminiKey !== "") interpreter = new GeminiMediaInterpreter({ apiKey: geminiKey });

      // A DEDICATED TradeService over the same durable ledger.
      //
      // WHY NOT REUSE `capabilities.trades`: that one is composed next to the
      // HTTP auth capability and therefore exists only when a boot JWT secret
      // does. The bot's write path must not depend on the presence of the HTTP
      // login surface — the webhook ingress is unauthenticated by design, and a
      // deployment that consumes updates but has no JWT secret still has to be
      // able to journal (and to refuse to, explicitly, if it cannot). Both
      // instances are thin wrappers over the SAME stores, so the ADR-002 fold,
      // validation and event log are identical on either path.
      const journalTrades = new TradeService({
        store: new PgTradeStore(pool),
        getUserTimezone: async (userId) => (await profileQuery(userId))?.timezone ?? "UTC",
        verifyAccountOwnership: async (accountId, userId) =>
          (await q("SELECT 1 FROM trading_accounts WHERE id = $1 AND user_id = $2 LIMIT 1", [accountId, userId])).length > 0,
      });
      const journal = new JournalApplicationService({
        trades: journalTrades,
        drafts: telegramStore,
        getUserTimezone: async (userId) => (await profileQuery(userId))?.timezone ?? "UTC",
      });

      const bot = new TelegramBot({
        api: telegramApi,
        store: telegramStore,
        links,
        journal,
        analysis: new JournalAnalysisService({ coach, journal }),
        media: { interpreter, attempts },
        attachments: capabilities.attachments,
        // One durable limiter store across every process, so the limit a user
        // hits does not depend on which replica answered.
        limiter: new FixedWindowRateLimiter(rateLimitStore),
        appUrl: () => resolveTelegramConfig(process.env).appUrl,
        getUserLocale: async (userId) => (await profileQuery(userId))?.locale ?? null,
        log: (event) => console.log(JSON.stringify(event)),
      });

      const pipeline = new TelegramUpdatePipeline({
        bot,
        mode: () => resolveTelegramConfig(process.env).updateMode,
        log: (event) => console.log(JSON.stringify(event)),
      });

      capabilities.telegram = {
        config: () => resolveTelegramConfig(process.env),
        links,
        store: telegramStore,
        pipeline,
        limiter: new FixedWindowRateLimiter(rateLimitStore),
        audit: telegramAudit,
        log: (event: Record<string, unknown>) => console.log(JSON.stringify(event)),
      };

      // THE SECOND CONSUMER IS NEVER STARTED. The resolver has already refused
      // polling in production (TG-007); here the mode is the only thing that can
      // start the loop, and webhook mode reaches the bot exclusively through the
      // ingress route.
      if (telegram.updateMode === "polling") {
        const poller = new TelegramPoller({ api: telegramApi, pipeline, log: (event) => console.log(JSON.stringify(event)) });
        void poller.run();
        console.log(JSON.stringify({ level: "warn", event: "telegram.polling_enabled" }));
      }
      console.log(
        JSON.stringify({
          level: "info",
          event: "telegram.enabled",
          updateMode: telegram.updateMode,
          linking: telegram.linkingConfigured,
          ingress: telegram.webhookConfigured,
          analysis: provider !== undefined,
          media: geminiKey !== "",
        }),
      );
    } else {
      console.log(JSON.stringify({ level: "info", event: "telegram.disabled" }));
    }
  }
  void withTransaction;

  const app = createApp({
    allowedOrigins: boot.allowedOrigins,
    checks: { database: dbProbe },
    // D2: the limiter rides the configured persistence (PG store when
    // PERSISTENCE=postgres; per-app memory store otherwise — identical to the
    // createApp default in the memory posture).
    rateLimiter: new FixedWindowRateLimiter(rateLimitStore),
    ...capabilities,
  });
  // HOST: bind address for deployed environments (container platforms need
  // 0.0.0.0; default 127.0.0.1 preserves local-dev behavior).
  const bound = await listen(app, boot.port, process.env.HOST ?? "127.0.0.1");
  console.log(
    JSON.stringify({
      level: "info",
      service: "api",
      event: "startup",
      port: bound,
      environment: boot.environment,
      persistence: boot.persistence.kind,
      db: boot.persistence.databaseUrl ? "configured" : "missing",
    }),
  );
}

void main();

/**
 * How many migrations this BUILD expects, read from `db/migrations/*.sql`.
 *
 * Read at boot rather than hard-coded so the number cannot drift from what the
 * repository actually ships, and returns `null` when the directory is not
 * readable from this process — the console then reports the migration component
 * as UNKNOWN instead of inventing an expectation. That distinction matters: a
 * process that cannot see the manifest must not claim the schema is current.
 */
function countMigrationManifest(): number | null {
  try {
    const dir = new URL("../../../db/migrations", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    return files.length;
  } catch {
    return null;
  }
}
