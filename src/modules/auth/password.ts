import argon2 from '@phc/argon2';
import bcrypt from 'bcryptjs';
import { ApiError } from '../../core/errors/errorHandler.js';

export class PasswordService {
  /**
   * Enforce unified password policy:
   * Minimum 8 characters, maximum 72 characters,
   * must contain at least one English letter [A-Za-z] and at least one digit [0-9].
   */
  static assertPasswordPolicy(password: string, fieldName = 'password'): void {
    if (!password || password.length < 8) {
      throw new ApiError('Password must be at least 8 characters long.', 400, 'VALIDATION_FAILED', {
        [fieldName]: 'At least 8 characters required.',
      });
    }

    if (password.length > 72) {
      throw new ApiError(
        'Password exceeds maximum length of 72 characters.',
        400,
        'VALIDATION_FAILED',
        {
          [fieldName]: 'Maximum 72 characters allowed.',
        },
      );
    }

    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      throw new ApiError(
        'Password must contain at least one English letter and one number.',
        400,
        'VALIDATION_FAILED',
        {
          [fieldName]: 'Must contain at least one English letter and one number.',
        },
      );
    }
  }

  /**
   * Hash password using Argon2id
   */
  static async hashPassword(password: string): Promise<string> {
    this.assertPasswordPolicy(password);
    return argon2.hash(password);
  }

  /**
   * Verify password against hash.
   * Supports Argon2id hashes and legacy Bcrypt ($2y$, $2b$, $2a$) hashes.
   */
  static async verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
    if (!password || !hash) {
      return false;
    }

    // Handle legacy Bcrypt hashes from PHP ($2y$, $2b$, $2a$)
    if (hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$')) {
      const compatHash = hash.replace(/^\$2y\$/, '$2a$');
      return bcrypt.compareSync(password, compatHash);
    }

    // Handle Argon2 hashes
    if (hash.startsWith('$argon2')) {
      try {
        return await argon2.verify(hash, password);
      } catch {
        return false;
      }
    }

    return false;
  }
}
