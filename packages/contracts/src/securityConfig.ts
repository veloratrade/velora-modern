// Security boot configuration — Phase B (S1/S2/S8), fail-closed.
//
// Pure, I/O-free policy module. It NEVER reads the environment itself and
// NEVER supplies a default secret or any fallback. Findings mirror the
// environment.ts contract style: rule codes + fixed messages; configured
// VALUES are never embedded in findings or errors.
//
//   SC-001  JWT_SECRET missing/empty where required         BLOCK (S1)
//   SC-002  JWT_SECRET below the minimum length             BLOCK (S1)
//   SC-003  PERSISTENCE not one of memory|postgres          BLOCK (S8)
//   SC-004  memory persistence outside development          BLOCK (S8)
//   SC-005  PERSISTENCE not explicit in staging/production  BLOCK (S8)
//   SC-006  postgres persistence without DATABASE_URL       BLOCK (S8)
//   SC-007  API_ALLOWED_ORIGINS not explicit in stg/prod    BLOCK (S2)
//   SC-008  development implicit memory persistence         WARN  (S8)
//   SC-009  development without JWT_SECRET                  WARN  (S1)
//
// Development allowances (non-security-sensitive only, per S2):
//   - PERSISTENCE may default to memory (SC-008 warns — the default is loud).
//   - JWT_SECRET may be absent (SC-009 warns; constructing the JWT service
//     without a secret still throws — there is no working fallback path).
//   - API_ALLOWED_ORIGINS may default to loopback (wired in kernel/boot.ts).

import type { EnvironmentName } from "./environment.js";

export type PersistenceKind = "memory" | "postgres";

/** Minimum JWT secret length in characters (OWASP-aligned for HS256). */
export const JWT_SECRET_MIN_CHARS = 32;

export type SecurityFindingCode =
  | "SC-001"
  | "SC-002"
  | "SC-003"
  | "SC-004"
  | "SC-005"
  | "SC-006"
  | "SC-007"
  | "SC-008"
  | "SC-009";

export type SecurityFindingSeverity = "BLOCK" | "WARN";

export interface SecurityFinding {
  readonly code: SecurityFindingCode;
  readonly severity: SecurityFindingSeverity;
  /** Fixed text — never embeds the configured value. */
  readonly message: string;
}

export interface PersistenceConfig {
  readonly kind: PersistenceKind;
  /** Present only for postgres persistence (validated non-empty). */
  readonly databaseUrl?: string;
}

export interface SecurityBootValidation {
  /** True only when no BLOCK-severity finding exists. */
  readonly valid: boolean;
  readonly findings: readonly SecurityFinding[];
  /** Non-null only when valid — callers must never use partial config. */
  readonly persistence: PersistenceConfig | null;
  /** Present only when supplied AND policy-compliant. Raw value, never mutated. */
  readonly jwtSecret: string | undefined;
}

/** The security-relevant subset of process environment variables. */
export interface SecurityBootEnv {
  readonly JWT_SECRET?: string | undefined;
  readonly PERSISTENCE?: string | undefined;
  readonly DATABASE_URL?: string | undefined;
  readonly API_ALLOWED_ORIGINS?: string | undefined;
}

function block(code: SecurityFindingCode, message: string): SecurityFinding {
  return { code, severity: "BLOCK", message };
}

function warn(code: SecurityFindingCode, message: string): SecurityFinding {
  return { code, severity: "WARN", message };
}

function parseCsv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Validate the security configuration for a KNOWN environment (parse the
 * environment identity first — ADR-013 EO-001 — before calling this).
 * Fail-closed: any BLOCK finding means the process must not start.
 */
export function validateSecurityBoot(
  env: SecurityBootEnv,
  environment: EnvironmentName,
): SecurityBootValidation {
  const findings: SecurityFinding[] = [];

  // --- JWT secret (S1) -----------------------------------------------------
  const rawSecret = env.JWT_SECRET;
  let jwtSecret: string | undefined;
  if (rawSecret === undefined || rawSecret.trim() === "") {
    if (environment === "development") {
      findings.push(
        warn(
          "SC-009",
          "JWT_SECRET is not set. Allowed in development only because no auth routes are active; the JWT service cannot be constructed without one (there is no fallback).",
        ),
      );
    } else {
      findings.push(
        block(
          "SC-001",
          "JWT_SECRET is missing or empty. Security configuration must be explicitly supplied; there is no fallback secret (S1).",
        ),
      );
    }
  } else if (rawSecret.length < JWT_SECRET_MIN_CHARS) {
    findings.push(
      block(
        "SC-002",
        `JWT_SECRET is shorter than ${JWT_SECRET_MIN_CHARS} characters; weak secrets are rejected (S1).`,
      ),
    );
  } else {
    jwtSecret = rawSecret; // raw value — never trimmed, never embedded in findings
  }

  // --- Persistence (S8) ----------------------------------------------------
  const rawPersistence = env.PERSISTENCE?.trim();
  let persistence: PersistenceConfig | null = null;
  if (rawPersistence === undefined || rawPersistence === "") {
    if (environment === "development") {
      findings.push(
        warn(
          "SC-008",
          "PERSISTENCE is not set — defaulting to memory for development only. Staging and production must set PERSISTENCE=postgres explicitly; memory persistence there is a startup failure.",
        ),
      );
      persistence = { kind: "memory" };
    } else {
      findings.push(
        block(
          "SC-005",
          "PERSISTENCE must be set explicitly (postgres) in staging and production; there is no implicit default (S8).",
        ),
      );
    }
  } else if (rawPersistence === "memory") {
    if (environment === "development") {
      persistence = { kind: "memory" };
    } else {
      findings.push(
        block(
          "SC-004",
          "PERSISTENCE=memory is a startup failure outside development: ephemeral persistence must never run in staging or production (S8).",
        ),
      );
    }
  } else if (rawPersistence === "postgres") {
    const databaseUrl = env.DATABASE_URL?.trim();
    if (databaseUrl === undefined || databaseUrl === "") {
      findings.push(
        block(
          "SC-006",
          "PERSISTENCE=postgres requires DATABASE_URL; missing durable-store configuration is a startup failure (S8).",
        ),
      );
    } else {
      persistence = { kind: "postgres", databaseUrl };
    }
  } else {
    findings.push(
      block("SC-003", "PERSISTENCE must be one of memory|postgres (exact, case-sensitive)."),
    );
  }

  // --- Origin allowlist (S2) ------------------------------------------------
  if (environment !== "development" && parseCsv(env.API_ALLOWED_ORIGINS).length === 0) {
    findings.push(
      block(
        "SC-007",
        "API_ALLOWED_ORIGINS must be set explicitly in staging and production; the loopback development default is not valid there (S2).",
      ),
    );
  }

  const valid = !findings.some((f) => f.severity === "BLOCK");
  return {
    valid,
    findings,
    persistence: valid ? persistence : null,
    jwtSecret: valid ? jwtSecret : undefined,
  };
}
