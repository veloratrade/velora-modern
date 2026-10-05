// Feature flags and the deterministic rollout gate.
//
// Legacy's capability (`ai_feature_flags` + `AIFeatureGuard` + `AIFeatureFlagRepository`):
// an operator switches an AI feature on or off and chooses what percentage of
// users it applies to; the decision for a given user is DETERMINISTIC, so a user
// never sees a feature flicker between requests; and when the flag table cannot
// be read the system fails CLOSED for new features while leaving screenshot
// extraction on (the one feature whose absence would break an existing flow).
//
// The default posture is Legacy's own: with no row at all, only
// `ai_screenshot_extraction` is enabled. Everything else must be switched on by
// an operator, which is why 0028 seeds analysis/report/assistant as off.
//
// THE ROLLOUT HASH. Legacy uses `crc32(feature + ":" + userId) % 100`. Modern
// keeps crc32 and the same string shape, so the rule is the same rule; the user
// identifier differs (Legacy's is an integer, Modern's a UUID), which changes
// WHICH users fall in a bucket but not the properties that matter: stable per
// user, uniform across users, and independent between features.

import { AiFailure, refused } from "./aiErrors.js";
import type { AiConfigStore } from "./aiConfigStore.js";

const CRC32_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(value: string): number {
  const bytes = Buffer.from(value, "utf8");
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

/** 0..99, stable for a (flag, user) pair. */
export function rolloutBucket(flag: string, userId: string): number {
  return crc32(`${flag}:${userId}`) % 100;
}

/** The one feature that stays on when the flag store cannot be read. */
export const FALLBACK_OPEN_FLAG = "ai_screenshot_extraction";

export class AiFeatureGuard {
  constructor(private readonly deps: { readonly store: AiConfigStore }) {}

  async isEnabled(flag: string, userId: string | null): Promise<boolean> {
    try {
      const row = await this.deps.store.flag(flag);
      if (row === null) {
        // Legacy's default posture: only extraction is on before an operator
        // has said anything.
        return flag === FALLBACK_OPEN_FLAG;
      }
      if (!row.enabled) return false;
      const rollout = row.rolloutPercentage;
      if (rollout >= 100) return true;
      if (rollout <= 0) return false;
      // No user context (a system call) is treated as "in", which is Legacy's
      // behaviour and the safe one: a background job must not be silently
      // excluded from a feature the operator switched on.
      if (userId === null) return true;
      return rolloutBucket(flag, userId) < rollout;
    } catch {
      // Fail closed for new features, open for extraction — Legacy's rule, and
      // the reason is operational: a flag-store outage must not turn off the one
      // capability users are actively relying on, and must not turn ON anything
      // an operator has not approved.
      return flag === FALLBACK_OPEN_FLAG;
    }
  }

  /** 403 with a code the client can localize (Legacy `AI_FEATURE_DISABLED`). */
  async requireEnabled(flag: string, userId: string | null): Promise<void> {
    if (!(await this.isEnabled(flag, userId))) throw refused("FEATURE_DISABLED");
  }

  async checkMultiple(flags: readonly string[], userId: string | null): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const flag of flags) out[flag] = await this.isEnabled(flag, userId);
    return out;
  }
}

/** The error type a route handler turns into a 403 with `errors.ai.featureDisabled`. */
export function featureDisabledFailure(): AiFailure {
  return refused("FEATURE_DISABLED");
}
