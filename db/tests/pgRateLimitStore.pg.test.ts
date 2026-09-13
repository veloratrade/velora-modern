// PgRateLimitStore real-PostgreSQL battery — Phase D D2.
//
// EVIDENCE LABEL (Phase D policy): executes ONLY against a REAL, disposable
// PostgreSQL (DATABASE_URL — postgres-evidence workflow). Without it, every
// test is SKIPPED. Proves on real PostgreSQL: PHP-parity window semantics
// (anchored first hit, preserved on increment, own-window expiry reset),
// single-row PK upserts, the 48h hygiene sweep, the atomic single-statement
// ON CONFLICT shape (no lost increments under concurrent load), and the
// FixedWindowRateLimiter composition boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createEngine, migrate } from "../migrate.ts";
import { PgRateLimitStore } from "../../apps/api/src/ratelimits/pgRateLimitStore.ts";
import { FixedWindowRateLimiter } from "../../apps/api/src/ratelimits/rateLimiter.ts";
import type { Pool } from "pg";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const PG_URL = process.env.DATABASE_URL;
const SKIP = PG_URL === undefined
  ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)"
  : false;

async function harness(): Promise<{ pool: Pool; store: PgRateLimitStore; close: () => Promise<void> }> {
  const { Pool } = await import("pg");
  const engine = await createEngine(PG_URL);
  await migrate(engine, MIGRATIONS);
  await engine.close();
  const pool = new Pool({ connectionString: PG_URL });
  return { pool, store: new PgRateLimitStore(pool), close: () => pool.end() };
}

test("PG: upsert round-trips — increments preserve window_start; single row per bucket", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const first = await h.store.hit("pg:rl:login|203.0.113.9", { windowSec: 300 }, 10_000);
    assert.equal(first.hits, 1);
    assert.equal(first.windowStartMs, 10_000);
    const second = await h.store.hit("pg:rl:login|203.0.113.9", { windowSec: 300 }, 20_000);
    assert.equal(second.hits, 2);
    assert.equal(second.windowStartMs, 10_000, "window anchored at the first hit");
    const rows = await h.pool.query("SELECT COUNT(*)::int AS n FROM rate_limits WHERE bucket LIKE 'pg:rl:%'");
    assert.ok(rows.rows[0].n >= 1);
    const one = await h.pool.query("SELECT bucket, hits FROM rate_limits WHERE bucket = $1", ["pg:rl:login|203.0.113.9"]);
    assert.equal(one.rows.length, 1, "PK upsert — never duplicates");
  } finally {
    await h.close();
  }
});

test("PG: expired window resets (hits=1, new window_start); exactly-at-edge keeps the window", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await h.store.hit("pg:rl:register|198.51.100.1", { windowSec: 3600 }, 0);
    const edge = await h.store.hit("pg:rl:register|198.51.100.1", { windowSec: 3600 }, 3_600_000);
    assert.equal(edge.hits, 2, "window_start exactly windowSec old is NOT expired (strict <)");
    const reset = await h.store.hit("pg:rl:register|198.51.100.1", { windowSec: 3600 }, 3_600_001);
    assert.equal(reset.hits, 1, "one millisecond past the window resets");
    assert.equal(reset.windowStartMs, 3_600_001);
  } finally {
    await h.close();
  }
});

test("PG: a longer-policy bucket is not shortened by another bucket's window (PHP comment parity)", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await h.store.hit("pg:rl:register|1.2.3.4", { windowSec: 3600 }, 0);
    await h.store.hit("pg:rl:login|1.2.3.4", { windowSec: 300 }, 400_000); // different bucket, shorter policy
    const stillRegister = await h.store.hit("pg:rl:register|1.2.3.4", { windowSec: 3600 }, 400_000);
    assert.equal(stillRegister.hits, 2, "same one-hour window — expiry uses the bucket's OWN policy");
    assert.equal(stillRegister.windowStartMs, 0);
  } finally {
    await h.close();
  }
});

test("PG: 48h stale sweep removes ancient rows", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await h.store.hit("pg:rl:stale|9.9.9.9", { windowSec: 300 }, 0);
    await h.store.hit("pg:rl:sweep|8.8.8.8", { windowSec: 300 }, 176_400_000); // any hit 49h later sweeps
    const rows = await h.pool.query("SELECT COUNT(*)::int AS n FROM rate_limits WHERE bucket = $1", ["pg:rl:stale|9.9.9.9"]);
    assert.equal(rows.rows[0].n, 0, "ancient bucket swept");
  } finally {
    await h.close();
  }
});

test("PG: ATOMICITY — 12 concurrent hits on one fresh bucket: no lost or duplicated increments", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const bucket = "pg:rl:race|203.0.113.77";
    const states = await Promise.all(
      Array.from({ length: 12 }, () => h.store.hit(bucket, { windowSec: 300 }, 5_000)),
    );
    const hits = states.map((s) => s.hits).sort((a, b) => a - b);
    assert.deepEqual(hits, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "each hit observes a distinct, gap-free count");
    for (const s of states) assert.equal(s.windowStartMs, 5_000, "window start never moves");
    const row = await h.pool.query("SELECT hits FROM rate_limits WHERE bucket = $1", [bucket]);
    assert.equal(Number(row.rows[0].hits), 12, "final stored count is exact");
  } finally {
    await h.close();
  }
});

test("PG: composition — FixedWindowRateLimiter over the PG store blocks at limit+1 with the right Retry-After", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    let now = 1_000_000;
    const limiter = new FixedWindowRateLimiter(h.store, () => now);
    for (let i = 1; i <= 8; i++) {
      assert.deepEqual(await limiter.hit("pg:rl:auth", "203.0.113.7"), { allowed: true });
    }
    assert.deepEqual(await limiter.hit("pg:rl:auth", "203.0.113.7"), {
      allowed: false,
      retryAfterSec: 300,
    }, "limit-th attempt allowed, (limit+1)-th blocked (PHP parity)");
    now += 300_001; // past the window → fresh window over the SAME store
    assert.deepEqual(await limiter.hit("pg:rl:auth", "203.0.113.7"), { allowed: true });
  } finally {
    await h.close();
  }
});
