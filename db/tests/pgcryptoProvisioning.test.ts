// The Cloudflare hasher's database prerequisite — provisioning contract (D2).
//
// `apps/api-cf/src/pgCryptoHasher.ts` sends `crypt($1, gen_salt('bf', $2))` to
// PostgreSQL. On a freshly provisioned database that prerequisite did not exist
// anywhere in the repository: no migration, no bootstrap SQL, no provision step
// created the pgcrypto extension, so a new environment could pass connectivity
// checks and then fail password hashing at runtime with the hasher's own loud
// "pgcrypto hashing unavailable" error.
//
// WHERE IT MUST LIVE. Not in a numbered migration: `CREATE EXTENSION` needs
// CREATE on the DATABASE — a privilege the provisioned roles deliberately do
// not hold (roles.sql revokes migrator CREATE; velora_owner reaches DDL only
// via SET ROLE for schema objects) — and the disposable PGlite dev batteries
// cannot carry contrib extensions. The privileged, idempotent, out-of-band
// home is db/provision.ts's pre-migration phase (the same rationale as the
// pg-boss bootstrap). These tests pin that decision so it cannot silently move.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const provisionSrc = readFileSync(join(ROOT, "db", "provision.ts"), "utf8");
const hasherSrc = readFileSync(join(ROOT, "apps", "api-cf", "src", "pgCryptoHasher.ts"), "utf8");

test("db/provision.ts provisions the pgcrypto extension, idempotently", () => {
  assert.match(
    provisionSrc,
    /CREATE EXTENSION IF NOT EXISTS pgcrypto/,
    "the privileged provisioner must be the place pgcrypto comes from",
  );
});

test("the statement runs in the PRE-migration phase (privileged admin connection)", () => {
  const preStart = provisionSrc.indexOf('opts.phase === "pre-migration"');
  const preEnd = provisionSrc.indexOf("} else {", preStart);
  assert.ok(preStart !== -1 && preEnd > preStart, "pre-migration phase block found in provision()");
  const preBlock = provisionSrc.slice(preStart, preEnd);
  assert.match(preBlock, /pgcrypto/i, "pgcrypto must be provisioned before migrations run");
});

test("no numbered migration creates extensions (privilege + PGlite invariant)", () => {
  const dir = join(import.meta.dirname, "..", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    assert.doesNotMatch(
      readFileSync(join(dir, file), "utf8"),
      /CREATE\s+EXTENSION/i,
      `${file} must not CREATE EXTENSION — migrations run without database-level CREATE`,
    );
  }
});

test("the provisioned extension is exactly what the CF hasher's SQL depends on", () => {
  assert.match(hasherSrc, /gen_salt\('bf'/, "hasher hashes with pgcrypto bcrypt");
  assert.match(hasherSrc, /crypt\(\$1, \$2\) = \$2/, "hasher verifies via crypt round-trip");
  assert.match(hasherSrc, /PGCRYPTO_BCRYPT_COST = 12/, "cost 12 per the ADR-005 migration contract");
});
