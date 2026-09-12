// Boot gate — deterministic fail-closed startup validation. Phase B (S2/S8).
//
// Assembles the accepted contracts into the process entrypoint policy:
//   1. Environment identity + origin binding (ADR-013, EO-001…EO-010) —
//      APP_ENV and APP_ORIGIN are EXPLICIT (no implicit defaults), origins
//      are https and bare, cross-environment bindings are blocked, and
//      production/staging only boot on owner-declared canonical origins
//      (CANONICAL_PRODUCTION_ORIGINS / CANONICAL_STAGING_ORIGINS, CSV).
//      Production with no declared canonical set cannot boot — fail-closed
//      by design (no production host is decided; Gate 3B is BLOCKED).
//   2. Security configuration (S1/S2/S8, SC-001…SC-009) — JWT secret,
//      persistence policy, origin allowlist.
//
// Pure function over an env record: fully unit-testable, no I/O. Throws
// BootError listing EVERY finding when any BLOCK exists; the entrypoint
// (server-main.ts) logs the codes/messages (never values) and exits 1.
import {
  validateEnvironmentOrigin,
  validateSecurityBoot,
  type CanonicalOrigins,
  type EnvironmentName,
  type PersistenceKind,
} from "@velora/contracts";

export interface BootFinding {
  readonly code: string;
  readonly severity: "BLOCK" | "WARN";
  readonly message: string;
}

export interface BootConfig {
  readonly environment: EnvironmentName;
  readonly port: number;
  readonly appOrigin: string;
  readonly allowedOrigins: readonly string[];
  readonly persistence: { readonly kind: PersistenceKind; readonly databaseUrl?: string };
  readonly jwtSecret?: string;
  /** Non-blocking findings (SC-008/009 development allowances, EO-010…). */
  readonly warnings: readonly BootFinding[];
}

export class BootError extends Error {
  constructor(readonly findings: readonly BootFinding[]) {
    const blocking = findings.filter((f) => f.severity === "BLOCK").map((f) => f.code);
    super(`boot blocked: ${blocking.join(", ")}`);
    this.name = "BootError";
  }
}

function parseCsv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Validate the complete boot configuration. Throws BootError on any BLOCK
 * finding; returns the validated config otherwise.
 */
export function assertBootable(env: Record<string, string | undefined>): BootConfig {
  const canonical: CanonicalOrigins = {
    production: parseCsv(env.CANONICAL_PRODUCTION_ORIGINS),
    staging: parseCsv(env.CANONICAL_STAGING_ORIGINS),
  };

  // 1. Environment identity + origin binding (ADR-013).
  const eo = validateEnvironmentOrigin(env.APP_ENV, env.APP_ORIGIN, canonical);
  const eoFindings: BootFinding[] = eo.findings.map((f) => ({
    code: f.code,
    severity: f.severity,
    message: f.message,
  }));
  if (eo.environment === null) {
    // Unknown environment identity: never validated against trusted config.
    throw new BootError(eoFindings);
  }
  const environment = eo.environment;

  // 2. Security configuration (S1/S2/S8).
  const security = validateSecurityBoot(env, environment);
  const allFindings: BootFinding[] = [
    ...eoFindings,
    ...security.findings.map((f) => ({ code: f.code, severity: f.severity, message: f.message })),
  ];

  // 3. Port (non-security, but invalid values still fail startup deterministically).
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    allFindings.push({
      code: "BOOT-001",
      severity: "BLOCK",
      message: "PORT must be an integer between 1 and 65535 (default 8080).",
    });
  }

  const blocking = allFindings.filter((f) => f.severity === "BLOCK");
  if (blocking.length > 0 || !security.valid) {
    throw new BootError(allFindings);
  }
  const persistence = security.persistence;
  if (persistence === null) {
    // Unreachable when valid (persistence is non-null on every valid path).
    throw new BootError(allFindings);
  }

  const appOrigin = env.APP_ORIGIN;
  if (appOrigin === undefined) {
    // Unreachable: EO-002 blocks a missing origin before this point.
    throw new BootError(eoFindings);
  }

  // Dev-only loopback default for the origin allowlist (SC-007 blocks
  // staging/production without an explicit allowlist; never reached there).
  const explicitOrigins = parseCsv(env.API_ALLOWED_ORIGINS);
  const allowedOrigins =
    explicitOrigins.length > 0 ? explicitOrigins : [`http://127.0.0.1:${port}`];

  return {
    environment,
    port,
    appOrigin,
    allowedOrigins,
    persistence,
    ...(security.jwtSecret !== undefined ? { jwtSecret: security.jwtSecret } : {}),
    warnings: allFindings.filter((f) => f.severity === "WARN"),
  };
}
