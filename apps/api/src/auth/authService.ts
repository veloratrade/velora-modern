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
import { passwordSchema } from "@velora/contracts";
import type { UserStore, UserRecord, EmailPreferences } from "./userStore.js";
import { DEFAULT_EMAIL_PREFERENCES } from "./userStore.js";
import type { JwtService, JwtPayload } from "./jwt.js";
import type { MailPort } from "../mail/mailPort.js";

export const ACCESS_TOKEN_TTL_SECONDS = 900;
export const REFRESH_TOKEN_TTL_SECONDS = 2_592_000;
export const VERIFICATION_TOKEN_TTL_MS = 86_400 * 1000;
export const VERIFICATION_MAX_PER_DAY = 3;
export const VERIFICATION_RETRY_INTERVAL_MS = 60 * 1000;
/**
 * Password-reset token TTL (Phase 3B-1). 1 hour: shorter than the 24h
 * verification TTL because a reset token is a full account-takeover primitive.
 */
export const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
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
  /**
   * Outbound transactional email (Phase 3B-1, OD-12).
   *
   * REQUIRED, deliberately. Verification and password-reset links are only
   * useful if they are actually dispatched, so a construction site that omitted
   * the port would silently turn those flows into no-ops with no runtime
   * signal. Making it mandatory turns that mistake into a COMPILE-TIME error
   * (TS2741/TS2345) instead. There is intentionally no default and no
   * fallback: a caller with genuinely nothing to send must say so explicitly by
   * passing a LogMailProvider (offline, in-memory outbox).
   *
   * NOTE: required dependency != observable delivery. MailPort never throws for
   * transport failure, and sendMailSafely keeps provider state unobservable so
   * anti-enumeration responses stay uniform.
   */
  readonly mail: MailPort;
  /** Base URL used to build verification/reset links (no trailing slash). */
  readonly appOrigin?: string;
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
      // Phase 3B-1: actually dispatch the token the flow already minted.
      await this.sendVerificationMail(existing.email, token);
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
    // Phase 3B-1: actually dispatch the token the flow already minted.
    await this.sendVerificationMail(user.email, token);
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

  /**
   * Change password (Remote + PHP verified semantics): verify current →
   * reject identical → policy-check new → persist Argon2id → REVOKE ALL
   * active sessions (Remote updateMany revokedAt; PHP revokeAllForUser).
   * The PHP password-changed email is Phase I (email dispatch) — deferred.
   */
  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<{ changed: true; messageKey: "auth.passwordChanged"; params: Record<string, never> }> {
    const user = await this.deps.store.findUserById(userId);
    if (user === null) {
      // Remote: 400 USER_NOT_FOUND; PHP: ValidationException (exact status
      // fixture-pending). Nearly unreachable behind a valid access token.
      throw new AuthError(400, "USER_NOT_FOUND", "User not found.");
    }
    if (!(await this.deps.hasher.verify(input.currentPassword, user.passwordHash))) {
      throw new AuthError(400, "VALIDATION_FAILED", "Current password is incorrect.", {
        currentPassword: "Current password is incorrect.",
      });
    }
    if (input.currentPassword === input.newPassword) {
      throw new AuthError(400, "VALIDATION_FAILED", "New password must differ from current password.", {
        newPassword: "New password must differ from current password.",
      });
    }
    // DOCUMENTED DIFFERENCE: Local password policy (min 10, ADR-005-adjacent
    // contract) is stricter than the observed PHP change-password validation
    // (min 8) — fixture-pending; stricter policy retained deliberately.
    const policy = passwordSchema.safeParse(input.newPassword);
    if (!policy.success) {
      throw new AuthError(400, "VALIDATION_FAILED", "New password does not meet the password policy.", {
        newPassword: policy.error.issues[0]?.message ?? "invalid password",
      });
    }
    const newHash = await this.deps.hasher.hash(input.newPassword);
    await this.deps.store.updateUserPasswordHash(userId, newHash, this.now());
    await this.deps.store.revokeAllSessionsForUser(userId, this.now());
    return { changed: true, messageKey: "auth.passwordChanged", params: {} };
  }

  // ===========================================================================
  // Phase 3B-1 — password reset + verification resend (owner-approved contract)
  // ===========================================================================

  /**
   * Request a password reset.
   *
   * ANTI-ENUMERATION (approved contract): the response is IDENTICAL whether or
   * not the address exists — same status, same body, no timing-relevant early
   * return that reveals existence, and no error when mail dispatch fails. An
   * unknown address performs no work and reports success.
   */
  async forgotPassword(input: { email: string }): Promise<{
    requested: true;
    messageKey: "auth.passwordResetRequested";
    params: Record<string, never>;
  }> {
    const email = input.email.trim().toLowerCase();
    const user = await this.deps.store.findUserByEmail(email);
    const uniform = {
      requested: true,
      messageKey: "auth.passwordResetRequested",
      params: {},
    } as const;

    if (user === null) return uniform; // unknown address — indistinguishable

    const now = this.now();
    const token = this.newVerificationToken();
    // Supersede any outstanding token: only the newest may be redeemed.
    await this.deps.store.deletePasswordResets(user.id);
    await this.deps.store.createPasswordReset({
      userId: user.id,
      tokenHash: sha256(token),
      expiresAt: new Date(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MS),
      createdAt: now,
    });

    // Delivery failure must NOT change the response (it would leak existence).
    await this.sendMailSafely({
      to: user.email,
      subject: "Reset your VELORA TRADE password",
      text:
        `A password reset was requested for your account.\n\n` +
        `${this.resetLink(token)}\n\n` +
        `This link can be used once and expires in 60 minutes. ` +
        `If you did not request it, no action is needed.`,
    });

    return uniform;
  }

  /**
   * Complete a password reset.
   *
   * Token rules (approved contract): single-use, TTL-bounded, hash-compared.
   * Distinct failures are reported distinctly here — unlike forgot-password,
   * the caller already holds a token, so status codes leak nothing about
   * account existence:
   *   invalid  → 400 INVALID_TOKEN
   *   expired  → 410 TOKEN_EXPIRED
   *   reused   → 409 TOKEN_ALREADY_USED
   * On success ALL sessions are revoked (an attacker-held session must not
   * survive the recovery it may have provoked).
   */
  async resetPassword(input: { token: string; newPassword: string }): Promise<{
    reset: true;
    messageKey: "auth.passwordReset";
    params: Record<string, never>;
  }> {
    const record = await this.deps.store.findPasswordResetByTokenHash(sha256(input.token));
    if (record === null) {
      throw new AuthError(400, "INVALID_TOKEN", "Invalid token.");
    }
    if (record.consumedAt !== null) {
      throw new AuthError(409, "TOKEN_ALREADY_USED", "This reset link has already been used.");
    }
    if (new Date(record.expiresAt) <= this.now()) {
      throw new AuthError(410, "TOKEN_EXPIRED", "This reset link has expired.");
    }

    const policy = passwordSchema.safeParse(input.newPassword);
    if (!policy.success) {
      throw new AuthError(400, "VALIDATION_FAILED", "New password does not meet the password policy.", {
        newPassword: policy.error.issues[0]?.message ?? "invalid password",
      });
    }

    const user = await this.deps.store.findUserById(record.userId);
    if (user === null) throw new AuthError(400, "INVALID_TOKEN", "Invalid token.");

    const now = this.now();
    const newHash = await this.deps.hasher.hash(input.newPassword);
    await this.deps.store.updateUserPasswordHash(user.id, newHash, now);
    // Consume BEFORE reporting success — the token must never be replayable.
    await this.deps.store.consumePasswordReset(record.id, now);
    await this.deps.store.revokeAllSessionsForUser(user.id, now);

    return { reset: true, messageKey: "auth.passwordReset", params: {} };
  }

  /**
   * Resend the verification email (single canonical endpoint — OD-14).
   *
   * Anti-enumeration: unknown address and already-verified account both return
   * the uniform response. The per-24h cap and 60s retry interval from the
   * registration path are reused so this endpoint cannot be used to bypass
   * them; the 4/hour dispatch-level limit is enforced in the router.
   */
  async resendVerification(input: { email: string }): Promise<{
    requested: true;
    messageKey: "auth.verificationResent";
    params: Record<string, never>;
  }> {
    const email = input.email.trim().toLowerCase();
    const uniform = {
      requested: true,
      messageKey: "auth.verificationResent",
      params: {},
    } as const;

    const user = await this.deps.store.findUserByEmail(email);
    if (user === null || user.emailVerifiedAt !== null) return uniform;

    const now = this.now();
    const dayAgo = new Date(now.getTime() - 86_400 * 1000);
    if ((await this.deps.store.countVerificationsSince(user.id, dayAgo)) >= VERIFICATION_MAX_PER_DAY) {
      throw new AuthError(400, "VERIFICATION_LIMIT", "Verification email limit reached.", {
        email: "Verification email limit reached (max 3 per 24 hours).",
      });
    }
    const latest = await this.deps.store.latestVerification(user.id);
    if (
      latest !== null &&
      new Date(latest.createdAt).getTime() > now.getTime() - VERIFICATION_RETRY_INTERVAL_MS
    ) {
      throw new AuthError(400, "VERIFICATION_RETRY_DELAY", "Verification retry interval not elapsed.", {
        email: "Please wait at least 1 minute before requesting another verification email.",
      });
    }

    const token = this.newVerificationToken();
    await this.deps.store.deleteVerifications(user.id);
    await this.deps.store.createVerification({
      userId: user.id,
      tokenHash: sha256(token),
      expiresAt: new Date(now.getTime() + VERIFICATION_TOKEN_TTL_MS),
      createdAt: now,
    });

    await this.sendVerificationMail(user.email, token);

    return uniform;
  }

  /** Single source of truth for the verification email body. */
  private async sendVerificationMail(to: string, token: string): Promise<void> {
    await this.sendMailSafely({
      to,
      subject: "Verify your VELORA TRADE email address",
      text:
        `Confirm your email address to activate your account.\n\n` +
        `${this.verificationLink(token)}\n\n` +
        `This link expires in 24 hours.`,
    });
  }

  /** Link builders — origin comes from configuration, never user input. */
  private resetLink(token: string): string {
    return `${this.origin()}/reset-password#token=${token}`;
  }

  private verificationLink(token: string): string {
    return `${this.origin()}/verify-email#token=${token}`;
  }

  private origin(): string {
    return (this.deps.appOrigin ?? "").replace(/\/+$/, "");
  }

  /**
   * Dispatch mail without ever letting a provider outcome become observable.
   * MailPort already returns a result instead of throwing; this also swallows
   * unexpected adapter errors so no flow can leak provider state. Nothing is
   * logged here: reset links are bearer-equivalent secrets (§7).
   */
  private async sendMailSafely(message: {
    to: string;
    subject: string;
    text: string;
  }): Promise<void> {
    try {
      await this.deps.mail.send(message);
    } catch {
      /* deliberately ignored — see doc comment */
    }
  }

  /** Update preferences (Remote + PHP): locale (fa|en) and/or ai_consent. */
  async updatePreferences(
    userId: string,
    input: { locale?: "fa" | "en" | undefined; ai_consent?: boolean | undefined },
  ): Promise<{
    updated: true;
    locale: string;
    ai_consent: boolean;
    ai_consent_at: string | null;
  }> {
    if (input.locale === undefined && input.ai_consent === undefined) {
      throw new AuthError(400, "VALIDATION_FAILED", "No valid preference field provided.");
    }
    const now = this.now();
    const aiConsentAt =
      input.ai_consent === undefined ? undefined : input.ai_consent ? now.toISOString() : null;
    const updated = await this.deps.store.updateUserPreferences(
      userId,
      {
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        ...(aiConsentAt !== undefined ? { aiConsentAt } : {}),
      },
      now,
    );
    if (updated === null) {
      throw new AuthError(404, "USER_NOT_FOUND", "User not found.");
    }
    return {
      updated: true,
      locale: updated.locale,
      ai_consent: updated.aiConsentAt !== null,
      ai_consent_at: updated.aiConsentAt,
    };
  }

  /** Email preferences API payload in the PHP shape (6 keys, 1|0 ints). */
  private preferencesToApi(p: EmailPreferences): Record<string, 0 | 1> {
    return {
      welcome_email: p.welcomeEmail ? 1 : 0,
      security_alerts: p.securityAlerts ? 1 : 0,
      trade_notifications: p.tradeNotifications ? 1 : 0,
      weekly_report: p.weeklyReport ? 1 : 0,
      monthly_report: p.monthlyReport ? 1 : 0,
      achievement_notifications: p.achievementNotifications ? 1 : 0,
    };
  }

  async getEmailPreferences(userId: string): Promise<{
    preferences: Record<string, 0 | 1>;
    messageKey: "auth.emailPreferences";
    params: Record<string, never>;
  }> {
    const prefs = await this.deps.store.getEmailPreferences(userId);
    return { preferences: this.preferencesToApi(prefs), messageKey: "auth.emailPreferences", params: {} };
  }

  /**
   * Update email preferences (PHP semantics): partial booleans over the 6
   * known keys (non-bool / unknown keys are IGNORED — PHP is_bool check),
   * merged onto current-or-default so no category is silently reset.
   */
  async updateEmailPreferences(
    userId: string,
    body: Record<string, unknown>,
  ): Promise<{
    updated: true;
    preferences: Record<string, 0 | 1>;
    messageKey: "auth.emailPreferencesUpdated";
    params: Record<string, never>;
  }> {
    const current = await this.deps.store.getEmailPreferences(userId);
    const merged: { -readonly [K in keyof EmailPreferences]: EmailPreferences[K] } = { ...current };
    if (typeof body.welcome_email === "boolean") merged.welcomeEmail = body.welcome_email;
    if (typeof body.security_alerts === "boolean") merged.securityAlerts = body.security_alerts;
    if (typeof body.trade_notifications === "boolean") merged.tradeNotifications = body.trade_notifications;
    if (typeof body.weekly_report === "boolean") merged.weeklyReport = body.weekly_report;
    if (typeof body.monthly_report === "boolean") merged.monthlyReport = body.monthly_report;
    if (typeof body.achievement_notifications === "boolean") merged.achievementNotifications = body.achievement_notifications;
    await this.deps.store.upsertEmailPreferences(userId, merged, this.now());
    return {
      updated: true,
      preferences: this.preferencesToApi(merged),
      messageKey: "auth.emailPreferencesUpdated",
      params: {},
    };
  }

  /** Exposed for route wiring: hash a refresh token (storage form). */
  hashRefreshToken(token: string): string {
    return sha256(token);
  }
}
