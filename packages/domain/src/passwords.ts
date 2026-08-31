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
