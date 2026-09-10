import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { env } from '../../config/env.js';

export interface ApiErrorResponse {
  success: false;
  error: string;
  code: string;
  statusCode: number;
  details?: Record<string, unknown>;
}

export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const requestId = request.id;

  // Zod Validation Errors
  if (error instanceof ZodError) {
    const response: ApiErrorResponse = {
      success: false,
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      details: {
        fieldErrors: error.flatten().fieldErrors,
      },
    };
    request.log.warn({ requestId, err: error }, 'Validation error');
    reply.status(400).send(response);
    return;
  }

  // Fastify Standard Errors
  const statusCode =
    'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;

  const code =
    'code' in error && typeof error.code === 'string'
      ? error.code
      : statusCode === 500
        ? 'INTERNAL_SERVER_ERROR'
        : 'BAD_REQUEST';

  const message =
    statusCode === 500 && env.NODE_ENV === 'production'
      ? 'Internal server error'
      : error.message || 'An unexpected error occurred';

  const response: ApiErrorResponse = {
    success: false,
    error: message,
    code,
    statusCode,
  };

  if (statusCode >= 500) {
    request.log.error({ requestId, err: error }, 'Server error encountered');
  } else {
    request.log.info({ requestId, err: error }, 'Client error encountered');
  }

  reply.status(statusCode).send(response);
}
