// Achievements read service — the Modern read side for the legacy
// UserAchievementRepository::listForUser port (MG-DOMAIN-LEGACY-ONLY, AC-24/26).
//
// WHAT IT IS: a thin, IO-free wrapper around the AchievementStore port that
// already backs the unlock triggers (first-trade + email-verified). The store
// itself is the single source of truth (PG 0030 + memory double), so this
// service never invents an achievement — it only reads what the domain's
// unlockAchievement() has persisted.
//
// AUTHZ: ownership-scoped (the caller reads ONLY their own userId). There is
// no admin variant — an admin reading another user's achievements is not a
// legacy capability and is not invented here.
//
// BEHAVIOUR: listAchievements(userId) → achievements ordered achievedAt DESC
// (PG ORDER BY achieved_at DESC, memory sort identical). Fail-closed only on
// driver failure (500); an empty list is a valid state (no achievements yet).
import type { AchievementStore, UnlockedAchievement } from "@velora/domain";

export interface AchievementsService {
  listAchievements(userId: string): Promise<UnlockedAchievement[]>;
}

export class PgAchievementsService implements AchievementsService {
  constructor(private readonly store: AchievementStore) {}

  async listAchievements(userId: string): Promise<UnlockedAchievement[]> {
    return this.store.list(userId);
  }
}
