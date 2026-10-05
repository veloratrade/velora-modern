// Platform AI secrets — resolution, replacement and status, without ever
// returning a value.
//
// THE CAPABILITY (Legacy): an operator can put a Gemini/OpenAI key and an n8n
// relay URL+token into the system from the admin panel, and the running process
// picks them up WITHOUT a file edit or a redeploy. Legacy implements that with
// `SecureCredentialStore` (an encrypted `config/velora-secrets.json` under
// VELORA_PRIVATE_ROOT, 0600, atomic write) plus `RelayConfigResolver`, whose
// documented precedence is: admin-managed encrypted secret > process ENV >
// private velora.env > unavailable.
//
// THE MODERN SHAPE, AND WHY IT DIFFERS. Modern's rule is that PostgreSQL is
// authoritative and there is no second store, so the admin-managed secret lives
// in `ai_platform_secrets` as an AES-256-GCM envelope produced by the SAME
// `credentialCrypto` the user credential vault uses (0010's columns, 0028's
// table). Precedence keeps Legacy's order minus the file: **admin-managed
// envelope → process env → unavailable**. Dropping the private-file tier is
// recorded in the phase-7 capability map §3; keeping it would mean three places
// a secret can live and two of them outside the database.
//
// WHAT NEVER HAPPENS HERE
//   * a plaintext value is never returned to a caller that serves HTTP — the
//     status method reports `configured`, `source` and a fingerprint, and that
//     is all;
//   * a fingerprint is HMAC-SHA256 under the master key: non-reversible, and
//     stable enough that an operator can tell "same key" from "key replaced";
//   * no master key ⇒ no admin-managed secrets at all (fail closed). The env tier
//     still works, because an env value was never encrypted by us.
import {
  CredentialDecryptionError,
  decryptCredential,
  encryptCredential,
  type MasterKey,
} from "../credentials/credentialCrypto.js";
import { secretFingerprint, type AiConfigStore, type AiSecretKey } from "./aiConfigStore.js";

export type SecretSource = "admin" | "env" | null;

export interface SecretResolution {
  readonly value: string | null;
  readonly source: SecretSource;
}

/** What an HTTP surface may know about a secret. There is no value field. */
export interface SecretStatus {
  readonly key: AiSecretKey;
  readonly configured: boolean;
  readonly source: SecretSource;
  readonly fingerprint: string | null;
}

export class AiSecretMasterKeyMissingError extends Error {
  constructor() {
    super("CREDENTIAL_MASTER_KEY is not configured; admin-managed AI secrets are unavailable.");
    this.name = "AiSecretMasterKeyMissingError";
  }
}

/** 4 KB is Legacy's own cap on a managed value (`SecureCredentialStore`). */
export const MAX_SECRET_BYTES = 4096;

export class AiSecretValueInvalidError extends Error {
  constructor(readonly reason: "empty" | "too-large") {
    super(reason === "empty" ? "A secret value must not be empty." : "A secret value exceeds the managed size bound.");
    this.name = "AiSecretValueInvalidError";
  }
}

export class AiSecretService {
  constructor(
    private readonly deps: {
      readonly store: AiConfigStore;
      /** Null means "no master key": the admin tier is unavailable, fail closed. */
      readonly masterKey: MasterKey | null;
      readonly env: (key: string) => string | undefined;
    },
  ) {}

  /** Admin-managed envelope first, then the process environment. */
  async resolve(key: AiSecretKey): Promise<SecretResolution> {
    if (this.deps.masterKey !== null) {
      const envelope = await this.deps.store.readSecret(key);
      if (envelope !== null) {
        try {
          const value = decryptCredential(envelope, this.deps.masterKey);
          if (value !== "") return { value, source: "admin" };
        } catch (err) {
          // A row encrypted under a rotated key, or a tampered row, must not take
          // the process down and must not be reported as a configured secret.
          // The uniform decryption error carries no detail to leak; fall through
          // to the env tier, which is the documented next source.
          if (!(err instanceof CredentialDecryptionError)) throw err;
        }
      }
    }
    const fromEnv = (this.deps.env(key) ?? "").trim();
    return fromEnv === "" ? { value: null, source: null } : { value: fromEnv, source: "env" };
  }

  /** Status for an HTTP response: is it there, where from, and which value. */
  async status(key: AiSecretKey): Promise<SecretStatus> {
    const resolved = await this.resolve(key);
    if (resolved.value === null) return { key, configured: false, source: null, fingerprint: null };
    return {
      key,
      configured: true,
      source: resolved.source,
      fingerprint: this.deps.masterKey === null ? null : this.fingerprint(resolved.value),
    };
  }

  async statusAll(keys: readonly AiSecretKey[]): Promise<SecretStatus[]> {
    const out: SecretStatus[] = [];
    for (const key of keys) out.push(await this.status(key));
    return out;
  }

  /** Non-reversible, stable identifier for a value. Never the value. */
  fingerprint(plaintext: string): string {
    if (this.deps.masterKey === null) throw new AiSecretMasterKeyMissingError();
    return secretFingerprint(plaintext, this.deps.masterKey.material());
  }

  /**
   * Store a secret from the admin surface. The plaintext exists only inside this
   * call: it is encrypted, fingerprinted, and neither is returned.
   */
  async replace(key: AiSecretKey, plaintext: string, actorId: string | null): Promise<{ fingerprint: string }> {
    if (this.deps.masterKey === null) throw new AiSecretMasterKeyMissingError();
    const trimmed = plaintext.trim();
    if (trimmed === "") throw new AiSecretValueInvalidError("empty");
    // A key, a URL or a token is never longer than the bound; the bound is what
    // stops this endpoint from becoming a general-purpose blob store.
    if (Buffer.byteLength(trimmed, "utf8") > MAX_SECRET_BYTES) throw new AiSecretValueInvalidError("too-large");
    const envelope = encryptCredential(trimmed, this.deps.masterKey);
    await this.deps.store.writeSecret(key, envelope, actorId);
    return { fingerprint: this.fingerprint(trimmed) };
  }

  async remove(key: AiSecretKey): Promise<boolean> {
    return this.deps.store.deleteSecret(key);
  }
}
