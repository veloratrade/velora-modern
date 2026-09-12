// UserStore — the Phase C identity persistence port (C6: smallest justified
// abstraction). All timestamps are ISO-8601 strings (UTC). This port is the
// application-level persistence boundary whose absence was documented in the
// Phase B S5 follow-up; real-PostgreSQL verification remains deferred to
// Phase D (PGlite tests are in-wasm evidence, NOT real-PG evidence).
export interface UserRecord {
  readonly id: string;
  readonly email: string; // canonical lowercase (ADR-003)
  readonly passwordHash: string;
  readonly fullName: string;
  readonly timezone: string;
  readonly locale: "fa" | "en";
  readonly role: "user" | "admin";
  readonly plan: string;
  readonly status: string;
  readonly emailVerifiedAt: string | null;
  readonly aiConsentAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly refreshTokenHash: string;
  readonly accessTokenHash: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface VerificationRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly createdAt: string;
}

/** Thrown by createUser on a duplicate canonical email (DB UNIQUE equivalent). */
export class UserEmailExistsError extends Error {
  constructor(email: string) {
    super("email already registered");
    this.name = "UserEmailExistsError";
  }
}

export interface UserStore {
  /** Create a user; throws UserEmailExistsError on duplicate email. */
  createUser(input: {
    email: string;
    passwordHash: string;
    fullName: string;
    timezone: string;
    locale: "fa" | "en";
    now: Date;
  }): Promise<UserRecord>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  updateUserPasswordHash(userId: string, passwordHash: string, now: Date): Promise<void>;
  markEmailVerified(userId: string, verifiedAt: Date): Promise<void>;

  countVerificationsSince(userId: string, since: Date): Promise<number>;
  latestVerification(userId: string): Promise<VerificationRecord | null>;
  deleteVerifications(userId: string): Promise<void>;
  createVerification(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<VerificationRecord>;
  findVerificationByTokenHash(tokenHash: string): Promise<VerificationRecord | null>;
  consumeVerification(id: string, consumedAt: Date): Promise<void>;

  createSession(input: {
    userId: string;
    refreshTokenHash: string;
    accessTokenHash: string;
    ipAddress: string | null;
    userAgent: string | null;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<SessionRecord>;
  findSessionByRefreshTokenHash(refreshTokenHash: string): Promise<SessionRecord | null>;
  rotateSession(
    id: string,
    input: {
      refreshTokenHash: string;
      accessTokenHash: string;
      ipAddress: string | null;
      userAgent: string | null;
      expiresAt: Date;
    },
  ): Promise<void>;
  revokeSession(id: string, revokedAt: Date): Promise<void>;
}
