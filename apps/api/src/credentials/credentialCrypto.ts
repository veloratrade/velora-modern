// CredentialCrypto — authenticated encryption for stored third-party secrets
// (C-22). Node's built-in `node:crypto` only: no new dependency, no custom
// cryptography, no hand-rolled construction.
//
// ALGORITHM: AES-256-GCM.
//   - Confidentiality AND integrity/authentication in one standard primitive.
//   - A 16-byte authentication tag is verified on every decrypt, so any
//     modification of the ciphertext, the tag, or the authenticated metadata
//     makes decryption FAIL rather than return corrupted plaintext.
//   - A fresh 12-byte CSPRNG nonce (the size recommended for GCM) is generated
//     per encryption, so encrypting the same secret twice yields different
//     ciphertext. Nonce reuse under one key breaks GCM catastrophically, which
//     is why the nonce is never derived, never counted, and never reused, and
//     why migration 0010 additionally enforces UNIQUE (key_version, iv).
//
// ENVELOPE (versioned, rotation-ready):
//   version | keyVersion | algorithm | iv | ciphertext | authTag
//   `version` is the envelope FORMAT version; `keyVersion` identifies WHICH
//   master key was used. Both are bound into the AAD (below), so neither can
//   be altered after the fact without failing authentication.
//
// AAD (additional authenticated data): `v<version>:k<keyVersion>:aes-256-gcm`.
//   These fields are stored in their own columns and are therefore modifiable
//   by anyone who can write the row. Binding them into the AAD means a
//   tampered enc_version/key_version/algorithm causes an authentication
//   failure instead of a silent downgrade or a confused decrypt.
//
// WHAT THIS MODULE DOES NOT DO:
//   - It never logs. Not the key, not the plaintext, not the ciphertext.
//   - Its errors are FIXED strings. No error carries key material, plaintext,
//     ciphertext, IV, tag, user id or provider (mirroring the securityConfig.ts
//     convention that findings never embed configured values).
//   - It does not read the environment: the key is injected by the caller, so
//     this module stays pure and unit-testable.
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/** Envelope format version. Bump only on a breaking format change. */
export const CREDENTIAL_ENVELOPE_VERSION = 1;
/** The single pinned algorithm for this version. */
export const CREDENTIAL_ALGORITHM = "aes-256-gcm";
/** AES-256 key length in bytes. */
export const MASTER_KEY_BYTES = 32;
/** GCM nonce length in bytes (96-bit, the recommended size). */
const IV_BYTES = 12;
/** GCM authentication tag length in bytes. */
const AUTH_TAG_BYTES = 16;

/**
 * A decryption-capable master key. The raw bytes are held in a Buffer and are
 * never serialized: `toJSON`/`toString` are deliberately overridden so an
 * accidental `JSON.stringify(key)` or string interpolation in a log line
 * cannot leak key material.
 */
export class MasterKey {
  readonly version: number;
  /** @internal - the raw key bytes. Never expose, never serialize. */
  private readonly bytes: Buffer;

  private constructor(version: number, bytes: Buffer) {
    this.version = version;
    this.bytes = bytes;
  }

  /**
   * Parse and VALIDATE a base64-encoded 32-byte key. Fail-closed: every
   * rejection throws CredentialKeyError with a fixed message that never
   * contains the supplied value.
   *
   * Base64 is required (not hex, not raw text) so the representation is
   * unambiguous, and the decoded length is checked exactly — a short or
   * malformed value can never be stretched into a "working" key.
   *
   * There is deliberately NO key-derivation function here: hashing an
   * arbitrary passphrase into a key would silently accept weak operator input
   * and give a false sense of strength. No existing ADR or convention requires
   * a KDF, so the key must be real 256-bit random material.
   */
  static fromBase64(raw: string | undefined, version = 1): MasterKey {
    if (raw === undefined || raw.trim() === "") {
      throw new CredentialKeyError("CREDENTIAL_MASTER_KEY is missing or empty.");
    }
    const value = raw.trim();
    // Strict base64: reject anything that is not canonical base64 before
    // decoding, because Buffer.from(..., "base64") silently ignores garbage.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      throw new CredentialKeyError("CREDENTIAL_MASTER_KEY is not valid base64.");
    }
    let decoded: Buffer;
    try {
      decoded = Buffer.from(value, "base64");
    } catch {
      throw new CredentialKeyError("CREDENTIAL_MASTER_KEY is not valid base64.");
    }
    // Round-trip check: catches values that decode "successfully" but are not
    // a faithful base64 encoding of the resulting bytes.
    if (decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
      throw new CredentialKeyError("CREDENTIAL_MASTER_KEY is not valid base64.");
    }
    if (decoded.length !== MASTER_KEY_BYTES) {
      throw new CredentialKeyError(
        `CREDENTIAL_MASTER_KEY must decode to exactly ${MASTER_KEY_BYTES} bytes.`,
      );
    }
    // An all-zero key is a placeholder, never a real key.
    if (decoded.every((b) => b === 0)) {
      throw new CredentialKeyError("CREDENTIAL_MASTER_KEY must not be all zero bytes.");
    }
    if (!Number.isInteger(version) || version < 1) {
      throw new CredentialKeyError("CREDENTIAL_MASTER_KEY_VERSION must be an integer >= 1.");
    }
    return new MasterKey(version, decoded);
  }

  /** @internal - for the cipher only. */
  material(): Buffer {
    return this.bytes;
  }

  /** Constant-time comparison, used only by tests asserting key identity. */
  equals(other: MasterKey): boolean {
    return (
      this.bytes.length === other.bytes.length && timingSafeEqual(this.bytes, other.bytes)
    );
  }

  /** Never serialize key material. */
  toJSON(): string {
    return "[redacted]";
  }

  toString(): string {
    return "[redacted MasterKey]";
  }
}

/** Raised for any master-key configuration problem. Never carries the value. */
export class CredentialKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialKeyError";
  }
}

/**
 * Raised when decryption fails: wrong key, tampered ciphertext, tampered tag,
 * tampered IV, or tampered envelope metadata.
 *
 * The message is intentionally UNIFORM and carries no detail. Distinguishing
 * "wrong key" from "tampered ciphertext" would hand an attacker an oracle, and
 * echoing any of the inputs would risk leaking secret material into logs.
 */
export class CredentialDecryptionError extends Error {
  constructor() {
    super("Credential could not be decrypted.");
    this.name = "CredentialDecryptionError";
  }
}

/** The stored envelope. Contains no plaintext and no key material. */
export interface CredentialEnvelope {
  readonly version: number;
  readonly keyVersion: number;
  readonly algorithm: typeof CREDENTIAL_ALGORITHM;
  readonly iv: Buffer;
  readonly ciphertext: Buffer;
  readonly authTag: Buffer;
}

/** Bind the envelope metadata so tampering with it fails authentication. */
function aad(version: number, keyVersion: number): Buffer {
  return Buffer.from(`v${version}:k${keyVersion}:${CREDENTIAL_ALGORITHM}`, "utf8");
}

/**
 * Encrypt a credential payload. A fresh nonce is generated on EVERY call, so
 * two encryptions of identical plaintext produce different ciphertext.
 */
export function encryptCredential(plaintext: string, key: MasterKey): CredentialEnvelope {
  if (plaintext === "") {
    throw new CredentialKeyError("Credential payload must not be empty.");
  }
  const iv = randomBytes(IV_BYTES); // CSPRNG, unique per operation
  const cipher = createCipheriv(CREDENTIAL_ALGORITHM, key.material(), iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(aad(CREDENTIAL_ENVELOPE_VERSION, key.version));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    version: CREDENTIAL_ENVELOPE_VERSION,
    keyVersion: key.version,
    algorithm: CREDENTIAL_ALGORITHM,
    iv,
    ciphertext,
    authTag: cipher.getAuthTag(),
  };
}

/**
 * Decrypt an envelope. Throws CredentialDecryptionError on ANY failure —
 * wrong key, wrong key version, tampered ciphertext/tag/IV/metadata.
 *
 * Every failure path is funnelled through the same uniform error, and the
 * underlying cause is deliberately NOT attached: an OpenSSL message could
 * otherwise reach a log or an HTTP error body.
 */
export function decryptCredential(envelope: CredentialEnvelope, key: MasterKey): string {
  if (envelope.version !== CREDENTIAL_ENVELOPE_VERSION) throw new CredentialDecryptionError();
  if (envelope.algorithm !== CREDENTIAL_ALGORITHM) throw new CredentialDecryptionError();
  // A row encrypted under a different key version cannot be read by this key.
  if (envelope.keyVersion !== key.version) throw new CredentialDecryptionError();
  if (envelope.iv.length !== IV_BYTES) throw new CredentialDecryptionError();
  if (envelope.authTag.length !== AUTH_TAG_BYTES) throw new CredentialDecryptionError();
  try {
    const decipher = createDecipheriv(CREDENTIAL_ALGORITHM, key.material(), envelope.iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(aad(envelope.version, envelope.keyVersion));
    decipher.setAuthTag(envelope.authTag);
    const plaintext = Buffer.concat([
      decipher.update(envelope.ciphertext),
      decipher.final(), // throws when the tag does not verify
    ]);
    return plaintext.toString("utf8");
  } catch {
    // Uniform failure: no oracle, no leaked cause, no input echoed.
    throw new CredentialDecryptionError();
  }
}
