// Rate-limit persistence-boundary integration test — Phase C increment 7.
//
// EVIDENCE LABEL (test honesty rule): this suite runs the REAL domain
// boundary (FixedWindowRateLimiter → RateLimitStore port) against a
// DISPOSABLE PGlite instance (PostgreSQL semantics in-wasm) with the real
// migrations applied (0001 rate_limits table — no new migration). It is
// PGlite evidence — NOT real-PostgreSQL evidence, NOT production evidence.
// Real-PG verification remains deferred to Phase D (S5 boundary).
//
// The PgliteRateLimitStore below is a test-local adapter implementing the
// RateLimitStore port from packages/domain with PHP-shaped SQL (DELETE
// expired-by-own-window, DELETE 48h-stale, INSERT … ON CONFLICT DO UPDATE,
// SELECT) — proving the port is PostgreSQL-compatible and the existing
// rate_limits table contract actually round-trips (no silent schema no-ops).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createEngine, migrate, type MigrationEngine } from "../migrate.ts";
import { FixedWindowRateLimiter } from "../../apps/api/src/ratelimits/rateLimiter.ts";
import type { RateLimitStore } from "@velora/domain";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

class PgliteRateLimitStore implements RateLimitStore {
  constructor(private readonly engine: MigrationEngine) {}

  async hit(
    bucket: string,
    policy: { windowSec: number },
    nowMs: number,
  ): Promise<{ hits: number; windowStartMs: number }> {
    const now = new Date(nowMs);
    const windowStartCutoff = new Date(nowMs - policy.windowSec * 1000);
    const staleCutoff = new Date(nowMs - 172800 * 1000);

    // PHP parity: expire this bucket using its OWN window, then the 48h stale sweep.
    await this.engine.query("DELETE FROM rate_limits WHERE bucket = $1 AND window_start < $2", [
      bucket,
      windowStartCutoff.toISOString(),
    ]);
    await this.engine.query("DELETE FROM rate_limits WHERE window_start < $1", [staleCutoff.toISOString()]);

    // PHP parity: upsert (PostgreSQL ON CONFLICT = the SQLite/MySQL paths).
    await this.engine.query(
      `INSERT INTO rate_limits (bucket, hits, window_start) VALUES ($1, 1, $2)
       ON CONFLICT (bucket) DO UPDATE SET hits = rate_limits.hits + 1`,
      [bucket, now.toISOString()],
    );

    const res = await this.engine.query("SELECT hits, window_start FROM rate_limits WHERE bucket = $1", [bucket]);
    const row = res.rows[0];
    assert.ok(row !== undefined, "bucket row must exist after upsert");
    return {
      hits: Number(row.hits),
      windowStartMs: new Date(String(row.window_start)).getTime(),
    };
  }
}

async function withStore(fn: (store: PgliteRateLimitStore, engine: MigrationEngine) => Promise<void>): Promise<void> {
  const engine = await createEngine();
  const ran = await migrate(engine, MIGRATIONS);
  assert.ok(ran.includes("0001_core.sql"));
  try {
    await fn(new PgliteRateLimitStore(engine), engine);
  } finally {
    await engine.close();
  }
}

test("upsert round-trips: increments preserve window_start; bucket stays a single row", async () => {
  await withStore(async (store, engine) => {
    const first = await store.hit("auth:login|203.0.113.9", { windowSec: 300 }, 10_000);
    assert.equal(first.hits, 1);
    assert.equal(first.windowStartMs, 10_000);
    const second = await store.hit("auth:login|203.0.113.9", { windowSec: 300 }, 20_000);
    assert.equal(second.hits, 2);
    assert.equal(second.windowStartMs, 10_000); // window anchored at the first hit
    const rows = await engine.query("SELECT bucket, hits FROM rate_limits");
    assert.equal(rows.rows.length, 1); // PK upsert — never duplicates
    assert.equal(rows.rows[0]?.bucket, "auth:login|203.0.113.9");
  });
});

test("expired window resets to a fresh one (hits=1, new window_start)", async () => {
  await withStore(async (store) => {
    await store.hit("auth:register|198.51.100.1", { windowSec: 3600 }, 0);
    // simulate the window having elapsed: next hit 3601s later
    const reset = await store.hit("auth:register|198.51.100.1", { windowSec: 3600 }, 3_601_000);
    assert.equal(reset.hits, 1);
    assert.equal(reset.windowStartMs, 3_601_000);
  });
});

test("a longer-policy bucket is not shortened by another bucket's window (PHP comment parity)", async () => {
  await withStore(async (store) => {
    await store.hit("auth:register|1.2.3.4", { windowSec: 3600 }, 0);
    // login hits on the same IP use a 300s policy — they must not expire the register bucket
    await store.hit("auth:login|1.2.3.4", { windowSec: 300 }, 400_000);
    const stillRegister = await store.hit("auth:register|1.2.3.4", { windowSec: 3600 }, 400_000);
    assert.equal(stillRegister.hits, 2); // same one-hour window
    assert.equal(stillRegister.windowStartMs, 0);
  });
});

test("48h stale sweep removes ancient rows", async () => {
  await withStore(async (store, engine) => {
    await store.hit("auth:login|9.9.9.9", { windowSec: 300 }, 0);
    // any hit 49h later sweeps the ancient row
    await store.hit("auth:login|8.8.8.8", { windowSec: 300 }, 176_400_000);
    const rows = await engine.query("SELECT bucket FROM rate_limits WHERE bucket = $1", ["auth:login|9.9.9.9"]);
    assert.equal(rows.rows.length, 0);
  });
});

test("full composition: limiter over the PGlite store blocks at limit+1 with the right Retry-After", async () => {
  await withStore(async (store) => {
    let now = 1_000_000;
    const limiter = new FixedWindowRateLimiter(store, () => now);
    for (let i = 1; i <= 8; i++) {
      assert.deepEqual(await limiter.hit("auth:login", "203.0.113.7"), { allowed: true });
    }
    assert.deepEqual(await limiter.hit("auth:login", "203.0.113.7"), {
      allowed: false,
      retryAfterSec: 300,
    });
    now += 300_001; // past the window → fresh window over the SAME store
    assert.deepEqual(await limiter.hit("auth:login", "203.0.113.7"), { allowed: true });
  });
});
