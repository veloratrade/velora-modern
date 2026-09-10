import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { AuthService } from './auth.service.js';
import { AuthMiddleware } from '../../core/middleware/auth.middleware.js';
import { RateLimiter } from '../../core/middleware/rateLimiter.js';
import { ApiError } from '../../core/errors/errorHandler.js';

export async function authRoutes(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  const authService = new AuthService();

  // Helper to set HttpOnly refresh token cookie
  const setRefreshCookie = (reply: FastifyReply, refreshToken: string): void => {
    reply.header(
      'Set-Cookie',
      `refresh_token=${refreshToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    );
  };

  // Helper to clear HttpOnly refresh token cookie
  const clearRefreshCookie = (reply: FastifyReply): void => {
    reply.header('Set-Cookie', 'refresh_token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  };

  // Helper to extract refresh token from cookie or body
  const extractRefreshToken = (req: FastifyRequest): string | undefined => {
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
      const cookies = Object.fromEntries(
        cookieHeader.split(';').map((c) => {
          const [k, v] = c.trim().split('=');
          return [k, v];
        }),
      );
      if (cookies.refresh_token) {
        return cookies.refresh_token;
      }
    }
    const body = req.body as { refreshToken?: string } | undefined;
    return body?.refreshToken;
  };

  // =========================================================================
  // PUBLIC ROUTES
  // =========================================================================

  // POST /api/v1/auth/register
  fastify.post('/register', async (req: FastifyRequest, reply: FastifyReply) => {
    const clientIp = RateLimiter.getClientIp(req.raw);
    await RateLimiter.hit('register', clientIp, 10, 3600);

    const body = req.body as {
      email?: string;
      password?: string;
      full_name?: string;
      fullName?: string;
      timezone?: string;
      locale?: string;
      notificationLocale?: string;
    };

    if (!body || !body.email || !body.password) {
      throw new ApiError('Email and password are required.', 400, 'VALIDATION_FAILED', {
        email: !body?.email ? 'Email is required.' : undefined,
        password: !body?.password ? 'Password is required.' : undefined,
      });
    }

    const result = await authService.register(
      {
        email: body.email,
        password: body.password,
        fullName: body.fullName || body.full_name,
        timezone: body.timezone,
        locale: body.locale,
        notificationLocale: body.notificationLocale,
      },
      clientIp,
      req.headers['user-agent'],
    );

    return reply.status(201).send(result);
  });

  // POST /api/v1/auth/verify-email
  fastify.post('/verify-email', async (req: FastifyRequest, reply: FastifyReply) => {
    const clientIp = RateLimiter.getClientIp(req.raw);
    await RateLimiter.hit('verifyEmail', clientIp, 10, 900);

    const body = req.body as { token?: string; notificationLocale?: string };
    if (!body || !body.token) {
      throw new ApiError('Verification token is required.', 400, 'VALIDATION_FAILED', {
        token: 'Token is required.',
      });
    }

    const alreadyVerified = await authService.verifyEmail(body.token);

    return reply.status(200).send({
      verified: true,
      alreadyVerified,
      messageKey: alreadyVerified ? 'auth.emailAlreadyVerified' : 'auth.emailVerified',
      params: {},
    });
  });

  // POST /api/v1/auth/resend-verification & Alias /resend-verification-email
  const handleResendVerification = async (req: FastifyRequest, reply: FastifyReply) => {
    const clientIp = RateLimiter.getClientIp(req.raw);
    await RateLimiter.hit('resendVerification', clientIp, 5, 900);

    const body = req.body as { email?: string; notificationLocale?: string };
    if (!body || !body.email) {
      throw new ApiError('Email is required.', 400, 'VALIDATION_FAILED', {
        email: 'Email is required.',
      });
    }

    const result = await authService.resendVerification({
      email: body.email,
      notificationLocale: body.notificationLocale,
    });

    return reply.status(200).send(result);
  };

  fastify.post('/resend-verification', handleResendVerification);
  fastify.post('/resend-verification-email', handleResendVerification);

  // POST /api/v1/auth/login
  fastify.post('/login', async (req: FastifyRequest, reply: FastifyReply) => {
    const clientIp = RateLimiter.getClientIp(req.raw);
    await RateLimiter.hit('login', clientIp, 10, 300);

    const body = req.body as { email?: string; password?: string; notificationLocale?: string };
    if (!body || !body.email || !body.password) {
      throw new ApiError('Email and password are required.', 400, 'VALIDATION_FAILED', {
        email: !body?.email ? 'Email is required.' : undefined,
        password: !body?.password ? 'Password is required.' : undefined,
      });
    }

    const result = await authService.login(
      {
        email: body.email,
        password: body.password,
        notificationLocale: body.notificationLocale,
      },
      clientIp,
      req.headers['user-agent'],
    );

    const refreshToken = result.refreshToken;
    delete result.refreshToken;

    if (refreshToken) {
      setRefreshCookie(reply, refreshToken);
    }

    return reply.status(200).send({ tokens: result });
  });

  // POST /api/v1/auth/refresh
  fastify.post('/refresh', async (req: FastifyRequest, reply: FastifyReply) => {
    const clientIp = RateLimiter.getClientIp(req.raw);
    const refreshToken = extractRefreshToken(req);

    if (!refreshToken) {
      clearRefreshCookie(reply);
      throw new ApiError('Refresh cookie is missing.', 401, 'REFRESH_COOKIE_MISSING');
    }

    try {
      const result = await authService.refresh(refreshToken, clientIp, req.headers['user-agent']);
      const newRefreshToken = result.refreshToken;
      delete result.refreshToken;

      if (newRefreshToken) {
        setRefreshCookie(reply, newRefreshToken);
      }

      return reply.status(200).send({ tokens: result });
    } catch (err) {
      clearRefreshCookie(reply);
      throw err;
    }
  });

  // POST /api/v1/auth/logout
  fastify.post('/logout', async (req: FastifyRequest, reply: FastifyReply) => {
    const refreshToken = extractRefreshToken(req);

    if (refreshToken) {
      await authService.logout(refreshToken);
    }

    clearRefreshCookie(reply);
    return reply.status(200).send({ loggedOut: true });
  });

  // POST /api/v1/auth/forgot-password
  fastify.post('/forgot-password', async (req: FastifyRequest, reply: FastifyReply) => {
    const clientIp = RateLimiter.getClientIp(req.raw);
    await RateLimiter.hit('forgotPassword', clientIp, 5, 900);

    const body = req.body as { email?: string; notificationLocale?: string };
    if (!body || !body.email) {
      throw new ApiError('Email is required.', 400, 'VALIDATION_FAILED', {
        email: 'Email is required.',
      });
    }

    const result = await authService.forgotPassword({
      email: body.email,
      notificationLocale: body.notificationLocale,
    });

    return reply.status(200).send(result);
  });

  // POST /api/v1/auth/reset-password
  fastify.post('/reset-password', async (req: FastifyRequest, reply: FastifyReply) => {
    const clientIp = RateLimiter.getClientIp(req.raw);
    await RateLimiter.hit('resetPassword', clientIp, 5, 900);

    const body = req.body as { token?: string; newPassword?: string; notificationLocale?: string };
    if (!body || !body.token || !body.newPassword) {
      throw new ApiError('Token and new password are required.', 400, 'VALIDATION_FAILED', {
        token: !body?.token ? 'Token is required.' : undefined,
        newPassword: !body?.newPassword ? 'New password is required.' : undefined,
      });
    }

    const result = await authService.resetPassword({
      token: body.token,
      newPassword: body.newPassword,
      notificationLocale: body.notificationLocale,
    });

    return reply.status(200).send(result);
  });

  // =========================================================================
  // PROTECTED ROUTES (Require Authentication)
  // =========================================================================

  // GET /api/v1/auth/me
  fastify.get(
    '/me',
    { preHandler: [AuthMiddleware.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.user) {
        throw new ApiError('Unauthenticated.', 401, 'UNAUTHORIZED');
      }
      return reply.status(200).send({ user: req.user });
    },
  );

  // POST /api/v1/auth/change-password
  fastify.post(
    '/change-password',
    { preHandler: [AuthMiddleware.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as {
        currentPassword?: string;
        newPassword?: string;
        notificationLocale?: string;
      };

      if (!body || !body.currentPassword || !body.newPassword) {
        throw new ApiError(
          'Current password and new password are required.',
          400,
          'VALIDATION_FAILED',
          {
            currentPassword: !body?.currentPassword ? 'Current password is required.' : undefined,
            newPassword: !body?.newPassword ? 'New password is required.' : undefined,
          },
        );
      }

      const result = await authService.changePassword(req.userId!, {
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
        notificationLocale: body.notificationLocale,
      });

      return reply.status(200).send(result);
    },
  );

  // GET /api/v1/auth/email-preferences
  fastify.get(
    '/email-preferences',
    { preHandler: [AuthMiddleware.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const preferences = await authService.getEmailPreferences(req.userId!);
      return reply.status(200).send({
        preferences,
        messageKey: 'auth.emailPreferences',
        params: {},
      });
    },
  );

  // PUT /api/v1/auth/email-preferences
  fastify.put(
    '/email-preferences',
    { preHandler: [AuthMiddleware.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body || {}) as Record<string, boolean>;
      const preferences = await authService.updateEmailPreferences(req.userId!, body);
      return reply.status(200).send({
        updated: true,
        preferences,
        messageKey: 'auth.emailPreferencesUpdated',
        params: {},
      });
    },
  );

  // PATCH /api/v1/auth/me/preferences
  fastify.patch(
    '/me/preferences',
    { preHandler: [AuthMiddleware.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body || {}) as { locale?: string; ai_consent?: boolean };

      if (body.locale === undefined && body.ai_consent === undefined) {
        throw new ApiError('No valid preference field provided.', 400, 'VALIDATION_FAILED');
      }

      const result = await authService.updatePreferences(req.userId!, body);
      return reply.status(200).send(result);
    },
  );
}
