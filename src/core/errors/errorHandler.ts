import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { env } from '../../config/env.js';

export interface PhpApiErrorEnvelope {
  status: 'error';
  data: null;
  error: {
    code: string;
    message: string;
    messageKey: string;
    params: Record<string, unknown>;
    details: Record<string, unknown> | null;
  };
  timestamp: string;
}

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly messageKey: string;
  public readonly params: Record<string, unknown>;
  public readonly details?: Record<string, unknown> | null;

  constructor(
    message: string,
    statusCode = 400,
    code?: string,
    details?: Record<string, unknown> | null,
    messageKey?: string,
    params: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code || defaultCode(statusCode);
    this.details = details || null;
    this.messageKey = messageKey || defaultMessageKey(statusCode, this.code);
    this.params = params;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function defaultCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 405:
      return 'METHOD_NOT_ALLOWED';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'VALIDATION_FAILED';
    case 429:
      return 'TOO_MANY_REQUESTS';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return 'INTERNAL_ERROR';
  }
}

function defaultMessageKey(status: number, code?: string): string {
  if (code === 'EMAIL_ALREADY_REGISTERED') return 'errors.auth.emailAlreadyRegistered';
  if (code === 'INVALID_CREDENTIALS') return 'errors.auth.invalidCredentials';
  if (code === 'EMAIL_NOT_VERIFIED') return 'errors.auth.emailNotVerified';
  if (code === 'ACCOUNT_INACTIVE') return 'errors.auth.accountInactive';
  if (code === 'VERIFICATION_LINK_INVALID') return 'errors.auth.verificationLinkInvalid';
  if (code === 'VERIFICATION_LINK_EXPIRED') return 'errors.auth.verificationLinkExpired';
  if (code === 'ACCESS_TOKEN_MISSING') return 'errors.auth.accessTokenMissing';
  if (code === 'REFRESH_COOKIE_MISSING') return 'errors.auth.sessionExpired';
  if (code === 'SESSION_EXPIRED') return 'errors.auth.sessionExpired';
  if (code === 'SESSION_REVOKED') return 'errors.auth.sessionRevoked';
  if (code === 'INVALID_TOKEN') return 'errors.auth.invalidToken';
  if (code === 'SERVICE_UNAVAILABLE') return 'errors.http.503';

  switch (status) {
    case 401:
      return 'errors.unauthorized';
    case 403:
      return 'errors.forbidden';
    case 404:
      return 'errors.notFound';
    case 409:
      return 'errors.conflict';
    case 422:
      return 'errors.validation';
    case 429:
      return 'errors.rateLimited';
    case 400:
    case 405:
    case 500:
    case 502:
    case 503:
    case 504:
      return `errors.http.${status}`;
    default:
      return 'errors.unknown';
  }
}

export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const requestId = request.id;
  const timestamp = new Date().toISOString();

  // Custom ApiError
  if (error instanceof ApiError) {
    const envelope: PhpApiErrorEnvelope = {
      status: 'error',
      data: null,
      error: {
        code: error.code,
        message: error.message,
        messageKey: error.messageKey,
        params: error.params || {},
        details: error.details || null,
      },
      timestamp,
    };

    if (error.statusCode >= 500) {
      request.log.error({ requestId, err: error }, 'Server error encountered');
    } else {
      request.log.info({ requestId, err: error }, 'Client error encountered');
    }
    reply.status(error.statusCode).send(envelope);
    return;
  }

  // Zod Validation Errors
  if (error instanceof ZodError) {
    const envelope: PhpApiErrorEnvelope = {
      status: 'error',
      data: null,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Validation failed.',
        messageKey: 'errors.validation',
        params: {},
        details: {
          fieldErrors: error.flatten().fieldErrors as unknown as Record<string, unknown>,
        },
      },
      timestamp,
    };
    request.log.warn({ requestId, err: error }, 'Validation error');
    reply.status(400).send(envelope);
    return;
  }

  // Fastify Standard Errors or Unexpected Errors
  const statusCode =
    'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;

  const code =
    'code' in error && typeof error.code === 'string'
      ? error.code
      : statusCode === 503
        ? 'SERVICE_UNAVAILABLE'
        : statusCode === 500
          ? 'INTERNAL_ERROR'
          : defaultCode(statusCode);

  const message =
    statusCode >= 500 && env.NODE_ENV === 'production'
      ? 'Internal server error.'
      : error.message || 'An unexpected error occurred.';

  const envelope: PhpApiErrorEnvelope = {
    status: 'error',
    data: null,
    error: {
      code,
      message,
      messageKey: defaultMessageKey(statusCode, code),
      params: {},
      details: null,
    },
    timestamp,
  };

  if (statusCode >= 500) {
    request.log.error({ requestId, err: error }, 'Server error encountered');
  } else {
    request.log.info({ requestId, err: error }, 'Client error encountered');
  }

  reply.status(statusCode).send(envelope);
}
