// Environment-only AI secret resolution for processes outside the API trust boundary.
//
// In particular, the worker must never receive CREDENTIAL_MASTER_KEY or decrypt
// ai_platform_secrets (ADR-016 / worker D-2). This adapter has no dependency on
// credentialCrypto, CredentialStore, or a database-backed secret reader. It
// returns only an explicitly supplied process-environment value.
import type { AiSecretKey } from "./aiConfigStore.js";
import type { AiSecretResolver, SecretResolution } from "./aiSecrets.js";

export class EnvironmentAiSecretResolver implements AiSecretResolver {
  constructor(private readonly env: (key: string) => string | undefined) {}

  async resolve(key: AiSecretKey): Promise<SecretResolution> {
    const value = (this.env(key) ?? "").trim();
    return value === "" ? { value: null, source: null } : { value, source: "env" };
  }
}
