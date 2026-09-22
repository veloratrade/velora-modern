// PgOwnershipStore real-PostgreSQL battery — System Owner hardening (Gap 3).
//
// EVIDENCE LABEL (Phase D policy): executes ONLY against a REAL, disposable
// PostgreSQL (DATABASE_URL). Without it every test is SKIPPED. PGlite evidence
// is in-wasm and is NEVER a substitute for this battery.
//
// Proves on real PostgreSQL: the installation_ownership singleton (PRIMARY KEY
// pinned to TRUE), the users FK, ON DELETE RESTRICT, the one-time claim, and
// that genuinely CONCURRENT claims resolve to exactly one winner via SQLSTATE
// 23505 mapped to OwnershipAlreadyClaimedError.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createEngine, migrate } from "../migrate.ts";
import { PgOwnershipStore } from "../../apps/api/src/auth/pgOwnershipStore.ts";
import { OwnershipAlreadyClaimedError } from "../../apps/api/src/auth/ownershipStore.ts";
import type { Pool } from "pg";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const PG_URL = process.env.DATABASE_URL;
const SKIP =
  PG_URL === undefined
    ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)"
    : false;

async function harness(): Promise<{
  pool: Pool;
  store: PgOwnershipStore;
  close: () => Promise<void>;
}> {
  const { Pool } = await import("pg");
  const engine = await createEngine(PG_URL);
  await migrate(engine, MIGRATIONS);
  await engine.close();
  const pool = new Pool({ connectionString: PG_URL });
  // Isolate from any prior run in the same disposable database.
  await pool.query("DELETE FROM installation_ownership");
  await pool.query("DELETE FROM users WHERE email LIKE '%@pgown.test'");
  return { pool, store: new PgOwnershipStore(pool), close: () => pool.end() };
}

async function seedAdmin(pool: Pool, email: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    "INSERT INTO users(email, password_hash, role) VALUES ($1,'x','admin') RETURNING id",
    [email],
  );
  return String(r.rows[0]!.id);
}

test("PG ownership: claim persists and reads back through the adapter", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const id = await seedAdmin(h.pool, "owner@pgown.test");
    assert.equal(await h.store.getOwnership(), null, "unclaimed installation reads as null");

    const now = new Date("2026-09-14T12:00:00.000Z");
    const rec = await h.store.claimOwnership({
      ownerUserId: id,
      claimedByUserId: id,
      claimedIp: "203.0.113.10",
      claimedUserAgent: "verification-agent",
      now,
    });
    assert.equal(rec.ownerUserId, id);
    assert.equal(rec.claimedByUserId, id);

    const read = await h.store.getOwnership();
    assert.equal(read!.ownerUserId, id);
    assert.equal(read!.claimedIp, "203.0.113.10");
    // Provenance columns must never carry a secret.
    assert.equal(JSON.stringify(read).includes("password"), false);
  } finally {
    await h.close();
  }
});

test("PG ownership: a second claim raises OwnershipAlreadyClaimedError", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const a = await seedAdmin(h.pool, "a@pgown.test");
    const b = await seedAdmin(h.pool, "b@pgown.test");
    const now = new Date();
    await h.store.claimOwnership({
      ownerUserId: a,
      claimedByUserId: a,
      claimedIp: null,
      claimedUserAgent: null,
      now,
    });
    await assert.rejects(
      () =>
        h.store.claimOwnership({
          ownerUserId: b,
          claimedByUserId: b,
          claimedIp: null,
          claimedUserAgent: null,
          now,
        }),
      OwnershipAlreadyClaimedError,
      "the DB singleton must reject the second claim (SQLSTATE 23505)",
    );
    // Ownership is still bound to the original owner.
    assert.equal((await h.store.getOwnership())!.ownerUserId, a);
  } finally {
    await h.close();
  }
});

test("PG ownership: CONCURRENT claims — exactly one winner", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) ids.push(await seedAdmin(h.pool, `c${i}@pgown.test`));
    const now = new Date();

    // Issued in parallel against a real server: the singleton PRIMARY KEY is the
    // arbiter, not application ordering.
    const results = await Promise.allSettled(
      ids.map((id) =>
        h.store.claimOwnership({
          ownerUserId: id,
          claimedByUserId: id,
          claimedIp: null,
          claimedUserAgent: null,
          now,
        }),
      ),
    );
    const winners = results.filter((r) => r.status === "fulfilled");
    assert.equal(winners.length, 1, "exactly one concurrent claim may succeed");
    for (const r of results.filter((x) => x.status === "rejected")) {
      assert.ok(
        (r as PromiseRejectedResult).reason instanceof OwnershipAlreadyClaimedError,
        "losers must surface the mapped domain error, not a raw pg error",
      );
    }
    const count = await h.pool.query<{ n: string }>(
      "SELECT COUNT(*)::int AS n FROM installation_ownership",
    );
    assert.equal(Number(count.rows[0]!.n), 1);
  } finally {
    await h.close();
  }
});

test("PG ownership: ON DELETE RESTRICT protects the owner's user row", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const owner = await seedAdmin(h.pool, "restrict@pgown.test");
    const other = await seedAdmin(h.pool, "other@pgown.test");
    await h.store.claimOwnership({
      ownerUserId: owner,
      claimedByUserId: owner,
      claimedIp: null,
      claimedUserAgent: null,
      now: new Date(),
    });

    await assert.rejects(
      () => h.pool.query("DELETE FROM users WHERE id = $1", [owner]),
      /violates foreign key constraint/i,
      "the owner's row must not be deletable while referenced",
    );
    // Control: a non-owner row deletes normally, so the guard is specific.
    await h.pool.query("DELETE FROM users WHERE id = $1", [other]);
    assert.equal((await h.store.getOwnership())!.ownerUserId, owner);
  } finally {
    await h.close();
  }
});

test("PG ownership: the FK rejects an owner id that does not exist", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await assert.rejects(
      () =>
        h.pool.query(
          "INSERT INTO installation_ownership(owner_user_id, claimed_by_user_id) VALUES (999999999, 999999999)",
        ),
      /violates foreign key constraint/i,
    );
  } finally {
    await h.close();
  }
});
