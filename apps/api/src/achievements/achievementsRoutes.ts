// Achievements routes — the Modern read surface for the legacy
// UserAchievementRepository::listForUser port (MG-DOMAIN-LEGACY-ONLY).
//
// AUTHZ: authenticated self-read only. Every read is keyed by `claims.sub`,
// never by a request-supplied user id. There is no admin override — an admin
// reading another user's achievements is not a legacy capability and is not
// invented.
//
// CAPABILITY CONTRACT: absent store → 503 SERVICE_UNAVAILABLE (fail-closed,
// same as every other capability slot). The store is the same
// PgAchievementStore / MemoryAchievementStore that already backs the unlock
// triggers, so no second table or second source of truth is introduced.
import { fail, ok } from "@velora/contracts";
import { capabilityAbsent, unauthenticated } from "../routes/responses.js";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";
import { PgAchievementsService } from "./achievementsService.js";

const ROUTES: readonly (readonly [string, string])[] = [
  ["GET", "/api/v1/achievements"],
];

function buildService(store: NonNullable<ExtendedRouteContext["config"]["achievements"]>): PgAchievementsService {
  return new PgAchievementsService(store);
}

export async function handleAchievementsRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  const owned = ROUTES.some(([method, path]) => method === ctx.method && path === ctx.path);
  if (!owned) return null;

  const store = ctx.config.achievements ?? null;
  if (store === null) return capabilityAbsent(ctx, "achievements");

  const service = buildService(store);

  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);

  try {
    const achievements = await service.listAchievements(claims.sub);
    return {
      status: 200,
      body: ok({
        achievements: achievements.map((a) => ({
          key: a.achievementKey,
          titleKey: JSON.parse(a.metadataJson as string)?.titleKey ?? "",
          descriptionKey: JSON.parse(a.metadataJson as string)?.descriptionKey ?? "",
          achievedAt: a.achievedAt,
          unlockedAt: JSON.parse(a.metadataJson as string)?.unlockedAt ?? a.achievedAt,
          metadata: JSON.parse(a.metadataJson as string),
        })),
        total: achievements.length,
      }),
    };
  } catch {
    return { status: 500, body: fail("ACHIEVEMENTS_FAILED", "Achievements could not be read.", ctx.requestId) };
  }
}
