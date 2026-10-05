// Real-PostgreSQL battery for Phase 7 — the AI substrate's persistence rules.
//
// WHAT ONLY A REAL ENGINE CAN PROVE HERE. The AI configuration is small, but four
// of its properties are exactly the kind a double can fake and a database cannot:
//
//   1. THE VOCABULARIES ARE CLOSED. 0028 CHECKs the provider, feature, route,
//      flag-name, secret-key and credential-status vocabularies. A row naming a
//      provider Modern cannot call, or a route no transport understands, must be
//      REFUSED by the engine — not filtered later by application code that a
//      future change might forget.
//   2. THE QUOTA RESERVATION IS ONE STATEMENT. Legacy's own comment records that
//      check-then-increment was a race. Here twenty concurrent reservations
//      against a limit of five must produce exactly five successes and fifteen
//      refusals, and the counter must read five — never six.
//   3. THE ENVELOPE SURVIVES BYTEA. An AES-256-GCM envelope written by
//      `credentialCrypto` must come back byte-identical through `bytea`, decrypt
//      to the original value, and the nonce-uniqueness constraint must refuse a
//      reused IV under the same key version.
//   4. DERIVED COLUMNS STAY DERIVED. `ai_provider_credentials.verified` is a
//      consequence of `status`; `ai_feedback.changed_fields` must be non-empty.
//      Both are enforced by the engine so no code path can write a row that says
//      "verified" about a credential whose status says otherwise.
//
// EVIDENCE LABEL (Phase D policy): executes ONLY against a REAL, disposable
// PostgreSQL (DATABASE_URL). Without it every test is SKIPPED, never silently
// passed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareDatabase } from "./support/pgTestDb.ts";
import { PgAiConfigStore, secretFingerprint } from "../../apps/api/src/ai/aiConfigStore.ts";
import { PgAiLedger } from "../../apps/api/src/ai/aiLedger.ts";
import { PgAiAttemptStore } from "../../apps/api/src/aicoach/aiProvider.ts";
import { MasterKey, encryptCredential, decryptCredential } from "../../apps/api/src/credentials/credentialCrypto.ts";
import type { QueryFn } from "../../apps/api/src/persistence/pg.ts";

const PG_URL = process.env.DATABASE_URL;
const SKIP =
  PG_URL === undefined ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)" : false;

const q = (pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }): QueryFn =>
  (async (sql: string, params?: unknown[]) => (await pool.query(sql, params as unknown[] | undefined)).rows) as unknown as QueryFn;

/** A CHECK/FK violation is 23514/23505; the battery asserts the engine refused. */
function isPgRejection(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === "23514" || code === "23505" || code === "23502" || code === "22001";
}

interface Ctx {
  pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
  q: QueryFn;
  store: PgAiConfigStore;
  userId: string;
  cleanup: () => Promise<void>;
}

let seq = 0;

async function setup(): Promise<Ctx> {
  const prepared = await prepareDatabase(PG_URL as string);
  const pool = prepared.pool as unknown as Ctx["pool"];
  const query = q(pool);
  seq += 1;
  const email = `ai-pg-${Date.now()}-${seq}@velora.test`;
  const rows = await query(
    `INSERT INTO users (email, password_hash, locale, timezone, role, email_verified_at)
     VALUES ($1, 'x', 'fa', 'Asia/Tehran', 'user', now()) RETURNING id::text AS id`,
    [email],
  );
  const userId = String(rows[0]!["id"]);
  return {
    pool,
    q: query,
    store: new PgAiConfigStore(pool as never),
    userId,
    cleanup: async () => {
      await query(`DELETE FROM ai_feedback WHERE user_id = $1`, [userId]);
      await query(`DELETE FROM ai_coaching_logs WHERE user_id = $1`, [userId]);
      await query(`DELETE FROM users WHERE id = $1`, [userId]);
      await prepared.close();
    },
  };
}

test("PG-AI: 0028's seed statements are idempotent and carry Legacy's default posture", { skip: SKIP }, async () => {
  const ctx = await setup();
  try {
    // The shared harness TRUNCATEs every application table, so the seeded rows are
    // gone by design. What is worth proving is the seed SQL itself: 0028's two
    // INSERT … ON CONFLICT DO NOTHING blocks, run twice, must produce Legacy's
    // posture exactly once — an operator's later decision must never be
    // overwritten by a re-run, and the chain must be gemini then the LOCAL OCR
    // fallback, which is the whole point of the fallback existing.
    const seeds = [
      `INSERT INTO ai_feature_routes (feature, provider, model, priority, enabled, route)
       VALUES ('screenshot_extraction', 'gemini', NULL, 1, true, NULL),
              ('screenshot_extraction', 'tesseract', NULL, 2, true, NULL)
       ON CONFLICT (feature, provider) DO NOTHING`,
      `INSERT INTO ai_feature_flags (feature_name, enabled, rollout_percentage) VALUES
         ('ai_screenshot_extraction', true,  100),
         ('ai_trade_analysis',        false, 0),
         ('ai_weekly_report',         false, 0),
         ('ai_assistant',             false, 0)
       ON CONFLICT (feature_name) DO NOTHING`,
      `INSERT INTO ai_provider_quotas (provider, quota_limit) VALUES
         ('gemini', 1500), ('openai', 1500), ('tesseract', 100000)
       ON CONFLICT (provider) DO NOTHING`,
    ];
    for (const sql of seeds) {
      await ctx.q(sql);
      await ctx.q(sql, );
    }
    const chain = await ctx.store.chainFor("screenshot_extraction");
    assert.deepEqual(chain.map((r) => `${r.provider}:${r.priority}`), ["gemini:1", "tesseract:2"]);
    const flags = await ctx.store.listFlags();
    const byName = new Map(flags.map((f) => [f.featureName, f]));
    assert.equal(byName.get("ai_screenshot_extraction")?.enabled, true);
    assert.equal(byName.get("ai_screenshot_extraction")?.rolloutPercentage, 100);
    assert.equal(byName.get("ai_trade_analysis")?.enabled, false, "analysis is off until an operator switches it on");
    assert.equal(byName.get("ai_assistant")?.enabled, false);
    const quotas = await ctx.store.quotas();
    assert.equal(quotas.find((x) => x.provider === "gemini")?.quotaLimit, 1500, "Gemini free tier = 1500/day");
    assert.equal(quotas.find((x) => x.provider === "tesseract")?.quotaLimit, 100000, "local OCR is counted but effectively unbounded");
    // An operator's decision survives a re-run of the seed.
    await ctx.store.setFlag("ai_trade_analysis", true, 25, ctx.userId);
    await ctx.q(seeds[1]!);
    assert.equal((await ctx.store.flag("ai_trade_analysis"))?.rolloutPercentage, 25, "a re-run must not overwrite a decision");
  } finally {
    await ctx.cleanup();
  }
});

test("PG-AI: the closed vocabularies refuse a provider, feature, route or flag nobody declared", { skip: SKIP }, async () => {
  const ctx = await setup();
  try {
    const bad: [string, unknown[]][] = [
      ["INSERT INTO ai_feature_routes (feature, provider) VALUES ('trade_analysis', 'claude')", []],
      ["INSERT INTO ai_feature_routes (feature, provider) VALUES ('not_a_feature', 'gemini')", []],
      ["INSERT INTO ai_feature_routes (feature, provider, route) VALUES ('trade_analysis', 'gemini', 'carrier_pigeon')", []],
      ["INSERT INTO ai_feature_routes (feature, provider, priority) VALUES ('trade_analysis', 'gemini', 0)", []],
      ["INSERT INTO ai_feature_flags (feature_name) VALUES ('not_an_ai_flag')", []],
      ["INSERT INTO ai_feature_flags (feature_name, rollout_percentage) VALUES ('ai_assistant', 150)", []],
      ["INSERT INTO ai_provider_quotas (provider) VALUES ('anthropic')", []],
      ["INSERT INTO ai_platform_secrets (secret_key, enc_version, key_version, algorithm, iv, auth_tag, secret_ciphertext) VALUES ('STRIPE_KEY', 1, 1, 'aes-256-gcm', '\\x000102030405060708090a0b', '\\x000102030405060708090a0b0c0d0e0f', '\\xaa')", []],
      ["INSERT INTO ai_settings (setting_key, setting_value) VALUES ('ai_route_default', 'via_satellite')", []],
      ["INSERT INTO ai_provider_credentials (provider, status, verified) VALUES ('gemini', 'INVALID_CREDENTIAL', true)", []],
    ];
    for (const [sql, params] of bad) {
      await assert.rejects(() => ctx.q(sql, params), isPgRejection, `engine must refuse: ${sql.slice(0, 70)}`);
    }
  } finally {
    await ctx.cleanup();
  }
});

test("PG-AI: one entry per provider per feature, so a chain is an order and not a multiset", { skip: SKIP }, async () => {
  const ctx = await setup();
  try {
    await ctx.store.upsertRoute({ feature: "trade_analysis", provider: "gemini", model: null, priority: 1, enabled: true, route: null });
    // The same pair again is an UPDATE, not a second row.
    await ctx.store.upsertRoute({ feature: "trade_analysis", provider: "gemini", model: "gemini-2.5-pro", priority: 3, enabled: true, route: "direct" });
    const rows = await ctx.store.chainFor("trade_analysis");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.model, "gemini-2.5-pro");
    assert.equal(rows[0]!.priority, 3);
    assert.equal(rows[0]!.route, "direct");
  } finally {
    await ctx.cleanup();
  }
});

test("PG-AI: a disabled entry leaves the chain, and reorder is atomic", { skip: SKIP }, async () => {
  const ctx = await setup();
  try {
    const a = await ctx.store.upsertRoute({ feature: "weekly_report", provider: "gemini", model: null, priority: 1, enabled: true, route: null });
    const b = await ctx.store.upsertRoute({ feature: "weekly_report", provider: "openai", model: null, priority: 2, enabled: true, route: null });
    assert.deepEqual((await ctx.store.chainFor("weekly_report")).map((r) => r.provider), ["gemini", "openai"]);
    await ctx.store.updateRoute(b.id, { enabled: false });
    assert.deepEqual((await ctx.store.chainFor("weekly_report")).map((r) => r.provider), ["gemini"], "a disabled entry is not a fallback");
    const reordered = await ctx.store.reorder("weekly_report", [b.id, a.id]);
    assert.deepEqual(reordered.map((r) => `${r.provider}:${r.priority}`), ["openai:1", "gemini:2"], "the stored order is the operator's order, including disabled rows");
  } finally {
    await ctx.cleanup();
  }
});

test("PG-AI: the quota reservation is atomic — twenty racers, five units, five winners", { skip: SKIP }, async () => {
  const ctx = await setup();
  try {
    await ctx.store.setQuotaLimit("gemini", 5);
    // Reset the window so the test does not inherit a spent budget.
    await ctx.q(`UPDATE ai_provider_quotas SET daily_used = 0, reset_at = date_trunc('day', now()) + interval '1 day' WHERE provider = 'gemini'`);
    const results = await Promise.all(Array.from({ length: 20 }, () => ctx.store.reserveQuota("gemini")));
    const granted = results.filter((r) => r !== null).length;
    assert.equal(granted, 5, "exactly the budget, never one more");
    const rows = await ctx.q(`SELECT daily_used, quota_limit FROM ai_provider_quotas WHERE provider = 'gemini'`);
    assert.equal(Number(rows[0]!["daily_used"]), 5);
    assert.equal(Number(rows[0]!["quota_limit"]), 5);
  } finally {
    await ctx.q(`UPDATE ai_provider_quotas SET daily_used = 0, quota_limit = 1500, reset_at = date_trunc('day', now()) + interval '1 day' WHERE provider = 'gemini'`);
    await ctx.cleanup();
  }
});

test("PG-AI: a rolled-over window resets the counter instead of refusing forever", { skip: SKIP }, async () => {
  const ctx = await setup();
  try {
    await ctx.store.setQuotaLimit("openai", 1);
    await ctx.q(`UPDATE ai_provider_quotas SET daily_used = 1, reset_at = date_trunc('day', now()) - interval '1 day' WHERE provider = 'openai'`);
    const first = await ctx.store.reserveQuota("openai");
    assert.notEqual(first, null, "yesterday's spent budget must not block today");
    assert.equal(first!.dailyUsed, 1);
    const second = await ctx.store.reserveQuota("openai");
    assert.equal(second, null, "and today's limit still holds");
  } finally {
    await ctx.q(`UPDATE ai_provider_quotas SET daily_used = 0, quota_limit = 1500, reset_at = date_trunc('day', now()) + interval '1 day' WHERE provider = 'openai'`);
    await ctx.cleanup();
  }
});

test("PG-AI: the encrypted envelope survives bytea and the nonce cannot be reused", { skip: SKIP }, async () => {
  const ctx = await setup();
  try {
    const key = MasterKey.fromBase64(Buffer.alloc(32, 7).toString("base64"), 1);
    const envelope = encryptCredential("AIza-real-shaped-key-value", key);
    await ctx.store.writeSecret("GEMINI_API_KEY", envelope, ctx.userId);
    const read = await ctx.store.readSecret("GEMINI_API_KEY");
    assert.ok(read !== null);
    assert.equal(decryptCredential(read!, key), "AIza-real-shaped-key-value");
    assert.deepEqual([...read!.iv], [...envelope.iv], "bytea round-trips byte for byte");
    // The same IV under the same key version is refused by the engine.
    await assert.rejects(
      () => ctx.q(
        `INSERT INTO ai_platform_secrets (secret_key, enc_version, key_version, algorithm, iv, auth_tag, secret_ciphertext)
         VALUES ('OPENAI_API_KEY', $1, $2, $3, $4, $5, $6)`,
        [envelope.version, envelope.keyVersion, envelope.algorithm, envelope.iv, envelope.authTag, envelope.ciphertext],
      ),
      isPgRejection,
    );
    // Replacing the value bumps the row, and the plaintext is never selectable.
    await ctx.store.writeSecret("GEMINI_API_KEY", encryptCredential("rotated-value", key), ctx.userId);
    const rotated = await ctx.store.readSecret("GEMINI_API_KEY");
    assert.equal(decryptCredential(rotated!, key), "rotated-value");
    const columns = await ctx.q(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_platform_secrets'`,
    );
    const names = columns.map((c) => String(c["column_name"]));
    assert.equal(names.includes("value"), false);
    assert.equal(names.includes("plaintext"), false);
    assert.equal(names.includes("secret"), false, "there is no plaintext column to leak");
    assert.equal(await ctx.store.deleteSecret("GEMINI_API_KEY"), true);
    assert.equal(await ctx.store.readSecret("GEMINI_API_KEY"), null);
  } finally {
    await ctx.q(`DELETE FROM ai_platform_secrets`);
    await ctx.cleanup();
  }
});

test("PG-AI: credential metadata derives `verified` from the status and bumps the version on replacement", { skip: SKIP }, async () => {
  const ctx = await setup();
  try {
    const fingerprint = secretFingerprint("key-a", Buffer.alloc(32, 3));
    const first = await ctx.store.recordVerification({ provider: "gemini", status: "VALID", fingerprint, latencyMs: 120 });
    assert.equal(first.verified, true);
    assert.equal(first.version, 1);
    assert.equal(first.fingerprint, fingerprint);
    const same = await ctx.store.recordVerification({ provider: "gemini", status: "VALID", fingerprint, latencyMs: 90 });
    assert.equal(same.version, 1, "re-probing the SAME value is not a replacement");
    const replaced = await ctx.store.recordVerification({
      provider: "gemini", status: "UNVERIFIED", fingerprint: secretFingerprint("key-b", Buffer.alloc(32, 3)),
    });
    assert.equal(replaced.version, 2, "a different value is a replacement");
    assert.equal(replaced.verified, false);
    const invalid = await ctx.store.recordVerification({ provider: "gemini", status: "INVALID_CREDENTIAL", errorCode: "UPSTREAM_AUTH", latencyMs: 40 });
    assert.equal(invalid.verified, false);
    // The engine, not the caller, keeps the two columns coherent.
    await assert.rejects(
      () => ctx.q(`UPDATE ai_provider_credentials SET verified = true WHERE provider = 'gemini'`),
      isPgRejection,
    );
  } finally {
    await ctx.q(`DELETE FROM ai_provider_credentials`);
    await ctx.cleanup();
  }
});

test("PG-AI: the ledger takes the phase-7 vocabulary and refuses a malformed chain column", { skip: SKIP }, async () => {
  const ctx = await setup();
  try {
    const attempts = new PgAiAttemptStore(ctx.q);
    const stored = await attempts.record({
      userId: ctx.userId,
      feature: "analysis",
      provider: "tesseract",
      model: "tesseract",
      promptVersion: "trade_analysis_v1",
      windowFrom: null,
      windowTo: null,
      tradesAnalyzed: 3,
      insight: { summary: "read locally" },
      tokensIn: null,
      tokensOut: null,
      costMicroUsd: null,
      outcome: "success",
      errorCode: null,
      route: null,
      fallbackIndex: 1,
      latencyMs: 42,
      inputHash: "a".repeat(64),
    });
    assert.ok(stored.id !== "");
    const rows = await ctx.q(`SELECT provider, feature, route, fallback_index, latency_ms, input_hash FROM ai_coaching_logs WHERE id = $1`, [stored.id]);
    assert.equal(String(rows[0]!["provider"]), "tesseract", "0028 widened the provider vocabulary for the local OCR fallback");
    assert.equal(Number(rows[0]!["fallback_index"]), 1);
    assert.equal(Number(rows[0]!["latency_ms"]), 42);
    for (const [column, value] of [["route", "carrier_pigeon"], ["fallback_index", -1], ["latency_ms", -5], ["input_hash", "not-a-hash"]] as [string, unknown][]) {
      await assert.rejects(
        () => ctx.q(`UPDATE ai_coaching_logs SET ${column} = $1 WHERE id = $2`, [value, stored.id]),
        isPgRejection,
        `the engine must refuse ${column} = ${String(value)}`,
      );
    }
  } finally {
    await ctx.cleanup();
  }
});

test("PG-AI: feedback refuses a correction that changes nothing", { skip: SKIP }, async () => {
  const ctx = await setup();
  try {
    await assert.rejects(
      () => ctx.q(
        `INSERT INTO ai_feedback (user_id, feature, original, corrected, changed_fields)
         VALUES ($1, 'screenshot_extraction', '{"lot":"0.10"}'::jsonb, '{"lot":"0.10"}'::jsonb, '[]'::jsonb)`,
        [ctx.userId],
      ),
      isPgRejection,
    );
    const row = await ctx.store.createFeedback({
      userId: ctx.userId, attemptId: null, feature: "screenshot_extraction",
      original: { lot: "0.10", symbol: "XAUUSD" }, corrected: { lot: "0.20", symbol: "XAUUSD" },
      changedFields: ["lot"],
    });
    assert.equal(row.id !== "", true);
    const mine = await ctx.store.feedbackFor(ctx.userId, 10);
    assert.equal(mine.length, 1);
    assert.deepEqual(mine[0]!.changedFields, ["lot"]);
  } finally {
    await ctx.cleanup();
  }
});

test("PG-AI: the usage drilldown reads the ONE ledger and totals it correctly", { skip: SKIP }, async () => {
  const ctx = await setup();
  try {
    const attempts = new PgAiAttemptStore(ctx.q);
    for (const [feature, provider, outcome, tokens, cost, latency] of [
      ["analysis", "gemini", "success", 100, 500, 1200],
      ["analysis", "gemini", "error", 0, 0, 300],
      ["report", "gemini", "success", 200, 900, 2200],
      ["ocr", "tesseract", "success", 0, 0, 800],
    ] as [string, string, string, number, number, number][]) {
      await attempts.record({
        userId: ctx.userId, feature: feature as never, provider: provider as never, model: "m",
        promptVersion: "v1", windowFrom: null, windowTo: null, tradesAnalyzed: null,
        insight: outcome === "success" ? { summary: "x" } : {}, tokensIn: tokens, tokensOut: 0,
        costMicroUsd: cost, outcome: outcome as never, errorCode: outcome === "error" ? "PROVIDER_ERROR" : null,
        latencyMs: latency,
      });
    }
    const ledger = new PgAiLedger(ctx.q);
    const all = await ledger.usage({ limit: 25 });
    assert.equal(all.total, 4);
    assert.equal(all.totals.successes, 3);
    assert.equal(all.totals.errors, 1);
    assert.equal(all.totals.tokensIn, 300);
    assert.equal(all.totals.costMicroUsd, 1400);
    const filtered = await ledger.usage({ feature: "analysis", limit: 25 });
    assert.equal(filtered.total, 2);
    const byProvider = await ledger.usage({ provider: "tesseract", limit: 25 });
    assert.equal(byProvider.total, 1);
    // The user-facing reader only ever returns the caller's own rows.
    const mine = await ledger.forUser(ctx.userId, ["analysis", "report"], 10);
    assert.equal(mine.length, 3);
    assert.equal(mine.every((r) => r.feature === "analysis" || r.feature === "report"), true);
    assert.equal((await ledger.forUser(ctx.userId, ["not_a_feature"], 10)).length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test("PG-AI: settings hold the admin route and refuse anything outside the allowlist", { skip: SKIP }, async () => {
  const ctx = await setup();
  try {
    assert.equal(await ctx.store.setting("ai_route_default"), null);
    await ctx.store.setSetting("ai_route_default", "n8n_relay", ctx.userId);
    assert.equal(await ctx.store.setting("ai_route_default"), "n8n_relay");
    await assert.rejects(
      () => ctx.q(`UPDATE ai_settings SET setting_value = 'direct_but_cheaper' WHERE setting_key = 'ai_route_default'`),
      isPgRejection,
    );
    assert.equal(await ctx.store.deleteSetting("ai_route_default"), true);
    assert.equal(await ctx.store.setting("ai_route_default"), null);
  } finally {
    await ctx.cleanup();
  }
});
