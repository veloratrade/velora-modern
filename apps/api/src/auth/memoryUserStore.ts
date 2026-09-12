// In-memory UserStore adapter — development/test only (PERSISTENCE=memory is
// blocked outside development by the Phase B boot gate; this adapter is the
// authorized local boundary). Mirrors the DB constraints (email UNIQUE,
// refresh-token UNIQUE) so port-contract violations surface identically.
import {
  type UserRecord,
  type SessionRecord,
  type VerificationRecord,
  type UserStore,
  UserEmailExistsError,
} from "./userStore.js";

const iso = (d: Date): string => d.toISOString();

export class MemoryUserStore implements UserStore {
  private readonly users = new Map<string, UserRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly verifications = new Map<string, VerificationRecord>();
  private readonly sessionsByRefreshHash = new Map<string, string>();
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
}
