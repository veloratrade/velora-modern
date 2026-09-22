// Credential master-key configuration (C-22) — fail-closed, environment-only.
//
// Mirrors the existing securityConfig.ts convention: a pure function over an
// env record, returning coded findings whose messages NEVER embed the
// configured value. It performs no I/O and holds no default.
//
// THE KEY IS NEVER INVENTED. There is deliberately no generated fallback: a
// key minted at startup would be lost on restart, making every previously
// stored credential permanently undecryptable while appearing to work. A
// missing or malformed key is therefore a hard configuration error, not a
// degraded mode — and there is no plaintext fallback path anywhere.
//
//   CR-001  CREDENTIAL_MASTER_KEY missing/empty          BLOCK
//   CR-002  CREDENTIAL_MASTER_KEY malformed/wrong length BLOCK
//   CR-003  CREDENTIAL_MASTER_KEY_VERSION invalid        BLOCK
import { MasterKey, CredentialKeyError } from "./credentialCrypto.js";

export type CredentialFindingCode = "CR-001" | "CR-002" | "CR-003";

export interface CredentialFinding {
  readonly code: CredentialFindingCode;
  /** Fixed text — never embeds the configured value. */
  readonly message: string;
}

export interface CredentialEnv {
  readonly CREDENTIAL_MASTER_KEY?: string | undefined;
  readonly CREDENTIAL_MASTER_KEY_VERSION?: string | undefined;
}

export interface CredentialKeyResolution {
  /** Present only when the configuration is fully valid. */
  readonly key: MasterKey | null;
  readonly findings: readonly CredentialFinding[];
}

/**
 * Resolve the master key from environment values.
 *
 * Returns findings instead of throwing so a caller can decide the posture:
 * the composition root treats any finding as "credential capability
 * unavailable" (fail-closed) rather than starting with encryption disabled.
 */
export function resolveCredentialKey(env: CredentialEnv): CredentialKeyResolution {
  const raw = env.CREDENTIAL_MASTER_KEY;
  if (raw === undefined || raw.trim() === "") {
    return {
      key: null,
      findings: [
        {
          code: "CR-001",
          message:
            "CREDENTIAL_MASTER_KEY is not set. The encrypted credential store cannot operate without it; it is never generated automatically.",
        },
      ],
    };
  }

  const rawVersion = env.CREDENTIAL_MASTER_KEY_VERSION;
  let version = 1;
  if (rawVersion !== undefined && rawVersion.trim() !== "") {
    const parsed = Number(rawVersion.trim());
    if (!Number.isInteger(parsed) || parsed < 1) {
      return {
        key: null,
        findings: [
          {
            code: "CR-003",
            message: "CREDENTIAL_MASTER_KEY_VERSION must be an integer greater than or equal to 1.",
          },
        ],
      };
    }
    version = parsed;
  }

  try {
    return { key: MasterKey.fromBase64(raw, version), findings: [] };
  } catch (err: unknown) {
    // The CredentialKeyError message is a fixed string by construction; it
    // never contains the supplied value, so it is safe to surface.
    const message =
      err instanceof CredentialKeyError
        ? err.message
        : "CREDENTIAL_MASTER_KEY is invalid.";
    return { key: null, findings: [{ code: "CR-002", message }] };
  }
}
