// Achievements engine — the port of legacy
// api/src/Core/UserAchievementRepository.php + the two achievement
// definitions the legacy system actually ships (READ-ONLY source-read
// 2026-10-04, MG-DOMAIN-LEGACY-ONLY / audit §9.3).
//
// WHAT LEGACY ACTUALLY HAS (source-verified, not assumed):
//   - UserAchievementRepository::unlock(userId, key, titleKey, descriptionKey)
//     idempotent: normalizes the key (mb_strtoupper + trim), returns false if
//     the user already has it, otherwise inserts a row with
//     achieved_at = gmdate('Y-m-d H:i:s') and
//     metadata_json = {titleKey, descriptionKey, unlockedAt: gmdate('c')}
//     and returns true. catch(Throwable) => false — DELIBERATELY fail-silent:
//     an achievement must never break its caller's flow (the callers are
//     post-trade and post-email-verification side effects).
//   - UserAchievementRepository::listForUser(userId): rows ordered
//     achieved_at DESC; catch(Throwable) => [].
//   - Exactly two definitions, unlocked inline by their callers:
//       FIRST_TRADE    (TradeService, after the first created trade)
//       EMAIL_VERIFIED (AuthService, after email verification)
//     each followed by an achievements email — sent ONLY when unlock()
//     returned true (first time) and the user's 'achievements' email
//     preference allows it.
//
// PORT SHAPE (house rules: domain is framework/IO-free):
//   The repository's IO is modeled as the AchievementStore port; the unlock
//   DECISION, key normalization, metadata contract, and timestamp formats are
//   the ported logic, deterministic and testable. The email step is NOT
//   ported here — it is a notification concern (the modern system already
//   keeps the `achievement_notifications` email flag; audit §9.3), and
//   sending email is a live-service boundary anyway.
//
// DIVERGENCE (cosmetic, documented): legacy userId is a bigint; modern
// identifiers are strings (UUID) — the port is generic over the identifier.

/** One achievement as legacy defines it: a stable key plus i18n copy keys. */
export interface AchievementDefinition {
  /** Normalized UPPER_SNAKE identifier (legacy achievement_key column). */
  readonly key: string;
  readonly titleKey: string;
  readonly descriptionKey: string;
}

/** The complete legacy catalog — exactly two definitions, nothing invented. */
export const ACHIEVEMENTS: Readonly<Record<string, AchievementDefinition>> = {
  FIRST_TRADE: {
    key: "FIRST_TRADE",
    titleKey: "achievements.firstTrade.title",
    descriptionKey: "achievements.firstTrade.description",
  },
  EMAIL_VERIFIED: {
    key: "EMAIL_VERIFIED",
    titleKey: "achievements.emailVerified.title",
    descriptionKey: "achievements.emailVerified.description",
  },
};

/** Legacy mb_strtoupper(trim($key)) — the stored key form. */
export function normalizeAchievementKey(key: string): string {
  return key.trim().toUpperCase();
}

/** Legacy gmdate('Y-m-d H:i:s') — the achieved_at column format, UTC. */
export function formatUtcDbTimestamp(now: Date): string {
  return now.toISOString().slice(0, 19).replace("T", " ");
}

/** Legacy gmdate('c') — ISO 8601 with an explicit +00:00 offset, no milliseconds. */
export function formatIso8601UtcPhpStyle(now: Date): string {
  return `${now.toISOString().slice(0, 19)}+00:00`;
}

/** metadata_json exactly as legacy json_encode produced it (same fields, same order, no escaping flags needed in JSON.stringify). */
export interface AchievementMetadata {
  titleKey: string;
  descriptionKey: string;
  unlockedAt: string;
}

export function buildAchievementMetadata(definition: AchievementDefinition, now: Date): string {
  const metadata: AchievementMetadata = {
    titleKey: definition.titleKey,
    descriptionKey: definition.descriptionKey,
    unlockedAt: formatIso8601UtcPhpStyle(now),
  };
  return JSON.stringify(metadata);
}

/** Parse stored metadata_json; null on anything malformed (legacy rows are trusted but display code must not throw). */
export function parseAchievementMetadata(json: string | null): AchievementMetadata | null {
  if (json === null) return null;
  try {
    const v = JSON.parse(json) as Partial<AchievementMetadata>;
    if (typeof v.titleKey !== "string" || typeof v.descriptionKey !== "string" || typeof v.unlockedAt !== "string") {
      return null;
    }
    return { titleKey: v.titleKey, descriptionKey: v.descriptionKey, unlockedAt: v.unlockedAt };
  } catch {
    return null;
  }
}

/** One persisted unlock row (legacy table user_achievements columns). */
export interface UnlockedAchievement {
  userId: string;
  achievementKey: string;
  /** 'YYYY-MM-DD HH:MM:SS' UTC. */
  achievedAt: string;
  metadataJson: string;
}

/**
 * The IO port — the repository's database half. Implementations own storage;
 * the domain owns the decision, formats, and failure semantics.
 */
export interface AchievementStore {
  /** True if the user already has this achievement key (legacy SELECT ... LIMIT 1). */
  exists(userId: string, achievementKey: string): Promise<boolean>;
  /** Persist the unlock row (legacy INSERT). */
  insert(entry: UnlockedAchievement): Promise<void>;
  /** Rows for the user ordered achieved_at DESC (legacy listForUser). */
  list(userId: string): Promise<UnlockedAchievement[]>;
}

/**
 * The unlock decision — legacy UserAchievementRepository::unlock port:
 * returns true only on the FIRST unlock; false when already unlocked or when
 * the store fails (legacy catch(Throwable) fail-silent, preserved
 * deliberately: an achievement must never break its caller's flow).
 */
export async function unlockAchievement(
  userId: string,
  definition: AchievementDefinition,
  store: AchievementStore,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const key = normalizeAchievementKey(definition.key);
    if (await store.exists(userId, key)) {
      return false; // قبلاً باز شده است — already unlocked
    }
    await store.insert({
      userId,
      achievementKey: key,
      achievedAt: formatUtcDbTimestamp(now),
      metadataJson: buildAchievementMetadata(definition, now),
    });
    return true;
  } catch {
    return false; // legacy parity: fail-silent
  }
}

/** listForUser port: the store owns ordering; errors degrade to [] like legacy. */
export async function listAchievementsForUser(
  userId: string,
  store: AchievementStore,
): Promise<UnlockedAchievement[]> {
  try {
    return await store.list(userId);
  } catch {
    return [];
  }
}
