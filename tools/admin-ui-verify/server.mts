// LOCAL VERIFICATION RIG — admin "Agent tools" tab, round 5.
//
// WHAT THIS IS. A loopback-only dev harness that boots the REAL API app
// (`createApp` from apps/api/src/kernel/server.ts) with the REAL AI admin route
// module, the REAL search/browser tool services, the REAL audit-store-backed
// admin read surface, the REAL rate limiter, secret service and permission code —
// and a MOCKED PROVIDER FETCH, nothing else. It exists so the tab can be verified
// in a real browser (rendered DOM, real HTTP, real cookies, real refusals) without
// any provider credential and without touching any deployed environment. This is
// NOT a second admin API: every route it answers is the production route module
// mounted with its production guards. The composition choices are exactly (a)
// in-memory stores — the same ones the repo's own HTTP harnesses use — and (b)
// `fetchImpl` doubles for the two external tools, which is the only egress the
// rig can and may simulate.
//
// SCENARIOS (--scenario=…). What the panel reports is decided HERE, server-side,
// never in the UI, so no state can be painted on by the client:
//   nosecret    no tool credentials at all          → search/browser rows `unavailable`
//   configured  fake env credentials, probe answers → rows `configured`; Validate → `verified`
//   reject      fake credentials, provider 400      → Validate → HTTP 424, row `failing`
//   hang        fake credentials, provider never    → the service's own timeout → 424 timeout
//   worker      like configured but raster:null     → banner row `unsupported` (the Worker shape)
//   none        tool services not mounted at all    → GET /admin/ai/tools → 503, never an empty list
//
// SECRETS: the sentinel in ./constants.mts is the only "credential" this process
// ever holds. The browser pass scans every response body and console line for it;
// finding it anywhere but the rig's own environment would be the actual leak.
import { createApp, listen } from "../../apps/api/src/kernel/server.js";
import { AuthService } from "../../apps/api/src/auth/authService.js";
import { MemoryUserStore } from "../../apps/api/src/auth/memoryUserStore.js";
import { VeloraHasher } from "../../apps/api/src/auth/hashing.js";
import { JwtService } from "../../apps/api/src/auth/jwt.js";
import { LogMailProvider } from "../../apps/api/src/mail/logMailProvider.js";
import { FixedWindowRateLimiter } from "../../apps/api/src/ratelimits/rateLimiter.js";
import { MemoryRateLimitStore } from "../../apps/api/src/ratelimits/memoryRateLimitStore.js";
import { OwnershipService } from "../../apps/api/src/auth/ownershipService.js";
import { MemoryOwnershipStore } from "../../apps/api/src/auth/memoryOwnershipStore.js";
import { AdminUserService } from "../../apps/api/src/auth/adminUserService.js";
import { MemoryAuditStore } from "../../apps/api/src/auth/memoryAuditStore.js";
import { MemoryAiConfigStore } from "../../apps/api/src/ai/memoryAiConfigStore.js";
import { MemoryAiLedger } from "../../apps/api/src/ai/aiLedger.js";
import { AiFeatureGuard } from "../../apps/api/src/ai/aiFeatureGuard.js";
import { AiFeatureRouter } from "../../apps/api/src/ai/aiFeatureRouter.js";
import { AiRouteResolver } from "../../apps/api/src/ai/aiRouteResolver.js";
import { AiSecretService } from "../../apps/api/src/ai/aiSecrets.js";
import { UnavailableImageAnonymizer } from "../../apps/api/src/ai/imageAnonymizer.js";
import { AiAdminService } from "../../apps/api/src/ai/aiAdminService.js";
import { AiToolAdminService } from "../../apps/api/src/ai/aiToolAdmin.js";
import { AiSearchService } from "../../apps/api/src/ai/aiSearchService.js";
import { AiBrowserService } from "../../apps/api/src/ai/aiBrowserService.js";
import { MasterKey } from "../../apps/api/src/credentials/credentialCrypto.js";
import { probeBannerRaster } from "../../apps/api/src/telegram/bannerRaster.js";
import { RIG_PASSWORD, RIG_SENTINEL, RIG_ACCOUNTS } from "./constants.mts";

const PORT = Number(process.env.RIG_PORT ?? 8080);
const SCENARIO = process.argv.find((a) => a.startsWith("--scenario="))?.slice("--scenario=".length) ?? "configured";

const env = new Map<string, string | undefined>();
if (SCENARIO !== "nosecret" && SCENARIO !== "none") {
  env.set("TAVILY_API_KEY", `${RIG_SENTINEL}-tavily`);
  // The key NAMES are whatever the catalog demands — the payload's own `secrets[]`
  // row is what says so; a rig that guesses key names would silently "verify" the
  // wrong fixture. `browser.verify.invalid` never resolves by DNS, and the mocked
  // fetch never even reaches that far, but the name stays fail-safe on purpose.
  env.set("BROWSERLESS_URL", "https://browser.verify.invalid");
  env.set("BROWSERLESS_TOKEN", `${RIG_SENTINEL}-browserless`);
}

// ── provider mock ────────────────────────────────────────────────────────────
// Records every attempt to leave the process and answers per scenario. `hang`
// resolves NEVER: what the browser then sees is produced by the SERVICE's own
// timeout, which is the point — the UI must not invent a success while nothing
// answered, and the rig must not shortcut the code that decides that.
const egress: string[] = [];

// A real `fetch` REJECTS with an AbortError when its signal fires; `toolFetch` relies on exactly that
// to map a dead provider to `TIMEOUT`. A mock that merely never resolves would not be simulating fetch,
// it would be simulating a defect — the product's timeout machinery would go untested and this rig would
// hang the route instead. So the hang scenario obeys the caller's signal, as any fetch must.
const hangUntilAborted = (init?: RequestInit): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === undefined || signal === null) return; // no signal: genuinely never settles
    if (signal.aborted) {
      reject(Object.assign(new Error("signal aborted"), { name: "AbortError" }));
      return;
    }
    signal.addEventListener("abort", () => reject(Object.assign(new Error("signal aborted"), { name: "AbortError" })), { once: true });
  });

const providerFetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  egress.push(`${String(init?.method ?? "GET")} ${url}`);
  if (SCENARIO === "hang") return hangUntilAborted(init);
  if (SCENARIO === "reject") {
    return new Response(JSON.stringify({ error_message: "rig: provider refused" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  // A well-formed, honest answer: the shapes the real services parse, with content
  // as empty as it can be while still meaning "the endpoint answered".
  return new Response(
    JSON.stringify({
      web: { results: [] },
      results: [],
      queries: [],
      response: "",
      screenshot: null,
      content: "",
      status: "ready",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as unknown as typeof fetch;

// ── composition (mirrors server-main's aiAdmin block; memory where prod has pg) ──
const users = new MemoryUserStore();
const audit = new MemoryAuditStore();
const verificationTokens: string[] = [];
const auth = new AuthService({
  store: users,
  hasher: new VeloraHasher(),
  jwt: JwtService.create("admin-ui-verify-local-secret-0123456789abcdef"),
  generateVerificationToken: () => {
    const token = `rig-verify-${Math.random().toString(36).slice(2)}-0123456789`;
    verificationTokens.push(token);
    return token;
  },
  mail: new LogMailProvider(),
});
const ownershipStore = new MemoryOwnershipStore();
const ownership = new OwnershipService({ ownership: ownershipStore, users, hasher: new VeloraHasher(), audit });
const adminUsers = new AdminUserService({
  store: users,
  audit,
  getSystemOwnerUserId: async () => (await ownershipStore.getOwnership())?.ownerUserId ?? null,
});

const config = new MemoryAiConfigStore();
config.seedLegacyDefaults();
const secretService = new AiSecretService({
  store: config,
  masterKey: MasterKey.fromBase64(Buffer.alloc(32, 9).toString("base64"), 1),
  env: (key) => env.get(key),
});
const routeResolver = new AiRouteResolver({ store: config, env: (key) => env.get(key) });
const guard = new AiFeatureGuard({ store: config });
const router = new AiFeatureRouter({
  store: config,
  secrets: secretService,
  routes: routeResolver,
  env: (key) => env.get(key),
});
const ledger = new MemoryAiLedger();
// No generation is ever claimed here: the rig's only simulated egress is the two
// tool providers. If a model call were somehow attempted, it fails LOUDLY.
const executors = {
  gemini: {
    provider: "gemini" as const,
    async execute(): Promise<never> {
      throw new Error("rig: model egress is not mocked and must never run in this harness");
    },
  },
};

const toolServices =
  SCENARIO === "none"
    ? null
    : {
        search: new AiSearchService({ secrets: secretService, fetchImpl: providerFetch }),
        browser: new AiBrowserService({ secrets: secretService, fetchImpl: providerFetch }),
      };

const aiAdmin = {
  audit,
  ...(toolServices === null
    ? {}
    : {
        tools: new AiToolAdminService({
          ...toolServices,
          // The Worker shape is BOTH halves: no probe AND no renderer. `raster: null` with a `rasterize`
          // stub would instead describe a runtime that can attempt a render and produces nothing — a
          // `failing` verdict, which is a different, honest statement about a different machine.
          raster: SCENARIO === "worker" ? null : probeBannerRaster,
          ...(SCENARIO === "worker" ? {} : { rasterize: async (): Promise<Buffer | null> => null }),
        }),
      }),
  admin: new AiAdminService({
    store: config,
    secrets: secretService,
    routes: routeResolver,
    router,
    guard,
    anonymizer: new UnavailableImageAnonymizer(),
    ledger,
    executors,
    localOcrAvailable: () => false,
    env: (key) => env.get(key),
  }),
} as const;

// The real `/api/v1/admin/audit-log` surface, over the same MemoryAuditStore the
// aiAdmin appends to — so the browser can show the AI_TOOL_VALIDATED rows THROUGH
// the product's own admin audit tab, not through a rig-only viewer.
const admin = {
  auditLog: async (filter: { action?: string; limit: number }) => {
    const all = await audit.list();
    const rows = filter.action === undefined ? all : all.filter((r) => r.action === filter.action);
    return { items: rows.slice(0, filter.limit), total: rows.length };
  },
  metrics: async () => ({
    users: 3,
    activeUsers: 3,
    tradingAccounts: 0,
    connectedAccounts: 0,
    trades: 0,
    openTrades: 0,
    paidSubscriptions: 0,
  }),
} as const;

// The origin guard is exact-match by design (kernel/security.ts). Localhost is what the browser driver
// uses; the sandbox's own https preview host is added ONLY because this rig exists to be LOOKED AT — a
// human opening the live preview has to be able to log in. It widens nothing in the product: the list
// lives in this file, on a loopback-only process holding sentinel credentials.
const previewOrigin = process.env.E2B_SANDBOX_ID ? `https://3000-${process.env.E2B_SANDBOX_ID}.e2b.app` : null;

const app = createApp({
  allowedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000", ...(previewOrigin !== null ? [previewOrigin] : [])],
  checks: { database: async () => "ok" as const },
  auth,
  adminUsers,
  ownership,
  admin,
  rateLimiter: new FixedWindowRateLimiter(new MemoryRateLimitStore()),
  aiAdmin,
});

await listen(app, PORT, "127.0.0.1");

// ── seed accounts (through the real register flow, so the passwords are real
//    hashes and the verification state is real) ──────────────────────────────
async function seedUser(email: string, role: "user" | "admin" | "super_admin"): Promise<void> {
  const reg = await fetch(`http://127.0.0.1:${PORT}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: RIG_PASSWORD, fullName: `Rig ${role}`, timezone: "UTC" }),
  });
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`rig: register ${email} → ${reg.status}`);
  const token = verificationTokens.shift();
  if (token === undefined) throw new Error(`rig: no verification token issued for ${email}`);
  const verify = await fetch(`http://127.0.0.1:${PORT}/api/v1/auth/verify-email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (verify.status !== 200) throw new Error(`rig: verify ${email} → ${verify.status}`);
  if (role !== "user") {
    const row = await users.findUserByEmail(email);
    if (row === null) throw new Error(`rig: seeded user vanished: ${email}`);
    await users.updateUserRole(row.id, role, new Date());
  }
}

await seedUser(RIG_ACCOUNTS.plain.email, "user");
await seedUser(RIG_ACCOUNTS.admin.email, "admin");
await seedUser(RIG_ACCOUNTS.super.email, "super_admin");

console.log(
  JSON.stringify({
    event: "rig.ready",
    scenario: SCENARIO,
    port: PORT,
    egressTargets: egress.slice(),
    note: "loopback only; sentinel credentials; no model egress",
  }),
);

// Keep the provider-fetch evidence readable without a second log: on exit, print
// how many requests tried to leave and to where.
process.on("SIGTERM", () => {
  console.log(JSON.stringify({ event: "rig.egress", count: egress.length, targets: egress.slice(0, 20) }));
  process.exit(0);
});
