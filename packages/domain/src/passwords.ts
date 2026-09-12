// Password policy — ADR-005 (Accepted, D-04).
// Migration contract: bcrypt $2y$ (cost 12, verified PHP) verifies as-is;
// successful logins rehash transparently to Argon2id m=19456,t=2,p=1;
// change/reset hash with Argon2id; NEVER bulk-rewrite.
import { ARGON2ID_PARAMS } from "@velora/contracts";

export interface PasswordHasher {
  /** Returns an Argon2id hash string (D-04 parameters). */
  hash(password: string): Promise<string>;
  /** Verifies a password against bcrypt ($2y$/$2a$/$2b$) or Argon2id hashes. */
  verify(password: string, hash: string): Promise<boolean>;
}

export type HashKind = "argon2id" | "bcrypt" | "unknown";

const ARGON2ID_PREFIX = `$argon2id$v=19$m=${ARGON2ID_PARAMS.memoryKiB},t=${ARGON2ID_PARAMS.iterations},p=${ARGON2ID_PARAMS.parallelism}$`;

export function identifyHash(hash: string): HashKind {
  if (hash.startsWith("$argon2id$")) return "argon2id";
  if (/^\$2[aby]\$/.test(hash)) return "bcrypt";
  return "unknown";
}

/** True when the hash must be upgraded (bcrypt of any flavor, or off-spec argon2id). */
export function needsRehash(hash: string): boolean {
  if (identifyHash(hash) === "bcrypt") return true; // transparent rehash on login
  if (identifyHash(hash) === "argon2id") return !hash.startsWith(ARGON2ID_PREFIX);
  return true; // unknown format: force reset path, never silent accept
}

/** Result of the login-boundary rehash policy (ADR-005 / Phase B S5). */
export interface RehashResult {
  /** Password verification outcome (the ONLY basis for any further action). */
  readonly verified: boolean;
  /** True when the stored hash must be replaced by `newHash`. */
  readonly rehashNeeded: boolean;
  /** Argon2id (D-04) replacement hash — present only when rehashNeeded. */
  readonly newHash?: string;
}

/**
 * Login-boundary rehash policy (ADR-005 / Phase B S5): verify FIRST; only a
 * SUCCESSFUL login of a non-compliant hash (bcrypt of any flavor, or
 * off-spec argon2id) produces a replacement Argon2id hash with the exact
 * D-04 parameters. The caller persists `newHash` through the user store in
 * the same login flow. The plaintext password is never returned, stored, or
 * logged by this function; a failed verification produces nothing.
 */
export async function verifyAndRehash(
  hasher: PasswordHasher,
  password: string,
  hash: string,
): Promise<RehashResult> {
  if (!(await hasher.verify(password, hash))) {
    return { verified: false, rehashNeeded: false };
  }
  if (!needsRehash(hash)) {
    return { verified: true, rehashNeeded: false };
  }
  return { verified: true, rehashNeeded: true, newHash: await hasher.hash(password) };
}
