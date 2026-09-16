// MetaAPI provisioning / binding evidence on REAL PostgreSQL 17 (OD-MP-1/2/3).
//
// Excluded from `npm test` by the *.pg.test.ts convention; run explicitly with
// DATABASE_URL set. Every assertion targets something an in-memory fake CANNOT
// demonstrate: a partial UNIQUE index firing across genuinely concurrent
// connections, CHECK constraints, compare-and-set under contention, and the
// fact that a disconnect leaves imported trades physically untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pool } from "pg";
import { createEngine, migrate } from "../migrate.ts";
import { PgAccountStore } from "../../apps/api/src/accounts/pgAccountStore.ts";
import { AccountBindingConflictError } from "../../apps/api/src/accounts/accountStore.ts";
import { PgProvisioningStore } from "../../apps/api/src/metaapi/pgProvisioningStore.ts";
import { PgAuditStore } from "../../apps/api/src/auth/pgAuditStore.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const URL = process.env["DATABASE_URL"];

const KEY64 = "a".repeat(64);
const MARKER = (n: number) => `velora-${String(n).padStart(32, "0")}`;

async function seedUser(pool: Pool, tag: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, locale) VALUES ($1,'x','en') RETURNING id`,
    [`prov-${tag}-${Math.random().toString(36).slice(2)}@example.com`],
  );
  return r.rows[0]!.id;
}

async function seedAccount(pool: Pool, userId: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO trading_accounts (user_id, external_account_id, broker_server)
     VALUES ($1,$2,'demo') RETURNING id`,
    [userId, `ext-${Math.random().toString(36).slice(2)}`],
  );
  return r.rows[0]!.id;
}

test("MetaAPI provisioning — real PostgreSQL", { skip: URL === undefined ? "DATABASE_URL not set" : false }, async (t) => {
  // Same convention as metaapiSync.pg.test.ts: the migration engine owns its
  // own connection and is closed before the test pool opens.
  const engine = await createEngine(URL!);
  await migrate(engine, MIGRATIONS);
  await engine.close?.();

  const pool = new Pool({ connectionString: URL });
  try {
    const accounts = new PgAccountStore(pool);
    const operations = new PgProvisioningStore(pool);
    const audit = new PgAuditStore(pool);
    const now = new Date();

    // ---------------------------------------------------------------- 0014
    await t.test("0014: the two authorized audit actions are accepted", async () => {
      const userId = await seedUser(pool, "actions");
      const accountId = await seedAccount(pool, userId);
      for (const action of ["CREDENTIAL_USED", "ACCOUNT_BINDING_CHANGED"] as const) {
        const rec = await audit.append({
          action,
          actorUserId: userId,
          targetUserId: userId,
          beforeState: null,
          afterState: "acct-x",
          outcome: "success",
          requestId: "r",
          occurredAt: now,
          tradingAccountId: accountId,
        });
        assert.equal(rec.action, action);
        assert.equal(rec.tradingAccountId, accountId);
      }
    });

    await t.test("0014: CREDENTIAL_REVEALED is still REJECTED by the CHECK", async () => {
      const userId = await seedUser(pool, "reveal");
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO audit_log (action, actor_user_id, occurred_at) VALUES ('CREDENTIAL_REVEALED',$1,now())`,
            [userId],
          ),
        (e: unknown) => (e as { code?: string }).code === "23514",
      );
    });

    await t.test("0014: the audit account reference survives account deletion", async () => {
      const userId = await seedUser(pool, "survive");
      const accountId = await seedAccount(pool, userId);
      await audit.append({
        action: "ACCOUNT_BINDING_CHANGED",
        actorUserId: userId, targetUserId: userId,
        beforeState: null, afterState: "acct-del", outcome: "success",
        requestId: null, occurredAt: now, tradingAccountId: accountId,
      });
      // Hard delete of the account must NOT erase or block the audit row.
      await pool.query(`DELETE FROM trading_accounts WHERE id = $1`, [accountId]);
      const rows = await pool.query(
        `SELECT 1 FROM audit_log WHERE trading_account_id = $1 AND action = 'ACCOUNT_BINDING_CHANGED'`,
        [accountId],
      );
      assert.equal(rows.rowCount, 1, "append-only audit durability must outlive the account");
    });

    // ---------------------------------------------------------- binding
    await t.test("binding persists and is readable", async () => {
      const userId = await seedUser(pool, "bind");
      const accountId = await seedAccount(pool, userId);
      const bound = await accounts.bindMetaApiAccount(accountId, userId, "mt-100", now, true);
      assert.notEqual(bound, null);
      assert.equal(await accounts.getMetaApiBinding(accountId, userId), "mt-100");
    });

    await t.test("ownership is enforced: a non-owner cannot bind or read", async () => {
      const owner = await seedUser(pool, "own");
      const other = await seedUser(pool, "other");
      const accountId = await seedAccount(pool, owner);
      assert.equal(await accounts.bindMetaApiAccount(accountId, other, "mt-x", now, true), null);
      assert.equal(await accounts.getMetaApiBinding(accountId, other), null);
      assert.equal(await accounts.getMetaApiBinding(accountId, owner), null);
    });

    await t.test("GLOBAL uniqueness: a second account cannot take a bound id", async () => {
      const u1 = await seedUser(pool, "g1");
      const u2 = await seedUser(pool, "g2");
      const a1 = await seedAccount(pool, u1);
      const a2 = await seedAccount(pool, u2);
      await accounts.bindMetaApiAccount(a1, u1, "mt-global", now, true);
      await assert.rejects(
        () => accounts.bindMetaApiAccount(a2, u2, "mt-global", now, true),
        (e: unknown) => e instanceof AccountBindingConflictError,
        "uniqueness must be GLOBAL, not per-user",
      );
    });

    await t.test("compare-and-set: an already-bound account is not silently rebound", async () => {
      const userId = await seedUser(pool, "cas");
      const accountId = await seedAccount(pool, userId);
      await accounts.bindMetaApiAccount(accountId, userId, "mt-first", now, true);
      assert.equal(
        await accounts.bindMetaApiAccount(accountId, userId, "mt-second", now, true),
        null,
      );
      assert.equal(await accounts.getMetaApiBinding(accountId, userId), "mt-first");
    });

    await t.test("the 0013 CHECK rejects a malformed provider id", async () => {
      const userId = await seedUser(pool, "chk");
      const accountId = await seedAccount(pool, userId);
      await assert.rejects(
        () => accounts.bindMetaApiAccount(accountId, userId, "bad id/../x", now, true),
        (e: unknown) => (e as { code?: string }).code === "23514",
      );
    });

    // ------------------------------------------------------- CONCURRENCY
    await t.test("CONCURRENCY: two simultaneous binds on separate connections → exactly one wins", async () => {
      const userId = await seedUser(pool, "conc");
      const accountId = await seedAccount(pool, userId);
      // Two independent pools = two genuinely separate backends.
      const poolA = new Pool({ connectionString: URL, max: 1 });
      const poolB = new Pool({ connectionString: URL, max: 1 });
      try {
        const results = await Promise.allSettled([
          new PgAccountStore(poolA).bindMetaApiAccount(accountId, userId, "mt-race-A", new Date(), true),
          new PgAccountStore(poolB).bindMetaApiAccount(accountId, userId, "mt-race-B", new Date(), true),
        ]);
        const bound = results.filter((r) => r.status === "fulfilled" && r.value !== null);
        assert.equal(bound.length, 1, "exactly one binding may succeed");
        const final = await accounts.getMetaApiBinding(accountId, userId);
        assert.ok(final === "mt-race-A" || final === "mt-race-B");
        const count = await pool.query(
          `SELECT COUNT(*)::int AS n FROM trading_accounts WHERE metaapi_account_id IN ('mt-race-A','mt-race-B')`,
        );
        assert.equal(count.rows[0]!.n, 1, "no duplicate binding may exist");
      } finally {
        await poolA.end();
        await poolB.end();
      }
    });

    await t.test("CONCURRENCY: two simultaneous reserves converge on ONE operation", async () => {
      const userId = await seedUser(pool, "op");
      const accountId = await seedAccount(pool, userId);
      const key = "b".repeat(64);
      const poolA = new Pool({ connectionString: URL, max: 1 });
      const poolB = new Pool({ connectionString: URL, max: 1 });
      try {
        const input = {
          userId, accountId, operationKey: key, providerMarker: MARKER(1),
          transactionId: "c".repeat(32), now: new Date(),
        };
        const [ra, rb] = await Promise.all([
          new PgProvisioningStore(poolA).reserve(input),
          new PgProvisioningStore(poolB).reserve(input),
        ]);
        assert.equal(ra.operation.id, rb.operation.id, "both callers must see ONE operation");
        assert.equal([ra.created, rb.created].filter(Boolean).length, 1, "exactly one creator");
        const n = await pool.query(
          `SELECT COUNT(*)::int AS n FROM provisioning_operations WHERE operation_key = $1`,
          [key],
        );
        assert.equal(n.rows[0]!.n, 1);
      } finally {
        await poolA.end();
        await poolB.end();
      }
    });

    // -------------------------------------------------- operation lifecycle
    await t.test("operation lifecycle: evidence of a provider outcome is never erased", async () => {
      const userId = await seedUser(pool, "life");
      const accountId = await seedAccount(pool, userId);
      const key = "d".repeat(64);
      const { operation } = await operations.reserve({
        userId, accountId, operationKey: key, providerMarker: MARKER(2),
        transactionId: "e".repeat(32), now: new Date(),
      });
      await operations.markStatus(operation.id, "ACCEPTED", new Date(), {
        providerAccountId: "mt-life", incrementAttempts: true,
      });
      // A later transition that supplies no id must NOT clear the recorded one.
      await operations.markStatus(operation.id, "AMBIGUOUS", new Date(), {
        lastErrorCode: "PROVIDER_UNAVAILABLE", incrementAttempts: true,
      });
      const after = await operations.findByKey(userId, key);
      assert.equal(after!.providerAccountId, "mt-life");
      assert.equal(after!.status, "AMBIGUOUS");
      assert.equal(after!.attempts, 2);
    });

    await t.test("a marker cannot be reused by a second operation", async () => {
      const u1 = await seedUser(pool, "m1");
      const u2 = await seedUser(pool, "m2");
      const a1 = await seedAccount(pool, u1);
      const a2 = await seedAccount(pool, u2);
      const marker = MARKER(3);
      await operations.reserve({
        userId: u1, accountId: a1, operationKey: "1".repeat(64),
        providerMarker: marker, transactionId: "f".repeat(32), now: new Date(),
      });
      await assert.rejects(
        () =>
          operations.reserve({
            userId: u2, accountId: a2, operationKey: "2".repeat(64),
            providerMarker: marker, transactionId: "0".repeat(32), now: new Date(),
          }),
        (e: unknown) => (e as { code?: string }).code === "23505",
      );
    });

    await t.test("the operations table rejects a non-hex operation key and a bad marker", async () => {
      const userId = await seedUser(pool, "bad");
      const accountId = await seedAccount(pool, userId);
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO provisioning_operations (user_id, account_id, operation_key, provider_marker)
             VALUES ($1,$2,'NOT-HEX',$3)`,
            [userId, accountId, MARKER(4)],
          ),
        (e: unknown) => (e as { code?: string }).code === "23514",
      );
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO provisioning_operations (user_id, account_id, operation_key, provider_marker)
             VALUES ($1,$2,$3,'not-a-marker')`,
            [userId, accountId, "3".repeat(64)],
          ),
        (e: unknown) => (e as { code?: string }).code === "23514",
      );
    });

    // ------------------------------------------------------------ DISCONNECT
    await t.test("DISCONNECT: unbinding leaves imported trades physically untouched", async () => {
      const userId = await seedUser(pool, "trades");
      const accountId = await seedAccount(pool, userId);
      await accounts.bindMetaApiAccount(accountId, userId, "mt-keep", now, true);

      // An imported trade with a ledger event, as the sync path would write it.
      // Column names are the ACTUAL 0001/0005 schema, not assumed ones.
      const trade = await pool.query<{ id: string }>(
        `INSERT INTO trades
           (user_id, account_id, external_deal_id, symbol, direction, status,
            entry_price, volume, net_pnl, occurred_at, source)
         VALUES ($1,$2,$3,'EURUSD','buy','CLOSED',1.10000000,1.00000000,42.50,now(),'metaapi')
         RETURNING id`,
        [userId, accountId, `deal-${Math.random().toString(36).slice(2)}`],
      );
      const tradeId = trade.rows[0]!.id;
      await pool.query(
        `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload, at)
         VALUES ($1,$2,'TRADE_IMPORTED','sync',0,'{}'::jsonb, now())`,
        [`ev-${Math.random().toString(36).slice(2)}`, tradeId],
      );
      const before = await pool.query(
        `SELECT net_pnl, occurred_at, source, version FROM trades WHERE id = $1`, [tradeId],
      );

      const previous = await accounts.unbindMetaApiAccount(accountId, userId, new Date());
      assert.equal(previous, "mt-keep", "the previous binding is returned for the audit trail");
      assert.equal(await accounts.getMetaApiBinding(accountId, userId), null);

      const after = await pool.query(
        `SELECT net_pnl, occurred_at, source, version FROM trades WHERE id = $1`, [tradeId],
      );
      assert.equal(after.rowCount, 1, "the imported trade MUST still exist");
      assert.deepEqual(after.rows[0], before.rows[0], "P/L, timestamps and provenance unchanged");
      const ev = await pool.query(`SELECT COUNT(*)::int AS n FROM trade_events WHERE trade_id = $1`, [tradeId]);
      assert.equal(ev.rows[0]!.n, 1, "ledger events MUST be untouched");
    });

    await t.test("DISCONNECT: the account is no longer syncable afterwards", async () => {
      const userId = await seedUser(pool, "sync");
      const accountId = await seedAccount(pool, userId);
      await accounts.bindMetaApiAccount(accountId, userId, "mt-sync", now, true);
      const beforeRows = await pool.query(
        `SELECT 1 FROM trading_accounts WHERE id = $1 AND metaapi_account_id IS NOT NULL`, [accountId],
      );
      assert.equal(beforeRows.rowCount, 1);
      await accounts.unbindMetaApiAccount(accountId, userId, new Date());
      const afterRows = await pool.query(
        `SELECT 1 FROM trading_accounts WHERE id = $1 AND metaapi_account_id IS NOT NULL`, [accountId],
      );
      assert.equal(afterRows.rowCount, 0, "the scheduler's syncable filter must no longer match");
    });

    await t.test("DISCONNECT: a non-owner cannot unbind", async () => {
      const owner = await seedUser(pool, "do");
      const other = await seedUser(pool, "dx");
      const accountId = await seedAccount(pool, owner);
      await accounts.bindMetaApiAccount(accountId, owner, "mt-owned", now, true);
      assert.equal(await accounts.unbindMetaApiAccount(accountId, other, new Date()), null);
      assert.equal(await accounts.getMetaApiBinding(accountId, owner), "mt-owned");
    });

    await t.test("DISCONNECT then RECONNECT: the freed id may be bound again", async () => {
      const userId = await seedUser(pool, "re");
      const accountId = await seedAccount(pool, userId);
      await accounts.bindMetaApiAccount(accountId, userId, "mt-cycle", now, true);
      await accounts.unbindMetaApiAccount(accountId, userId, new Date());
      const again = await accounts.bindMetaApiAccount(accountId, userId, "mt-cycle", new Date(), true);
      assert.notEqual(again, null, "a released id must be re-bindable (partial index excludes NULLs)");
    });

    // ------------------------------------------------------------- SECRETS
    await t.test("no provisioning table can hold a secret-looking value", async () => {
      const leak = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM provisioning_operations
          WHERE operation_key ILIKE '%password%' OR provider_marker ILIKE '%password%'
             OR COALESCE(last_error_code,'') ILIKE '%password%'`,
      );
      assert.equal(leak.rows[0]!.n, 0);
      const cols = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'provisioning_operations'`,
      );
      const names = cols.rows.map((r) => r.column_name);
      for (const forbidden of ["password", "secret", "credential", "token", "ciphertext"]) {
        assert.ok(
          !names.some((n) => n.includes(forbidden) && n !== "transaction_id"),
          `provisioning_operations must not carry a ${forbidden} column`,
        );
      }
    });
  } finally {
    await pool.end();
  }
});
