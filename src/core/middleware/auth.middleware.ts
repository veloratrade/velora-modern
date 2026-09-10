import { FastifyRequest } from 'fastify';
import { AuthService } from '../../modules/auth/auth.service.js';
import { RoleService } from '../../modules/auth/roles.js';
import { ApiError } from '../errors/errorHandler.js';
import { PublicUserDto } from '../../modules/auth/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: PublicUserDto;
    userId?: number;
    userRole?: string;
    userPlan?: string;
  }
}

export class AuthMiddleware {
  private static authService = new AuthService();

  /**
   * Centralized Fastify authentication hook.
   * Extracts Bearer token, verifies JWT, checks user status & active session.
   */
  static async authenticate(request: FastifyRequest): Promise<void> {
    const authHeader = request.headers.authorization;
    let token: string | undefined;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    }

    if (!token) {
      throw new ApiError('Access token is missing.', 401, 'ACCESS_TOKEN_MISSING');
    }

    const publicUser = await AuthMiddleware.authService.authenticateToken(token);
    request.user = publicUser;
    request.userId = publicUser.id;
    request.userRole = publicUser.role;
    request.userPlan = publicUser.plan || 'free';
  }

  /**
   * Fastify preHandler hook requiring specific role
   */
  static requireRole(allowedRoles: string[]) {
    return async (request: FastifyRequest): Promise<void> => {
      await AuthMiddleware.authenticate(request);

      if (!request.userRole || !allowedRoles.includes(request.userRole)) {
        throw new ApiError('Forbidden resource.', 403, 'FORBIDDEN');
      }
    };
  }

  /**
   * Fastify preHandler hook requiring specific permission
   */
  static requirePermission(permission: string) {
    return async (request: FastifyRequest): Promise<void> => {
      await AuthMiddleware.authenticate(request);

      if (!request.userRole || !RoleService.can(request.userRole, permission)) {
        throw new ApiError('Insufficient privileges.', 403, 'PERMISSION_DENIED');
      }
    };
  }
}
