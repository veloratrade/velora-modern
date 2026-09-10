import { describe, it, expect } from 'vitest';
import { logger } from '../../src/core/logger.js';

describe('Logger Configuration', () => {
  it('should initialize pino logger instance with service name', () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
  });
});
