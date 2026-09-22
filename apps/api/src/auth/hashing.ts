// Password hashing implementations — ADR-005 (Accepted, D-04).
// bcrypt $2y$ (cost 12, PHP) verifies as-is; Argon2id m=19456,t=2,p=1 for all
// new hashes; transparent rehash on login; NEVER bulk rewrite.
import { randomBytes } from "node:crypto";
import { argon2id, argon2Verify } from "hash-wasm";
import bcrypt from "bcryptjs";
import { ARGON2ID_PARAMS } from "@velora/contracts";
import { identifyHash, type PasswordHasher } from "@velora/domain";

export class VeloraHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return argon2id({
      password,
      salt: randomBytes(16),
      parallelism: ARGON2ID_PARAMS.parallelism,
      iterations: ARGON2ID_PARAMS.iterations,
      memorySize: ARGON2ID_PARAMS.memoryKiB,
      hashLength: 32,
      outputType: "encoded", // $argon2id$v=19$m=19456,t=2,p=1$…
    });
  }

  async verify(password: string, hash: string): Promise<boolean> {
    const kind = identifyHash(hash);
    if (kind === "argon2id") {
      return argon2Verify({ password, hash });
    }
    if (kind === "bcrypt") {
      return bcrypt.compare(password, hash); // bcryptjs accepts $2y$/$2a$/$2b$ — proven by the gate test
    }
    return false; // unknown format: never silently accept
  }
}
