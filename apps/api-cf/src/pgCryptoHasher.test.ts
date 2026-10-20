// The database-backed hasher: what it sends, what it accepts, and what it refuses.
//
// No database is touched. These tests pin the two properties that matter at the Worker boundary:
//   1. bcrypt verification is ONE query and the decision is the database's (`crypt(...) = ...`);
//   2. an Argon2id hash still verifies (the legacy fallback) and an unknown format never does.
// The integration half — that PostgreSQL really answers these queries — is covered by the live login
// checks against staging recorded in docs/state/evidence/objective-d/verification.json.
import test from "node:test";
import assert from "node:assert/strict";

import { PgCryptoHasher, PGCRYPTO_BCRYPT_COST } from "./pgCryptoHasher.js";
import { VeloraHasher } from "../../api/src/auth/hashing.js";

/** Records every statement and replays a scripted answer. */
const scripted = (answers: Array<Array<Record<string, unknown>>>) => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const query = async (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params });
    return answers.shift() ?? [];
  };
  return { hasher: new PgCryptoHasher(query), calls };
};

test("hash() asks PostgreSQL for bcrypt at cost 12 and returns exactly what the database produced", async () => {
  const stored = "$2a$12$abcdefghijklmnopqrstuv";
  const { hasher, calls } = scripted([[{ hash: stored }]]);
  assert.equal(await hasher.hash("Correct-Horse-Battery-9"), stored);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /crypt\(\$1, gen_salt\('bf', \$2\)\)/);
  assert.deepEqual(calls[0]!.params, ["Correct-Horse-Battery-9", PGCRYPTO_BCRYPT_COST]);
});

test("hash() refuses to return nothing — a missing pgcrypto extension must not become a stored null", async () => {
  const { hasher } = scripted([[]]);
  await assert.rejects(() => hasher.hash("x"), /pgcrypto/);
  const nullRow = scripted([[{ hash: null }]]).hasher;
  await assert.rejects(() => nullRow.hash("x"), /pgcrypto/);
});

test("verify() of a bcrypt hash is ONE query and the comparison happens inside the database", async () => {
  const hash = "$2a$12$abcdefghijklmnopqrstuv";
  const ok = scripted([[{ ok: true }]]);
  assert.equal(await ok.hasher.verify("secret-password", hash), true);
  assert.equal(ok.calls.length, 1);
  assert.match(ok.calls[0]!.sql, /crypt\(\$1, \$2\) = \$2/);
  assert.deepEqual(ok.calls[0]!.params, ["secret-password", hash]);

  const wrong = scripted([[{ ok: false }]]);
  assert.equal(await wrong.hasher.verify("wrong-password", hash), false);
});

test("a database that returns anything but true is a REFUSAL, never a pass", async () => {
  for (const answer of [[{}], [{ ok: "true" }], [{ ok: 1 }], []]) {
    const { hasher } = scripted([answer as Array<Record<string, unknown>>]);
    assert.equal(await hasher.verify("secret-password", "$2a$12$abcdefghijklmnopqrstuv"), false, JSON.stringify(answer));
  }
});

test("an unknown hash format never reaches the database and never verifies", async () => {
  const { hasher, calls } = scripted([]);
  for (const bad of ["", "plaintext", "$argon2i$v=19$m=8,t=1,p=1$c2FsdA$aGFzaA"]) {
    assert.equal(await hasher.verify("secret", bad), false, bad);
  }
  assert.equal(calls.length, 0, "no query is spent on a format this host cannot check");
});

test("legacy Argon2id rows still verify through the in-worker fallback", async () => {
  // A hash produced by the Node hasher: the Worker must accept it even though it stores bcrypt now.
  const argon2Hash = await new VeloraHasher().hash("Correct-Horse-Battery-9");
  const { hasher, calls } = scripted([]);
  assert.equal(await hasher.verify("Correct-Horse-Battery-9", argon2Hash), true);
  assert.equal(await hasher.verify("wrong-password", argon2Hash), false);
  assert.equal(calls.length, 0, "argon2 never queries the database");
});
