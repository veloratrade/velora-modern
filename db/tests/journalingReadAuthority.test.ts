// Journaling READ authority: the 0022 parity mirrors must not outrank the columns the modern
// write path maintains.
//
// EVIDENCE LABEL: real application boundary (PgAnalyticsStore and PgPortfolioStore, constructed
// exactly as server-main.ts constructs them) against a DISPOSABLE PGlite instance (PostgreSQL
// semantics in-wasm) with the real migrations applied. PGlite evidence — NOT real-PostgreSQL,
// NOT production.
//
// WHY THIS EXISTS. `trades.strategy` and `trades.emotion` are the columns the write path
// maintains. `trades.strategy_tag` and `trades.emotional_score` are the 0022 legacy-parity MIRRORS
// that the modern path never populates. Three report reads COALESCEd them mirror-first, so a
// broker-imported label could outlive the user's own edit — and an edit made through the Telegram
// /trade card (which writes the authoritative column only) would look like it did nothing.
// Owner decision 2026-10-18: reads follow the authoritative column, the mirrors stay documented
// as legacy-only, and no sync migration is invented to paper over the divergence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createEngine, migrate } from "../migrate.ts";
import { PgAnalyticsStore } from "../../apps/api/src/analytics/analyticsStore.ts";
import { PgPortfolioStore } from "../../apps/api/src/portfolio/portfolioRoutes.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

/** Rows-as-array QueryFn, the same shape the production composition root passes. */
function queryFn(engine: { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }) {
  return async (sql: string, params: readonly unknown[] = []) => (await engine.query(sql, [...params])).rows;
}

async function seeded(): Promise<{ engine: Awaited<ReturnType<typeof createEngine>>; userId: string; tag: string }> {
  const engine = await createEngine();
  await migrate(engine, MIGRATIONS);
  const stamp = String(process.hrtime.bigint());
  const email = `read-authority-${stamp}@velora.test`;
  const users = await engine.query("INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id", [email]);
  const userId = String(users.rows[0]?.["id"]);
  const accounts = await engine.query(
    `INSERT INTO trading_accounts (user_id, external_account_id, broker_server, metaapi_account_id)
     VALUES ($1,$2,'read-authority','read-authority') RETURNING id`,
    [userId, `ra-${stamp}`],
  );
  const accountId = String(accounts.rows[0]?.["id"]);
  await engine.query(
    `INSERT INTO trades (user_id, account_id, symbol, direction, status, entry_price, volume, occurred_at)
     VALUES ($1,$2,'EURUSD','buy','OPEN','1.10000000','1.00000000', now())`,
    [userId, accountId],
  );
  return { engine, userId, tag: `ra-${stamp}` };
}

test("read authority: a modern edit wins over the legacy strategy mirror in every report read", async () => {
  const { engine, userId } = await seeded();
  try {
    const q = queryFn(engine);
    await engine.query(
      `UPDATE trades SET strategy = 'Modern edit', strategy_tag = 'LEGACY mirror', emotion = 4, emotional_score = NULL
        WHERE user_id = $1`,
      [userId],
    );

    const listed = await new PgAnalyticsStore(q).listTrades({ userId, from: null, to: null, accountId: null });
    assert.ok(listed.length > 0, "the analytics read found no trade — fixture is wrong, not the query");
    assert.deepEqual(
      [...new Set(listed.map((r) => r.strategy))],
      ["Modern edit"],
      "the analytics read still prefers the 0022 mirror over the authoritative column",
    );

    const byAccount = await new PgPortfolioStore(q).tradesByAccount(userId);
    assert.deepEqual(
      [...new Set(byAccount.map((r) => r.strategy))],
      ["Modern edit"],
      "the portfolio-by-account read still prefers the 0022 mirror",
    );

    // The emotion half of the same decision: the authoritative column is what a reader sees, and
    // the untouched mirror must not contradict it into looking unwritten.
    const raw = await engine.query("SELECT emotion, emotional_score FROM trades WHERE user_id = $1", [userId]);
    assert.equal(Number(raw.rows[0]?.["emotion"]), 4, "emotion (authoritative) must carry the score");
    assert.equal(raw.rows[0]?.["emotional_score"], null, "the mirror must stay untouched by a modern write");
  } finally {
    await engine.close();
  }
});

test("read authority: the mirror is a fallback, so legacy-imported rows keep their label", async () => {
  const { engine, userId } = await seeded();
  try {
    const q = queryFn(engine);
    // A row imported from the legacy contract has ONLY strategy_tag. Flipping the coalesce order
    // without the fallback would blank real imported history — that is the other half of the fix.
    await engine.query(`UPDATE trades SET strategy = NULL, strategy_tag = 'LEGACY mirror' WHERE user_id = $1`, [userId]);
    const listed = await new PgAnalyticsStore(q).listTrades({ userId, from: null, to: null, accountId: null });
    assert.deepEqual([...new Set(listed.map((r) => r.strategy))], ["LEGACY mirror"]);
    const byAccount = await new PgPortfolioStore(q).tradesByAccount(userId);
    assert.deepEqual([...new Set(byAccount.map((r) => r.strategy))], ["LEGACY mirror"]);
  } finally {
    await engine.close();
  }
});

test("read authority: no report read puts the mirror first", async () => {
  // Source-text pin, deliberately: the third mirror-first site lived inside PgTenancyStore's private
  // profile builder, whose fixture plumbing (public_profiles + visibility) costs more to stand up
  // than the one-line order it proves. This guard fails the moment anyone re-flips it.
  const offenders: string[] = [];
  for (const file of [
    "apps/api/src/analytics/analyticsStore.ts",
    "apps/api/src/portfolio/portfolioRoutes.ts",
    "apps/api/src/tenancy/tenancyRoutes.ts",
  ]) {
    const text = readFileSync(join(import.meta.dirname, "..", "..", file), "utf8");
    if (/COALESCE\(\s*t?\.*strategy_tag\s*,\s*t?\.*strategy\s*\)/.test(text)) offenders.push(file);
    if (/COALESCE\(\s*emotional_score\s*,\s*emotion\s*\)/.test(text)) offenders.push(`${file} (emotion)`);
  }
  assert.deepEqual(offenders, [], `these reads prefer the 0022 mirror over the authoritative column: ${offenders.join(", ")}`);
});
