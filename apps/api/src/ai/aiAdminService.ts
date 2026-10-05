// The admin AI surface's application layer.
//
// Legacy spreads this over four controllers (`AIConfigController` 598 lines,
// `AiGlobalRouteController`, `AiUsageController`, `RelayConfigController`) and one
// service (`EffectiveConfigService`). Modern keeps ONE service, because the five
// things an operator does here — look at the effective configuration, edit the
// chains, hold the secrets, choose the route, read the usage — all read the same
// substrate, and splitting them would mean five places to keep honest.
//
// THE RULE THAT SHAPES EVERY METHOD: an operator is told the TRUTH about what the
// system can do, and never shown a secret.
//   * `overview` reports, per provider: is a credential resolvable, from which
//     tier (admin-managed or environment), what its verification status is, what
//     the fingerprint is, how much of today's budget is left, which chains it
//     appears in, and — for the relay — whether the URL is https and which HOST it
//     points at. The host, not the URL: a relay URL can carry a workflow id, and
//     the token certainly must not travel back.
//   * a credential write returns a fingerprint and a status. It never echoes the
//     value, and a read never returns one.
//   * `verify` and `testConnection` perform a REAL probe. Legacy's own comment on
//     its integrations routes is the standard kept here: "connectivity only from a
//     real probe". A provider that has never been probed is reported UNVERIFIED,
//     not assumed healthy.
//   * a chain entry that cannot be used is reported with the REASON it was skipped
//     (`no_credential`, `relay_not_configured`, `not_available`,
//     `unsupported_capability`, `invalid_route`), which is the answer to "why did
//     Tesseract run when I configured Gemini".

import { AI_PROVIDER_NAMES, PROVIDERS, defaultModel, isAiFeature, isAiProvider, isAiRoute, isValidModel, isValidRoute,
  type AiCatalogProvider, type AiFeature, type AiRoute } from "./aiCatalog.js";
import {
  AI_ROUTE_SETTING, type AiConfigStore, type AiCredentialStatus, type AiSecretKey, type CredentialMetadata,
  type FeatureFlagRow, type FeatureRouteRow, type QuotaRow,
} from "./aiConfigStore.js";
import { AiSecretService, type SecretStatus } from "./aiSecrets.js";
import { AiRouteResolver, type ResolvedRoute } from "./aiRouteResolver.js";
import type { AiFeatureRouter, ResolvedChain, SkippedEntry } from "./aiFeatureRouter.js";
import type { AiExecutor } from "./aiExecutors.js";
import { AiFailure } from "./aiErrors.js";
import type { AiFeatureGuard } from "./aiFeatureGuard.js";
import type { ImageAnonymizer } from "./imageAnonymizer.js";
import type { AiUsageReader } from "./aiLedger.js";
import { relayIsConfigured } from "./n8nRelayTransport.js";
import { AI_FLAGS } from "./aiCatalog.js";

export class AiConfigValidationError extends Error {
  constructor(readonly field: string, readonly reason: string) {
    super(`${field}: ${reason}`);
    this.name = "AiConfigValidationError";
  }
}

export interface ProviderOverview {
  readonly provider: AiCatalogProvider;
  readonly local: boolean;
  readonly capabilities: readonly string[];
  readonly models: readonly string[];
  readonly defaultModel: string | null;
  readonly routes: readonly (string | null)[];
  readonly costTier: number;
  readonly credential: {
    readonly required: boolean;
    readonly keys: readonly string[];
    readonly configured: boolean;
    readonly source: "admin" | "env" | null;
    readonly fingerprint: string | null;
  };
  readonly verification: CredentialMetadata | null;
  readonly quota: QuotaRow | null;
  readonly available: boolean;
  /** Why it is not available, when it is not. Never a guess. */
  readonly unavailableReason: SkippedEntry["reason"] | null;
}

export interface AiOverview {
  readonly providers: readonly ProviderOverview[];
  readonly chains: readonly { feature: AiFeature; source: "db" | "env-default"; entries: ResolvedChain["entries"]; skipped: readonly SkippedEntry[] }[];
  readonly configuredRoutes: readonly FeatureRouteRow[];
  readonly flags: readonly FeatureFlagRow[];
  readonly globalRoute: ResolvedRoute;
  readonly relay: {
    readonly configured: boolean;
    readonly source: "admin" | "env" | null;
    readonly host: string | null;
    readonly https: boolean;
    readonly tokenPresent: boolean;
  };
  readonly secrets: readonly SecretStatus[];
  readonly anonymizer: ReturnType<ImageAnonymizer["info"]>;
  readonly transportAvailable: readonly { provider: AiCatalogProvider; transport: boolean }[];
}

export interface AiAdminServiceDeps {
  readonly store: AiConfigStore;
  readonly secrets: AiSecretService;
  readonly routes: AiRouteResolver;
  readonly router: AiFeatureRouter;
  readonly guard: AiFeatureGuard;
  readonly anonymizer: ImageAnonymizer;
  readonly ledger: AiUsageReader;
  readonly executors: Readonly<Partial<Record<AiCatalogProvider, AiExecutor>>>;
  readonly localOcrAvailable: () => boolean;
  /** The environment reader, so "which tier did this value come from" is answerable. */
  readonly env: (key: string) => string | undefined;
  readonly now?: () => Date;
}

/** What a probe may cost: one short call, bounded, and never a user's data. */
export const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_PROMPT_VERSION = "provider_probe_v1";
export const PROBE_PROMPT = "Reply with the single JSON object {\"ok\":true} and nothing else.";

export class AiAdminService {
  constructor(private readonly deps: AiAdminServiceDeps) {}

  private get now(): () => Date {
    return this.deps.now ?? (() => new Date());
  }

  // ── overview ────────────────────────────────────────────────────────────────

  async overview(): Promise<AiOverview> {
    const [statuses, quotas, credentials, configuredRoutes, flags, globalRoute, relay] = await Promise.all([
      this.deps.secrets.statusAll(["GEMINI_API_KEY", "OPENAI_API_KEY", "GEMINI_RELAY_URL", "GEMINI_RELAY_TOKEN"]),
      this.deps.store.quotas(),
      this.deps.store.allCredentialMetadata(),
      this.deps.store.listRoutes(),
      this.deps.store.listFlags(),
      this.deps.routes.resolveWithSource(),
      this.relayStatus(),
    ]);
    const statusOf = (key: string): SecretStatus | undefined => statuses.find((s) => s.key === key);

    const providers: ProviderOverview[] = [];
    for (const provider of AI_PROVIDER_NAMES) {
      const def = PROVIDERS[provider];
      const key = def.credentialKeys[0] ?? null;
      const secret = key === null ? undefined : statusOf(key);
      const verification = credentials.find((c) => c.provider === provider) ?? null;
      const quota = quotas.find((q) => q.provider === provider) ?? null;
      const chain = await this.deps.router.buildDefaultChain(null);
      const skipped = chain.skipped.find((s) => s.provider === provider);
      const inChain = chain.entries.some((e) => e.provider === provider);
      providers.push({
        provider,
        local: def.local,
        capabilities: def.capabilities,
        models: def.models,
        defaultModel: defaultModel(provider, (k) => this.deps.env(k)),
        routes: def.routes,
        costTier: def.costTier,
        credential: {
          required: !def.local,
          keys: def.credentialKeys,
          configured: def.local ? true : secret?.configured === true,
          source: def.local ? null : secret?.source ?? null,
          fingerprint: def.local ? null : secret?.fingerprint ?? null,
        },
        verification,
        quota,
        available: def.local ? this.deps.localOcrAvailable() : inChain,
        unavailableReason: def.local
          ? (this.deps.localOcrAvailable() ? null : "not_available")
          : inChain ? null : skipped?.reason ?? "no_credential",
      });
    }

    const chains = [];
    for (const feature of ["screenshot_extraction", "trade_analysis", "weekly_report", "assistant", "translate", "copilot"] as AiFeature[]) {
      const resolved = await this.deps.router.resolveChain(feature);
      chains.push({ feature, source: resolved.source, entries: resolved.entries, skipped: resolved.skipped });
    }

    return {
      providers,
      chains,
      configuredRoutes,
      flags,
      globalRoute,
      relay,
      secrets: statuses,
      anonymizer: this.deps.anonymizer.info(),
      // Honest about what Modern can actually call: a provider in the vocabulary
      // with no transport is reported as such instead of appearing configurable.
      transportAvailable: AI_PROVIDER_NAMES.map((provider) => ({
        provider,
        transport: this.deps.executors[provider] !== undefined,
      })),
    };
  }

  /** The relay's status without its secrets: host and shape, never the URL or token. */
  async relayStatus(): Promise<AiOverview["relay"]> {
    const url = await this.deps.secrets.resolve("GEMINI_RELAY_URL");
    const token = await this.deps.secrets.resolve("GEMINI_RELAY_TOKEN");
    const value = url.value ?? "";
    let host: string | null = null;
    try {
      host = value === "" ? null : new URL(value).host;
    } catch {
      host = null;
    }
    return {
      configured: relayIsConfigured(url.value, token.value),
      source: url.source ?? token.source,
      host,
      https: value.startsWith("https://"),
      tokenPresent: (token.value ?? "") !== "",
    };
  }

  // ── chains ──────────────────────────────────────────────────────────────────

  async listFeatureRoutes(): Promise<FeatureRouteRow[]> {
    return this.deps.store.listRoutes();
  }

  async createFeatureRoute(input: {
    feature: string; provider: string; model?: string | null; priority?: number;
    enabled?: boolean; route?: string | null;
  }): Promise<FeatureRouteRow> {
    if (!isAiFeature(input.feature)) throw new AiConfigValidationError("feature", "unknown feature");
    if (!isAiProvider(input.provider)) throw new AiConfigValidationError("provider", "unknown provider");
    const model = input.model ?? null;
    if (!isValidModel(input.provider, model)) throw new AiConfigValidationError("model", "not in the provider's allowlist");
    const rawRoute = input.route ?? null;
    if (!isValidRoute(input.provider, rawRoute)) throw new AiConfigValidationError("route", "not a legal route for this provider");
    const route: AiRoute | null = rawRoute !== null && isAiRoute(rawRoute) ? rawRoute : null;
    const priority = input.priority ?? 1;
    if (!Number.isInteger(priority) || priority < 1) throw new AiConfigValidationError("priority", "must be an integer >= 1");
    return this.deps.store.upsertRoute({
      feature: input.feature,
      provider: input.provider,
      model: model === null || model === "" ? null : model,
      priority,
      enabled: input.enabled ?? true,
      route,
    });
  }

  async updateFeatureRoute(id: string, patch: {
    model?: string | null; priority?: number; enabled?: boolean; route?: string | null;
  }): Promise<FeatureRouteRow | null> {
    const existing = (await this.deps.store.listRoutes()).find((r) => r.id === id);
    if (existing === undefined) return null;
    if (patch.model !== undefined && !isValidModel(existing.provider, patch.model)) {
      throw new AiConfigValidationError("model", "not in the provider's allowlist");
    }
    if (patch.route !== undefined && !isValidRoute(existing.provider, patch.route)) {
      throw new AiConfigValidationError("route", "not a legal route for this provider");
    }
    const nextRoute: AiRoute | null | undefined =
      patch.route === undefined ? undefined : patch.route !== null && isAiRoute(patch.route) ? patch.route : null;
    // Built key by key: with `exactOptionalPropertyTypes` an explicit `undefined`
    // is not the same as an absent key, and COALESCE in the UPDATE relies on the
    // difference (absent = leave the column alone).
    const next: { model?: string | null; priority?: number; enabled?: boolean; route?: AiRoute | null } = {};
    if (patch.model !== undefined) next.model = patch.model;
    if (patch.priority !== undefined) next.priority = patch.priority;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (nextRoute !== undefined) next.route = nextRoute;
    if (patch.priority !== undefined && (!Number.isInteger(patch.priority) || patch.priority < 1)) {
      throw new AiConfigValidationError("priority", "must be an integer >= 1");
    }
    return this.deps.store.updateRoute(id, next);
  }

  async deleteFeatureRoute(id: string): Promise<boolean> {
    return this.deps.store.deleteRoute(id);
  }

  async reorderFeatureRoutes(feature: string, orderedIds: readonly string[]): Promise<FeatureRouteRow[]> {
    if (!isAiFeature(feature)) throw new AiConfigValidationError("feature", "unknown feature");
    const own = (await this.deps.store.listRoutes()).filter((r) => r.feature === feature);
    const ownIds = new Set(own.map((r) => r.id));
    // Every id must belong to this feature and every row must be named exactly
    // once: a partial ordering would leave two entries at the same priority, and
    // then "which provider runs first" would depend on a tie-break instead of on
    // the operator's intent.
    if (orderedIds.length !== ownIds.size) throw new AiConfigValidationError("ids", "must name every entry of this feature exactly once");
    for (const id of orderedIds) {
      if (!ownIds.has(id)) throw new AiConfigValidationError("ids", "an id does not belong to this feature");
    }
    if (new Set(orderedIds).size !== orderedIds.length) throw new AiConfigValidationError("ids", "an id is repeated");
    return this.deps.store.reorder(feature, orderedIds);
  }

  // ── flags and budgets ───────────────────────────────────────────────────────

  async listFlags(): Promise<FeatureFlagRow[]> {
    return this.deps.store.listFlags();
  }

  async setFlag(featureName: string, enabled: boolean, rolloutPercentage: number, actorId: string | null): Promise<FeatureFlagRow> {
    if (!(AI_FLAGS as readonly string[]).includes(featureName)) {
      throw new AiConfigValidationError("feature_name", "not a canonical AI flag");
    }
    if (!Number.isInteger(rolloutPercentage) || rolloutPercentage < 0 || rolloutPercentage > 100) {
      throw new AiConfigValidationError("rollout_percentage", "must be an integer 0..100");
    }
    return this.deps.store.setFlag(featureName, enabled, rolloutPercentage, actorId);
  }

  async quotas(): Promise<QuotaRow[]> {
    return this.deps.store.quotas();
  }

  async setQuotaLimit(provider: string, limit: number): Promise<QuotaRow> {
    if (!isAiProvider(provider)) throw new AiConfigValidationError("provider", "unknown provider");
    if (!Number.isInteger(limit) || limit < 0) throw new AiConfigValidationError("quota_limit", "must be an integer >= 0");
    return this.deps.store.setQuotaLimit(provider, limit);
  }

  // ── route ───────────────────────────────────────────────────────────────────

  async route(): Promise<ResolvedRoute & { configured: AiRoute | null }> {
    const resolved = await this.deps.routes.resolveWithSource();
    return { ...resolved, configured: await this.deps.routes.configuredRoute() };
  }

  async saveRoute(route: string, actorId: string | null): Promise<ResolvedRoute> {
    if (!isAiRoute(route)) throw new AiConfigValidationError("route", "must be direct or n8n_relay");
    const saved = await this.deps.routes.save(route, actorId);
    if (!saved) throw new AiConfigValidationError("route", "must be direct or n8n_relay");
    return this.deps.routes.resolveWithSource();
  }

  async clearRoute(): Promise<ResolvedRoute> {
    await this.deps.routes.clear();
    return this.deps.routes.resolveWithSource();
  }

  // ── secrets ─────────────────────────────────────────────────────────────────

  async replaceSecret(key: string, value: string, actorId: string | null): Promise<{ key: AiSecretKey; fingerprint: string }> {
    const secretKey = assertSecretKey(key);
    const written = await this.deps.secrets.replace(secretKey, value, actorId);
    // A replaced provider key invalidates the previous verification: reporting
    // VALID for a value nobody has probed would be a claim without evidence.
    const provider = providerForSecretKey(secretKey);
    if (provider !== null) {
      await this.deps.store.recordVerification({
        provider,
        status: "UNVERIFIED",
        fingerprint: written.fingerprint,
        errorCode: null,
        latencyMs: 0,
      });
    }
    return { key: secretKey, fingerprint: written.fingerprint };
  }

  async deleteSecret(key: string): Promise<{ key: AiSecretKey; removed: boolean; status: SecretStatus }> {
    const secretKey = assertSecretKey(key);
    const removed = await this.deps.secrets.remove(secretKey);
    const provider = providerForSecretKey(secretKey);
    if (provider !== null && removed) {
      await this.deps.store.recordVerification({ provider, status: "UNVERIFIED", fingerprint: null, errorCode: null, latencyMs: 0 });
    }
    return { key: secretKey, removed, status: await this.deps.secrets.status(secretKey) };
  }

  async saveRelay(url: string, token: string, actorId: string | null): Promise<AiOverview["relay"]> {
    // https only, enforced here as well as in the transport: an operator must not
    // be able to save a relay that would send the token in the clear.
    if (!url.trim().startsWith("https://")) throw new AiConfigValidationError("url", "must be an https URL");
    if (token.trim() === "") throw new AiConfigValidationError("token", "must not be empty");
    await this.deps.secrets.replace("GEMINI_RELAY_URL", url.trim(), actorId);
    await this.deps.secrets.replace("GEMINI_RELAY_TOKEN", token.trim(), actorId);
    return this.relayStatus();
  }

  async clearRelay(): Promise<AiOverview["relay"]> {
    await this.deps.secrets.remove("GEMINI_RELAY_URL");
    await this.deps.secrets.remove("GEMINI_RELAY_TOKEN");
    return this.relayStatus();
  }

  // ── verification: a REAL probe, never an assumption ─────────────────────────

  /**
   * Probe a provider and record what happened.
   *
   * `mode: "verify"` checks the credential itself (Legacy `verifyCredential`);
   * `mode: "test-connection"` performs the same call and additionally reports the
   * resolved route, which is what an operator needs when the relay is in play.
   * Both record the outcome in `ai_provider_credentials` — status, error code,
   * latency, and (for a credential probe) the fingerprint — so the next overview
   * reports evidence rather than hope.
   */
  async probe(providerName: string, mode: "verify" | "test-connection", actorId: string | null): Promise<{
    provider: AiCatalogProvider;
    status: AiCredentialStatus;
    verified: boolean;
    errorCode: string | null;
    latencyMs: number;
    fingerprint: string | null;
    route: AiRoute | null;
    model: string | null;
    probedAt: string;
  }> {
    if (!isAiProvider(providerName)) throw new AiConfigValidationError("provider", "unknown provider");
    const provider = providerName;
    const def = PROVIDERS[provider];
    const started = Date.now();

    if (def.local) {
      // The local OCR engine has no credential. Its probe is "is the binary
      // really there", which is the only honest question to ask of it.
      const available = this.deps.localOcrAvailable();
      const recorded = await this.deps.store.recordVerification({
        provider,
        status: available ? "VALID" : "PROVIDER_UNAVAILABLE",
        fingerprint: null,
        errorCode: available ? null : "OCR_UNAVAILABLE",
        latencyMs: Date.now() - started,
      });
      return {
        provider, status: recorded.status, verified: recorded.verified, errorCode: recorded.errorCode,
        latencyMs: recorded.latencyMs, fingerprint: null, route: null, model: null, probedAt: this.now().toISOString(),
      };
    }

    const executor = this.deps.executors[provider] ?? null;
    if (executor === null) {
      const recorded = await this.deps.store.recordVerification({
        provider, status: "PROVIDER_UNAVAILABLE", errorCode: "NO_TRANSPORT", latencyMs: Date.now() - started,
      });
      return {
        provider, status: recorded.status, verified: false, errorCode: "NO_TRANSPORT",
        latencyMs: recorded.latencyMs, fingerprint: null, route: null, model: null, probedAt: this.now().toISOString(),
      };
    }

    const route = provider === "gemini" ? await this.deps.routes.resolve() : "direct";
    const key = def.credentialKeys[0]! as AiSecretKey;
    const secret = await this.deps.secrets.resolve(key);
    const fingerprint = secret.value === null ? null : this.deps.secrets.fingerprint(secret.value);
    if (secret.value === null) {
      const recorded = await this.deps.store.recordVerification({
        provider, status: "UNVERIFIED", fingerprint, errorCode: "NO_CREDENTIAL", latencyMs: Date.now() - started,
      });
      return {
        provider, status: recorded.status, verified: false, errorCode: "NO_CREDENTIAL",
        latencyMs: recorded.latencyMs, fingerprint, route, model: null, probedAt: this.now().toISOString(),
      };
    }

    let status: AiCredentialStatus = "VALID";
    let errorCode: string | null = null;
    let latencyMs = 0;
    try {
      // A probe sends NO user data: one fixed prompt, no facts, no image. What it
      // proves is that the credential and the route work, nothing more.
      await executor.execute(
        { userId: actorId ?? "system", prompt: PROBE_PROMPT, promptVersion: PROBE_PROMPT_VERSION, timeoutMs: PROBE_TIMEOUT_MS },
        { model: null, route },
      );
      latencyMs = Date.now() - started;
    } catch (err) {
      latencyMs = Date.now() - started;
      const code = err instanceof AiFailure ? err.code : "PROVIDER_ERROR";
      errorCode = code;
      status = classifyProbeFailure(code);
    }

    const recorded = await this.deps.store.recordVerification({ provider, status, fingerprint, errorCode, latencyMs });
    return {
      provider, status: recorded.status, verified: recorded.verified, errorCode: recorded.errorCode,
      latencyMs: recorded.latencyMs, fingerprint: recorded.fingerprint, route,
      model: defaultModel(provider, (k) => this.deps.env(k)), probedAt: this.now().toISOString(),
    };
  }

  // ── usage ───────────────────────────────────────────────────────────────────

  async usage(filter: { feature?: string | null; provider?: string | null; outcome?: string | null; since?: string | null; limit: number; before?: string | null }) {
    return this.deps.ledger.usage(filter);
  }

  async settingsSnapshot(): Promise<Record<string, string | null>> {
    return { [AI_ROUTE_SETTING]: await this.deps.store.setting(AI_ROUTE_SETTING) };
  }
}

function classifyProbeFailure(code: string): AiCredentialStatus {
  switch (code) {
    case "UPSTREAM_AUTH":
    case "RELAY_REJECTED_CREDENTIALS":
      return "INVALID_CREDENTIAL";
    case "UPSTREAM_QUOTA_EXHAUSTED":
      return "QUOTA_EXCEEDED";
    case "PROVIDER_TIMEOUT":
    case "UPSTREAM_TIMEOUT":
      return "NETWORK_ERROR";
    case "UPSTREAM_UNAVAILABLE":
      return "PROVIDER_UNAVAILABLE";
    case "PROVIDER_NOT_CONFIGURED":
    case "RELAY_NOT_CONFIGURED":
      return "UNVERIFIED";
    default:
      return "UNKNOWN";
  }
}

function assertSecretKey(key: string): AiSecretKey {
  const allowed: readonly AiSecretKey[] = ["GEMINI_API_KEY", "OPENAI_API_KEY", "GEMINI_RELAY_URL", "GEMINI_RELAY_TOKEN"];
  if (!(allowed as readonly string[]).includes(key)) throw new AiConfigValidationError("provider", "not a manageable secret key");
  return key as AiSecretKey;
}

function providerForSecretKey(key: AiSecretKey): AiCatalogProvider | null {
  if (key === "GEMINI_API_KEY") return "gemini";
  if (key === "OPENAI_API_KEY") return "openai";
  return null;
}
