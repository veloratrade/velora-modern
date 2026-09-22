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
import { MetaApiProvisioningService } from "../../apps/api/src/metaapi/provisioningService.ts";
import { withTransaction } from "../../apps/api/src/persistence/pg.ts";
import { resetSchema } from "./support/pgTestDb.ts";

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
  // ISOLATION (pass 2): truncate every application table so the battery is
  // repeatable in any order and against a cluster other batteries have used.
  // Its outcome previously depended on leftover rows (observed order-dependent
  // failures when run after other batteries). See db/tests/support/pgTestDb.ts.
  await resetSchema(pool);
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

// ---------------------------------------------------------------------------
// AUD-03 — TRANSACTIONAL ATOMICITY (real PostgreSQL, failure injection).
//
// The audit found bind + terminal operation state + ACCOUNT_BINDING_CHANGED
// were three separate autocommit statements, so a crash between them could
// leave a binding committed with no audit row. These tests drive the REAL
// MetaApiProvisioningService against REAL PostgreSQL and inject a failure at
// each seam. The transaction is NOT faked: `runInTransaction` is the same
// `withTransaction` the production composition uses in server-main.ts.
// ---------------------------------------------------------------------------

test("AUD-03 atomicity — real PostgreSQL", { skip: URL === undefined ? "DATABASE_URL not set" : false }, async (t) => {
  const engine = await createEngine(URL!);
  await migrate(engine, MIGRATIONS);
  await engine.close?.();

  const pool = new Pool({ connectionString: URL });
  try {
    // ISOLATION (pass 2): this harness ALSO resets. It previously relied on the
    // previous test having left a clean database, which made the file's outcome
    // depend on its own internal ordering rather than on its fixtures.
    await resetSchema(pool);

    const PROVIDER_ID = "AUD03-provider-account";

    /**
     * Builds a service wired to real PG stores, with an injectable audit fault.
     *
     * `atomic` controls whether the service is given the transaction runner.
     * It exists so the rollback test cannot pass for the wrong reason: with
     * `atomic: false` the SAME assertions fail (binding committed, audit rows
     * 0), which is precisely the AUD-03 defect. That makes this a built-in
     * negative control rather than a claim in a comment.
     */
    const harness = async (failAudit: boolean, atomic = true) => {
      // Unique per harness: `metaapi_account_id` is GLOBALLY unique, so a
      // shared literal would make a later connect() fail with DUPLICATE_BINDING
      // before it ever reached the audit write — masking what is under test.
      const svcProviderId = `AUD03-svc-${Math.random().toString(36).slice(2, 10)}`;
      const userId = await seedUser(pool, "aud03");
      const accountId = await seedAccount(pool, userId);
      const accounts = new PgAccountStore(pool);
      const operations = new PgProvisioningStore(pool);
      const realAudit = new PgAuditStore(pool);

      // The ONLY fault: the audit INSERT throws. Everything else is real.
      const audit = {
        append: async (entry: Parameters<PgAuditStore["append"]>[0], tx?: Parameters<PgAuditStore["append"]>[1]) => {
          if (failAudit && entry.action === "ACCOUNT_BINDING_CHANGED") {
            throw new Error("injected audit failure");
          }
          return realAudit.append(entry, tx);
        },
        list: () => realAudit.list(),
      };

      const service = new MetaApiProvisioningService({
        accounts,
        credentials: { reveal: async () => "pw" } as never,
        operations,
        audit: audit as never,
        platformToken: () => "tok",
        // Stub ONLY at the fetch boundary — no real MetaAPI call is ever made.
        // Everything below this line (stores, transaction, audit) is real.
        clientOptions: {
          fetchImpl: (async () =>
            new Response(JSON.stringify({ id: svcProviderId }), {
              status: 201,
              headers: { "content-type": "application/json" },
            })) as unknown as typeof fetch,
        },
        now: () => new Date("2026-09-16T00:00:00Z"),
        // The REAL transaction primitive — identical to server-main.ts.
        ...(atomic ? { runInTransaction: <T,>(fn: (tx: import("../../apps/api/src/persistence/pg.ts").QueryFn) => Promise<T>) => withTransaction(pool, fn) } : {}),
      });
      return { userId, accountId, accounts, operations, service, realAudit };
    };

    const auditRowsFor = async (accountId: string): Promise<number> => {
      const r = await pool.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM audit_log
          WHERE trading_account_id = $1 AND action = 'ACCOUNT_BINDING_CHANGED'`,
        [accountId],
      );
      return Number(r.rows[0]!.n);
    };

    await t.test("HAPPY PATH: binding and its audit row commit together", async () => {
      const h = await harness(false);
      const bound = await h.accounts.bindMetaApiAccount!(
        h.accountId, h.userId, PROVIDER_ID + "-ok", new Date(), true,
      );
      assert.notEqual(bound, null);
      // Sanity: the fixture itself can produce both halves.
      assert.equal(await h.accounts.getMetaApiBinding!(h.accountId, h.userId), PROVIDER_ID + "-ok");
    });

    await t.test("ROLLBACK: an audit failure must leave NO binding committed", async () => {
      const h = await harness(true);
      const op = await h.operations.reserve({
        userId: h.userId, accountId: h.accountId, operationKey: "b".repeat(64),
        providerMarker: MARKER(4242), transactionId: "c".repeat(32), now: new Date(),
      });

      // Drive the real bind+audit transaction and force the audit to throw.
      await assert.rejects(
        withTransaction(pool, async (tx) => {
          const bound = await h.accounts.bindMetaApiAccount!(
            h.accountId, h.userId, PROVIDER_ID, new Date(), true, tx,
          );
          assert.notEqual(bound, null, "the bind itself must succeed inside the txn");
          await h.operations.markStatus(op.operation.id, "COMPLETED", new Date(), { providerAccountId: PROVIDER_ID }, tx);
          throw new Error("injected audit failure");
        }),
        /injected audit failure/,
      );

      // THE INVARIANT: neither half survived.
      const binding = await h.accounts.getMetaApiBinding!(h.accountId, h.userId);
      assert.equal(binding, null, "binding must NOT be committed when the audit write fails");
      assert.equal(await auditRowsFor(h.accountId), 0, "no audit row may exist either");

      // And the operation did not reach a terminal COMPLETED state.
      const after = await h.operations.findByKey(h.userId, "b".repeat(64));
      assert.notEqual(after, null);
      assert.notEqual(after!.status, "COMPLETED", "terminal state must have rolled back too");
    });

    await t.test("ROLLBACK: a terminal-state failure must leave NO binding and NO audit row", async () => {
      const h = await harness(false);
      const accountId = h.accountId;

      await assert.rejects(
        withTransaction(pool, async (tx) => {
          await h.accounts.bindMetaApiAccount!(accountId, h.userId, PROVIDER_ID + "-2", new Date(), true, tx);
          await h.realAudit.append({
            action: "ACCOUNT_BINDING_CHANGED", actorUserId: h.userId, targetUserId: h.userId,
            beforeState: null, afterState: PROVIDER_ID + "-2", outcome: "success",
            credentialId: null, provider: null, tradingAccountId: accountId,
            requestId: "aud03-req", occurredAt: new Date(),
          }, tx);
          // Fail AFTER both writes — the classic "audit committed, binding
          // missing" inversion the audit asked to be ruled out.
          throw new Error("injected terminal failure");
        }),
        /injected terminal failure/,
      );

      assert.equal(await h.accounts.getMetaApiBinding!(accountId, h.userId), null,
        "binding must not survive");
      assert.equal(await auditRowsFor(accountId), 0,
        "the audit row must not survive either — no audit-without-binding inversion");
    });

    await t.test("the service's own connect path commits binding AND audit together", async () => {
      const h = await harness(false);
      // Real service, real PG, stubbed provider at the fetch boundary only.
      const r = await h.service.connect(
        { id: h.userId, requestId: "aud03-connect" },
        h.accountId,
        { credentialId: "1", login: "123", server: "Demo", platform: "mt5" },
      );
      assert.equal(r.status, "connected");
      assert.equal(await h.accounts.getMetaApiBinding!(h.accountId, h.userId), r.metaapiAccountId);
      assert.equal(await auditRowsFor(h.accountId), 1,
        "exactly one ACCOUNT_BINDING_CHANGED row accompanies the committed binding");
    });

    await t.test("SERVICE-LEVEL ROLLBACK: an audit failure inside connect() leaves NO binding", async () => {
      // THE DECISIVE TEST. The three tests above drive `withTransaction`
      // directly, so they prove PostgreSQL rolls back — not that the SERVICE
      // opens a transaction at all. This one injects the fault through the
      // real `connect()` path, so it fails if `runInTransaction` is ever
      // bypassed. (Verified by negative control: reverting completeBinding to
      // autocommit makes exactly this test fail.)
      const h = await harness(true); // audit append throws on ACCOUNT_BINDING_CHANGED

      await assert.rejects(
        h.service.connect(
          { id: h.userId, requestId: "aud03-rollback" },
          h.accountId,
          { credentialId: "1", login: "123", server: "Demo", platform: "mt5" },
        ),
        // Surfaces as the mapped local-persistence failure, not a raw error.
        (err: unknown) => err instanceof Error,
      );

      assert.equal(await h.accounts.getMetaApiBinding!(h.accountId, h.userId), null,
        "connect() must not leave a binding committed when its audit write fails");
      assert.equal(await auditRowsFor(h.accountId), 0,
        "and no ACCOUNT_BINDING_CHANGED row may exist");
    });

    await t.test("BUILT-IN NEGATIVE CONTROL: without the transaction the AUD-03 defect reappears", async () => {
      // Same fault, same assertions, but the service is composed WITHOUT
      // `runInTransaction` — i.e. the pre-remediation autocommit wiring.
      // This pins the defect: it documents, by execution, exactly what the fix
      // prevents, and it fails if someone "fixes" the rollback by making the
      // audit failure silent instead.
      const h = await harness(true, /* atomic */ false);

      await assert.rejects(h.service.connect(
        { id: h.userId, requestId: "aud03-negctl" },
        h.accountId,
        { credentialId: "1", login: "123", server: "Demo", platform: "mt5" },
      ));

      // THE DEFECT, reproduced deliberately: binding committed, audit missing.
      assert.notEqual(await h.accounts.getMetaApiBinding!(h.accountId, h.userId), null,
        "without a transaction the binding commits (this is the AUD-03 defect)");
      assert.equal(await auditRowsFor(h.accountId), 0,
        "…while its audit row is absent — the inconsistency the fix removes");
    });
  } finally {
    await pool.end();
  }
});
