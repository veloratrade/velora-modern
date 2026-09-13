// PgUserStore real-PostgreSQL battery — Phase D D2.
//
// EVIDENCE LABEL (Phase D policy): this file executes ONLY against a REAL,
// disposable PostgreSQL (DATABASE_URL — the postgres-evidence GitHub Actions
// service container). Without DATABASE_URL every test is SKIPPED (never
// reported as passed). PGlite results are never a substitute for this
// battery. SQLSTATE/error-object behavior proven here (23505 mapping,
// concurrent duplicate-email convergence) is real-PG evidence only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createEngine, migrate } from "../migrate.ts";
import { PgUserStore } from "../../apps/api/src/auth/pgUserStore.ts";
import { UserEmailExistsError } from "../../apps/api/src/auth/userStore.ts";
import type { Pool } from "pg";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const PG_URL = process.env.DATABASE_URL;
const SKIP = PG_URL === undefined
  ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)"
  : false;

const T0 = new Date("2026-09-13T09:00:00.000Z");
const T1 = new Date("2026-09-13T10:00:00.000Z");
const T2 = new Date("2026-09-13T11:00:00.000Z");

async function harness(): Promise<{ pool: Pool; store: PgUserStore; close: () => Promise<void> }> {
  const { Pool } = await import("pg");
  const engine = await createEngine(PG_URL); // migration runner's real-pg branch
  await migrate(engine, MIGRATIONS);
  await engine.close();
  const pool = new Pool({ connectionString: PG_URL });
  return { pool, store: new PgUserStore(pool), close: () => pool.end() };
}

test("PG: user lifecycle — create, find by email/id, password update, verify, timestamps", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const u = await h.store.createUser({
      email: "pguser-lifecycle@velora.test",
      passwordHash: "bcrypt$hash",
      fullName: "Lifecycle Probe",
      timezone: "Asia/Tehran",
      locale: "fa",
      now: T0,
    });
    assert.match(u.id, /^\d+$/);
    assert.equal(u.email, "pguser-lifecycle@velora.test");
    assert.equal(u.plan, "free"); // 0002 defaults
    assert.equal(u.status, "active");
    assert.equal(u.emailVerifiedAt, null);
    assert.equal(typeof u.createdAt, "string");

    const byEmail = await h.store.findUserByEmail("pguser-lifecycle@velora.test");
    assert.notEqual(byEmail, null);
    assert.equal(byEmail!.id, u.id);

    await h.store.updateUserPasswordHash(u.id, "new-hash", T1);
    await h.store.markEmailVerified(u.id, T1);
    const byId = await h.store.findUserById(u.id);
    assert.notEqual(byId, null);
    assert.equal(byId!.passwordHash, "new-hash");
    assert.equal(byId!.emailVerifiedAt, T1.toISOString()); // timestamptz → exact ISO (S4)
    assert.equal(byId!.id, u.id); // BIGINT stable as string (S3)

    assert.equal(await h.store.findUserByEmail("absent@velora.test"), null);
    assert.equal(await h.store.findUserById("999999999"), null);
  } finally {
    await h.close();
  }
});

test("PG: duplicate email maps SQLSTATE 23505 → UserEmailExistsError", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await h.store.createUser({
      email: "pguser-dup@velora.test", passwordHash: "h", fullName: "First",
      timezone: "UTC", locale: "en", now: T0,
    });
    await assert.rejects(
      h.store.createUser({
        email: "pguser-dup@velora.test", passwordHash: "h", fullName: "Second",
        timezone: "UTC", locale: "en", now: T1,
      }),
      (e: unknown) => e instanceof UserEmailExistsError,
      "unique violation must surface as the domain error, not a driver error",
    );
  } finally {
    await h.close();
  }
});

test("PG: CONCURRENT duplicate create — exactly one row, losers get UserEmailExistsError", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const email = "pguser-race@velora.test";
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        h.store.createUser({
          email, passwordHash: "h", fullName: `Racer ${i}`,
          timezone: "UTC", locale: "en", now: T0,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(ok.length, 1, "exactly one concurrent creator wins");
    assert.equal(rejected.length, 5);
    for (const r of rejected) {
      assert.ok(r.reason instanceof UserEmailExistsError, "losers must see the domain error");
    }
    const rows = await h.pool.query("SELECT COUNT(*)::int AS n FROM users WHERE email = $1", [email]);
    assert.equal(rows.rows[0].n, 1, "exactly one row exists (unique constraint holds under concurrency)");
  } finally {
    await h.close();
  }
});

test("PG: sessions — create, find by refresh hash, rotate, revoke, revoke-all", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const u = await h.store.createUser({
      email: "pguser-sessions@velora.test", passwordHash: "h", fullName: "S",
      timezone: "UTC", locale: "en", now: T0,
    });
    const s1 = await h.store.createSession({
      userId: u.id, refreshTokenHash: "rt-1", accessTokenHash: "at-1",
      ipAddress: "203.0.113.4", userAgent: "probe-agent", expiresAt: T2, createdAt: T0,
    });
    assert.equal(s1.userId, u.id);
    assert.equal(s1.revokedAt, null);

    const found = await h.store.findSessionByRefreshTokenHash("rt-1");
    assert.notEqual(found, null);
    assert.equal(found!.id, s1.id);

    await h.store.rotateSession(s1.id, {
      refreshTokenHash: "rt-2", accessTokenHash: "at-2",
      ipAddress: null, userAgent: null, expiresAt: T2,
    });
    assert.equal(await h.store.findSessionByRefreshTokenHash("rt-1"), null, "old refresh hash gone after rotation");
    const rotated = await h.store.findSessionByRefreshTokenHash("rt-2");
    assert.notEqual(rotated, null);

    await h.store.createSession({
      userId: u.id, refreshTokenHash: "rt-3", accessTokenHash: "at-3",
      ipAddress: null, userAgent: null, expiresAt: T2, createdAt: T1,
    });
    await h.store.revokeAllSessionsForUser(u.id, T2);
    const all = await h.pool.query("SELECT revoked_at IS NOT NULL AS r FROM user_sessions WHERE user_id = $1", [u.id]);
    assert.equal(all.rows.length, 2);
    for (const row of all.rows) assert.equal(row.r, true, "every session revoked");
    assert.equal((await h.store.findSessionByRefreshTokenHash("rt-2"))!.revokedAt, T2.toISOString());
  } finally {
    await h.close();
  }
});

test("PG: verifications — create, count-since, latest, consume, delete-all", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const u = await h.store.createUser({
      email: "pguser-verify@velora.test", passwordHash: "h", fullName: "V",
      timezone: "UTC", locale: "en", now: T0,
    });
    const v1 = await h.store.createVerification({ userId: u.id, tokenHash: "th-1", expiresAt: T2, createdAt: T0 });
    const v2 = await h.store.createVerification({ userId: u.id, tokenHash: "th-2", expiresAt: T2, createdAt: T1 });
    // created_at is DB-generated (DEFAULT now() — same contract as the
    // PGlite-evidenced adapter; the input createdAt exists for the memory
    // adapter's deterministic tests). Count boundaries therefore anchor to
    // the store's OWN returned timestamps, never to a caller-side clock
    // (run 34732496174 lesson: fixed future-dated boundaries count zero).
    assert.equal(await h.store.countVerificationsSince(u.id, new Date(0)), 2, "since epoch: both rows");
    const justAfterFirst = new Date(new Date(v1.createdAt).getTime() + 1);
    assert.equal(await h.store.countVerificationsSince(u.id, justAfterFirst), 1, ">= boundary excludes the earlier row");
    const latest = await h.store.latestVerification(u.id);
    assert.equal(latest!.tokenHash, "th-2"); // v2 inserted after v1 — later DB created_at
    assert.equal((await h.store.findVerificationByTokenHash("th-1"))!.id, v1.id);
    await h.store.consumeVerification(v1.id, T2);
    assert.equal((await h.store.findVerificationByTokenHash("th-1"))!.consumedAt, T2.toISOString());
    await h.store.deleteVerifications(u.id);
    assert.equal(await h.store.latestVerification(u.id), null);
    assert.equal(await h.store.countVerificationsSince(u.id, new Date(0)), 0, "all rows deleted");
    void v2;
  } finally {
    await h.close();
  }
});

test("PG: preferences — locale patch, aiConsentAt set/null-clear, email prefs default + upsert", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const u = await h.store.createUser({
      email: "pguser-prefs@velora.test", passwordHash: "h", fullName: "P",
      timezone: "UTC", locale: "fa", now: T0,
    });
    // absent locale keeps current value; aiConsentAt set
    const set1 = await h.store.updateUserPreferences(u.id, { aiConsentAt: T1.toISOString() }, T1);
    assert.equal(set1!.locale, "fa");
    assert.equal(set1!.aiConsentAt, T1.toISOString());
    // explicit null CLEARS ai_consent_at (the CASE pair — null-clear law)
    const set2 = await h.store.updateUserPreferences(u.id, { aiConsentAt: null }, T2);
    assert.equal(set2!.aiConsentAt, null);
    // locale flip
    const set3 = await h.store.updateUserPreferences(u.id, { locale: "en" }, T2);
    assert.equal(set3!.locale, "en");
    assert.equal(await h.store.updateUserPreferences("999999999", { locale: "en" }, T2), null);

    // email preferences: default-ON when no row; upsert round-trips
    const defaults = await h.store.getEmailPreferences(u.id);
    assert.equal(defaults.weeklyReport, true);
    await h.store.upsertEmailPreferences(u.id, {
      welcomeEmail: true, securityAlerts: false, tradeNotifications: true,
      weeklyReport: false, monthlyReport: true, achievementNotifications: false,
    }, T1);
    const prefs = await h.store.getEmailPreferences(u.id);
    assert.deepEqual(prefs, {
      welcomeEmail: true, securityAlerts: false, tradeNotifications: true,
      weeklyReport: false, monthlyReport: true, achievementNotifications: false,
    });
    await h.store.upsertEmailPreferences(u.id, {
      welcomeEmail: false, securityAlerts: true, tradeNotifications: false,
      weeklyReport: true, monthlyReport: true, achievementNotifications: true,
    }, T2); // single row per user (PK upsert)
    const again = await h.store.getEmailPreferences(u.id);
    assert.equal(again.welcomeEmail, false);
    const rows = await h.pool.query("SELECT COUNT(*)::int AS n FROM email_preferences WHERE user_id = $1", [u.id]);
    assert.equal(rows.rows[0].n, 1);
  } finally {
    await h.close();
  }
});
