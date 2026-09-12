// Identity persistence-boundary integration test — Phase C (C6/C10).
//
// EVIDENCE LABEL (test honesty rule): this suite runs the REAL application
// boundary (AuthService → UserStore port) against a DISPOSABLE PGlite
// instance (PostgreSQL semantics in-wasm) with the real migrations applied.
// It is PGlite evidence — NOT real-PostgreSQL evidence, NOT production
// evidence. Real-PG verification remains deferred to Phase D (S5 boundary).
//
// The PgliteUserStore below is a test-local adapter implementing the UserStore
// port from apps/api/src/auth/userStore.ts with SQL — proving the port is
// PostgreSQL-compatible and that DB constraints (email UNIQUE, token UNIQUE)
// surface through the boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createEngine, migrate, type MigrationEngine } from "../migrate.ts";
import { AuthService } from "../../apps/api/src/auth/authService.ts";
import { VeloraHasher } from "../../apps/api/src/auth/hashing.ts";
import { JwtService } from "../../apps/api/src/auth/jwt.ts";
import type {
  UserStore,
  UserRecord,
  SessionRecord,
  VerificationRecord,
  EmailPreferences,
} from "../../apps/api/src/auth/userStore.ts";
import { UserEmailExistsError, DEFAULT_EMAIL_PREFERENCES } from "../../apps/api/src/auth/userStore.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const SECRET = "identity-pglite-test-secret-0123456789abcdef"; // 43 chars, test-only
const PHP_BCRYPT_2Y_COST10 =
  "$2y$10$.vGA1O9wmRjrwAVXD98HNOgsNpDczlqm3Jq7KnEd1rVAGv3Fykk1a"; // PHP manual vector
const VECTOR_PASSWORD = "rasmuslerdorf"; // public documentation example, not a credential

const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

interface UserRow {
  id: string | bigint | number;
  email: string;
  password_hash: string;
  full_name: string;
  timezone: string;
  locale: string;
  role: string;
  plan: string;
  status: string;
  email_verified_at: Date | string | null;
  ai_consent_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapUser(r: UserRow): UserRecord {
  return {
    id: String(r.id),
    email: r.email,
    passwordHash: r.password_hash,
    fullName: r.full_name,
    timezone: r.timezone,
    locale: r.locale === "en" ? "en" : "fa",
    role: r.role === "admin" ? "admin" : "user",
    plan: r.plan,
    status: r.status,
    emailVerifiedAt: iso(r.email_verified_at),
    aiConsentAt: iso(r.ai_consent_at),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

/** PostgreSQL-dialect UserStore implementation (PGlite engine, test-local). */
class PgliteUserStore implements UserStore {
  constructor(private readonly engine: MigrationEngine) {}

  async createUser(input: {
    email: string;
    passwordHash: string;
    fullName: string;
    timezone: string;
    locale: "fa" | "en";
    now: Date;
  }): Promise<UserRecord> {
    try {
      const res = await this.engine.query(
        `INSERT INTO users (email, password_hash, full_name, timezone, locale)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [input.email, input.passwordHash, input.fullName, input.timezone, input.locale],
      );
      return mapUser(res.rows[0] as unknown as UserRow);
    } catch (err) {
      if (err instanceof Error && /users_email_unique/.test(err.message)) {
        throw new UserEmailExistsError(input.email);
      }
      throw err;
    }
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const res = await this.engine.query("SELECT * FROM users WHERE email = $1", [email]);
    return res.rows.length === 0 ? null : mapUser(res.rows[0] as unknown as UserRow);
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const res = await this.engine.query("SELECT * FROM users WHERE id = $1", [id]);
    return res.rows.length === 0 ? null : mapUser(res.rows[0] as unknown as UserRow);
  }

  async updateUserPasswordHash(userId: string, passwordHash: string, now: Date): Promise<void> {
    await this.engine.query("UPDATE users SET password_hash = $1, updated_at = $2 WHERE id = $3", [
      passwordHash,
      now,
      userId,
    ]);
  }

  async markEmailVerified(userId: string, verifiedAt: Date): Promise<void> {
    await this.engine.query("UPDATE users SET email_verified_at = $1 WHERE id = $2", [
      verifiedAt,
      userId,
    ]);
  }

  async countVerificationsSince(userId: string, since: Date): Promise<number> {
    const res = await this.engine.query(
      "SELECT COUNT(*)::int AS n FROM email_verifications WHERE user_id = $1 AND created_at >= $2",
      [userId, since],
    );
    return Number((res.rows[0] as { n: number }).n);
  }

  async latestVerification(userId: string): Promise<VerificationRecord | null> {
    const res = await this.engine.query(
      "SELECT * FROM email_verifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [userId],
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0] as Record<string, Date | string | null>;
    return {
      id: String(r.id),
      userId: String(r.user_id),
      tokenHash: String(r.token_hash),
      expiresAt: iso(r.expires_at)!,
      consumedAt: iso(r.consumed_at),
      createdAt: iso(r.created_at)!,
    };
  }

  async deleteVerifications(userId: string): Promise<void> {
    await this.engine.query("DELETE FROM email_verifications WHERE user_id = $1", [userId]);
  }

  async createVerification(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<VerificationRecord> {
    const res = await this.engine.query(
      "INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING *",
      [input.userId, input.tokenHash, input.expiresAt],
    );
    const r = res.rows[0] as Record<string, Date | string | null>;
    return {
      id: String(r.id),
      userId: String(r.user_id),
      tokenHash: String(r.token_hash),
      expiresAt: iso(r.expires_at)!,
      consumedAt: iso(r.consumed_at),
      createdAt: iso(r.created_at)!,
    };
  }

  async findVerificationByTokenHash(tokenHash: string): Promise<VerificationRecord | null> {
    const res = await this.engine.query(
      "SELECT * FROM email_verifications WHERE token_hash = $1",
      [tokenHash],
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0] as Record<string, Date | string | null>;
    return {
      id: String(r.id),
      userId: String(r.user_id),
      tokenHash: String(r.token_hash),
      expiresAt: iso(r.expires_at)!,
      consumedAt: iso(r.consumed_at),
      createdAt: iso(r.created_at)!,
    };
  }

  async consumeVerification(id: string, consumedAt: Date): Promise<void> {
    await this.engine.query("UPDATE email_verifications SET consumed_at = $1 WHERE id = $2", [
      consumedAt,
      id,
    ]);
  }

  async createSession(input: {
    userId: string;
    refreshTokenHash: string;
    accessTokenHash: string;
    ipAddress: string | null;
    userAgent: string | null;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<SessionRecord> {
    const res = await this.engine.query(
      `INSERT INTO user_sessions (user_id, refresh_token_hash, access_token_hash, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        input.userId,
        input.refreshTokenHash,
        input.accessTokenHash,
        input.ipAddress,
        input.userAgent,
        input.expiresAt,
      ],
    );
    const r = res.rows[0] as Record<string, Date | string | null>;
    return {
      id: String(r.id),
      userId: String(r.user_id),
      refreshTokenHash: String(r.refresh_token_hash),
      accessTokenHash: r.access_token_hash === null ? null : String(r.access_token_hash),
      ipAddress: r.ip_address === null ? null : String(r.ip_address),
      userAgent: r.user_agent === null ? null : String(r.user_agent),
      expiresAt: iso(r.expires_at)!,
      revokedAt: iso(r.revoked_at),
      createdAt: iso(r.created_at)!,
    };
  }

  async findSessionByRefreshTokenHash(refreshTokenHash: string): Promise<SessionRecord | null> {
    const res = await this.engine.query(
      "SELECT * FROM user_sessions WHERE refresh_token_hash = $1",
      [refreshTokenHash],
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0] as Record<string, Date | string | null>;
    return {
      id: String(r.id),
      userId: String(r.user_id),
      refreshTokenHash: String(r.refresh_token_hash),
      accessTokenHash: r.access_token_hash === null ? null : String(r.access_token_hash),
      ipAddress: r.ip_address === null ? null : String(r.ip_address),
      userAgent: r.user_agent === null ? null : String(r.user_agent),
      expiresAt: iso(r.expires_at)!,
      revokedAt: iso(r.revoked_at),
      createdAt: iso(r.created_at)!,
    };
  }

  async rotateSession(
    id: string,
    input: {
      refreshTokenHash: string;
      accessTokenHash: string;
      ipAddress: string | null;
      userAgent: string | null;
      expiresAt: Date;
    },
  ): Promise<void> {
    await this.engine.query(
      `UPDATE user_sessions
       SET refresh_token_hash = $1, access_token_hash = $2, ip_address = $3, user_agent = $4, expires_at = $5
       WHERE id = $6`,
      [input.refreshTokenHash, input.accessTokenHash, input.ipAddress, input.userAgent, input.expiresAt, id],
    );
  }

  async revokeSession(id: string, revokedAt: Date): Promise<void> {
    await this.engine.query("UPDATE user_sessions SET revoked_at = $1 WHERE id = $2", [
      revokedAt,
      id,
    ]);
  }

  async revokeAllSessionsForUser(userId: string, revokedAt: Date): Promise<void> {
    await this.engine.query(
      "UPDATE user_sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL",
      [revokedAt, userId],
    );
  }

  async updateUserPreferences(
    userId: string,
    patch: { locale?: "fa" | "en"; aiConsentAt?: string | null },
    now: Date,
  ): Promise<UserRecord | null> {
    const res = await this.engine.query(
      `UPDATE users SET
         locale = COALESCE($1, locale),
         ai_consent_at = CASE WHEN $2::timestamptz IS NOT NULL THEN $2::timestamptz
                              WHEN $3 THEN NULL ELSE ai_consent_at END,
         updated_at = $4
       WHERE id = $5 RETURNING *`,
      [patch.locale ?? null, patch.aiConsentAt ?? null, patch.aiConsentAt === null, now, userId],
    );
    return res.rows.length === 0 ? null : mapUser(res.rows[0] as unknown as UserRow);
  }

  async getEmailPreferences(userId: string): Promise<EmailPreferences> {
    const res = await this.engine.query(
      "SELECT * FROM email_preferences WHERE user_id = $1",
      [userId],
    );
    if (res.rows.length === 0) return DEFAULT_EMAIL_PREFERENCES;
    const r = res.rows[0] as Record<string, boolean>;
    return {
      welcomeEmail: r.welcome_email === true,
      securityAlerts: r.security_alerts === true,
      tradeNotifications: r.trade_notifications === true,
      weeklyReport: r.weekly_report === true,
      monthlyReport: r.monthly_report === true,
      achievementNotifications: r.achievement_notifications === true,
    };
  }

  async upsertEmailPreferences(userId: string, prefs: EmailPreferences, now: Date): Promise<void> {
    await this.engine.query(
      `INSERT INTO email_preferences
         (user_id, welcome_email, security_alerts, trade_notifications, weekly_report, monthly_report, achievement_notifications, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id) DO UPDATE SET
         welcome_email = EXCLUDED.welcome_email,
         security_alerts = EXCLUDED.security_alerts,
         trade_notifications = EXCLUDED.trade_notifications,
         weekly_report = EXCLUDED.weekly_report,
         monthly_report = EXCLUDED.monthly_report,
         achievement_notifications = EXCLUDED.achievement_notifications,
         updated_at = EXCLUDED.updated_at`,
      [userId, prefs.welcomeEmail, prefs.securityAlerts, prefs.tradeNotifications, prefs.weeklyReport, prefs.monthlyReport, prefs.achievementNotifications, now],
    );
  }
}

async function freshHarness(): Promise<{
  engine: MigrationEngine;
  service: AuthService;
  tokens: string[];
  close: () => Promise<void>;
}> {
  const engine = await createEngine();
  const ran = await migrate(engine, MIGRATIONS);
  assert.ok(ran.includes("0001_core.sql"));
  assert.ok(ran.includes("0002_identity_capability.sql"));
  assert.ok(ran.includes("0003_email_preferences.sql"));
  const tokens: string[] = [];
  const service = new AuthService({
    store: new PgliteUserStore(engine),
    hasher: new VeloraHasher(),
    jwt: JwtService.create(SECRET),
    generateVerificationToken: () => {
      const t = `pglite-verification-token-${tokens.length + 1}-0123456789abcdef`;
      tokens.push(t);
      return t;
    },
  });
  return { engine, service, tokens, close: () => engine.close() };
}

test("PGlite: migrations 0001+0002 apply; full identity journey through the port", async () => {
  const h = await freshHarness();
  try {
    // register → verify → login → me → refresh → logout (all through real SQL)
    const reg = await h.service.register({
      email: "pglite@velora.example",
      password: "a-strong-password-123",
      fullName: "P Glite",
      timezone: "Europe/Amsterdam",
    });
    assert.equal(reg.verificationRequired, true);
    await h.service.verifyEmail(h.tokens.shift()!);

    const pair = await h.service.login({
      email: "pglite@velora.example",
      password: "a-strong-password-123",
      ipAddress: "127.0.0.1",
      userAgent: "pglite-test-agent",
    });
    assert.equal(pair.user.fullName, "P Glite");
    assert.equal(pair.user.timezone, "Europe/Amsterdam");

    const me = await h.service.me(pair.user.id.toString());
    assert.equal(me.email, "pglite@velora.example");

    const rotated = await h.service.refresh(pair.refreshToken, "127.0.0.1", "pglite-test-agent");
    assert.notEqual(rotated.refreshToken, pair.refreshToken);
    await h.service.logout(rotated.refreshToken);

    // post-logout refresh rejected
    await assert.rejects(h.service.refresh(rotated.refreshToken));
  } finally {
    await h.close();
  }
});

test("PGlite: legacy $2y$ login rehashes to exact Argon2id and is PERSISTED in PG", async () => {
  const h = await freshHarness();
  try {
    const legacy = await (h.service as unknown as { deps: { store: PgliteUserStore } }).deps.store.createUser({
      email: "legacy-pg@velora.example",
      passwordHash: PHP_BCRYPT_2Y_COST10,
      fullName: "",
      timezone: "UTC",
      locale: "fa",
      now: new Date(),
    });
    await (h.service as unknown as { deps: { store: PgliteUserStore } }).deps.store.markEmailVerified(
      legacy.id,
      new Date(),
    );
    const pair = await h.service.login({ email: "legacy-pg@velora.example", password: VECTOR_PASSWORD });
    assert.equal(pair.user.email, "legacy-pg@velora.example");

    const row = await h.engine.query("SELECT password_hash FROM users WHERE id = $1", [legacy.id]);
    const storedHash = String((row.rows[0] as { password_hash: string }).password_hash);
    assert.ok(
      storedHash.startsWith("$argon2id$v=19$m=19456,t=2,p=1$"),
      "rehashed in PG to the exact D-04 parameters",
    );

    // second login uses the upgraded hash (and does not rehash again)
    const before = storedHash;
    await h.service.login({ email: "legacy-pg@velora.example", password: VECTOR_PASSWORD });
    const after = await h.engine.query("SELECT password_hash FROM users WHERE id = $1", [legacy.id]);
    assert.equal(String((after.rows[0] as { password_hash: string }).password_hash), before);
  } finally {
    await h.close();
  }
});

test("PGlite: DB constraints surface through the port (email UNIQUE, token UNIQUE)", async () => {
  const h = await freshHarness();
  try {
    // (register on an unverified duplicate takes the resend path — covered in
    // the unit suite; the DB constraint itself is asserted at the store level.)
    const store = (h.service as unknown as { deps: { store: PgliteUserStore } }).deps.store;
    await store.createUser({
      email: "dup@velora.example",
      passwordHash: "x",
      fullName: "",
      timezone: "UTC",
      locale: "fa",
      now: new Date(),
    });
    await assert.rejects(
      store.createUser({
        email: "dup@velora.example",
        passwordHash: "x",
        fullName: "",
        timezone: "UTC",
        locale: "fa",
        now: new Date(),
      }),
      (e: unknown) => e instanceof UserEmailExistsError,
    );
    // duplicate refresh-token hash → DB unique violation
    await store.createSession({
      userId: "1",
      refreshTokenHash: "duplicate-hash",
      accessTokenHash: "a",
      ipAddress: null,
      userAgent: null,
      expiresAt: new Date(),
      createdAt: new Date(),
    });
    await assert.rejects(
      store.createSession({
        userId: "1",
        refreshTokenHash: "duplicate-hash",
        accessTokenHash: "a",
        ipAddress: null,
        userAgent: null,
        expiresAt: new Date(),
        createdAt: new Date(),
      }),
      (e: unknown) => /user_sessions_token_unique|duplicate key/.test(String(e)),
    );
  } finally {
    await h.close();
  }
});

test("PGlite: change-password revokes all sessions and persists the new hash in PG", async () => {
  const h = await freshHarness();
  try {
    await h.service.register({ email: "chg@velora.example", password: "first-strong-password-1" });
    await h.service.verifyEmail(h.tokens.shift()!);
    const pair = await h.service.login({ email: "chg@velora.example", password: "first-strong-password-1" });

    const result = await h.service.changePassword(pair.user.id.toString(), {
      currentPassword: "first-strong-password-1",
      newPassword: "second-strong-password-2",
    });
    assert.deepEqual(result, { changed: true, messageKey: "auth.passwordChanged", params: {} });

    // all sessions revoked
    await assert.rejects(
      h.service.refresh(pair.refreshToken),
      (e: unknown) => e instanceof Error && (e as { code?: string }).code === "INVALID_TOKEN",
    );
    // old password rejected; new password works
    await assert.rejects(h.service.login({ email: "chg@velora.example", password: "first-strong-password-1" }));
    const reLogin = await h.service.login({ email: "chg@velora.example", password: "second-strong-password-2" });
    const row = await h.engine.query("SELECT password_hash FROM users WHERE email = $1", ["chg@velora.example"]);
    assert.ok(String((row.rows[0] as { password_hash: string }).password_hash).startsWith("$argon2id$v=19$m=19456,t=2,p=1$"));
    void reLogin;
  } finally {
    await h.close();
  }
});

test("PGlite: email preferences persist through the port (0003 migration)", async () => {
  const h = await freshHarness();
  try {
    await h.service.register({ email: "prefs@velora.example", password: "a-strong-password-123" });
    await h.service.verifyEmail(h.tokens.shift()!);

    // defaults (no row) — PHP shape, all ON
    const before = await h.service.getEmailPreferences("1");
    assert.deepEqual(before.preferences, {
      welcome_email: 1,
      security_alerts: 1,
      trade_notifications: 1,
      weekly_report: 1,
      monthly_report: 1,
      achievement_notifications: 1,
    });

    // partial update: only booleans over known keys merge (PHP semantics)
    const updated = await h.service.updateEmailPreferences("1", {
      weekly_report: false,
      marketing_emails: true, // unknown key — ignored (not in the PHP key set)
      monthly_report: "yes",  // non-bool — ignored (PHP is_bool)
    });
    assert.equal(updated.updated, true);
    assert.equal(updated.preferences.weekly_report, 0);
    assert.equal(updated.preferences.monthly_report, 1); // unchanged
    assert.equal(updated.preferences.welcome_email, 1);  // no silent reset

    // persisted in PG
    const row = await h.engine.query("SELECT weekly_report FROM email_preferences WHERE user_id = $1", ["1"]);
    assert.equal((row.rows[0] as { weekly_report: boolean }).weekly_report, false);
  } finally {
    await h.close();
  }
});

test("PGlite: preferences update persists locale + ai_consent_at", async () => {
  const h = await freshHarness();
  try {
    await h.service.register({ email: "pref2@velora.example", password: "a-strong-password-123" });
    await h.service.verifyEmail(h.tokens.shift()!);
    const r = await h.service.updatePreferences("1", { locale: "en", ai_consent: true });
    assert.equal(r.updated, true);
    assert.equal(r.locale, "en");
    assert.equal(r.ai_consent, true);
    assert.ok(r.ai_consent_at !== null);
    const off = await h.service.updatePreferences("1", { ai_consent: false });
    assert.equal(off.ai_consent, false);
    assert.equal(off.ai_consent_at, null);
    const row = await h.engine.query("SELECT locale, ai_consent_at FROM users WHERE id = $1", ["1"]);
    assert.equal((row.rows[0] as { locale: string }).locale, "en");
    assert.equal((row.rows[0] as { ai_consent_at: Date | null }).ai_consent_at, null);
  } finally {
    await h.close();
  }
});
