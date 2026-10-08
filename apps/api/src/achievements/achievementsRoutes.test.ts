// Achievements HTTP surface — the Modern read side for the legacy
// UserAchievementRepository::listForUser port (MG-DOMAIN-LEGACY-ONLY).
//
// WHAT THIS FILE IS EVIDENCE FOR. Everything below runs through the REAL kernel
// (`createApp` + `listen`) and the REAL bearer verification; only the storage
// adapter is a double. That is deliberate, because the security properties here
// are decided at the ROUTE layer and a service-level test cannot prove them:
//
//   1. identity comes from `claims.sub` ONLY — a client cannot read another
//      user's achievements;
//   2. the surface is fail-closed (503) when the capability is absent;
//   3. an anonymous caller is 401, not 200 with an empty list;
//   4. the list is ordered achievedAt DESC and honours the domain's timestamp
//      contract (first-trade + email-verified).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listen } from "../kernel/server.js";
import { AuthService } from "../auth/authService.js";
import { JwtService } from "../auth/jwt.js";
import { VeloraHasher } from "../auth/hashing.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { LogMailProvider } from "../mail/logMailProvider.js";
import { FixedWindowRateLimiter } from "../ratelimits/rateLimiter.js";
import { MemoryRateLimitStore } from "../ratelimits/memoryRateLimitStore.js";
import { MemoryAchievementStore } from "../notifications/notificationStores.js";
import { ACHIEVEMENTS, buildAchievementMetadata } from "@velora/domain";

const JWT_SECRET = "achievements-routes-test-secret-0123456789abcdef";

interface Envelope<T = Record<string, unknown>> {
  status: string;
  data: T;
  error: { code: string; message: string; details?: Record<string, string | number> } | null;
  timestamp: string;
}

async function withServer(
  fn: (h: { base: string; store: MemoryUserStore; achievements: MemoryAchievementStore; close: () => Promise<void> }, tokens: { alice: string; bob: string }) => Promise<void>,
  opts: { withAchievements?: boolean } = {},
): Promise<void> {
  const verificationTokens: string[] = [];
  const store = new MemoryUserStore();
  const achievements = new MemoryAchievementStore();
  const auth = new AuthService({
    store,
    hasher: new VeloraHasher(),
    jwt: JwtService.create(JWT_SECRET),
    generateVerificationToken: () => {
      const t = `ach-verification-${Math.random().toString(36).slice(2)}-0123456789`;
      verificationTokens.push(t);
      return t;
    },
    mail: new LogMailProvider(),
    achievements,
  });
  const app = createApp({
    allowedOrigins: ["https://app.velora.example"],
    checks: { database: async () => "ok" as const },
    auth,
    ...(opts.withAchievements === false ? {} : { achievements }),
    rateLimiter: new FixedWindowRateLimiter(new MemoryRateLimitStore()),
  });
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;

  async function login(email: string): Promise<string> {
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
    const res = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "a-strong-password-123" }),
    });
    assert.equal(res.status, 200);
    return ((await res.json()) as Envelope<{ tokens: { accessToken: string } }>).data.tokens.accessToken;
  }

  try {
    const alice = await login("ach-alice@velora.example");
    const bob = await login("ach-bob@velora.example");
    await fn({ base, store, achievements, close: async () => undefined }, { alice, bob });
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

// ── Authentication and capability ────────────────────────────────────────────

test("ACHIEVEMENTS HTTP: routes fail closed (503) when the capability is unconfigured", async () => {
  await withServer(
    async ({ base }, { alice }) => {
      const res = await fetch(`${base}/api/v1/achievements`, { headers: bearer(alice) });
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as Envelope).error?.code, "SERVICE_UNAVAILABLE");
    },
    { withAchievements: false },
  );
});

test("ACHIEVEMENTS HTTP: anonymous caller is 401", async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/v1/achievements`);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as Envelope).error?.code, "UNAUTHENTICATED");
  });
});

test("ACHIEVEMENTS HTTP: empty list when no achievements yet", async () => {
  await withServer(async ({ base }, { alice }) => {
    const res = await fetch(`${base}/api/v1/achievements`, { headers: bearer(alice) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Envelope<{ achievements: unknown[]; total: number }>;
    assert.equal(body.data.total, 0);
    assert.deepEqual(body.data.achievements, []);
  });
});

test("ACHIEVEMENTS HTTP: isolation — alice cannot see bob's achievements", async () => {
  await withServer(async ({ base, store, achievements }, { alice, bob }) => {
    const aliceUser = await store.findUserByEmail("ach-alice@velora.example");
    const bobUser = await store.findUserByEmail("ach-bob@velora.example");
    assert.ok(aliceUser && bobUser);
    const now = new Date("2026-10-08T12:00:00.000Z");
    const meta = buildAchievementMetadata(ACHIEVEMENTS.FIRST_TRADE!, now);
    await achievements.insert({
      userId: bobUser.id,
      achievementKey: "FIRST_TRADE",
      achievedAt: "2026-10-08 12:00:00",
      metadataJson: meta,
    });

    const aliceRes = await fetch(`${base}/api/v1/achievements`, { headers: bearer(alice) });
    assert.equal(aliceRes.status, 200);
    assert.equal(((await aliceRes.json()) as Envelope<{ total: number }>).data.total, 0);

    const bobRes = await fetch(`${base}/api/v1/achievements`, { headers: bearer(bob) });
    assert.equal(bobRes.status, 200);
    const bobBody = (await bobRes.json()) as Envelope<{ achievements: { key: string }[]; total: number }>;
    assert.equal(bobBody.data.total, 1);
    assert.equal(bobBody.data.achievements[0]!.key, "FIRST_TRADE");
  });
});

test("ACHIEVEMENTS HTTP: ordered DESC and shape includes i18n keys + timestamps", async () => {
  await withServer(async ({ base, store, achievements }, { alice }) => {
    const aliceUser = await store.findUserByEmail("ach-alice@velora.example");
    assert.ok(aliceUser);
    const t1 = new Date("2026-10-08T10:00:00.000Z");
    const t2 = new Date("2026-10-08T12:00:00.000Z");
    const meta1 = buildAchievementMetadata(ACHIEVEMENTS.FIRST_TRADE!, t1);
    const meta2 = buildAchievementMetadata(ACHIEVEMENTS.EMAIL_VERIFIED!, t2);
    await achievements.insert({
      userId: aliceUser.id,
      achievementKey: "FIRST_TRADE",
      achievedAt: "2026-10-08 10:00:00",
      metadataJson: meta1,
    });
    await achievements.insert({
      userId: aliceUser.id,
      achievementKey: "EMAIL_VERIFIED",
      achievedAt: "2026-10-08 12:00:00",
      metadataJson: meta2,
    });

    const res = await fetch(`${base}/api/v1/achievements`, { headers: bearer(alice) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Envelope<{ achievements: { key: string; titleKey: string; descriptionKey: string; achievedAt: string; unlockedAt: string }[] }>;
    assert.equal(body.data.achievements.length, 2);
    // DESC: EMAIL_VERIFIED (12:00) before FIRST_TRADE (10:00)
    assert.equal(body.data.achievements[0]!.key, "EMAIL_VERIFIED");
    assert.equal(body.data.achievements[1]!.key, "FIRST_TRADE");
    assert.equal(body.data.achievements[0]!.titleKey, "achievements.emailVerified.title");
    assert.equal(body.data.achievements[1]!.titleKey, "achievements.firstTrade.title");
    assert.equal(body.data.achievements[0]!.achievedAt, "2026-10-08 12:00:00");
  });
});
