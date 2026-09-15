// MetaAPI platform-token configuration (ADR-014 / D-19) — environment-only.
//
// Mirrors credentialConfig.ts: a pure function over an env record returning
// coded findings whose messages NEVER embed the configured value. No I/O, no
// default token, no generated fallback.
//
//   MA-001  METAAPI_PLATFORM_TOKEN missing/empty        capability unavailable
//   MA-002  METAAPI_PLATFORM_TOKEN malformed            capability unavailable
//   MA-003  METAAPI_BASE_URL not an absolute https URL  capability unavailable
//
// HOW THIS DIFFERS FROM THE MASTER KEY, AND WHY
//   A missing CREDENTIAL_MASTER_KEY is a hard configuration error: stored
//   ciphertext becomes undecryptable, so there is no safe degraded mode. A
//   missing MetaAPI token is different in kind — the capability is simply
//   ABSENT. Per ADR-014 §5 the API MUST NOT crash at boot because of it, and it
//   MUST NOT appear in /ready: MetaAPI is a third-party integration, and
//   letting a provider configuration gap take down authentication and trades
//   would be a behavioural regression.
//
//   These are three distinct secrets with three distinct owners (ADR-014 §1):
//   CREDENTIAL_MASTER_KEY protects the credential store, METAAPI_PLATFORM_TOKEN
//   authenticates Velora to MetaAPI, and a user's broker password authenticates
//   that user's account. This module touches only the second, and MUST NOT be
//   used to resolve either of the others.

/** Finding codes are fixed identifiers, safe to log. */
export type MetaApiFindingCode = "MA-001" | "MA-002" | "MA-003";

export interface MetaApiFinding {
  readonly code: MetaApiFindingCode;
  /** Fixed text — never embeds the configured value. */
  readonly message: string;
}

export interface MetaApiEnv {
  readonly METAAPI_PLATFORM_TOKEN?: string | undefined;
  readonly METAAPI_BASE_URL?: string | undefined;
}

/**
 * Resolved MetaAPI configuration.
 *
 * The token is carried as an opaque holder rather than a bare string so it is
 * awkward to log or serialize by accident: `toJSON` and `toString` are
 * overridden to reveal nothing. This is friction, not encryption — a caller
 * that truly wants the value can still call `reveal()`, which is exactly the
 * single reviewable choke point we want.
 */
export class PlatformToken {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The only way to obtain the raw token. Call sites are the audit surface. */
  reveal(): string {
    return this.#value;
  }

  /** Defeats accidental disclosure via JSON.stringify of a config object. */
  toJSON(): string {
    return "[redacted]";
  }

  /** Defeats accidental disclosure via string interpolation. */
  toString(): string {
    return "[redacted]";
  }
}

export interface MetaApiResolution {
  /** Present only when the configuration is fully valid. */
  readonly token: PlatformToken | null;
  /** Present only when the configuration is fully valid. */
  readonly baseUrl: string | null;
  readonly findings: readonly MetaApiFinding[];
  /** True when MetaAPI may be constructed. Safe to log. */
  readonly configured: boolean;
}

/**
 * ADR-014 §5: no silently guessed host. This is the explicit, reviewed constant
 * the ADR permits — it is the documented public MetaAPI endpoint, contains no
 * secret, and is overridden by METAAPI_BASE_URL when supplied.
 */
export const DEFAULT_METAAPI_BASE_URL = "https://mt-client-api-v1.new-york.agiliumtrade.ai";

/** Rejects whitespace and C0/C1 control characters anywhere in the token. */
function isMalformedToken(raw: string): boolean {
  for (const ch of raw) {
    const c = ch.codePointAt(0)!;
    if (c <= 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) return true;
  }
  return false;
}

function absoluteHttpsUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  // https only: the platform token is a bearer credential, so a plaintext or
  // non-web scheme would expose it in transit.
  if (parsed.protocol !== "https:") return null;
  // Normalise away a trailing slash so callers can join paths predictably.
  return parsed.href.replace(/\/+$/, "");
}

/**
 * Resolve MetaAPI configuration from environment values.
 *
 * Returns findings instead of throwing: the composition root treats any finding
 * as "MetaAPI capability unavailable" and continues booting (ADR-014 §5).
 */
export function resolveMetaApiConfig(env: MetaApiEnv): MetaApiResolution {
  const unavailable = (finding: MetaApiFinding): MetaApiResolution => ({
    token: null,
    baseUrl: null,
    findings: [finding],
    configured: false,
  });

  const raw = env.METAAPI_PLATFORM_TOKEN;
  if (raw === undefined || raw.trim() === "") {
    return unavailable({
      code: "MA-001",
      message:
        "METAAPI_PLATFORM_TOKEN is not set. The MetaAPI capability is unavailable; it is never generated automatically.",
    });
  }

  // Compared against the untrimmed value: surrounding whitespace in a bearer
  // token is a configuration error worth surfacing, not silently repairing.
  if (isMalformedToken(raw)) {
    return unavailable({
      code: "MA-002",
      message:
        "METAAPI_PLATFORM_TOKEN is malformed: it must not contain whitespace or control characters.",
    });
  }

  const rawBase = env.METAAPI_BASE_URL;
  let baseUrl = DEFAULT_METAAPI_BASE_URL;
  if (rawBase !== undefined && rawBase.trim() !== "") {
    const normalized = absoluteHttpsUrl(rawBase.trim());
    if (normalized === null) {
      return unavailable({
        code: "MA-003",
        message: "METAAPI_BASE_URL must be an absolute https:// URL.",
      });
    }
    baseUrl = normalized;
  }

  return { token: new PlatformToken(raw), baseUrl, findings: [], configured: true };
}
