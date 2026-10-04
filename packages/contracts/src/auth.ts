// Auth contract — ADR-005 (Accepted, D-04) + verified PHP behaviors.
import { z } from "zod";

// Canonical email (ADR-003, D-02): lowercase at EVERY write path; plain UNIQUE.
export function canonicalEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "invalid email");

export const passwordSchema = z
  .string()
  .min(10, "password too short")
  .max(128, "password too long");

export const registerRequest = z.object({
  email: emailSchema,
  password: passwordSchema,
  locale: z.enum(["fa", "en"]).optional(),
  fullName: z.string().trim().max(100).optional(),
  timezone: z.string().trim().max(64).optional(),
});

export const loginRequest = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export const refreshRequest = z.object({ refreshToken: z.string().min(20) });

// Email link contracts (frozen external tier C-06/C-07 — verified formats):
//   {frontend_url}/verify-email#token=<rawurlencoded>
//   {frontend_url}/reset-password#token=<rawurlencoded>
export function buildVerifyEmailLink(frontendBaseUrl: string, token: string): string {
  return `${trimSlash(frontendBaseUrl)}/verify-email#token=${encodeURIComponent(token)}`;
}
export function buildResetPasswordLink(frontendBaseUrl: string, token: string): string {
  return `${trimSlash(frontendBaseUrl)}/reset-password#token=${encodeURIComponent(token)}`;
}
function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

// Argon2id parameters — owner decision D-04 (m=19456 KiB, t=2, p=1).
export const ARGON2ID_PARAMS = {
  memoryKiB: 19456,
  iterations: 2,
  parallelism: 1,
} as const;

// Route throttle defaults — verified PHP limits (external contract C-14:
// carried as DEFAULTS, tunable with evidence).
export const RATE_LIMIT_DEFAULTS = {
  "auth:register": { limit: 5, windowSec: 3600 },
  "auth:verify-email": { limit: 20, windowSec: 900 },
  "auth:resend-verification": { limit: 4, windowSec: 3600 },
  "auth:login": { limit: 8, windowSec: 300 },
  "auth:refresh": { limit: 30, windowSec: 300 },
  "auth:forgot-password": { limit: 4, windowSec: 3600 },
  "auth:reset-password": { limit: 6, windowSec: 3600 },
  "auth:change-password": { limit: 8, windowSec: 900 },
  "trades:extract-screenshot": { limit: 8, windowSec: 300 },
  // --- Telegram client (ADR-018) --------------------------------------------
  // MODERN-ONLY VALUES: these have no PHP lineage, because the Telegram client
  // has no PHP lineage. They are deliberately conservative per-identity limits
  // (the bucket discriminator is the Telegram user id, not an IP — a bot has no
  // meaningful client IP). See docs/telegram/SECURITY.md §rate limiting.
  //
  // "trades:extract-screenshot" above is REUSED for the Telegram image path: it
  // is the same product operation (screenshot → candidate fields), and inventing
  // a second key for it would let the two limits drift apart.
  "telegram:link-start": { limit: 5, windowSec: 3600 },
  "telegram:update": { limit: 60, windowSec: 60 },
  "telegram:journal": { limit: 20, windowSec: 3600 },
  "telegram:analyze": { limit: 8, windowSec: 3600 },
  "telegram:channel": { limit: 10, windowSec: 3600 },
} as const;
export type RateLimitKey = keyof typeof RATE_LIMIT_DEFAULTS;
