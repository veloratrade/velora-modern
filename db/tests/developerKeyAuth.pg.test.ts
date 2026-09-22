// DEVELOPER-KEY authentication battery — real PostgreSQL (v3.0, R-5/R-11).
//
// EVIDENCE LABEL (Phase D policy): executes ONLY against a REAL, disposable
// PostgreSQL (DATABASE_URL — postgres-evidence workflow). Without it, every test
// is SKIPPED.
//
// The HTTP battery (`apps/api/src/developer/developerKeyHttp.test.ts`) proves the
// kernel's behaviour with an in-memory key lookup. THIS battery proves the part
// that battery cannot: that the authority is the ROW in `developer_api_keys` —
// the hash lookup, the revocation flag, the stored scope list, the stored
// `rate_limit_per_min`, and the throttled `last_used_at` bookkeeping all behave
// as claimed against real SQL, and that the guard composed over a real
// PostgreSQL rate-limit store enforces the per-key window across processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { prepareDatabase } from "./support/pgTestDb.ts";
import {
  DeveloperKeyAuth,
  PgDeveloperKeyLookup,
  hashDeveloperKey,
  looksLikeDeveloperKey,
} from "../../apps/api/src/developer/developerAuth.ts";
import { PgRateLimitStore } from "../../apps/api/src/ratelimits/pgRateLimitStore.ts";
import type { QueryFn } from "../../apps/api/src/persistence/pg.ts";
import type { Pool } from "pg";

const PG_URL = process.env.DATABASE_URL;
const SKIP = PG_URL === undefined
  ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)"
  : false;

interface Harness {
  pool: Pool;
  lookup: PgDeveloperKeyLookup;
  limiter: PgRateLimitStore;
  userId: string;
  /** Mint a key row exactly as the lifecycle route does (hash only). */
  issue: (input: { secret: string; scopes: string[]; rateLimitPerMin?: number; revoked?: boolean }) => Promise<string>;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const { Pool } = await import("pg");
  await (await prepareDatabase(PG_URL as string)).close();
  const pool = new Pool({ connectionString: PG_URL });
  const user = await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id::text AS id",
    ["devkey@velora.test", "x"],
  );
  const userId = String((user.rows[0] as { id: string }).id);
  const q: QueryFn = async (sql, params) => (await pool.query(sql, params as unknown[])).rows;

  return {
    pool,
    lookup: new PgDeveloperKeyLookup(q),
    limiter: new PgRateLimitStore(pool),
    userId,
    issue: async ({ secret, scopes, rateLimitPerMin = 100, revoked = false }) => {
      const prefix = secret.slice(0, 8);
      const rows = await pool.query(
        `INSERT INTO developer_api_keys
           (user_id, name, key_prefix, key_hash, scopes, rate_limit_per_min, revoked_at)
         VALUES ($1,'battery',$2,$3,$4::text[],$5,$6)
         RETURNING id::text AS id`,
        [userId, prefix, hashDeveloperKey(secret), scopes, rateLimitPerMin, revoked ? new Date() : null],
      );
      return String((rows.rows[0] as { id: string }).id);
    },
    close: () => pool.end(),
  };
}

const SECRET_A = "aaaaaaaa_a".padEnd(41, "b");
const bearer = (secret: string): IncomingMessage =>
  ({ headers: { authorization: `Bearer ${secret}` } } as unknown as IncomingMessage);

const guardFor = (h: Harness) => new DeveloperKeyAuth({ lookup: h.lookup, limiter: h.limiter });

test("PG: a live key resolves to its owner, scopes and stored limit", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const id = await h.issue({ secret: SECRET_A, scopes: ["trades:read", "analytics:read"], rateLimitPerMin: 7 });
    const principal = await h.lookup.findByHash(hashDeveloperKey(SECRET_A));
    assert.ok(principal);
    assert.equal(principal.keyId, id);
    assert.equal(principal.userId, h.userId);
    assert.deepEqual([...principal.scopes].sort(), ["analytics:read", "trades:read"]);
    assert.equal(principal.rateLimitPerMin, 7, "the LIMIT comes from the row, not from a default in code");

    // The hash is what is stored: the plaintext never appears in the table.
    const stored = await h.pool.query("SELECT key_hash, key_prefix FROM developer_api_keys WHERE id = $1::bigint", [id]);
    assert.equal(stored.rows[0].key_hash, hashDeveloperKey(SECRET_A));
    assert.ok(!JSON.stringify(stored.rows[0]).includes(SECRET_A), "plaintext is never persisted");
    assert.equal(stored.rows[0].key_prefix, SECRET_A.slice(0, 8), "only the display prefix is stored in the clear");
  } finally {
    await h.close();
  }
});

test("PG: revoked and unknown keys are indistinguishable (both null)", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await h.issue({ secret: SECRET_A, scopes: ["trades:read"], revoked: true });
    assert.equal(await h.lookup.findByHash(hashDeveloperKey(SECRET_A)), null, "revoked ⇒ unresolvable");
    assert.equal(await h.lookup.findByHash(hashDeveloperKey("ffffffff_z".padEnd(41, "z"))), null, "unknown ⇒ unresolvable");

    // Revocation is a state of the ROW, so re-reading after a revoke sees it.
    const second = "bbbbbbbb_c".padEnd(41, "d");
    const id = await h.issue({ secret: second, scopes: ["trades:read"] });
    assert.notEqual(await h.lookup.findByHash(hashDeveloperKey(second)), null);
    await h.pool.query("UPDATE developer_api_keys SET revoked_at = now() WHERE id = $1::bigint", [id]);
    assert.equal(await h.lookup.findByHash(hashDeveloperKey(second)), null, "revocation is immediate");
  } finally {
    await h.close();
  }
});

test("PG: `last_used_at` is throttled bookkeeping, never an authorization input", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const id = await h.issue({ secret: SECRET_A, scopes: ["trades:read"] });
    const readLastUsed = async (): Promise<Date | null> =>
      ((await h.pool.query("SELECT last_used_at FROM developer_api_keys WHERE id = $1::bigint", [id])).rows[0]
        .last_used_at as Date | null);

    assert.equal(await readLastUsed(), null, "a never-used key is still usable (it just says so)");
    await h.lookup.touchLastUsed(id);
    const first = await readLastUsed();
    assert.ok(first instanceof Date);

    // Immediately again: the UPDATE's own WHERE clause refuses to move it, so a
    // read-heavy key cannot turn every request into a write.
    await h.lookup.touchLastUsed(id);
    const second = await readLastUsed();
    assert.equal(second?.getTime(), first?.getTime(), "at most one touch per minute");

    // After the throttle window the touch moves it again.
    await h.pool.query("UPDATE developer_api_keys SET last_used_at = now() - interval '2 minutes' WHERE id = $1::bigint", [id]);
    await h.lookup.touchLastUsed(id);
    const third = await readLastUsed();
    assert.ok(third !== null && third.getTime() > (first as Date).getTime(), "the throttle only delays bookkeeping");
  } finally {
    await h.close();
  }
});

test("PG: the guard authorizes the stored scopes and refuses everything else", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await h.issue({ secret: SECRET_A, scopes: ["trades:read"], rateLimitPerMin: 100 });
    const auth = guardFor(h);

    const allowed = await auth.guard({ req: bearer(SECRET_A), method: "GET", path: "/api/v1/trades", requestId: "r1" });
    assert.equal(allowed.blocked, null);
    assert.deepEqual(allowed.principal, { sub: h.userId, role: "user" }, "the key acts as its owner, least privileged");

    // Out of the key's scope: 403 with the exact missing scope, no fallback.
    const missing = await auth.guard({ req: bearer(SECRET_A), method: "POST", path: "/api/v1/trades", requestId: "r2" });
    assert.equal(missing.blocked?.status, 403);
    const refusal = missing.blocked?.body as { status: string; data: null; error: { code: string; details?: Record<string, string> } };
    assert.equal(refusal.status, "error");
    assert.equal(refusal.error.code, "FORBIDDEN");
    assert.deepEqual(refusal.error.details, { required_scope: "trades:write" }, "the refusal names the scope it needs");
    assert.equal(missing.principal, null, "a refused key never becomes a principal");

    // Outside the frozen vocabulary entirely — including admin and the key's own
    // management surface.
    for (const path of ["/api/v1/admin/rbac/self", "/api/v1/developer/keys", "/api/v1/billing/subscription"]) {
      const refused = await auth.guard({ req: bearer(SECRET_A), method: "GET", path, requestId: "r3" });
      assert.equal(refused.blocked?.status, 403, path);
    }

    // A session token is not this guard's business: it returns null and lets the
    // session path run unchanged (the credential classes are disjoint by shape).
    // The token is minted by the real service rather than spelled out, so this
    // battery also proves the guard ignores a GENUINE JWT.
    const { JwtService } = await import("../../apps/api/src/auth/jwt.ts");
    const jwt = JwtService.create("developer-key-pg-battery-secret-0123456789").sign({ sub: h.userId, role: "user" }, 900);
    assert.equal(looksLikeDeveloperKey(jwt), false);
    assert.deepEqual(await auth.guard({ req: bearer(jwt), method: "GET", path: "/api/v1/trades", requestId: "r4" }), {
      blocked: null,
      principal: null,
    });
  } finally {
    await h.close();
  }
});

test("PG: the per-key window is enforced by the shared store (limit and Retry-After)", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await h.issue({ secret: SECRET_A, scopes: ["trades:read"], rateLimitPerMin: 2 });
    const auth = guardFor(h);
    const call = () => auth.guard({ req: bearer(SECRET_A), method: "GET", path: "/api/v1/trades", requestId: "rl" });

    assert.equal((await call()).blocked, null);
    assert.equal((await call()).blocked, null);
    const third = await call();
    assert.equal(third.blocked?.status, 429);
    assert.equal(third.blocked?.body.error?.code, "TOO_MANY_REQUESTS");
    assert.ok(Number(third.blocked?.headers?.["Retry-After"]) >= 1, "the window's remaining seconds are reported");

    // The window lives in `rate_limits`, so a SECOND process (a fresh guard with
    // its own in-memory state) sees the same exhaustion.
    const otherProcess = guardFor(h);
    assert.equal((await otherProcess.guard({ req: bearer(SECRET_A), method: "GET", path: "/api/v1/trades", requestId: "rl2" })).blocked?.status, 429);

    // A different key has its own bucket.
    const second = "cccccccc_e".padEnd(41, "f");
    await h.issue({ secret: second, scopes: ["trades:read"], rateLimitPerMin: 2 });
    assert.equal((await guardFor(h).guard({ req: bearer(second), method: "GET", path: "/api/v1/trades", requestId: "rl3" })).blocked, null);

    const buckets = await h.pool.query("SELECT bucket FROM rate_limits WHERE bucket LIKE 'devkey:%' ORDER BY bucket");
    assert.equal(buckets.rows.length, 2, "one bucket per key");
  } finally {
    await h.close();
  }
});

test("PG: the guard's bookkeeping cannot turn a valid request into a failure", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await h.issue({ secret: SECRET_A, scopes: ["trades:read"] });
    // A lookup whose touch ALWAYS fails (the row is gone mid-request) still
    // authorizes: last_used_at is bookkeeping, and the failure is logged.
    const logs: Record<string, unknown>[] = [];
    const auth = new DeveloperKeyAuth({
      lookup: {
        findByHash: (hash) => h.lookup.findByHash(hash),
        touchLastUsed: async () => {
          throw new Error("bookkeeping is down");
        },
      },
      limiter: h.limiter,
      log: (event) => logs.push(event),
    });
    const decision = await auth.guard({ req: bearer(SECRET_A), method: "GET", path: "/api/v1/trades", requestId: "bookkeeping" });
    assert.equal(decision.blocked, null, "a bookkeeping failure is not an authorization failure");
    assert.ok(logs.some((l) => l["event"] === "developer.key_touch_failed"));
  } finally {
    await h.close();
  }
});
