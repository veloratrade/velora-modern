import { describe, it, expect } from 'vitest';
import { PasswordService } from '../../src/modules/auth/password.js';
import bcrypt from 'bcryptjs';

describe('PasswordService Unit Tests', () => {
  it('should accept valid passwords meeting policy', () => {
    expect(() => PasswordService.assertPasswordPolicy('Password123')).not.toThrow();
    expect(() => PasswordService.assertPasswordPolicy('SecretPass1')).not.toThrow();
  });

  it('should reject passwords shorter than 8 characters', () => {
    expect(() => PasswordService.assertPasswordPolicy('Pass1')).toThrow(/at least 8 characters/i);
  });

  it('should reject passwords longer than 72 characters', () => {
    const longPassword = 'A'.repeat(71) + '1';
    expect(() => PasswordService.assertPasswordPolicy(longPassword + 'A')).toThrow(
      /72 characters/i,
    );
  });

  it('should reject passwords missing digits', () => {
    expect(() => PasswordService.assertPasswordPolicy('PasswordOnly')).toThrow(
      /at least one English letter and one number/i,
    );
  });

  it('should reject passwords missing English letters', () => {
    expect(() => PasswordService.assertPasswordPolicy('1234567890')).toThrow(
      /at least one English letter and one number/i,
    );
  });

  it('should hash and verify passwords using Argon2id', async () => {
    const plain = 'VeloraSecured123';
    const hash = await PasswordService.hashPassword(plain);

    expect(hash).toMatch(/^\$argon2/);
    const isValid = await PasswordService.verifyPassword(plain, hash);
    expect(isValid).toBe(true);

    const isInvalid = await PasswordService.verifyPassword('WrongPassword123', hash);
    expect(isInvalid).toBe(false);
  });

  it('should verify legacy PHP Bcrypt hashes ($2y$)', async () => {
    // Generate valid $2y$ hash for 'Password123'
    const legacy2yHash = bcrypt.hashSync('Password123', 10).replace(/^\$2a\$/, '$2y$');
    const isValid = await PasswordService.verifyPassword('Password123', legacy2yHash);
    expect(isValid).toBe(true);

    const isInvalid = await PasswordService.verifyPassword('WrongPass123', legacy2yHash);
    expect(isInvalid).toBe(false);
  });
});
