// Real-PostgreSQL battery — SEC-04 edge session probe.
//
// EVIDENCE LABEL (Phase D policy): executes ONLY against a REAL, disposable
// PostgreSQL (DATABASE_URL); without it every test SKIPS (a skip is not
// evidence). What is proven here cannot be proven in memory: that the probe is
// read-only against the real `user_sessions` row (no rotation, no write, no
// new row) while competing with a concurrent real rotation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareDatabase } from "./support/pgTestDb.ts";
import { PgUserStore } from "../../apps/api/src/auth/pgUserStore.ts";
import { AuthService } from "../../apps/api/src/auth/authService.ts";
import { VeloraHasher } from "../../apps/api/src/auth/hashing.ts";
import { JwtService } from "../../apps/api/src/auth/jwt.ts";
import { LogMailProvider } from "../../apps/api/src/mail/logMailProvider.ts";
import type { Pool } from "pg";

const PG_URL = process.env.DATABASE_URL;
const SKIP = PG_URL === undefined
  ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)"
  : false;

const SECRET = "pg-session-probe-battery-secret-0123456789ab";
const PASSWORD = "a-strong-password-1234";

async function harness(): Promise<{ pool: Pool; users: PgUserStore; auth: AuthService; close: () => Promise<void> }> {
  const { Pool } = await import("pg");
  await (await prepareDatabase(PG_URL as string)).close();
  const pool = new Pool({ connectionString: PG_URL });
  const users = new PgUserStore(pool);
  const auth = new AuthService({
    store: users,
    hasher: new VeloraHasher(),
    jwt: JwtService.create(SECRET),
    mail: new LogMailProvider(),
  });
  return { pool, users, auth, close: () => pool.end() };
}

async function verifiedUser(auth: AuthService, users: PgUserStore, email: string): Promise<void> {
  const now = new Date();
  await auth.register({ email, password: PASSWORD, fullName: "PG Probe", locale: "fa" });
  const user = await users.findUserByEmail(email);
  await users.markEmailVerified(user!.id, now);
}

test("PG probe: five probes leave the session row byte-identical, and the token still refreshes", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await verifiedUser(h.auth, h.users, "probe.pg@velora.test");
    const pair = await h.auth.login({ email: "probe.pg@velora.test", password: PASSWORD });

    const before = await h.pool.query(
      "SELECT id, refresh_token_hash, access_token_hash, revoked_at, expires_at FROM user_sessions",
    );
    assert.equal(before.rowCount, 1, "login created exactly one session");

    for (let i = 0; i < 5; i++) {
      assert.deepEqual(await h.auth.sessionProbe(pair.refreshToken), { authenticated: true, role: "user" });
    }

    const after = await h.pool.query(
      "SELECT id, refresh_token_hash, access_token_hash, revoked_at, expires_at FROM user_sessions",
    );
    assert.equal(after.rowCount, 1, "probing must not create a session");
    assert.deepEqual(after.rows, before.rows, "probing must not modify the session row at all");

    // The strongest read-only proof: the original token still performs a real
    // rotation, i.e. the probe did not consume it.
    const rotated = await h.auth.refresh(pair.refreshToken);
    assert.notEqual(rotated.refreshToken, pair.refreshToken);
    assert.deepEqual(await h.auth.sessionProbe(rotated.refreshToken), { authenticated: true, role: "user" });
    assert.deepEqual(await h.auth.sessionProbe(pair.refreshToken), { authenticated: false }, "the old token is now dead");
  } finally {
    await h.close();
  }
});

test("PG probe: revoking the session (logout) turns the probe to unauthenticated immediately", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await verifiedUser(h.auth, h.users, "probe.logout@velora.test");
    const pair = await h.auth.login({ email: "probe.logout@velora.test", password: PASSWORD });
    assert.deepEqual(await h.auth.sessionProbe(pair.refreshToken), { authenticated: true, role: "user" });

    // Revoke out-of-band, like an admin device-revocation would: the probe must
    // read the CURRENT row state, not a cached answer.
    const revokedAt = new Date();
    await h.pool.query("UPDATE user_sessions SET revoked_at = $1", [revokedAt.toISOString()]);
    assert.deepEqual(await h.auth.sessionProbe(pair.refreshToken), { authenticated: false });

    // And a suspension does the same without touching the session.
    await h.pool.query("UPDATE user_sessions SET revoked_at = NULL");
    assert.deepEqual(await h.auth.sessionProbe(pair.refreshToken), { authenticated: true, role: "user" });
    const user = await h.users.findUserByEmail("probe.logout@velora.test");
    await h.users.updateUserStatus(user!.id, "suspended", new Date());
    assert.deepEqual(await h.auth.sessionProbe(pair.refreshToken), { authenticated: false }, "a suspended account is not a session");
  } finally {
    await h.close();
  }
});

test("PG probe: concurrent probes during a real refresh never deadlock or double-rotate", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await verifiedUser(h.auth, h.users, "probe.race@velora.test");
    const pair = await h.auth.login({ email: "probe.race@velora.test", password: PASSWORD });

    const probes = Array.from({ length: 8 }, () => h.auth.sessionProbe(pair.refreshToken));
    const rotations = [h.auth.refresh(pair.refreshToken), h.auth.refresh(pair.refreshToken)];
    const [probeResults, rotationResults] = await Promise.all([
      Promise.all(probes),
      Promise.allSettled(rotations),
    ]);

    // A probe racing a rotation legitimately sees either answer: the live session
    // (it read first) or nothing (the rotation had already replaced the token).
    // What it may NEVER do is throw, invent a role, or return a third shape.
    let sawLive = 0;
    for (const r of probeResults) {
      if (r.authenticated === false) continue;
      assert.deepEqual(r, { authenticated: true, role: "user" });
      sawLive += 1;
    }
    assert.ok(sawLive >= 1, "at least one probe read the session while it was live");

    // Exactly ONE rotation may win; the loser must be refused with a typed code,
    // never a raw driver error, and never a token the store does not know.
    const fulfilled = rotationResults.filter((r) => r.status === "fulfilled");
    const rejected = rotationResults.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one concurrent refresh wins");
    assert.equal(rejected.length, 1, "the loser is refused");
    const loser = rejected[0] as PromiseRejectedResult;
    assert.equal((loser.reason as { code?: string }).code, "INVALID_TOKEN");

    const winner = (fulfilled[0] as PromiseFulfilledResult<{ refreshToken: string }>).value;
    assert.deepEqual(await h.auth.sessionProbe(winner.refreshToken), { authenticated: true, role: "user" });
    assert.deepEqual(await h.auth.sessionProbe(pair.refreshToken), { authenticated: false }, "the replaced token is dead");

    const rows = await h.pool.query("SELECT count(*)::int AS n FROM user_sessions");
    assert.equal(rows.rows[0]!.n, 1, "rotation reuses the session row (no session duplication)");
  } finally {
    await h.close();
  }
});
