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
  // --- Broker/provider-touching routes (SEC-02, step 2) ---------------------
  // PHP dispatch-level limits for the routes whose work leaves the process or
  // verifies broker credentials. Keys are the product operations, not the
  // Modern paths: `metaapi-connect` is Modern's
  // POST /accounts/{id}/metaapi/connect (the provisioning call that verifies a
  // broker login against MetaAPI), `metaapi-detect` is /accounts/detect-server
  // (same value), and the ingress limit is the webhook receiver. Legacy's own
  // names are kept in the key text so the lineage stays searchable.
  //
  // Legacy ALSO throttled POST /accounts/{id}/sync at 20/300. That route now
  // EXISTS in Modern (TRD-06: the user-triggered sync the accounts page needs),
  // so the key landed WITH it — and the queue it feeds is the same one the tick
  // and the webhook ingress feed, which is why the limit is per user and the
  // work is deduplicated by the job key rather than by the response.
  "accounts:sync": { limit: 20, windowSec: 300 },
  "accounts:metaapi-connect": { limit: 5, windowSec: 900 },
  "accounts:detect-server": { limit: 20, windowSec: 900 },
  // --- Phase 5: support tickets ---------------------------------------------
  // Legacy throttled the AUTH routes and the provider-touching routes, and left
  // the ticket endpoints to the generic authenticated surface. Modern keeps one
  // explicit bucket because a ticket write is the one support operation that
  // creates durable rows a human must read: 20 writes per 5 minutes is well above
  // any genuine support conversation and well below a usable flood.
  "support:write": { limit: 20, windowSec: 300 },
  "webhooks:metaapi": { limit: 120, windowSec: 60 },
  // Legacy also throttled its two admin USER MUTATIONS (`admin-user-action`,
  // 30/300, in Admin/UserManagementController::setStatus + setRole). Modern has
  // exactly those two operations (PATCH .../role and .../status), so the same
  // number covers the same surface; the limit is per caller, keyed like every
  // other bucket here (see throttleKeyFor's caller for the discriminator).
  //
  // NOT covered, deliberately: Legacy's remaining buckets guard surfaces Modern
  // does not have yet — `ai-analyze` / `ai-report` / `ai-feedback` (both the
  // dispatcher IP limits and AIController's per-USER `ai-*-user-{id}` limits)
  // belong to the AI phase, and the `admin-*` controller buckets (config,
  // feature flags, integrations, settings, health refresh, user create/invite)
  // guard admin surfaces owned by the admin phase. Each lands WITH its route, so
  // no key here ever describes a route that does not exist.
  "admin:user-action": { limit: 30, windowSec: 300 },
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
