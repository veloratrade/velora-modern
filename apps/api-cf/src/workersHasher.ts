// The password hasher for the Worker host — same algorithm, same encoded format, no WebAssembly.
//
// WHY THIS FILE EXISTS. `VeloraHasher` (apps/api, used by the Node server) hashes with `hash-wasm`,
// which compiles WebAssembly at runtime. A deployed Worker refuses that: the runtime answers
// `WebAssembly.compile(): Wasm code generation disallowed by embedder`. Measured on staging
// 2026-10-20 — `POST /api/v1/auth/register` returned 500, and login could not have succeeded either,
// because `needsRehash()` sends every successful bcrypt login through `hash()` as well. So on this host
// BOTH halves of the credential path were broken while every route around them looked healthy.
//
// WHAT IT IS. A drop-in `PasswordHasher` backed by `@noble/hashes/argon2` — Argon2id in pure TypeScript.
// It produces the SAME encoded string hash-wasm (and therefore the Node server) produces:
//
//   $argon2id$v=19$m=19456,t=2,p=1$<base64 salt>$<base64 hash>
//
// and it VERIFIES hashes produced anywhere: argon2id by re-deriving with the parameters named in the
// hash itself (so a legacy or future parameter set still verifies), bcrypt via `bcryptjs` (pure JS, which
// is also what the Node hasher uses for the `$2y$` imports). Nothing is weakened: the parameters come
// from `ARGON2ID_PARAMS` (ADR-005), the salt is 16 random bytes from `crypto.getRandomValues`, and the
// comparison is constant-time.
//
// WHY NOT KEEP TWO IMPLEMENTATIONS. `apps/api-cf/src/workersHasher.test.ts` cross-verifies against the
// Node hasher in both directions: a hash made here verifies there, and a hash made there verifies here.
// If the formats ever drift, that test fails instead of every login failing in production.
import { argon2id } from "@noble/hashes/argon2.js";
import bcrypt from "bcryptjs";

import { ARGON2ID_PARAMS } from "@velora/contracts";
import { identifyHash, type PasswordHasher } from "@velora/domain";

const SALT_BYTES = 16;
const HASH_BYTES = 32;
const ARGON2_VERSION = 0x13; // 19 — the version in the encoded prefix, as Argon2 specifies
const ARGON2ID_PREFIX = "$argon2id$v=19$";

/** RFC 4648 base64 without padding — the encoding Argon2's PHC string uses for salt and hash. */
const toB64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte ?? 0);
  return btoa(binary).replace(/=+$/, "");
};

const fromB64 = (text: string): Uint8Array => {
  const padded = text.length % 4 === 0 ? text : text + "=".repeat(4 - (text.length % 4));
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

/** Constant-time equality. A length mismatch is not secret, so an early return is fine. */
const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};

interface ParsedArgon2id {
  readonly m: number;
  readonly t: number;
  readonly p: number;
  readonly salt: Uint8Array;
  readonly hash: Uint8Array;
  readonly version: number;
}

/**
 * Parse `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`.
 *
 * Returns `null` for anything that is not a well-formed argon2id PHC string — including `$argon2i$` and
 * `$argon2d$`, which this host must NOT silently accept as argon2id.
 */
export function parseArgon2id(encoded: string): ParsedArgon2id | null {
  const parts = encoded.split("$");
  // ['', 'argon2id', 'v=19', 'm=…,t=…,p=…', '<salt>', '<hash>']
  if (parts.length !== 6 || parts[0] !== "" || parts[1] !== "argon2id") return null;
  const versionPart = parts[2] ?? "";
  if (!versionPart.startsWith("v=")) return null;
  const version = Number(versionPart.slice(2));
  if (!Number.isSafeInteger(version) || version <= 0) return null;
  const params: Record<string, number> = {};
  for (const pair of (parts[3] ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return null;
    const value = Number(pair.slice(eq + 1));
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    params[pair.slice(0, eq)] = value;
  }
  const { m, t, p } = params;
  if (m === undefined || t === undefined || p === undefined) return null;
  try {
    return { m, t, p, version, salt: fromB64(parts[4] ?? ""), hash: fromB64(parts[5] ?? "") };
  } catch {
    return null;
  }
}

export class WorkersHasher implements PasswordHasher {
  /** Argon2id with the ADR-005 parameters, encoded exactly as `hash-wasm` encodes it. */
  async hash(password: string): Promise<string> {
    const salt = new Uint8Array(SALT_BYTES);
    crypto.getRandomValues(salt);
    const derived = argon2id(password, salt, {
      m: ARGON2ID_PARAMS.memoryKiB,
      t: ARGON2ID_PARAMS.iterations,
      p: ARGON2ID_PARAMS.parallelism,
      dkLen: HASH_BYTES,
      version: ARGON2_VERSION,
    });
    return `${ARGON2ID_PREFIX}m=${ARGON2ID_PARAMS.memoryKiB},t=${ARGON2ID_PARAMS.iterations},p=${ARGON2ID_PARAMS.parallelism}$${toB64(salt)}$${toB64(derived)}`;
  }

  async verify(password: string, hash: string): Promise<boolean> {
    const kind = identifyHash(hash);
    if (kind === "bcrypt") {
      // bcryptjs accepts $2a$/$2b$/$2y$ — the last is what the Legacy PHP system wrote.
      return bcrypt.compare(password, hash);
    }
    if (kind !== "argon2id") return false; // unknown format: never silently accept

    const parsed = parseArgon2id(hash);
    // A hash whose parameters this runtime cannot honour must FAIL, not throw: a thrown error here would
    // surface as a 500 and read as an outage, when the truth is "this credential cannot be checked here".
    if (parsed === null) return false;
    try {
      const derived = argon2id(password, parsed.salt, {
        m: parsed.m,
        t: parsed.t,
        p: parsed.p,
        dkLen: parsed.hash.length === 0 ? HASH_BYTES : parsed.hash.length,
        version: parsed.version,
      });
      return timingSafeEqual(derived, parsed.hash);
    } catch {
      return false;
    }
  }
}
