import { prisma } from '../db.js';
import { ApiError } from '../errors/errorHandler.js';

export class RateLimiter {
  private static memoryStore = new Map<string, { hits: number; windowStart: number }>();

  /**
   * Hit rate limit bucket.
   * Throws 429 TOO_MANY_REQUESTS if maxAttempts exceeded within windowSec.
   */
  static async hit(
    bucketName: string,
    ip: string,
    maxAttempts = 10,
    windowSec = 300,
  ): Promise<void> {
    const bucketKey = `${bucketName}|${ip}`;
    const now = new Date();
    const windowStartCutoff = new Date(now.getTime() - windowSec * 1000);

    try {
      // 1. Try DB-backed rate limiting
      await prisma.rateLimit.deleteMany({
        where: {
          bucket: bucketKey,
          windowStart: { lt: windowStartCutoff },
        },
      });

      const existing = await prisma.rateLimit.findUnique({
        where: { bucket: bucketKey },
      });

      let currentHits = 1;

      if (existing) {
        currentHits = existing.hits + 1;
        await prisma.rateLimit.update({
          where: { bucket: bucketKey },
          data: { hits: currentHits },
        });
      } else {
        await prisma.rateLimit.create({
          data: {
            bucket: bucketKey,
            hits: 1,
            windowStart: now,
          },
        });
      }

      if (currentHits > maxAttempts) {
        throw new ApiError('Too many requests.', 429, 'TOO_MANY_REQUESTS');
      }
    } catch (err) {
      if (err instanceof ApiError) {
        throw err;
      }

      // Memory fallback is strictly allowed ONLY in test environment
      if (process.env.NODE_ENV !== 'test') {
        throw new ApiError('Service unavailable.', 503, 'SERVICE_UNAVAILABLE');
      }

      const record = this.memoryStore.get(bucketKey);
      const currentTime = Date.now();

      if (!record || record.windowStart < currentTime - windowSec * 1000) {
        this.memoryStore.set(bucketKey, { hits: 1, windowStart: currentTime });
      } else {
        record.hits += 1;
        if (record.hits > maxAttempts) {
          throw new ApiError('Too many requests.', 429, 'TOO_MANY_REQUESTS');
        }
      }
    }
  }

  static getClientIp(req: {
    headers: Record<string, string | string[] | undefined>;
    socket?: { remoteAddress?: string };
  }): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      if (raw) {
        const first = raw.split(',')[0]?.trim();
        if (first) return first;
      }
    }
    return req.socket?.remoteAddress || '0.0.0.0';
  }
}
