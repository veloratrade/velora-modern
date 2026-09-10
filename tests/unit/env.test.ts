import { describe, it, expect } from 'vitest';
import { envSchema } from '../../src/config/env.js';

describe('Environment Configuration (Zod Schema)', () => {
  it('should parse valid environment variables with defaults', () => {
    const result = envSchema.parse({
      NODE_ENV: 'test',
      PORT: '8080',
    });

    expect(result.NODE_ENV).toBe('test');
    expect(result.PORT).toBe(8080);
    expect(result.HOST).toBe('0.0.0.0');
    expect(result.LOG_LEVEL).toBe('info');
  });

  it('should reject invalid PORT values', () => {
    expect(() =>
      envSchema.parse({
        PORT: 'invalid-port',
      }),
    ).toThrow();
  });

  it('should accept optional database and redis URLs', () => {
    const result = envSchema.parse({
      NODE_ENV: 'production',
      DATABASE_URL: 'mysql://user:pass@localhost:3306/db',
      REDIS_URL: 'redis://localhost:6379',
    });

    expect(result.DATABASE_URL).toBe('mysql://user:pass@localhost:3306/db');
    expect(result.REDIS_URL).toBe('redis://localhost:6379');
  });
});
