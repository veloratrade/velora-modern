// PgUserStore — Phase D D2: the real-PostgreSQL UserStore adapter (direct pg).
// SQL contract is the PGlite-evidenced implementation from
// db/tests/identityPersistence.test.ts (behavioral guidance per the D2 rule),
// with one PostgreSQL-specific divergence: duplicate-email detection maps
// SQLSTATE 23505 + users_email_unique to UserEmailExistsError via the pg
// error object (D1 risk R7) instead of relying on message text alone.
//
// EVIDENCE: adapter battery = db/tests/pgUserStore.pg.test.ts, executed only
// against a real disposable PostgreSQL (postgres-evidence workflow). The
// PGlite identity suite remains separate, in-wasm evidence — never real-PG
// proof (Phase D evidence policy).
import type { Pool } from "pg";
import { normalizeRole } from "@velora/contracts";
import { poolQuery, isUniqueViolation, iso, isoOrNull, type QueryFn } from "../persistence/pg.js";
import type {
  UserStore,
  UserRecord,
  AppRoleName,
  SessionRecord,
  VerificationRecord,
  EmailPreferences,
  PasswordResetRecord,
} from "./userStore.js";
import { UserEmailExistsError, DEFAULT_EMAIL_PREFERENCES } from "./userStore.js";

/** Row shape as node-postgres delivers it (int8 → string, timestamptz → Date). */
interface UserRow {
  id: string;
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
    // Phase 3B-3: normalizeRole maps any value outside the frozen OD-9 set to
    // the LEAST privileged role. The previous ternary silently collapsed
    // 'super_admin' to 'user' (a privilege DOWNGRADE that would have become
    // live the moment migration 0006 widened the CHECK).
    role: normalizeRole(r.role),
    plan: r.plan,
    status: r.status,
    emailVerifiedAt: isoOrNull(r.email_verified_at),
    aiConsentAt: isoOrNull(r.ai_consent_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function mapVerification(r: Record<string, unknown>): VerificationRecord {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    tokenHash: String(r.token_hash),
    expiresAt: iso(r.expires_at as Date | string),
    consumedAt: isoOrNull(r.consumed_at as Date | string | null),
    createdAt: iso(r.created_at as Date | string),
  };
}

function mapPasswordReset(r: Record<string, unknown>): PasswordResetRecord {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    tokenHash: String(r.token_hash),
    expiresAt: iso(r.expires_at as Date | string),
    consumedAt: isoOrNull(r.consumed_at as Date | string | null),
    createdAt: iso(r.created_at as Date | string),
  };
}

function mapSession(r: Record<string, unknown>): SessionRecord {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    refreshTokenHash: String(r.refresh_token_hash),
    accessTokenHash: r.access_token_hash === null ? null : String(r.access_token_hash),
    ipAddress: r.ip_address === null ? null : String(r.ip_address),
    userAgent: r.user_agent === null ? null : String(r.user_agent),
    expiresAt: iso(r.expires_at as Date | string),
    revokedAt: isoOrNull(r.revoked_at as Date | string | null),
    createdAt: iso(r.created_at as Date | string),
  };
}

export class PgUserStore implements UserStore {
  private readonly q: QueryFn;

  constructor(private readonly pool: Pool) {
    this.q = poolQuery(pool);
  }

  async createUser(input: {
    email: string;
    passwordHash: string;
    fullName: string;
    timezone: string;
    locale: "fa" | "en";
    now: Date;
  }): Promise<UserRecord> {
    let row: Record<string, unknown> | undefined;
    try {
      const rows = await this.q(
        `INSERT INTO users (email, password_hash, full_name, timezone, locale)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [input.email, input.passwordHash, input.fullName, input.timezone, input.locale],
      );
      row = rows[0];
    } catch (err) {
      // PostgreSQL: unique_violation (23505) on users_email_unique.
      if (isUniqueViolation(err, "users_email_unique")) {
        throw new UserEmailExistsError(input.email);
      }
      throw err;
    }
    if (row === undefined) throw new Error("createUser: INSERT returned no row");
    return mapUser(row as unknown as UserRow);
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const rows = await this.q("SELECT * FROM users WHERE email = $1", [email]);
    return rows.length === 0 ? null : mapUser(rows[0] as unknown as UserRow);
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const rows = await this.q("SELECT * FROM users WHERE id = $1", [id]);
    return rows.length === 0 ? null : mapUser(rows[0] as unknown as UserRow);
  }

  async updateUserPasswordHash(userId: string, passwordHash: string, now: Date): Promise<void> {
    await this.q("UPDATE users SET password_hash = $1, updated_at = $2 WHERE id = $3", [
      passwordHash,
      now,
      userId,
    ]);
  }

  async markEmailVerified(userId: string, verifiedAt: Date): Promise<void> {
    await this.q("UPDATE users SET email_verified_at = $1 WHERE id = $2", [verifiedAt, userId]);
  }

  async countVerificationsSince(userId: string, since: Date): Promise<number> {
    const rows = await this.q(
      "SELECT COUNT(*)::int AS n FROM email_verifications WHERE user_id = $1 AND created_at >= $2",
      [userId, since],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async latestVerification(userId: string): Promise<VerificationRecord | null> {
    const rows = await this.q(
      "SELECT * FROM email_verifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [userId],
    );
    return rows.length === 0 ? null : mapVerification(rows[0]!);
  }

  async deleteVerifications(userId: string): Promise<void> {
    await this.q("DELETE FROM email_verifications WHERE user_id = $1", [userId]);
  }

  async createVerification(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<VerificationRecord> {
    const rows = await this.q(
      "INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING *",
      [input.userId, input.tokenHash, input.expiresAt],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("createVerification: INSERT returned no row");
    return mapVerification(row);
  }

  async findVerificationByTokenHash(tokenHash: string): Promise<VerificationRecord | null> {
    const rows = await this.q("SELECT * FROM email_verifications WHERE token_hash = $1", [tokenHash]);
    return rows.length === 0 ? null : mapVerification(rows[0]!);
  }

  async consumeVerification(id: string, consumedAt: Date): Promise<void> {
    await this.q("UPDATE email_verifications SET consumed_at = $1 WHERE id = $2", [consumedAt, id]);
  }

  // --- Password reset (Phase 3B-1; table exists since 0001_core.sql) --------

  async deletePasswordResets(userId: string): Promise<void> {
    await this.q("DELETE FROM password_resets WHERE user_id = $1", [userId]);
  }

  async createPasswordReset(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<PasswordResetRecord> {
    const rows = await this.q(
      "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING *",
      [input.userId, input.tokenHash, input.expiresAt],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("createPasswordReset: INSERT returned no row");
    return mapPasswordReset(row);
  }

  async findPasswordResetByTokenHash(tokenHash: string): Promise<PasswordResetRecord | null> {
    const rows = await this.q("SELECT * FROM password_resets WHERE token_hash = $1", [tokenHash]);
    return rows.length === 0 ? null : mapPasswordReset(rows[0]!);
  }

  async consumePasswordReset(id: string, consumedAt: Date): Promise<void> {
    await this.q("UPDATE password_resets SET consumed_at = $1 WHERE id = $2", [consumedAt, id]);
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
    const rows = await this.q(
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
    const row = rows[0];
    if (row === undefined) throw new Error("createSession: INSERT returned no row");
    return mapSession(row);
  }

  async findSessionByRefreshTokenHash(refreshTokenHash: string): Promise<SessionRecord | null> {
    const rows = await this.q("SELECT * FROM user_sessions WHERE refresh_token_hash = $1", [
      refreshTokenHash,
    ]);
    return rows.length === 0 ? null : mapSession(rows[0]!);
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
    await this.q(
      `UPDATE user_sessions
       SET refresh_token_hash = $1, access_token_hash = $2, ip_address = $3, user_agent = $4, expires_at = $5
       WHERE id = $6`,
      [input.refreshTokenHash, input.accessTokenHash, input.ipAddress, input.userAgent, input.expiresAt, id],
    );
  }

  async revokeSession(id: string, revokedAt: Date): Promise<void> {
    await this.q("UPDATE user_sessions SET revoked_at = $1 WHERE id = $2", [revokedAt, id]);
  }

  async revokeAllSessionsForUser(userId: string, revokedAt: Date): Promise<void> {
    await this.q(
      "UPDATE user_sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL",
      [revokedAt, userId],
    );
  }

  async updateUserPreferences(
    userId: string,
    patch: { locale?: "fa" | "en"; aiConsentAt?: string | null },
    now: Date,
  ): Promise<UserRecord | null> {
    // PGlite-evidenced SQL: COALESCE keeps absent locale; the CASE pair
    // distinguishes "set ai_consent_at" from "explicitly clear it to NULL".
    const rows = await this.q(
      `UPDATE users SET
         locale = COALESCE($1, locale),
         ai_consent_at = CASE WHEN $2::timestamptz IS NOT NULL THEN $2::timestamptz
                              WHEN $3 THEN NULL ELSE ai_consent_at END,
         updated_at = $4
       WHERE id = $5 RETURNING *`,
      [patch.locale ?? null, patch.aiConsentAt ?? null, patch.aiConsentAt === null, now, userId],
    );
    return rows.length === 0 ? null : mapUser(rows[0] as unknown as UserRow);
  }

  // --- Phase 3B-4: administrative user management ---------------------------
  // Every value is bound as a parameter; no fragment is ever concatenated from
  // caller input. The ILIKE needle is bound too, so wildcards supplied by a
  // caller are matched literally rather than expanding the result set.

  async listUsers(query: {
    search?: string;
    role?: AppRoleName;
    status?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: readonly UserRecord[]; total: number }> {
    // Containment search WITHOUT LIKE: position() has no metacharacters, so a
    // needle containing % or _ is matched literally with no escape clause to get
    // wrong, and the semantics are identical to MemoryUserStore's
    // `toLowerCase().includes(...)` — the two adapters cannot drift.
    const search = (query.search ?? "").trim();
    const needle = search === "" ? null : search.toLowerCase();
    const where = `WHERE ($1::text IS NULL
                      OR position($1 in lower(email)) > 0
                      OR position($1 in lower(full_name)) > 0)
                     AND ($2::text IS NULL OR role = $2)
                     AND ($3::text IS NULL OR status = $3)`;
    const filters = [needle, query.role ?? null, query.status ?? null];
    const countRows = await this.q(`SELECT COUNT(*)::int AS n FROM users ${where}`, filters);
    const rows = await this.q(
      `SELECT * FROM users ${where} ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5`,
      [...filters, query.limit, query.offset],
    );
    return {
      items: rows.map((r) => mapUser(r as unknown as UserRow)),
      total: Number(countRows[0]?.n ?? 0),
    };
  }

  async updateUserRole(userId: string, role: AppRoleName, now: Date): Promise<UserRecord | null> {
    const rows = await this.q(
      "UPDATE users SET role = $1, updated_at = $2 WHERE id = $3 RETURNING *",
      [role, now, userId],
    );
    return rows.length === 0 ? null : mapUser(rows[0] as unknown as UserRow);
  }

  async updateUserStatus(userId: string, status: string, now: Date): Promise<UserRecord | null> {
    const rows = await this.q(
      "UPDATE users SET status = $1, updated_at = $2 WHERE id = $3 RETURNING *",
      [status, now, userId],
    );
    return rows.length === 0 ? null : mapUser(rows[0] as unknown as UserRow);
  }

  async countUsersByRole(role: AppRoleName): Promise<number> {
    const rows = await this.q("SELECT COUNT(*)::int AS n FROM users WHERE role = $1", [role]);
    return Number(rows[0]?.n ?? 0);
  }

  async countActiveUsersByRole(role: AppRoleName, excludeUserId?: string): Promise<number> {
    const rows = await this.q(
      `SELECT COUNT(*)::int AS n FROM users
        WHERE role = $1 AND status = 'active' AND ($2::text IS NULL OR id <> $2::bigint)`,
      [role, excludeUserId ?? null],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async getEmailPreferences(userId: string): Promise<EmailPreferences> {
    const rows = await this.q("SELECT * FROM email_preferences WHERE user_id = $1", [userId]);
    if (rows.length === 0) return DEFAULT_EMAIL_PREFERENCES;
    const r = rows[0]! as Record<string, boolean>;
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
    await this.q(
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
      [
        userId,
        prefs.welcomeEmail,
        prefs.securityAlerts,
        prefs.tradeNotifications,
        prefs.weeklyReport,
        prefs.monthlyReport,
        prefs.achievementNotifications,
        now,
      ],
    );
  }
}
