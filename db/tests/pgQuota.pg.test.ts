// D3 real-PostgreSQL battery — transactional entitlements & account quota.
//
// EVIDENCE LABEL (Phase D policy): executes ONLY against a REAL, disposable
// PostgreSQL (DATABASE_URL — postgres-evidence workflow). Without it, every
// test is SKIPPED. Proves on real PostgreSQL, through the REAL AccountService
// over the real PgAccountStore:
//   - the exact 429 ACCOUNT_QUOTA_EXCEEDED contract (message/code/details)
//   - D3 atomicity: users-row FOR UPDATE + count + insert in ONE transaction
//   - concurrent creation CANNOT exceed the quota — across TWO independent
//     service instances (no shared process state; correctness is the DB's)
//   - unlimited plans are not guarded (Remote semantics)
//   - delete frees the quota slot through the transactional path
//   - DB failure surfaces as failure — never a false success/quota verdict
//   - quota-exceeded transactions leave no partial rows (rollback proof)
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { prepareDatabase } from "./support/pgTestDb.ts";
import { PgAccountStore } from "../../apps/api/src/accounts/pgAccountStore.ts";
import { AccountService, AccountError } from "../../apps/api/src/accounts/accountService.ts";
import type { Pool } from "pg";

const PG_URL = process.env.DATABASE_URL;
const SKIP = PG_URL === undefined
  ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)"
  : false;

const T0 = new Date("2026-09-13T09:00:00.000Z");

async function harness(): Promise<{
  pool: Pool;
  store: PgAccountStore;
  freeUser: string;
  raceUser: string;
  proUser: string;
  svcFree: AccountService;
  svcFree2: AccountService;
  svcPro: AccountService;
  close: () => Promise<void>;
}> {
  const { Pool } = await import("pg");
  // Migrate (idempotent) and reset every application table, so the battery is
  // repeatable against a cluster previous runs have already used.
  await (await prepareDatabase(PG_URL as string)).close();
  const pool = new Pool({ connectionString: PG_URL });
  pool.on("error", () => { /* idle-client socket errors must not crash the battery */ });
  await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1,'x'), ($2,'y'), ($3,'z') ON CONFLICT (email) DO NOTHING",
    ["pgquota-free@velora.test", "pgquota-race@velora.test", "pgquota-pro@velora.test"],
  );
  const ids = await pool.query(
    "SELECT id, email FROM users WHERE email IN ($1,$2,$3)",
    ["pgquota-free@velora.test", "pgquota-race@velora.test", "pgquota-pro@velora.test"],
  );
  const byEmail = new Map<string, string>(
    ids.rows.map((r: { id: string; email: string }) => [r.email, String(r.id)]),
  );
  const freeUser = byEmail.get("pgquota-free@velora.test")!;
  const raceUser = byEmail.get("pgquota-race@velora.test")!;
  const proUser = byEmail.get("pgquota-pro@velora.test")!;
  const plans: Record<string, string> = { [freeUser]: "free", [raceUser]: "free", [proUser]: "pro" };
  const mkService = () =>
    new AccountService({
      store: new PgAccountStore(pool),
      getPlan: async (userId) => plans[userId] ?? "free",
      now: () => T0,
    });
  return {
    pool,
    store: new PgAccountStore(pool),
    freeUser,
    raceUser,
    proUser,
    svcFree: mkService(),
    svcFree2: mkService(), // independent instance — no shared process state
    svcPro: mkService(),
    close: () => pool.end(),
  };
}

test("PG: D3 quota — normal create works, second create → EXACT 429 contract", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const a = await h.svcFree.createAccount(h.freeUser, { provider: "MT5", label: "Primary" });
    assert.equal(a.provider, "MT5");
    assert.equal(a.platform, "MT5"); // platform mirrors provider (service contract)
    assert.equal(a.timezoneSource, "unknown");
    assert.equal(a.status, "disconnected");
    assert.match(a.id, /^\d+$/);

    await assert.rejects(
      h.svcFree.createAccount(h.freeUser, { provider: "MT4", label: "Second" }),
      (e: unknown) => {
        assert.ok(e instanceof AccountError, `must be AccountError, got ${String(e)}`);
        assert.equal(e.status, 429);
        assert.equal(e.code, "ACCOUNT_QUOTA_EXCEEDED");
        assert.equal(e.message, "Trading account quota exceeded. Free plan allows up to 1 trading account.");
        assert.deepEqual(e.details, {
          messageKey: "errors.accounts.quotaExceeded",
          plan: "free",
          currentCount: 1,
          maxAllowed: 1,
        });
        return true;
      },
      "quota-exceeded must produce the exact existing API contract",
    );
    assert.equal(await h.store.countByUser(h.freeUser), 1, "no partial account written by the rejected create");
  } finally {
    await h.close();
  }
});

test("PG: D3 CONCURRENT — free plan (max 1): 8 creates across TWO service instances → exactly one success", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    // Two independent AccountService instances (separate mutex maps, separate
    // store objects, one shared pool): correctness can ONLY come from the
    // database — the users-row FOR UPDATE inside createWithQuotaGuard.
    const attempts = Array.from({ length: 8 }, (_, i) =>
      (i % 2 === 0 ? h.svcFree : h.svcFree2).createAccount(h.raceUser, {
        provider: "MT4",
        label: `Racer ${i}`,
      }),
    );
    const results = await Promise.allSettled(attempts);
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(ok.length, 1, "exactly one concurrent creator wins");
    assert.equal(rejected.length, 7);
    for (const r of rejected) {
      const e = r.reason as AccountError;
      assert.ok(e instanceof AccountError, "loser must be the domain error, not a driver error");
      assert.equal(e.status, 429);
      assert.equal(e.code, "ACCOUNT_QUOTA_EXCEEDED");
      assert.equal(e.details?.currentCount, 1, "every loser observed the winner's committed row (serialized)");
      assert.equal(e.details?.maxAllowed, 1);
    }
    // Rollback proof: the quota holds and NO partial rows survived the losers.
    assert.equal(await h.store.countByUser(h.raceUser), 1, "quota never exceeded; no partial accounts");

    // Locks were released by the losers' rollbacks: normal ops proceed,
    // and freeing the slot lets a new create through the SAME path.
    const list = await h.store.listByUser(h.raceUser);
    assert.equal(list.length, 1);
    assert.equal(await h.store.deleteForUser(list[0]!.id, h.raceUser), true);
    const again = await h.svcFree.createAccount(h.raceUser, { provider: "MT5", label: "After delete" });
    assert.equal(again.label, "After delete");
    assert.equal(await h.store.countByUser(h.raceUser), 1);
  } finally {
    await h.close();
  }
});

test("PG: D3 CONCURRENT — pro plan (unlimited): all 8 succeed, no guard interference", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const attempts = Array.from({ length: 8 }, (_, i) =>
      h.svcPro.createAccount(h.proUser, { provider: "MT4", label: `Pro ${i}` }),
    );
    const results = await Promise.allSettled(attempts);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 8, "unlimited plan: every create succeeds");
    assert.equal(await h.store.countByUser(h.proUser), 8);
  } finally {
    await h.close();
  }
});

test("PG: D3 DB failure surfaces as failure — never a false success or false quota verdict", { skip: SKIP }, async () => {
  const { Pool } = await import("pg");
  // Credential-free URL (secret-scan policy: no user:password@host shapes in
  // files) — port 9 (discard) is unreachable, which is exactly the probe.
  const deadPool = new Pool({ connectionString: "postgres://127.0.0.1:9/velora" });
  deadPool.on("error", () => { /* expected: the dead target produces socket errors */ });
  try {
    const svc = new AccountService({
      store: new PgAccountStore(deadPool),
      getPlan: async () => "free",
      now: () => T0,
    });
    await assert.rejects(
      svc.createAccount("1", { provider: "MT5", label: "Dead DB" }),
      (e: unknown) => {
        // A connection failure must propagate as an error — it must NOT be
        // swallowed into a success, a quota verdict, or any AccountError.
        assert.ok(!(e instanceof AccountError), "DB failure must not masquerade as an API error");
        assert.match(String((e as Error).message), /ECONNREFUSED|connect|connection/i);
        return true;
      },
      "dead database must reject the create",
    );
  } finally {
    await deadPool.end();
  }
});
