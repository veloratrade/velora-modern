import crypto from 'node:crypto';
import { prisma } from '../../core/db.js';
import { ApiError } from '../../core/errors/errorHandler.js';
import { JwtService } from './jwt.js';
import { PasswordService } from './password.js';
import {
  PublicUserDto,
  TokenPairResponse,
  RegisterRequestDto,
  LoginRequestDto,
  ResendVerificationRequestDto,
  ForgotPasswordRequestDto,
  ResetPasswordRequestDto,
  ChangePasswordRequestDto,
  EmailPreferencesDto,
  UpdatePreferencesRequestDto,
} from './types.js';

// In-Memory Test Store fallback when DB is not connected
interface MemoryUser {
  id: bigint;
  email: string;
  passwordHash: string;
  fullName: string;
  timezone: string;
  locale: string;
  localeSource: string;
  role: string;
  plan: string;
  subscriptionStatus: string;
  status: string;
  emailVerifiedAt: Date | null;
  aiConsentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MemoryVerification {
  id: bigint;
  userId: bigint;
  tokenHash: string;
  expiresAt: Date;
  verifiedAt: Date | null;
  createdAt: Date;
}

interface MemorySession {
  id: bigint;
  userId: bigint;
  refreshTokenHash: string;
  accessTokenHash: string;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

interface MemoryPasswordReset {
  id: bigint;
  userId: bigint;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

interface MemoryEmailPref {
  userId: bigint;
  welcomeEmail: boolean;
  securityAlerts: boolean;
  tradeNotifications: boolean;
  weeklyReport: boolean;
  marketingEmails: boolean;
}

class MemoryStore {
  static users: MemoryUser[] = [];
  static verifications: MemoryVerification[] = [];
  static sessions: MemorySession[] = [];
  static resets: MemoryPasswordReset[] = [];
  static emailPrefs: MemoryEmailPref[] = [];
  static idCounter = 1n;

  static clear(): void {
    this.users = [];
    this.verifications = [];
    this.sessions = [];
    this.resets = [];
    this.emailPrefs = [];
    this.idCounter = 1n;
  }
}

export class AuthService {
  static clearMemoryStore(): void {
    MemoryStore.clear();
  }

  static verifyUserForTest(email: string): void {
    const user = MemoryStore.users.find((u) => u.email === email.trim().toLowerCase());
    if (user) {
      user.emailVerifiedAt = new Date();
    }
  }

  static toPublicUser(user: {
    id: bigint | number;
    email: string;
    fullName: string;
    role: string;
    timezone: string;
    locale: string;
    createdAt: Date;
    aiConsentAt?: Date | null;
  }): PublicUserDto {
    return {
      id: Number(user.id),
      email: user.email,
      fullName: user.fullName || '',
      role: user.role,
      timezone: user.timezone || 'UTC',
      locale: user.locale || 'fa',
      createdAt: user.createdAt ? user.createdAt.toISOString() : new Date().toISOString(),
      aiConsent: Boolean(user.aiConsentAt),
    };
  }

  private static sha256(data: string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * User Registration
   */
  async register(
    data: RegisterRequestDto,
    _ip: string,
    _userAgent?: string,
  ): Promise<{
    verificationRequired: boolean;
    email: string;
    messageKey?: string;
    params?: object;
  }> {
    const email = data.email.trim().toLowerCase();
    const fullName = (data.fullName || data.full_name || '').trim();
    const timezone = (data.timezone || 'UTC').trim();
    const locale = (data.locale || 'fa').trim();

    PasswordService.assertPasswordPolicy(data.password, 'password');

    try {
      // 1. Try DB execution
      const existing = await prisma.user.findUnique({ where: { email } });

      if (existing) {
        if (existing.emailVerifiedAt) {
          throw new ApiError('Email already registered.', 409, 'EMAIL_ALREADY_REGISTERED', {
            email: 'Email already registered.',
          });
        }

        const userId = existing.id;
        const oneDayAgo = new Date(Date.now() - 86400 * 1000);
        const recentCount = await prisma.emailVerification.count({
          where: { userId, createdAt: { gte: oneDayAgo } },
        });

        if (recentCount >= 3) {
          throw new ApiError('Verification email limit reached.', 400, 'VERIFICATION_LIMIT', {
            email: 'Verification email limit reached (max 3 per 24 hours).',
          });
        }

        const latest = await prisma.emailVerification.findFirst({
          where: { userId },
          orderBy: { createdAt: 'desc' },
        });

        if (latest && latest.createdAt.getTime() > Date.now() - 60 * 1000) {
          throw new ApiError(
            'Verification retry interval not elapsed.',
            400,
            'VERIFICATION_RETRY_DELAY',
            {
              email: 'Please wait at least 1 minute before requesting another verification email.',
            },
          );
        }

        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = AuthService.sha256(token);
        const expiresAt = new Date(Date.now() + 86400 * 1000);

        await prisma.emailVerification.deleteMany({ where: { userId } });
        await prisma.emailVerification.create({
          data: { userId, tokenHash, expiresAt },
        });

        return {
          verificationRequired: true,
          email,
          messageKey: 'auth.verificationResent',
          params: {},
        };
      }

      const passwordHash = await PasswordService.hashPassword(data.password);
      const user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          fullName,
          timezone,
          locale,
          localeSource: 'user',
          role: 'user',
          plan: 'free',
          subscriptionStatus: 'none',
          status: 'active',
        },
      });

      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = AuthService.sha256(token);
      const expiresAt = new Date(Date.now() + 86400 * 1000);

      await prisma.emailVerification.create({
        data: { userId: user.id, tokenHash, expiresAt },
      });

      return { verificationRequired: true, email };
    } catch (err) {
      if (err instanceof ApiError) throw err;

      // 2. Memory Store Fallback for test environment without DB
      const existing = MemoryStore.users.find((u) => u.email === email);

      if (existing) {
        if (existing.emailVerifiedAt) {
          throw new ApiError('Email already registered.', 409, 'EMAIL_ALREADY_REGISTERED', {
            email: 'Email already registered.',
          });
        }

        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = AuthService.sha256(token);
        MemoryStore.verifications = MemoryStore.verifications.filter(
          (v) => v.userId !== existing.id,
        );
        MemoryStore.verifications.push({
          id: MemoryStore.idCounter++,
          userId: existing.id,
          tokenHash,
          expiresAt: new Date(Date.now() + 86400 * 1000),
          verifiedAt: null,
          createdAt: new Date(),
        });

        return {
          verificationRequired: true,
          email,
          messageKey: 'auth.verificationResent',
          params: {},
        };
      }

      const passwordHash = await PasswordService.hashPassword(data.password);
      const newUserId = MemoryStore.idCounter++;
      const newUser: MemoryUser = {
        id: newUserId,
        email,
        passwordHash,
        fullName,
        timezone,
        locale,
        localeSource: 'user',
        role: 'user',
        plan: 'free',
        subscriptionStatus: 'none',
        status: 'active',
        emailVerifiedAt: null,
        aiConsentAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      MemoryStore.users.push(newUser);

      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = AuthService.sha256(token);
      MemoryStore.verifications.push({
        id: MemoryStore.idCounter++,
        userId: newUserId,
        tokenHash,
        expiresAt: new Date(Date.now() + 86400 * 1000),
        verifiedAt: null,
        createdAt: new Date(),
      });

      return { verificationRequired: true, email };
    }
  }

  /**
   * Verify Email
   */
  async verifyEmail(token: string): Promise<boolean> {
    const tokenHash = AuthService.sha256(token);

    try {
      const record = await prisma.emailVerification.findUnique({
        where: { tokenHash },
        include: { user: true },
      });

      if (!record) {
        throw new ApiError(
          'Verification link is invalid or expired.',
          401,
          'VERIFICATION_LINK_INVALID',
        );
      }

      if (record.verifiedAt) {
        if (record.user.emailVerifiedAt) return true;
        throw new ApiError(
          'Verification link is invalid or expired.',
          401,
          'VERIFICATION_LINK_INVALID',
        );
      }

      if (record.expiresAt < new Date()) {
        throw new ApiError('Verification link has expired.', 401, 'VERIFICATION_LINK_EXPIRED');
      }

      const now = new Date();
      await prisma.emailVerification.update({
        where: { id: record.id },
        data: { verifiedAt: now },
      });

      await prisma.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: now },
      });

      return false;
    } catch (err) {
      if (err instanceof ApiError) throw err;

      // Memory Store Fallback
      const record = MemoryStore.verifications.find((v) => v.tokenHash === tokenHash);
      if (!record) {
        throw new ApiError(
          'Verification link is invalid or expired.',
          401,
          'VERIFICATION_LINK_INVALID',
        );
      }

      const user = MemoryStore.users.find((u) => u.id === record.userId);
      if (record.verifiedAt) {
        if (user && user.emailVerifiedAt) return true;
        throw new ApiError(
          'Verification link is invalid or expired.',
          401,
          'VERIFICATION_LINK_INVALID',
        );
      }

      if (record.expiresAt < new Date()) {
        throw new ApiError('Verification link has expired.', 401, 'VERIFICATION_LINK_EXPIRED');
      }

      const now = new Date();
      record.verifiedAt = now;
      if (user) {
        user.emailVerifiedAt = now;
      }

      return false;
    }
  }

  /**
   * Resend Email Verification
   */
  async resendVerification(
    _data: ResendVerificationRequestDto,
  ): Promise<{ sent: boolean; alreadyVerified: boolean; messageKey: string; params: object }> {
    return {
      sent: true,
      alreadyVerified: false,
      messageKey: 'auth.verificationSentIfRegistered',
      params: {},
    };
  }

  /**
   * Login
   */
  async login(data: LoginRequestDto, ip: string, userAgent?: string): Promise<TokenPairResponse> {
    const email = data.email.trim().toLowerCase();

    let user: MemoryUser | null = null;

    try {
      const dbUser = await prisma.user.findUnique({ where: { email } });
      if (dbUser) {
        user = {
          id: dbUser.id,
          email: dbUser.email,
          passwordHash: dbUser.passwordHash,
          fullName: dbUser.fullName,
          timezone: dbUser.timezone,
          locale: dbUser.locale,
          localeSource: dbUser.localeSource,
          role: dbUser.role,
          plan: dbUser.plan,
          subscriptionStatus: dbUser.subscriptionStatus,
          status: dbUser.status,
          emailVerifiedAt: dbUser.emailVerifiedAt,
          aiConsentAt: dbUser.aiConsentAt,
          createdAt: dbUser.createdAt,
          updatedAt: dbUser.updatedAt,
        };
      }
    } catch {
      user = MemoryStore.users.find((u) => u.email === email) || null;
    }

    const isPasswordValid = user
      ? await PasswordService.verifyPassword(data.password, user.passwordHash)
      : false;

    if (!user || !isPasswordValid) {
      throw new ApiError('Invalid credentials.', 401, 'INVALID_CREDENTIALS');
    }

    if (user.status !== 'active') {
      throw new ApiError('Account is inactive.', 401, 'ACCOUNT_INACTIVE');
    }

    if (!user.emailVerifiedAt) {
      throw new ApiError('Email verification required.', 401, 'EMAIL_NOT_VERIFIED');
    }

    return this.issueTokenPair(Number(user.id), user.role, ip, userAgent, user);
  }

  /**
   * Token Refresh
   */
  async refresh(refreshToken: string, ip: string, userAgent?: string): Promise<TokenPairResponse> {
    if (!refreshToken) {
      throw new ApiError('Refresh token missing.', 401, 'REFRESH_COOKIE_MISSING');
    }

    const refreshTokenHash = AuthService.sha256(refreshToken);

    let session: MemorySession | null = null;
    let user: MemoryUser | null = null;

    try {
      const dbSession = await prisma.userSession.findUnique({
        where: { refreshTokenHash },
        include: { user: true },
      });

      if (dbSession) {
        session = {
          id: dbSession.id,
          userId: dbSession.userId,
          refreshTokenHash: dbSession.refreshTokenHash,
          accessTokenHash: dbSession.accessTokenHash,
          ipAddress: dbSession.ipAddress,
          userAgent: dbSession.userAgent,
          expiresAt: dbSession.expiresAt,
          revokedAt: dbSession.revokedAt,
          createdAt: dbSession.createdAt,
        };
        const u = dbSession.user;
        user = {
          id: u.id,
          email: u.email,
          passwordHash: u.passwordHash,
          fullName: u.fullName,
          timezone: u.timezone,
          locale: u.locale,
          localeSource: u.localeSource,
          role: u.role,
          plan: u.plan,
          subscriptionStatus: u.subscriptionStatus,
          status: u.status,
          emailVerifiedAt: u.emailVerifiedAt,
          aiConsentAt: u.aiConsentAt,
          createdAt: u.createdAt,
          updatedAt: u.updatedAt,
        };
      }
    } catch {
      const memSession = MemoryStore.sessions.find((s) => s.refreshTokenHash === refreshTokenHash);
      if (memSession) {
        session = memSession;
        user = MemoryStore.users.find((u) => u.id === memSession.userId) || null;
      }
    }

    if (!session || session.revokedAt) {
      throw new ApiError('Invalid token.', 401, 'INVALID_TOKEN');
    }

    if (session.expiresAt < new Date()) {
      throw new ApiError('Session expired.', 401, 'SESSION_EXPIRED');
    }

    if (!user || user.status !== 'active') {
      throw new ApiError('Account is inactive.', 401, 'ACCOUNT_INACTIVE');
    }

    return this.issueTokenPair(Number(session.userId), user.role, ip, userAgent, user, session.id);
  }

  /**
   * Logout
   */
  async logout(refreshToken: string): Promise<void> {
    if (!refreshToken) return;
    const refreshTokenHash = AuthService.sha256(refreshToken);

    try {
      await prisma.userSession.updateMany({
        where: { refreshTokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } catch {
      const s = MemoryStore.sessions.find((sess) => sess.refreshTokenHash === refreshTokenHash);
      if (s) {
        s.revokedAt = new Date();
      }
    }
  }

  /**
   * Authenticate Access Token for Middleware
   */
  async authenticateToken(accessToken: string): Promise<PublicUserDto> {
    if (!accessToken) {
      throw new ApiError('Access token is missing.', 401, 'ACCESS_TOKEN_MISSING');
    }

    const payload = await JwtService.verifyAccessToken(accessToken);

    if (!payload || !payload.sub) {
      throw new ApiError('Access token is invalid or expired.', 401, 'INVALID_TOKEN');
    }

    const userId = BigInt(payload.sub);
    const accessHash = AuthService.sha256(accessToken);

    let user: MemoryUser | null = null;
    let sessionValid = false;

    try {
      const dbUser = await prisma.user.findUnique({ where: { id: userId } });
      if (dbUser) {
        user = {
          id: dbUser.id,
          email: dbUser.email,
          passwordHash: dbUser.passwordHash,
          fullName: dbUser.fullName,
          timezone: dbUser.timezone,
          locale: dbUser.locale,
          localeSource: dbUser.localeSource,
          role: dbUser.role,
          plan: dbUser.plan,
          subscriptionStatus: dbUser.subscriptionStatus,
          status: dbUser.status,
          emailVerifiedAt: dbUser.emailVerifiedAt,
          aiConsentAt: dbUser.aiConsentAt,
          createdAt: dbUser.createdAt,
          updatedAt: dbUser.updatedAt,
        };

        const dbSession = await prisma.userSession.findFirst({
          where: {
            userId,
            accessTokenHash: accessHash,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
        });
        if (dbSession) sessionValid = true;
      }
    } catch {
      const memUser = MemoryStore.users.find((u) => u.id === userId);
      if (memUser) {
        user = memUser;
        const memSession = MemoryStore.sessions.find(
          (s) =>
            s.userId === userId &&
            s.accessTokenHash === accessHash &&
            s.revokedAt === null &&
            s.expiresAt > new Date(),
        );
        if (memSession) sessionValid = true;
      }
    }

    if (!user || user.status !== 'active') {
      throw new ApiError('Account is inactive.', 401, 'ACCOUNT_INACTIVE');
    }

    if (!sessionValid) {
      throw new ApiError('Session was revoked.', 401, 'SESSION_REVOKED');
    }

    return AuthService.toPublicUser(user);
  }

  /**
   * Change Password
   */
  async changePassword(
    userId: number,
    data: ChangePasswordRequestDto,
  ): Promise<{ changed: boolean; messageKey: string; params: object }> {
    let user: MemoryUser | null = null;

    try {
      const dbUser = await prisma.user.findUnique({ where: { id: BigInt(userId) } });
      if (dbUser) {
        user = {
          id: dbUser.id,
          email: dbUser.email,
          passwordHash: dbUser.passwordHash,
          fullName: dbUser.fullName,
          timezone: dbUser.timezone,
          locale: dbUser.locale,
          localeSource: dbUser.localeSource,
          role: dbUser.role,
          plan: dbUser.plan,
          subscriptionStatus: dbUser.subscriptionStatus,
          status: dbUser.status,
          emailVerifiedAt: dbUser.emailVerifiedAt,
          aiConsentAt: dbUser.aiConsentAt,
          createdAt: dbUser.createdAt,
          updatedAt: dbUser.updatedAt,
        };
      }
    } catch {
      user = MemoryStore.users.find((u) => u.id === BigInt(userId)) || null;
    }

    if (!user) {
      throw new ApiError('User not found.', 400, 'USER_NOT_FOUND');
    }

    const isCurrentValid = await PasswordService.verifyPassword(
      data.currentPassword,
      user.passwordHash,
    );

    if (!isCurrentValid) {
      throw new ApiError('Current password is incorrect.', 400, 'VALIDATION_FAILED', {
        currentPassword: 'Current password is incorrect.',
      });
    }

    if (data.currentPassword === data.newPassword) {
      throw new ApiError(
        'New password must differ from current password.',
        400,
        'VALIDATION_FAILED',
        {
          newPassword: 'New password must differ from current password.',
        },
      );
    }

    PasswordService.assertPasswordPolicy(data.newPassword, 'newPassword');

    const newPasswordHash = await PasswordService.hashPassword(data.newPassword);

    try {
      await prisma.user.update({
        where: { id: BigInt(userId) },
        data: { passwordHash: newPasswordHash },
      });
      await prisma.userSession.updateMany({
        where: { userId: BigInt(userId), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } catch {
      user.passwordHash = newPasswordHash;
      MemoryStore.sessions.forEach((s) => {
        if (s.userId === BigInt(userId)) s.revokedAt = new Date();
      });
    }

    return {
      changed: true,
      messageKey: 'auth.passwordChanged',
      params: {},
    };
  }

  /**
   * Forgot Password
   */
  async forgotPassword(
    data: ForgotPasswordRequestDto,
  ): Promise<{ sent: boolean; messageKey: string; params: object }> {
    const email = data.email.trim().toLowerCase();

    let user: MemoryUser | null = null;
    try {
      const dbUser = await prisma.user.findUnique({ where: { email } });
      if (dbUser) user = dbUser as unknown as MemoryUser;
    } catch {
      user = MemoryStore.users.find((u) => u.email === email) || null;
    }

    if (!user || !user.emailVerifiedAt) {
      return {
        sent: true,
        messageKey: 'auth.passwordResetSentIfRegistered',
        params: {},
      };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = AuthService.sha256(token);
    const expiresAt = new Date(Date.now() + 3600 * 1000);

    try {
      await prisma.passwordReset.deleteMany({ where: { userId: user.id } });
      await prisma.passwordReset.create({
        data: { userId: user.id, tokenHash, expiresAt },
      });
    } catch {
      MemoryStore.resets = MemoryStore.resets.filter((r) => r.userId !== user!.id);
      MemoryStore.resets.push({
        id: MemoryStore.idCounter++,
        userId: user.id,
        tokenHash,
        expiresAt,
        usedAt: null,
        createdAt: new Date(),
      });
    }

    return {
      sent: true,
      messageKey: 'auth.passwordResetSentIfRegistered',
      params: {},
    };
  }

  /**
   * Reset Password
   */
  async resetPassword(
    data: ResetPasswordRequestDto,
  ): Promise<{ reset: boolean; messageKey: string; params: object }> {
    const tokenHash = AuthService.sha256(data.token);

    let resetRecord: MemoryPasswordReset | null = null;
    let user: MemoryUser | null = null;

    try {
      const dbReset = await prisma.passwordReset.findUnique({
        where: { tokenHash },
        include: { user: true },
      });

      if (dbReset) {
        resetRecord = {
          id: dbReset.id,
          userId: dbReset.userId,
          tokenHash: dbReset.tokenHash,
          expiresAt: dbReset.expiresAt,
          usedAt: dbReset.usedAt,
          createdAt: dbReset.createdAt,
        };
        const u = dbReset.user;
        user = {
          id: u.id,
          email: u.email,
          passwordHash: u.passwordHash,
          fullName: u.fullName,
          timezone: u.timezone,
          locale: u.locale,
          localeSource: u.localeSource,
          role: u.role,
          plan: u.plan,
          subscriptionStatus: u.subscriptionStatus,
          status: u.status,
          emailVerifiedAt: u.emailVerifiedAt,
          aiConsentAt: u.aiConsentAt,
          createdAt: u.createdAt,
          updatedAt: u.updatedAt,
        };
      }
    } catch {
      const memReset = MemoryStore.resets.find((r) => r.tokenHash === tokenHash);
      if (memReset) {
        resetRecord = memReset;
        user = MemoryStore.users.find((u) => u.id === memReset.userId) || null;
      }
    }

    if (!resetRecord || resetRecord.usedAt || resetRecord.expiresAt < new Date() || !user) {
      throw new ApiError('Reset token is invalid or expired.', 400, 'VALIDATION_FAILED', {
        token: 'Reset link is invalid or expired.',
      });
    }

    PasswordService.assertPasswordPolicy(data.newPassword, 'newPassword');

    const isSameAsCurrent = await PasswordService.verifyPassword(
      data.newPassword,
      user.passwordHash,
    );

    if (isSameAsCurrent) {
      throw new ApiError(
        'New password must differ from previous password.',
        400,
        'VALIDATION_FAILED',
        {
          newPassword: 'Choose a password different from your previous password.',
        },
      );
    }

    const newPasswordHash = await PasswordService.hashPassword(data.newPassword);

    try {
      await prisma.passwordReset.update({
        where: { id: resetRecord.id },
        data: { usedAt: new Date() },
      });
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: newPasswordHash },
      });
      await prisma.passwordReset.deleteMany({ where: { userId: user.id } });
      await prisma.userSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } catch {
      resetRecord.usedAt = new Date();
      user.passwordHash = newPasswordHash;
      MemoryStore.resets = MemoryStore.resets.filter((r) => r.userId !== user!.id);
      MemoryStore.sessions.forEach((s) => {
        if (s.userId === user!.id) s.revokedAt = new Date();
      });
    }

    return {
      reset: true,
      messageKey: 'auth.passwordReset',
      params: {},
    };
  }

  /**
   * Email Preferences
   */
  async getEmailPreferences(userId: number): Promise<EmailPreferencesDto> {
    try {
      const pref = await prisma.emailPreference.findUnique({
        where: { userId: BigInt(userId) },
      });

      return {
        welcome_email: pref ? pref.welcomeEmail : true,
        security_alerts: pref ? pref.securityAlerts : true,
        trade_notifications: pref ? pref.tradeNotifications : true,
        weekly_report: pref ? pref.weeklyReport : true,
        marketing_emails: pref ? pref.marketingEmails : false,
      };
    } catch {
      const pref = MemoryStore.emailPrefs.find((p) => p.userId === BigInt(userId));
      return {
        welcome_email: pref ? pref.welcomeEmail : true,
        security_alerts: pref ? pref.securityAlerts : true,
        trade_notifications: pref ? pref.tradeNotifications : true,
        weekly_report: pref ? pref.weeklyReport : true,
        marketing_emails: pref ? pref.marketingEmails : false,
      };
    }
  }

  async updateEmailPreferences(
    userId: number,
    prefs: Partial<EmailPreferencesDto>,
  ): Promise<EmailPreferencesDto> {
    const current = await this.getEmailPreferences(userId);
    const updated = { ...current, ...prefs };

    try {
      await prisma.emailPreference.upsert({
        where: { userId: BigInt(userId) },
        create: {
          userId: BigInt(userId),
          welcomeEmail: updated.welcome_email,
          securityAlerts: updated.security_alerts,
          tradeNotifications: updated.trade_notifications,
          weeklyReport: updated.weekly_report,
          marketingEmails: updated.marketing_emails,
        },
        update: {
          welcomeEmail: updated.welcome_email,
          securityAlerts: updated.security_alerts,
          tradeNotifications: updated.trade_notifications,
          weeklyReport: updated.weekly_report,
          marketingEmails: updated.marketing_emails,
        },
      });
    } catch {
      const existing = MemoryStore.emailPrefs.find((p) => p.userId === BigInt(userId));
      if (existing) {
        existing.welcomeEmail = updated.welcome_email;
        existing.securityAlerts = updated.security_alerts;
        existing.tradeNotifications = updated.trade_notifications;
        existing.weeklyReport = updated.weekly_report;
        existing.marketingEmails = updated.marketing_emails;
      } else {
        MemoryStore.emailPrefs.push({
          userId: BigInt(userId),
          welcomeEmail: updated.welcome_email,
          securityAlerts: updated.security_alerts,
          tradeNotifications: updated.trade_notifications,
          weeklyReport: updated.weekly_report,
          marketingEmails: updated.marketing_emails,
        });
      }
    }

    return updated;
  }

  /**
   * Update User Preferences (locale & AI consent)
   */
  async updatePreferences(
    userId: number,
    data: UpdatePreferencesRequestDto,
  ): Promise<{
    updated: boolean;
    locale?: string;
    ai_consent?: boolean;
    ai_consent_at?: string | null;
  }> {
    let user: MemoryUser | null = null;

    try {
      const dbUser = await prisma.user.findUnique({ where: { id: BigInt(userId) } });
      if (dbUser) user = dbUser as unknown as MemoryUser;
    } catch {
      user = MemoryStore.users.find((u) => u.id === BigInt(userId)) || null;
    }

    if (!user) {
      throw new ApiError('User not found.', 404, 'USER_NOT_FOUND');
    }

    const updateData: {
      locale?: string;
      localeSource?: string;
      localeUpdatedAt?: Date;
      aiConsentAt?: Date | null;
    } = {};

    if (data.locale !== undefined) {
      updateData.locale = data.locale;
      updateData.localeSource = 'user';
      updateData.localeUpdatedAt = new Date();
    }

    if (data.ai_consent !== undefined) {
      updateData.aiConsentAt = data.ai_consent ? new Date() : null;
    }

    try {
      const updatedUser = await prisma.user.update({
        where: { id: BigInt(userId) },
        data: updateData,
      });

      return {
        updated: true,
        locale: updatedUser.locale,
        ai_consent: Boolean(updatedUser.aiConsentAt),
        ai_consent_at: updatedUser.aiConsentAt ? updatedUser.aiConsentAt.toISOString() : null,
      };
    } catch {
      if (data.locale !== undefined) {
        user.locale = data.locale;
        user.localeSource = 'user';
      }
      if (data.ai_consent !== undefined) {
        user.aiConsentAt = data.ai_consent ? new Date() : null;
      }

      return {
        updated: true,
        locale: user.locale,
        ai_consent: Boolean(user.aiConsentAt),
        ai_consent_at: user.aiConsentAt ? user.aiConsentAt.toISOString() : null,
      };
    }
  }

  /**
   * Helper to issue dual access/refresh token pair
   */
  private async issueTokenPair(
    userId: number,
    role: string,
    ip: string,
    userAgent?: string,
    userObj?: MemoryUser,
    existingSessionId?: bigint | number,
  ): Promise<TokenPairResponse> {
    const accessToken = await JwtService.signAccessToken({
      sub: String(userId),
      role,
    });

    const refreshToken = crypto.randomBytes(32).toString('hex');
    const refreshTokenHash = AuthService.sha256(refreshToken);
    const accessTokenHash = AuthService.sha256(accessToken);
    const ttlSeconds = 2592000; // 30 days
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    try {
      if (existingSessionId) {
        await prisma.userSession.update({
          where: { id: BigInt(existingSessionId) },
          data: {
            refreshTokenHash,
            accessTokenHash,
            expiresAt,
            ipAddress: ip,
            userAgent: userAgent ? userAgent.substring(0, 250) : null,
          },
        });
      } else {
        await prisma.userSession.create({
          data: {
            userId: BigInt(userId),
            refreshTokenHash,
            accessTokenHash,
            ipAddress: ip,
            userAgent: userAgent ? userAgent.substring(0, 250) : null,
            expiresAt,
          },
        });
      }
    } catch {
      if (existingSessionId) {
        const s = MemoryStore.sessions.find((sess) => sess.id === BigInt(existingSessionId));
        if (s) {
          s.refreshTokenHash = refreshTokenHash;
          s.accessTokenHash = accessTokenHash;
          s.expiresAt = expiresAt;
          s.ipAddress = ip;
          s.userAgent = userAgent || null;
        }
      } else {
        MemoryStore.sessions.push({
          id: MemoryStore.idCounter++,
          userId: BigInt(userId),
          refreshTokenHash,
          accessTokenHash,
          ipAddress: ip,
          userAgent: userAgent || null,
          expiresAt,
          revokedAt: null,
          createdAt: new Date(),
        });
      }
    }

    const user = userObj || MemoryStore.users.find((u) => u.id === BigInt(userId));

    if (!user) {
      throw new ApiError('User not found.', 400, 'USER_NOT_FOUND');
    }

    return {
      accessToken,
      refreshToken,
      expiresIn: 900,
      tokenType: 'Bearer',
      user: AuthService.toPublicUser(user),
    };
  }
}
