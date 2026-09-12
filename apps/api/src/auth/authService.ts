// AuthService — Phase C port of the Remote identity capability (behavioral
// reference: remote-snapshot-99e024c829db src/modules/auth/auth.service.ts +
// auth.routes.ts; PHP AuthController for the external contract).
//
// Local-native by design (C5/C6):
//  - NO memory-store fallback in the service: persistence goes through the
//    injected UserStore port (in-memory adapter is dev/test-only; the Phase B
//    boot gate blocks memory persistence outside development).
//  - JWT via the Local hardened JwtService (no fallback secret, CSPRNG jti).
//  - Rehash-on-login uses the domain verifyAndRehash policy (S5) and persists
//    through the store — the application boundary whose existence S5 required.
//  - Refresh tokens: crypto.randomBytes(32) hex (Remote-verified mechanism),
//    stored only as sha256 hashes; sessions rotate on refresh.
//
// Remote-verified constants: access TTL 900s; refresh/session TTL 2,592,000s
// (30 days); verification token 32 random bytes, 24h expiry, max 3 per 24h,
// 60s retry interval; user agent capped at 250 chars.
import { createHash, randomBytes } from "node:crypto";
import type { PasswordHasher } from "@velora/domain";
import { verifyAndRehash } from "@velora/domain";
import type { UserStore, UserRecord } from "./userStore.js";
import type { JwtService, JwtPayload } from "./jwt.js";

export const ACCESS_TOKEN_TTL_SECONDS = 900;
export const REFRESH_TOKEN_TTL_SECONDS = 2_592_000;
export const VERIFICATION_TOKEN_TTL_MS = 86_400 * 1000;
export const VERIFICATION_MAX_PER_DAY = 3;
export const VERIFICATION_RETRY_INTERVAL_MS = 60 * 1000;
const USER_AGENT_MAX_CHARS = 250;

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Externally observable user shape (Remote PublicUserDto, VERIFIED). */
export interface PublicUserDto {
  id: number;
  email: string;
  fullName: string;
  role: string;
  plan: string;
  timezone: string;
  locale: string;
  createdAt: string;
  aiConsent: boolean;
}

export interface TokenPair {
  accessToken: string;
  /**
   * Internal transport of the refresh credential. NEVER serialized into a
   * response body — routes strip it and set the HttpOnly cookie (Remote-
   * verified pattern: `delete result.refreshToken` before send).
   */
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  user: PublicUserDto;
}

export interface AuthDeps {
  readonly store: UserStore;
  readonly hasher: PasswordHasher;
  readonly jwt: JwtService;
  /** Injectable clock (TestClock pattern). Defaults to real time. */
  readonly now?: () => Date;
  /**
   * Injectable verification-token generator for deterministic tests ONLY;
   * default is the CSPRNG (32 bytes hex). Never weakens production entropy.
   */
  readonly generateVerificationToken?: () => string;
}

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export class AuthService {
  private readonly now: () => Date;
  private readonly newVerificationToken: () => string;

  constructor(private readonly deps: AuthDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newVerificationToken =
      deps.generateVerificationToken ?? (() => randomBytes(32).toString("hex"));
  }

  /** Remote-verified PublicUserDto mapping (toPublicUser). */
  toPublicUser(user: UserRecord): PublicUserDto {
    return {
      id: Number(user.id),
      email: user.email,
      fullName: user.fullName || "",
      role: user.role,
      plan: user.plan || "free",
      timezone: user.timezone || "UTC",
      locale: user.locale || "fa",
      createdAt: user.createdAt,
      aiConsent: user.aiConsentAt !== null,
    };
  }

  /**
   * Register (Remote-verified semantics). New user → {verificationRequired,
   * email}. Existing UNVERIFIED user → verification resend path with the
   * 3-per-24h and 60s-retry limits → messageKey 'auth.verificationResent'.
   * The raw verification token is created for the (Phase I) email dispatch —
   * it is never returned in the response and only its hash is stored.
   */
  async register(input: {
    email: string;
    password: string;
    fullName?: string | undefined;
    timezone?: string | undefined;
    locale?: "fa" | "en" | undefined;
  }): Promise<{
    verificationRequired: true;
    email: string;
    messageKey?: "auth.verificationResent";
    params?: Record<string, never>;
  }> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.deps.store.findUserByEmail(email);
    const now = this.now();

    if (existing !== null) {
      if (existing.emailVerifiedAt !== null) {
        throw new AuthError(409, "EMAIL_ALREADY_REGISTERED", "Email already registered.", {
          email: "Email already registered.",
        });
      }
      const dayAgo = new Date(now.getTime() - 86_400 * 1000);
      const recentCount = await this.deps.store.countVerificationsSince(existing.id, dayAgo);
      if (recentCount >= VERIFICATION_MAX_PER_DAY) {
        throw new AuthError(400, "VERIFICATION_LIMIT", "Verification email limit reached.", {
          email: "Verification email limit reached (max 3 per 24 hours).",
        });
      }
      const latest = await this.deps.store.latestVerification(existing.id);
      if (latest !== null && new Date(latest.createdAt).getTime() > now.getTime() - VERIFICATION_RETRY_INTERVAL_MS) {
        throw new AuthError(
          400,
          "VERIFICATION_RETRY_DELAY",
          "Verification retry interval not elapsed.",
          { email: "Please wait at least 1 minute before requesting another verification email." },
        );
      }
      const token = this.newVerificationToken();
      await this.deps.store.deleteVerifications(existing.id);
      await this.deps.store.createVerification({
        userId: existing.id,
        tokenHash: sha256(token),
        expiresAt: new Date(now.getTime() + VERIFICATION_TOKEN_TTL_MS),
        createdAt: now,
      });
      return { verificationRequired: true, email, messageKey: "auth.verificationResent", params: {} };
    }

    const passwordHash = await this.deps.hasher.hash(input.password);
    const user = await this.deps.store.createUser({
      email,
      passwordHash,
      fullName: (input.fullName ?? "").trim(),
      timezone: input.timezone ?? "UTC",
      locale: input.locale ?? "fa",
      now,
    });
    const token = this.newVerificationToken();
    await this.deps.store.createVerification({
      userId: user.id,
      tokenHash: sha256(token),
      expiresAt: new Date(now.getTime() + VERIFICATION_TOKEN_TTL_MS),
      createdAt: now,
    });
    return { verificationRequired: true, email };
  }

  /** Verify email (Remote-verified semantics + Local consumed_at mapping). */
  async verifyEmail(token: string): Promise<{
    verified: true;
    alreadyVerified: boolean;
    messageKey: "auth.emailVerified" | "auth.emailAlreadyVerified";
    params: Record<string, never>;
  }> {
    const record = await this.deps.store.findVerificationByTokenHash(sha256(token));
    if (record === null) {
      throw new AuthError(401, "INVALID_TOKEN", "Invalid token.");
    }
    if (record.consumedAt !== null) {
      return { verified: true, alreadyVerified: true, messageKey: "auth.emailAlreadyVerified", params: {} };
    }
    if (new Date(record.expiresAt) <= this.now()) {
      throw new AuthError(401, "INVALID_TOKEN", "Invalid token."); // expired ≡ invalid (fixture-pending refinement)
    }
    await this.deps.store.consumeVerification(record.id, this.now());
    await this.deps.store.markEmailVerified(record.userId, this.now());
    return { verified: true, alreadyVerified: false, messageKey: "auth.emailVerified", params: {} };
  }

  /** Login (Remote-verified failure order: credentials → status → verified). */
  async login(input: {
    email: string;
    password: string;
    ipAddress?: string | undefined;
    userAgent?: string | undefined;
  }): Promise<TokenPair> {
    const email = input.email.trim().toLowerCase();
    const user = await this.deps.store.findUserByEmail(email);
    if (user === null) {
      throw new AuthError(401, "INVALID_CREDENTIALS", "Invalid credentials.");
    }

    // S5 boundary: verify + transparent rehash, persisted through the store.
    const result = await verifyAndRehash(this.deps.hasher, input.password, user.passwordHash);
    if (!result.verified) {
      throw new AuthError(401, "INVALID_CREDENTIALS", "Invalid credentials.");
    }
    if (result.rehashNeeded && result.newHash !== undefined) {
      await this.deps.store.updateUserPasswordHash(user.id, result.newHash, this.now());
    }

    if (user.status !== "active") {
      throw new AuthError(401, "ACCOUNT_INACTIVE", "Account is inactive.");
    }
    if (user.emailVerifiedAt === null) {
      throw new AuthError(401, "EMAIL_NOT_VERIFIED", "Email verification required.");
    }
    return this.issueTokenPair(user, input.ipAddress, input.userAgent);
  }

  /** Refresh with rotation (Remote-verified semantics + error codes). */
  async refresh(
    refreshToken: string,
    ipAddress?: string | undefined,
    userAgent?: string | undefined,
  ): Promise<TokenPair> {
    if (refreshToken === "") {
      throw new AuthError(401, "REFRESH_COOKIE_MISSING", "Refresh cookie is missing.");
    }
    const session = await this.deps.store.findSessionByRefreshTokenHash(sha256(refreshToken));
    if (session === null || session.revokedAt !== null) {
      throw new AuthError(401, "INVALID_TOKEN", "Invalid token.");
    }
    if (new Date(session.expiresAt) <= this.now()) {
      throw new AuthError(401, "SESSION_EXPIRED", "Session expired.");
    }
    const user = await this.deps.store.findUserById(session.userId);
    if (user === null || user.status !== "active") {
      throw new AuthError(401, "ACCOUNT_INACTIVE", "Account is inactive.");
    }
    return this.issueTokenPair(user, ipAddress, userAgent, session);
  }

  /** Logout: revoke the session bound to this refresh token (idempotent). */
  async logout(refreshToken: string): Promise<void> {
    const session = await this.deps.store.findSessionByRefreshTokenHash(sha256(refreshToken));
    if (session !== null && session.revokedAt === null) {
      await this.deps.store.revokeSession(session.id, this.now());
    }
  }

  /** Current user (protected route payload). */
  async me(userId: string): Promise<PublicUserDto> {
    const user = await this.deps.store.findUserById(userId);
    if (user === null) {
      throw new AuthError(401, "UNAUTHENTICATED", "Unauthenticated.");
    }
    return this.toPublicUser(user);
  }

  /** Access-token subject claims (Remote-verified payload {sub, role}). */
  accessTokenClaims(user: UserRecord): { sub: string; role: string } {
    return { sub: String(user.id), role: user.role };
  }

  /** Verify an access token (protected-route helper over the hardened JWT service). */
  verifyAccessToken(token: string): JwtPayload | null {
    return this.deps.jwt.verify(token);
  }

  private async issueTokenPair(
    user: UserRecord,
    ipAddress: string | undefined,
    userAgent: string | undefined,
    existingSession?: { id: string },
  ): Promise<TokenPair> {
    const accessToken = this.deps.jwt.sign(this.accessTokenClaims(user), ACCESS_TOKEN_TTL_SECONDS);
    const refreshToken = randomBytes(32).toString("hex"); // CSPRNG — never injectable
    const now = this.now();
    const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);
    const ua = userAgent === undefined ? null : userAgent.substring(0, USER_AGENT_MAX_CHARS);

    if (existingSession !== undefined) {
      await this.deps.store.rotateSession(existingSession.id, {
        refreshTokenHash: sha256(refreshToken),
        accessTokenHash: sha256(accessToken),
        ipAddress: ipAddress ?? null,
        userAgent: ua,
        expiresAt,
      });
    } else {
      await this.deps.store.createSession({
        userId: user.id,
        refreshTokenHash: sha256(refreshToken),
        accessTokenHash: sha256(accessToken),
        ipAddress: ipAddress ?? null,
        userAgent: ua,
        expiresAt,
        createdAt: now,
      });
    }

    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      tokenType: "Bearer",
      user: this.toPublicUser(user),
    };
  }

  /** Exposed for route wiring: hash a refresh token (storage form). */
  hashRefreshToken(token: string): string {
    return sha256(token);
  }
}
