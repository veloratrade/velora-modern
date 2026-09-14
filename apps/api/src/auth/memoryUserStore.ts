// In-memory UserStore adapter — development/test only (PERSISTENCE=memory is
// blocked outside development by the Phase B boot gate; this adapter is the
// authorized local boundary). Mirrors the DB constraints (email UNIQUE,
// refresh-token UNIQUE) so port-contract violations surface identically.
import {
  type UserRecord,
  type SessionRecord,
  type VerificationRecord,
  type PasswordResetRecord,
  type UserStore,
  type AppRoleName,
  type EmailPreferences,
  DEFAULT_EMAIL_PREFERENCES,
  UserEmailExistsError,
} from "./userStore.js";

const iso = (d: Date): string => d.toISOString();

export class MemoryUserStore implements UserStore {
  private readonly users = new Map<string, UserRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly verifications = new Map<string, VerificationRecord>();
  private readonly passwordResets = new Map<string, PasswordResetRecord>();
  private readonly sessionsByRefreshHash = new Map<string, string>();
  private readonly emailPrefs = new Map<string, EmailPreferences>();
  private idCounter = 0;

  async createUser(input: {
    email: string;
    passwordHash: string;
    fullName: string;
    timezone: string;
    locale: "fa" | "en";
    now: Date;
  }): Promise<UserRecord> {
    for (const u of this.users.values()) {
      if (u.email === input.email) throw new UserEmailExistsError(input.email);
    }
    const id = String(++this.idCounter);
    const user: UserRecord = {
      id,
      email: input.email,
      passwordHash: input.passwordHash,
      fullName: input.fullName,
      timezone: input.timezone,
      locale: input.locale,
      role: "user",
      plan: "free",
      status: "active",
      emailVerifiedAt: null,
      aiConsentAt: null,
      createdAt: iso(input.now),
      updatedAt: iso(input.now),
    };
    this.users.set(id, user);
    return user;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    for (const u of this.users.values()) if (u.email === email) return u;
    return null;
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async updateUserPasswordHash(userId: string, passwordHash: string, now: Date): Promise<void> {
    const u = this.users.get(userId);
    if (u) this.users.set(userId, { ...u, passwordHash, updatedAt: iso(now) });
  }

  async markEmailVerified(userId: string, verifiedAt: Date): Promise<void> {
    const u = this.users.get(userId);
    if (u) this.users.set(userId, { ...u, emailVerifiedAt: iso(verifiedAt) });
  }

  async countVerificationsSince(userId: string, since: Date): Promise<number> {
    let n = 0;
    for (const v of this.verifications.values()) {
      if (v.userId === userId && new Date(v.createdAt) >= since) n += 1;
    }
    return n;
  }

  async latestVerification(userId: string): Promise<VerificationRecord | null> {
    let latest: VerificationRecord | null = null;
    for (const v of this.verifications.values()) {
      if (v.userId !== userId) continue;
      if (latest === null || v.createdAt > latest.createdAt) latest = v;
    }
    return latest;
  }

  async deleteVerifications(userId: string): Promise<void> {
    for (const [id, v] of this.verifications) {
      if (v.userId === userId) this.verifications.delete(id);
    }
  }

  async createVerification(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<VerificationRecord> {
    const record: VerificationRecord = {
      id: String(++this.idCounter),
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: iso(input.expiresAt),
      consumedAt: null,
      createdAt: iso(input.createdAt),
    };
    this.verifications.set(record.id, record);
    return record;
  }

  async findVerificationByTokenHash(tokenHash: string): Promise<VerificationRecord | null> {
    for (const v of this.verifications.values()) if (v.tokenHash === tokenHash) return v;
    return null;
  }

  async consumeVerification(id: string, consumedAt: Date): Promise<void> {
    const v = this.verifications.get(id);
    if (v) this.verifications.set(id, { ...v, consumedAt: iso(consumedAt) });
  }

  // --- Password reset (Phase 3B-1) -----------------------------------------

  async deletePasswordResets(userId: string): Promise<void> {
    for (const [id, r] of this.passwordResets) {
      if (r.userId === userId) this.passwordResets.delete(id);
    }
  }

  async createPasswordReset(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<PasswordResetRecord> {
    const record: PasswordResetRecord = {
      id: String(++this.idCounter),
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: iso(input.expiresAt),
      consumedAt: null,
      createdAt: iso(input.createdAt),
    };
    this.passwordResets.set(record.id, record);
    return record;
  }

  async findPasswordResetByTokenHash(tokenHash: string): Promise<PasswordResetRecord | null> {
    for (const r of this.passwordResets.values()) if (r.tokenHash === tokenHash) return r;
    return null;
  }

  async consumePasswordReset(id: string, consumedAt: Date): Promise<void> {
    const r = this.passwordResets.get(id);
    if (r) this.passwordResets.set(id, { ...r, consumedAt: iso(consumedAt) });
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
    if (this.sessionsByRefreshHash.has(input.refreshTokenHash)) {
      throw new Error("refresh token hash already exists"); // DB UNIQUE equivalent
    }
    const id = String(++this.idCounter);
    const record: SessionRecord = {
      id,
      userId: input.userId,
      refreshTokenHash: input.refreshTokenHash,
      accessTokenHash: input.accessTokenHash,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      expiresAt: iso(input.expiresAt),
      revokedAt: null,
      createdAt: iso(input.createdAt),
    };
    this.sessions.set(id, record);
    this.sessionsByRefreshHash.set(input.refreshTokenHash, id);
    return record;
  }

  async findSessionByRefreshTokenHash(refreshTokenHash: string): Promise<SessionRecord | null> {
    const id = this.sessionsByRefreshHash.get(refreshTokenHash);
    return id === undefined ? null : (this.sessions.get(id) ?? null);
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
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessionsByRefreshHash.delete(s.refreshTokenHash);
    this.sessionsByRefreshHash.set(input.refreshTokenHash, id);
    this.sessions.set(id, {
      ...s,
      refreshTokenHash: input.refreshTokenHash,
      accessTokenHash: input.accessTokenHash,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      expiresAt: iso(input.expiresAt),
    });
  }

  async revokeSession(id: string, revokedAt: Date): Promise<void> {
    const s = this.sessions.get(id);
    if (s) this.sessions.set(id, { ...s, revokedAt: iso(revokedAt) });
  }

  async revokeAllSessionsForUser(userId: string, revokedAt: Date): Promise<void> {
    for (const [id, s] of this.sessions) {
      if (s.userId === userId && s.revokedAt === null) {
        this.sessions.set(id, { ...s, revokedAt: iso(revokedAt) });
      }
    }
  }

  async updateUserPreferences(
    userId: string,
    patch: { locale?: "fa" | "en"; aiConsentAt?: string | null },
    now: Date,
  ): Promise<UserRecord | null> {
    const u = this.users.get(userId);
    if (u === undefined) return null;
    const updated: UserRecord = {
      ...u,
      ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
      ...(patch.aiConsentAt !== undefined ? { aiConsentAt: patch.aiConsentAt } : {}),
      updatedAt: iso(now),
    };
    this.users.set(userId, updated);
    return updated;
  }

  // --- Phase 3B-4: administrative user management ---------------------------

  async listUsers(query: {
    search?: string;
    role?: AppRoleName;
    status?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: readonly UserRecord[]; total: number }> {
    const needle = (query.search ?? "").trim().toLowerCase();
    const matched = [...this.users.values()]
      .filter((u) => {
        if (query.role !== undefined && u.role !== query.role) return false;
        if (query.status !== undefined && u.status !== query.status) return false;
        if (needle === "") return true;
        return (
          u.email.toLowerCase().includes(needle) || u.fullName.toLowerCase().includes(needle)
        );
      })
      // Newest first; id is a monotonic counter here, so it breaks createdAt ties
      // deterministically (two users created in the same millisecond in tests).
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? Number(b.id) - Number(a.id)
          : a.createdAt < b.createdAt
            ? 1
            : -1,
      );
    return {
      items: matched.slice(query.offset, query.offset + query.limit),
      total: matched.length,
    };
  }

  async updateUserRole(userId: string, role: AppRoleName, now: Date): Promise<UserRecord | null> {
    const u = this.users.get(userId);
    if (u === undefined) return null;
    const updated: UserRecord = { ...u, role, updatedAt: iso(now) };
    this.users.set(userId, updated);
    return updated;
  }

  async updateUserStatus(userId: string, status: string, now: Date): Promise<UserRecord | null> {
    const u = this.users.get(userId);
    if (u === undefined) return null;
    const updated: UserRecord = { ...u, status, updatedAt: iso(now) };
    this.users.set(userId, updated);
    return updated;
  }

  async countUsersByRole(role: AppRoleName): Promise<number> {
    let n = 0;
    for (const u of this.users.values()) if (u.role === role) n += 1;
    return n;
  }

  async countActiveUsersByRole(role: AppRoleName, excludeUserId?: string): Promise<number> {
    let n = 0;
    for (const u of this.users.values()) {
      if (u.role === role && u.status === "active" && u.id !== excludeUserId) n += 1;
    }
    return n;
  }

  async getEmailPreferences(userId: string): Promise<EmailPreferences> {
    return this.emailPrefs.get(userId) ?? DEFAULT_EMAIL_PREFERENCES;
  }

  async upsertEmailPreferences(userId: string, prefs: EmailPreferences, now: Date): Promise<void> {
    this.emailPrefs.set(userId, prefs);
    const u = this.users.get(userId);
    if (u) this.users.set(userId, { ...u, updatedAt: iso(now) });
  }
}
