// Environment-origin safety contract — ADR-013 (owner decision D-17, 2026-09-12).
//
// Pure, I/O-free validation binding an explicit environment identity to an
// explicit application origin. FAIL-CLOSED:
//   EO-001  APP_ENV missing/unknown        BLOCK — no implicit default; unknown never trusted
//   EO-002  APP_ORIGIN missing/empty       BLOCK — no implicit default
//   EO-003  unparseable origin             BLOCK
//   EO-004  non-https (outside dev loopback) BLOCK
//   EO-005  non-bare origin                BLOCK — no path/slash/query/fragment/credentials
//   EO-006  non-default port (outside dev loopback) BLOCK
//   EO-007  cross-environment binding      BLOCK — non-production env using a production origin
//   EO-008  staging without decided canonical origin BLOCK — OD-1 open ⇒ staging unvalidatable
//   EO-009  origin not in canonical set    BLOCK
//   EO-010  development non-loopback       WARN
//
// Secret safety: findings carry rule codes and fixed messages only — origin
// VALUES are never embedded in findings (mirrors the Reference guard's
// never-print-the-value property). Canonical origin maps are supplied by the
// caller; no staging origin is hardcoded here (ADR-013 OD-1 pending).

export type EnvironmentName = "development" | "staging" | "production";

export const ENVIRONMENT_NAMES: readonly EnvironmentName[] = [
  "development",
  "staging",
  "production",
];

/**
 * Parse an explicit environment identity.
 * Missing, empty, or unknown values return null — there is NO default.
 * (Stricter than the Reference, whose config defaulted APP_ENV to production.)
 */
export function parseEnvironment(
  value: string | null | undefined,
): EnvironmentName | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return (ENVIRONMENT_NAMES as readonly string[]).includes(v)
    ? (v as EnvironmentName)
    : null;
}

/** Canonical application-origin sets per non-development environment. */
export interface CanonicalOrigins {
  /** Production origins (owner-fixed; carried from the PHP system — ADR-013). */
  readonly production: readonly string[];
  /**
   * Staging origins. ABSENT/empty until owner decision OD-1 is recorded —
   * staging cannot be validated (EO-008) until then, by design.
   */
  readonly staging?: readonly string[];
}

export type OriginFindingCode =
  | "EO-001"
  | "EO-002"
  | "EO-003"
  | "EO-004"
  | "EO-005"
  | "EO-006"
  | "EO-007"
  | "EO-008"
  | "EO-009"
  | "EO-010";

export type OriginFindingSeverity = "BLOCK" | "WARN";

export interface OriginFinding {
  readonly code: OriginFindingCode;
  readonly severity: OriginFindingSeverity;
  /** Fixed text — never embeds the configured origin value. */
  readonly message: string;
}

export interface EnvironmentOriginValidation {
  /** True only when no BLOCK-severity finding exists. */
  readonly valid: boolean;
  readonly environment: EnvironmentName | null;
  readonly findings: readonly OriginFinding[];
}

function block(code: OriginFindingCode, message: string): OriginFinding {
  return { code, severity: "BLOCK", message };
}

function hostsOf(origins: readonly string[] | undefined): string[] {
  return (origins ?? [])
    .map((o) => {
      try {
        return new URL(o).hostname.toLowerCase();
      } catch {
        return "";
      }
    })
    .filter((h) => h !== "");
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.startsWith("[::1]")
  );
}

/**
 * Validate the environment-identity ↔ application-origin binding (ADR-013).
 *
 * The four forbidden cases (owner directive 2026-09-12) all fail closed:
 *   staging intent → production origin        (EO-007)
 *   production intent → staging origin        (EO-009)
 *   unknown environment → trusted origin      (EO-001 — env checked first)
 *   missing origin → implicit default         (EO-002)
 */
export function validateEnvironmentOrigin(
  rawEnvironment: string | null | undefined,
  rawOrigin: string | null | undefined,
  canonical: CanonicalOrigins,
): EnvironmentOriginValidation {
  const findings: OriginFinding[] = [];

  // Environment identity first: an unknown environment must never be
  // validated against a trusted origin map.
  const environment = parseEnvironment(rawEnvironment);
  if (environment === null) {
    findings.push(
      block(
        "EO-001",
        "APP_ENV is missing or not one of development|staging|production. Environment identity must be explicit; unknown environments are never trusted and there is no implicit default (ADR-013).",
      ),
    );
    return { valid: false, environment: null, findings };
  }

  if (typeof rawOrigin !== "string" || rawOrigin.trim() === "") {
    findings.push(
      block(
        "EO-002",
        "APP_ORIGIN is missing or empty. The application origin must be explicit; there is no implicit default (ADR-013).",
      ),
    );
    return { valid: false, environment, findings };
  }

  const raw = rawOrigin.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    findings.push(
      block("EO-003", "APP_ORIGIN is not parseable as an absolute URL."),
    );
    return { valid: false, environment, findings };
  }

  const loopback = isLoopback(url.hostname);

  // EO-004 — https everywhere; http only for loopback in development.
  if (url.protocol !== "https:" && !(environment === "development" && loopback)) {
    findings.push(
      block(
        "EO-004",
        "APP_ORIGIN scheme must be https (http is allowed only for loopback origins in development).",
      ),
    );
  }

  // EO-005 — bare origin: the raw value must be exactly `protocol//host`.
  // This single check rejects paths, trailing slashes, queries, fragments,
  // and embedded credentials (they all make raw ≠ protocol//host).
  const bare = `${url.protocol}//${url.host}`;
  if (raw.toLowerCase() !== bare.toLowerCase()) {
    findings.push(
      block(
        "EO-005",
        "APP_ORIGIN must be a bare origin: no path, no trailing slash, no query, no fragment, no embedded credentials.",
      ),
    );
  }

  // EO-006 — no non-default ports outside development loopback.
  if (url.port !== "" && url.port !== "443") {
    if (!(environment === "development" && loopback)) {
      findings.push(
        block(
          "EO-006",
          "APP_ORIGIN must not specify a non-default port outside development loopback.",
        ),
      );
    }
  }

  const host = url.hostname.toLowerCase();
  const productionHosts = hostsOf(canonical.production);
  const stagingHosts = hostsOf(canonical.staging);

  // EO-007 — cross-environment: any non-production environment pointing at a
  // production origin. This is the "staging intent → production origin" case:
  // verification emails, tokens, and links would act on production.
  if (environment !== "production" && productionHosts.includes(host)) {
    findings.push(
      block(
        "EO-007",
        "Cross-environment binding: a non-production environment must not use a production origin. Links, tokens, and emails would act on production (ADR-013).",
      ),
    );
  }

  if (environment === "staging") {
    if (stagingHosts.length === 0) {
      // Fail closed while OD-1 (canonical staging origin) is undecided.
      findings.push(
        block(
          "EO-008",
          "No canonical staging origin has been decided (ADR-013 OD-1, owner decision required). Staging cannot be validated — and must not be operated — until one is recorded.",
        ),
      );
    } else if (!stagingHosts.includes(host)) {
      findings.push(
        block(
          "EO-009",
          "APP_ORIGIN does not match the canonical staging origin set for this environment.",
        ),
      );
    }
  }

  // EO-009 — production must match the canonical production set exactly.
  // (Also covers "production intent → staging origin".)
  if (environment === "production" && !productionHosts.includes(host)) {
    findings.push(
      block(
        "EO-009",
        "APP_ORIGIN does not match the canonical production origin set.",
      ),
    );
  }

  // EO-010 — advisory only.
  if (environment === "development" && !loopback) {
    findings.push({
      code: "EO-010",
      severity: "WARN",
      message:
        "Development APP_ORIGIN is not a loopback address — verify this is intentional.",
    });
  }

  const valid = !findings.some((f) => f.severity === "BLOCK");
  return { valid, environment, findings };
}
