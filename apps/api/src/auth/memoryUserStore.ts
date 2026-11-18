// In-memory UserStore adapter — development/test only (PERSISTENCE=memory is
// blocked outside development by the Phase B boot gate; this adapter is the
// authorized local boundary). Mirrors the DB constraints (email UNIQUE,
// refresh-token UNIQUE) so port-contract violations surface identically.
import {
  type UserRecord,
  type SessionRecord,
  type DeviceRecord,
  type VerificationRecord,
  type PasswordResetRecord,
  type InvitationRecord,
  type UserStore,
  type AppRoleName,
  type EmailPreferences,
  DEFAULT_EMAIL_PREFERENCES,
  UserEmailExistsError,
} from "./userStore.js";
import type { AuditWrite } from "./auditStore.js";

const iso = (d: Date): string => d.toISOString();

export class MemoryUserStore implements UserStore {
  private readonly users = new Map<string, UserRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly verifications = new Map<string, VerificationRecord>();
  private readonly passwordResets = new Map<string, PasswordResetRecord>();
  private readonly sessionsByRefreshHash = new Map<string, string>();
  /**
   * Device fingerprints. EMPTY in every running system — nothing writes
   * `user_devices` yet (MG-DEVICE-TRACKING). The map exists so the port has a
   * contract-identical double; seeding it must be done explicitly by a test.
   */
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly emailPrefs = new Map<string, EmailPreferences>();
  /**
   * Pending invitations keyed by id. Mirrors the DB: token_hash unique,
   * one pending row per e-mail.
   */
  private readonly invitations = new Map<string, InvitationRecord>();
  /** token_hash → invitation id (the plaintext token itself is never stored). */
  private readonly invitationsByToken = new Map<string, string>();
  private idCounter = 0;

  async createUser(input: {
    email: string;
    passwordHash: string;
    fullName: string;
    timezone: string;
    locale: "fa" | "en";
    localeSource?: "user" | "default";
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
      localeSource: input.localeSource ?? "default",
      localeUpdatedAt: input.localeSource === "user" ? iso(input.now) : null,
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

  /**
   * Test seam: put a user row with a CHOSEN id (route suites address users as
   * "1", "2", …). Keeps the id counter ahead of any numeric id so later
   * `createUser`/`createSession` calls never collide with it. Not on the
   * `UserStore` port — production adapters have no equivalent.
   */
  seedUser(input: { id: string; role?: AppRoleName; status?: string; email?: string; now?: Date }): UserRecord {
    const now = iso(input.now ?? new Date());
    const user: UserRecord = {
      id: input.id,
      email: input.email ?? `user-${input.id}@velora.test`,
      passwordHash: "",
      fullName: `User ${input.id}`,
      timezone: "UTC",
      locale: "en",
      localeSource: "default",
      localeUpdatedAt: null,
      role: input.role ?? "user",
      plan: "free",
      status: input.status ?? "active",
      emailVerifiedAt: null,
      aiConsentAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(user.id, user);
    const n = Number(input.id);
    if (Number.isInteger(n) && n > this.idCounter) this.idCounter = n;
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

  async findSessionByAccessTokenHash(accessTokenHash: string): Promise<SessionRecord | null> {
    for (const s of this.sessions.values()) if (s.accessTokenHash === accessTokenHash) return s;
    return null;
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
    expectedRefreshTokenHash: string,
  ): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    // Same compare-and-swap as PgUserStore: a rotation whose expectation no
    // longer matches is a NO-OP that reports failure, so the in-memory batteries
    // exercise the production race semantics rather than a friendlier variant.
    if (s.refreshTokenHash !== expectedRefreshTokenHash) return false;
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
    return true;
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

  // --- Phase 6: the admin console's account operations -----------------------
  // Contract-identical doubles of the pg adapter. They are TEST doubles, never
  // database evidence: the Phase 6 real-PostgreSQL battery
  // (db/tests/adminConsole.pg.test.ts) is what exercises the SQL below.

  async listSessions(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: readonly SessionRecord[]; total: number }> {
    const all = [...this.sessions.values()]
      .filter((s) => s.userId === userId)
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? Number(b.id) - Number(a.id)
          : a.createdAt < b.createdAt
            ? 1
            : -1,
      );
    return { items: all.slice(offset, offset + limit), total: all.length };
  }

  async revokeUserSession(
    userId: string,
    sessionId: string,
    revokedAt: Date,
    audit?: AuditWrite,
  ): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (s === undefined || s.userId !== userId || s.revokedAt !== null) return false;
    this.sessions.set(sessionId, { ...s, revokedAt: iso(revokedAt) });
    if (audit !== undefined) await audit(undefined);
    return true;
  }

  async revokeAllUserSessions(
    userId: string,
    revokedAt: Date,
    audit?: AuditWrite,
  ): Promise<number> {
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (s.userId === userId && s.revokedAt === null) {
        this.sessions.set(id, { ...s, revokedAt: iso(revokedAt) });
        n += 1;
      }
    }
    if (audit !== undefined) await audit(undefined);
    return n;
  }

  async verifyEmailOnce(
    userId: string,
    verifiedAt: Date,
    audit?: AuditWrite,
  ): Promise<UserRecord | null> {
    const u = this.users.get(userId);
    if (u === undefined || u.emailVerifiedAt !== null) return null;
    const updated: UserRecord = {
      ...u,
      emailVerifiedAt: iso(verifiedAt),
      updatedAt: iso(verifiedAt),
    };
    this.users.set(userId, updated);
    if (audit !== undefined) await audit(undefined);
    return updated;
  }

  async listDevices(userId: string): Promise<readonly DeviceRecord[]> {
    return [...this.devices.values()]
      .filter((d) => d.userId === userId)
      .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
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
      ...(patch.locale !== undefined
        ? { locale: patch.locale, localeSource: "user", localeUpdatedAt: iso(now) }
        : {}),
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

  async updateUserRole(
    userId: string,
    role: AppRoleName,
    now: Date,
    audit?: AuditWrite,
  ): Promise<UserRecord | null> {
    const u = this.users.get(userId);
    if (u === undefined) return null;
    // C-34 atomicity, in-memory equivalent: the audit write runs BEFORE the map
    // is mutated, so if it throws the user record is left untouched — the same
    // observable outcome as the PG adapter's ROLLBACK.
    if (audit !== undefined) await audit(undefined);
    const updated: UserRecord = { ...u, role, updatedAt: iso(now) };
    this.users.set(userId, updated);
    return updated;
  }

  async updateUserStatus(
    userId: string,
    status: string,
    now: Date,
    audit?: AuditWrite,
  ): Promise<UserRecord | null> {
    const u = this.users.get(userId);
    if (u === undefined) return null;
    if (audit !== undefined) await audit(undefined);
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

  async createInvitation(input: {
    email: string;
    role: AppRoleName;
    tokenHash: string;
    expiresAt: Date;
    now: Date;
    invitedByUserId: string;
  }): Promise<InvitationRecord> {
    for (const inv of this.invitations.values()) {
      if (inv.email === input.email && inv.usedAt === null) {
        throw new UserEmailExistsError(input.email);
      }
    }
    const id = String(++this.idCounter);
    const invitation: InvitationRecord = {
      id,
      email: input.email,
      role: input.role,
      expiresAt: iso(input.expiresAt),
      createdAt: iso(input.now),
      usedAt: null,
      usedByUserId: null,
      invitedByUserId: input.invitedByUserId,
    };
    this.invitations.set(id, invitation);
    this.invitationsByToken.set(input.tokenHash, id);
    return invitation;
  }

  async findInvitationByToken(tokenHash: string): Promise<InvitationRecord | null> {
    const id = this.invitationsByToken.get(tokenHash);
    if (id === undefined) return null;
    const inv = this.invitations.get(id);
    if (!inv || inv.usedAt !== null || new Date(inv.expiresAt) <= new Date()) {
      return null;
    }
    return inv;
  }

  async consumeInvitation(id: string, usedByUserId: string, now: Date): Promise<boolean> {
    const inv = this.invitations.get(id);
    if (!inv || inv.usedAt !== null || new Date(inv.expiresAt) <= new Date()) {
      return false;
    }
    this.invitations.set(id, { ...inv, usedAt: iso(now), usedByUserId });
    return true;
  }
}
