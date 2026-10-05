// Route resolution — `direct` or `n8n_relay`, and who decided.
//
// Legacy's precedence (`AiRouteResolver::resolveWithSource`) is:
//   1. the admin-managed global setting `ai_route_default`
//   2. the `GEMINI_ROUTE` environment variable
//   3. a legacy boolean feature flag `ai_gemini_relay_route`
//   4. `direct`
// and it reports the SOURCE alongside the value so the admin UI can distinguish
// "configured" from "effective". That distinction is the useful part: an operator
// who sets the relay and still sees direct traffic needs to know which tier won.
//
// Modern keeps tiers 1, 2 and 4 and drops tier 3, because Modern's flag table is
// a per-feature ROLLOUT gate (`ai_feature_flags`, 0028), not a route switch — and
// keeping a second switch for the same decision would mean two places an operator
// can be contradicted. Recorded in the phase-7 capability map §3.
//
// Only allowlisted values are ever returned: an unrecognised setting is treated as
// absent, so a typo in a config row degrades to the safe default (direct) instead
// of becoming a route string that reaches a transport.

import { isAiRoute, type AiRoute } from "./aiCatalog.js";
import { AI_ROUTE_SETTING, type AiConfigStore } from "./aiConfigStore.js";

export const AI_ROUTE_SOURCES = ["admin", "env", "default"] as const;
export type AiRouteSource = (typeof AI_ROUTE_SOURCES)[number];

export interface ResolvedRoute {
  readonly route: AiRoute;
  readonly source: AiRouteSource;
}

export const AI_ROUTE_ENV_KEY = "GEMINI_ROUTE";

export class AiRouteResolver {
  constructor(
    private readonly deps: {
      readonly store: AiConfigStore;
      readonly env: (key: string) => string | undefined;
    },
  ) {}

  /** The explicitly saved admin route, or null when unset/unrecognised. */
  async configuredRoute(): Promise<AiRoute | null> {
    const value = await this.deps.store.setting(AI_ROUTE_SETTING);
    return isAiRoute(value) ? value : null;
  }

  async resolveWithSource(): Promise<ResolvedRoute> {
    const admin = await this.configuredRoute();
    if (admin !== null) return { route: admin, source: "admin" };

    const fromEnv = (this.deps.env(AI_ROUTE_ENV_KEY) ?? "").toLowerCase().trim();
    if (isAiRoute(fromEnv)) return { route: fromEnv, source: "env" };

    return { route: "direct", source: "default" };
  }

  async resolve(): Promise<AiRoute> {
    return (await this.resolveWithSource()).route;
  }

  /** Admin write. Returns false for a value outside the allowlist. */
  async save(route: string, actorId: string | null): Promise<boolean> {
    if (!isAiRoute(route)) return false;
    await this.deps.store.setSetting(AI_ROUTE_SETTING, route, actorId);
    return true;
  }

  /** Clear the admin choice, i.e. go back to inheriting env → default. */
  async clear(): Promise<boolean> {
    return this.deps.store.deleteSetting(AI_ROUTE_SETTING);
  }
}
