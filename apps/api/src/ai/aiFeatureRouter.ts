// Feature → provider chain resolution.
//
// Legacy's `FeatureRouter::resolveChain` answers one question: for THIS feature,
// in WHICH order do we try providers, and with what model and route? Its rules,
// all preserved here:
//
//   * configured rows win. If `ai_feature_providers` (Modern: `ai_feature_routes`)
//     has enabled rows for the feature, they ARE the chain, ordered by priority.
//     Otherwise the chain is built from the environment/registry default.
//   * a row is skipped — not errored — when the provider cannot serve the request:
//     the capability does not match, the provider is not available, or no
//     credential can be resolved for it (including, for the relay route, the relay
//     URL and token).
//   * the source of the chain (`db` | `env-default`) is reported, because the
//     admin overview has to be able to say "this chain is configured" versus
//     "this chain is what the environment implies".
//
// ONE ADDITION Legacy does not have: `skipped[]`. Legacy builds a chain and
// silently drops entries, so an operator who configures Gemini and sees
// Tesseract run has no way to learn that the API key was missing. Recording the
// reason per dropped entry is what makes the admin AI overview answer "why did
// this not use the provider I configured".

import {
  AI_PROVIDER_NAMES, FEATURE_CAPABILITY, PROVIDERS, defaultModel, isValidRoute,
  type AiCapability, type AiCatalogProvider, type AiFeature, type AiRoute,
} from "./aiCatalog.js";
import type { AiConfigStore } from "./aiConfigStore.js";
import type { AiSecretService } from "./aiSecrets.js";
import type { AiRouteResolver } from "./aiRouteResolver.js";

export interface ChainEntry {
  readonly provider: AiCatalogProvider;
  readonly model: string | null;
  readonly priority: number;
  /** Null means "the provider resolves its own route" (Legacy's behaviour). */
  readonly route: AiRoute | null;
  readonly fallbackIndex: number;
}

export type ChainSource = "db" | "env-default";

export interface SkippedEntry {
  readonly provider: AiCatalogProvider;
  readonly reason: "unsupported_capability" | "not_available" | "no_credential" | "relay_not_configured" | "invalid_route";
}

export interface ResolvedChain {
  readonly entries: readonly ChainEntry[];
  readonly source: ChainSource;
  readonly skipped: readonly SkippedEntry[];
}

export interface AiFeatureRouterDeps {
  readonly store: AiConfigStore;
  readonly secrets: AiSecretService;
  readonly routes: AiRouteResolver;
  readonly env: (key: string) => string | undefined;
  /** True when the local OCR binary is really present. Injected, never probed lazily. */
  readonly localOcrAvailable: () => boolean;
}

export class AiFeatureRouter {
  constructor(private readonly deps: AiFeatureRouterDeps) {}

  async resolveChain(feature: AiFeature, capabilityOverride?: AiCapability | null): Promise<ResolvedChain> {
    const capability = capabilityOverride === undefined ? FEATURE_CAPABILITY[feature] : capabilityOverride;
    const rows = await this.deps.store.chainFor(feature);
    if (rows.length > 0) return this.buildFromRows(rows, capability);
    return this.buildDefaultChain(capability);
  }

  async sourceFor(feature: AiFeature): Promise<ChainSource> {
    const rows = await this.deps.store.chainFor(feature);
    return rows.length > 0 ? "db" : "env-default";
  }

  private async buildFromRows(
    rows: readonly { provider: AiCatalogProvider; model: string | null; priority: number; route: AiRoute | null }[],
    capability: AiCapability | null,
  ): Promise<ResolvedChain> {
    const entries: ChainEntry[] = [];
    const skipped: SkippedEntry[] = [];
    for (const row of rows) {
      const provider = row.provider;
      if (!this.hasCapability(provider, capability)) {
        skipped.push({ provider, reason: "unsupported_capability" });
        continue;
      }
      if (!isValidRoute(provider, row.route)) {
        skipped.push({ provider, reason: "invalid_route" });
        continue;
      }
      const route = await this.effectiveRoute(provider, row.route);
      const availability = await this.credentialState(provider, route);
      if (!availability.available) {
        skipped.push({ provider, reason: availability.reason });
        continue;
      }
      entries.push({
        provider,
        model: row.model !== null && row.model !== "" ? row.model : defaultModel(provider, this.deps.env),
        priority: row.priority,
        route: row.route,
        fallbackIndex: entries.length,
      });
    }
    return { entries, source: "db", skipped };
  }

  /**
   * The environment-implied chain, in catalog order. Legacy builds this from its
   * provider registry; Modern builds it from the catalog and the same
   * availability rules, so a deployment with only a Gemini key gets Gemini, and a
   * deployment with nothing gets the local OCR provider only.
   */
  async buildDefaultChain(capability: AiCapability | null): Promise<ResolvedChain> {
    const entries: ChainEntry[] = [];
    const skipped: SkippedEntry[] = [];
    for (const provider of AI_PROVIDER_NAMES) {
      if (!this.hasCapability(provider, capability)) {
        skipped.push({ provider, reason: "unsupported_capability" });
        continue;
      }
      const route = await this.effectiveRoute(provider, null);
      const availability = await this.credentialState(provider, route);
      if (!availability.available) {
        skipped.push({ provider, reason: availability.reason });
        continue;
      }
      entries.push({
        provider,
        model: defaultModel(provider, this.deps.env),
        priority: entries.length + 1,
        route: null,
        fallbackIndex: entries.length,
      });
    }
    return { entries, source: "env-default", skipped };
  }

  private hasCapability(provider: AiCatalogProvider, capability: AiCapability | null): boolean {
    if (capability === null) return true;
    return (PROVIDERS[provider].capabilities as readonly string[]).includes(capability);
  }

  /**
   * The route this entry will actually use. A row may pin one; otherwise Gemini
   * inherits the global resolution (admin → env → direct) and every other
   * provider is direct-only by catalog.
   */
  private async effectiveRoute(provider: AiCatalogProvider, pinned: AiRoute | null): Promise<AiRoute | null> {
    if (PROVIDERS[provider].local) return null;
    if (pinned !== null) return pinned;
    if (provider === "gemini") return this.deps.routes.resolve();
    return "direct";
  }

  private async credentialState(
    provider: AiCatalogProvider,
    route: AiRoute | null,
  ): Promise<{ available: true } | { available: false; reason: SkippedEntry["reason"] }> {
    const def = PROVIDERS[provider];
    if (def.local) {
      // The local OCR provider needs no credential, but it does need its binary.
      return this.deps.localOcrAvailable() ? { available: true } : { available: false, reason: "not_available" };
    }
    if (route === "n8n_relay") {
      const url = await this.deps.secrets.resolve("GEMINI_RELAY_URL");
      const token = await this.deps.secrets.resolve("GEMINI_RELAY_TOKEN");
      const configured = (url.value ?? "").startsWith("https://") && (token.value ?? "") !== "";
      return configured ? { available: true } : { available: false, reason: "relay_not_configured" };
    }
    for (const key of def.credentialKeys) {
      const resolved = await this.deps.secrets.resolve(key as "GEMINI_API_KEY" | "OPENAI_API_KEY");
      if (resolved.value !== null && resolved.value !== "") return { available: true };
    }
    return { available: false, reason: "no_credential" };
  }
}
