// Password hashing that happens INSIDE PostgreSQL — the only shape that fits a 10 ms CPU budget.
//
// THE CONSTRAINT, MEASURED. A Cloudflare Worker on the Free plan may spend 10 ms of CPU per request.
// Argon2id (m=19456, t=2) needs ~200–240 ms of CPU, so `POST /api/v1/auth/login` failed with
// `1102 Worker exceeded resource limits` on roughly half of all attempts (wrangler tail showed
// "Exceeded CPU Limit"), while every route that does not hash was fine. WebAssembly — the normal way to
// make Argon2 fast — is refused by the Workers runtime, so the work cannot be made cheaper on the Worker.
//
// THE ANSWER IS NOT "WEAKEN THE HASH". The password check moves to the database: Neon runs PostgreSQL,
// PostgreSQL has `pgcrypto`, and `crypt()`/`gen_salt('bf', 12)` run in the database's process. The Worker
// sends one query and reads one boolean; its CPU cost is a round trip, not a KDF. bcrypt at cost 12 is a
// standard, defensible credential hash — and, importantly, it is a format BOTH hosts already understand:
// the Node server verifies `$2a$/$2b$/$2y$` with `bcryptjs` (the Legacy PHP imports are `$2y$`), so a
// credential created here keeps working when the API moves to a VPS.
//
// WHAT THIS FILE DOES NOT DO. It does not compare hashes in JavaScript, does not receive the hash into a
// log, and does not invent a new format. `crypt($1, $2) = $2` is evaluated by PostgreSQL; the plaintext
// is a bind parameter and appears in no log this code writes.
//
// LEGACY ARGON2ID ROWS STILL VERIFY — through `WorkersHasher`, which is slow here. That is a deliberate
// fallback for rows created before this change (and by the Node server), not a path anyone should stay on:
// `PgCryptoHasher` rewrites them to bcrypt on their next successful login for the hosts that allow it.
import { identifyHash } from "@velora/domain";
import type { PasswordHasher } from "@velora/domain";

import { WorkersHasher } from "./workersHasher.js";

/** bcrypt cost, matching the Legacy cost the migration contract names (ADR-005, cost 12). */
export const PGCRYPTO_BCRYPT_COST = 12;

/** The slice of a query function this hasher needs — `pg`'s and Hyperdrive's both fit. */
export interface QueryRows {
  (sql: string, params?: readonly unknown[]): Promise<ReadonlyArray<Record<string, unknown>>>;
}

export class PgCryptoHasher implements PasswordHasher {
  private readonly argon2Fallback = new WorkersHasher();

  constructor(private readonly query: QueryRows) {}

  /**
   * Hash with PostgreSQL's bcrypt.
   *
   * The result is `$2a$12$…` — the same family the Node host verifies. `pgcrypto`'s bcrypt truncates at
   * 72 bytes exactly as `bcryptjs` does, so the two hosts cannot disagree about a long password.
   */
  async hash(password: string): Promise<string> {
    const rows = await this.query("SELECT crypt($1, gen_salt('bf', $2)) AS hash", [password, PGCRYPTO_BCRYPT_COST]);
    const hash = rows[0]?.["hash"];
    if (typeof hash !== "string" || hash === "") {
      // A missing pgcrypto extension lands here (`crypt` is unknown, the driver throws) or returns NULL.
      // Either way: refuse loudly rather than store something that cannot be verified.
      throw new Error("pgcrypto hashing unavailable (is the pgcrypto extension installed?)");
    }
    return hash;
  }

  /**
   * Verify against bcrypt in the database, or Argon2id in this worker as a legacy fallback.
   *
   * The database comparison is `crypt($1, $2) = $2`: bcrypt re-derives from the salt embedded in the
   * stored hash, so the database needs nothing but the two values. A malformed hash simply does not match.
   */
  async verify(password: string, hash: string): Promise<boolean> {
    const kind = identifyHash(hash);
    if (kind === "bcrypt") {
      const rows = await this.query("SELECT (crypt($1, $2) = $2) AS ok", [password, hash]);
      return rows[0]?.["ok"] === true;
    }
    if (kind === "argon2id") return this.argon2Fallback.verify(password, hash);
    return false; // unknown format: never silently accept
  }
}
