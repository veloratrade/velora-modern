// The AI catalog — vocabulary and provider facts, in ONE place.
//
// WHY THIS FILE EXISTS. Legacy keeps this in `AI/Services/ProviderCatalog.php`
// and `AI/Providers/ProviderCapability.php`: which features exist, which
// capability each feature needs, which providers exist, which models each one
// admits, which route values are legal for it, and what it costs. Those are
// boundary facts, not business logic, and scattering them across services is how
// a provider that cannot do vision ends up in a vision chain.
//
// WHAT IS COPIED AND WHAT IS NOT. The feature names, provider names, model
// allowlists, route values and capability names are Legacy's own identifiers,
// carried over verbatim so a configuration row means the same thing in both
// systems and so an operator migrating from the old panel recognises every
// value. The PHP class/registry structure is NOT copied: there is no provider
// class map here, because Modern injects implementations through a port
// (`AiProvider` in ../aicoach/aiProvider.ts) instead of instantiating by name.
//
// ONE DELIBERATE OMISSION: Legacy also ships a `claude` provider. Modern's
// ledger vocabulary (0017, widened by 0028) admits openai | gemini | tesseract,
// and there is no Anthropic transport in this repository. Declaring a provider
// Modern cannot call would put a fabricated option in an operator's dropdown, so
// it is left out and recorded in the phase-7 capability map §3.
import type { AiProviderName } from "../aicoach/aiProvider.js";

/** The provider names the schema admits (0028's closed CHECK). */
export const AI_PROVIDER_NAMES = ["openai", "gemini", "tesseract"] as const;
export type AiCatalogProvider = (typeof AI_PROVIDER_NAMES)[number];

/** How a provider is reached. Legacy `AiRouteResolver::ROUTE_*`. */
export const AI_ROUTES = ["direct", "n8n_relay"] as const;
export type AiRoute = (typeof AI_ROUTES)[number];

/**
 * What a provider can be asked to do. Legacy `ProviderCapability::all()`,
 * minus the three names nothing in either system ever declares
 * (`recommendations`, `memory`) — a capability no provider holds and no feature
 * requires is noise in an operator's dropdown.
 */
export const AI_CAPABILITIES = ["vision", "text", "analysis", "chat", "extraction", "ocr", "reports"] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];

/**
 * The features a chain can be configured for.
 *
 * The first four are Legacy's `ProviderCatalog::FEATURES`; the rest are the
 * features Modern's ledger already discriminates (0023) plus the two support
 * console features Legacy put in its AI module (`SupportController::translate`
 * and `::copilot`), which phase 5 recorded as open with the AI phase as owner.
 */
export const AI_FEATURES = [
  "screenshot_extraction",
  "trade_analysis",
  "weekly_report",
  "assistant",
  "coach",
  "transcribe",
  "vision_extract",
  "translate",
  "copilot",
] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/**
 * The ledger's `feature` vocabulary (0028's CHECK). It is NOT the same list as
 * AI_FEATURES: the ledger records what a call WAS (including `ocr` and
 * `journal_extract`), while AI_FEATURES names what can be ROUTED. Keeping the
 * two apart is what stops a routing name from silently becoming a ledger name.
 */
export const AI_LEDGER_FEATURES = [
  "coach",
  "journal_extract",
  "transcribe",
  "vision_extract",
  "analysis",
  "report",
  "assistant",
  "ocr",
  "translate",
  "copilot",
] as const;
export type AiLedgerFeature = (typeof AI_LEDGER_FEATURES)[number];

/** The runtime flags, exactly as Legacy's `AIFeatureFlagRepository::CANONICAL_FLAGS`. */
export const AI_FLAGS = [
  "ai_screenshot_extraction",
  "ai_trade_analysis",
  "ai_weekly_report",
  "ai_assistant",
] as const;
export type AiFlag = (typeof AI_FLAGS)[number];

/** Which flag gates which feature. Legacy pairs them in AIController. */
export const FEATURE_FLAG: Readonly<Record<string, AiFlag>> = {
  screenshot_extraction: "ai_screenshot_extraction",
  trade_analysis: "ai_trade_analysis",
  weekly_report: "ai_weekly_report",
  assistant: "ai_assistant",
};

export interface ProviderDefinition {
  /** Env key NAMES only. A value never appears in this file. */
  readonly credentialKeys: readonly string[];
  /** Env key names for the Gemini relay (Legacy `relayKeys`). */
  readonly relayKeys: readonly string[];
  readonly modelEnvKey: string | null;
  readonly models: readonly string[];
  readonly defaultModel: string | null;
  readonly routes: readonly (AiRoute | null)[];
  readonly capabilities: readonly AiCapability[];
  /** Legacy's cost tier: 0 = free/local, 1 = cheap, 2 = paid. */
  readonly costTier: 0 | 1 | 2;
  /** True when the provider runs on this machine and needs no credential. */
  readonly local: boolean;
}

export const PROVIDERS: Readonly<Record<AiCatalogProvider, ProviderDefinition>> = {
  gemini: {
    credentialKeys: ["GEMINI_API_KEY"],
    relayKeys: ["GEMINI_RELAY_URL", "GEMINI_RELAY_TOKEN"],
    modelEnvKey: "GEMINI_MODEL",
    models: ["gemini-3.6-flash", "gemini-3.6-pro", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    defaultModel: "gemini-3.6-flash",
    routes: ["direct", "n8n_relay", null],
    capabilities: ["vision", "text", "extraction", "analysis", "chat"],
    costTier: 0,
    local: false,
  },
  openai: {
    credentialKeys: ["OPENAI_API_KEY"],
    relayKeys: [],
    modelEnvKey: "OPENAI_MODEL",
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o", "gpt-4o-mini"],
    defaultModel: "gpt-5-mini",
    routes: ["direct", null],
    capabilities: ["vision", "text", "extraction"],
    costTier: 2,
    local: false,
  },
  tesseract: {
    credentialKeys: [],
    relayKeys: [],
    modelEnvKey: null,
    models: [],
    defaultModel: null,
    // The local OCR fallback has no route concept and needs no credential. It
    // is the reason a screenshot still yields text when Google is unreachable,
    // region-blocked or out of quota.
    routes: [null],
    capabilities: ["ocr", "text"],
    costTier: 0,
    local: true,
  },
};

/**
 * The capability a feature requires.
 *
 * Legacy declares this twice and the two disagree: `ProviderCatalog::FEATURE_CAPABILITY`
 * maps every text feature to `text`, while `TradeAnalyzerService` passes
 * `capability: 'analysis'` and `WeeklyReportService` passes `'reports'` as call
 * options — and NO provider in Legacy declares `reports`, so the weekly report's
 * chain resolves empty and the route can only fail. That is a Legacy defect, not
 * a capability. Modern derives the requirement from the feature in ONE place
 * (this map), so a per-call string cannot contradict it, and the weekly report
 * is reachable by every provider that can read text.
 */
export const FEATURE_CAPABILITY: Readonly<Record<AiFeature, AiCapability | null>> = {
  screenshot_extraction: null, // no filter: the local OCR provider must qualify
  trade_analysis: "text",
  weekly_report: "text",
  assistant: "text",
  coach: "text",
  transcribe: "text",
  vision_extract: "vision",
  translate: "text",
  copilot: "text",
};

export function isAiProvider(value: unknown): value is AiCatalogProvider {
  return typeof value === "string" && (AI_PROVIDER_NAMES as readonly string[]).includes(value);
}

export function isAiRoute(value: unknown): value is AiRoute {
  return typeof value === "string" && (AI_ROUTES as readonly string[]).includes(value);
}

export function isAiFeature(value: unknown): value is AiFeature {
  return typeof value === "string" && (AI_FEATURES as readonly string[]).includes(value);
}

/**
 * Is `model` a legal choice for `provider`? NULL/empty means "the provider's own
 * default", which is always legal (Legacy `ProviderCatalog::isValidModel`).
 */
export function isValidModel(provider: AiCatalogProvider, model: string | null | undefined): boolean {
  if (model === null || model === undefined || model.trim() === "") return true;
  return PROVIDERS[provider].models.includes(model.trim());
}

/** Is `route` legal for `provider`? (Legacy `ProviderCatalog::isValidRoute`.) */
export function isValidRoute(provider: AiCatalogProvider, route: string | null | undefined): boolean {
  const allowed = PROVIDERS[provider].routes;
  if (route === null || route === undefined || route === "") return allowed.includes(null);
  return (allowed as readonly (string | null)[]).includes(String(route).toLowerCase().trim());
}

/**
 * The effective default model: an env override wins over the catalog default,
 * exactly as Legacy's `ProviderCatalog::defaultModel` does. `tesseract` has no
 * model concept and returns null.
 */
export function defaultModel(provider: AiCatalogProvider, env: (key: string) => string | undefined): string | null {
  const def = PROVIDERS[provider];
  if (def.modelEnvKey !== null) {
    const fromEnv = (env(def.modelEnvKey) ?? "").trim();
    if (fromEnv !== "") return fromEnv;
  }
  return def.defaultModel;
}

/** Narrow the catalog provider name to the ledger's provider vocabulary. */
export function asLedgerProvider(provider: AiCatalogProvider): AiProviderName | "tesseract" {
  return provider;
}
