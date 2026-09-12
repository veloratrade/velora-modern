// *** BCRYPT "$2y$" COMPATIBILITY PROOF GATE — Phase 1 exit requirement (ADR-005/D-04). ***
// A PHP-generated $2y$ vector MUST verify; a wrong password MUST fail.
// Vector source: the canonical PHP password_hash() example vector for
// password "rasmuslerdorf" (cost 10) — an independently generated PHP artifact,
// not produced by this codebase.
import { test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { VeloraHasher } from "./hashing.js";
import { needsRehash, identifyHash } from "@velora/domain";
import { ARGON2ID_PARAMS } from "@velora/contracts";

const PHP_BCRYPT_2Y_COST10 =
  "$2y$10$.vGA1O9wmRjrwAVXD98HNOgsNpDczlqm3Jq7KnEd1rVAGv3Fykk1a";

test("GATE: PHP-generated $2y$ hash verifies with the correct password", async () => {
  assert.equal(await bcrypt.compare("rasmuslerdorf", PHP_BCRYPT_2Y_COST10), true);
});

test("GATE: PHP-generated $2y$ hash REJECTS a wrong password", async () => {
  assert.equal(await bcrypt.compare("wrong-password", PHP_BCRYPT_2Y_COST10), false);
});

test("GATE: $2y$ ≡ $2b$ cryptographic equivalence (prefix normalization proof)", async () => {
  // Node bcryptjs generates $2b$/$2a$; rewriting the prefix to $2y$ (the PHP
  // flavor marker) must not change verification — proves flavor compatibility.
  const as2b = await bcrypt.hash("vector-pw", 10);
  const as2y = "$2y$" + as2b.slice(4);
  assert.equal(await bcrypt.compare("vector-pw", as2y), true);
  assert.equal(await bcrypt.compare("nope", as2y), false);
});

test("GATE: full hasher handles migrated bcrypt and new argon2id hashes", async () => {
  const hasher = new VeloraHasher();
  // migrated PHP hash path
  assert.equal(await hasher.verify("rasmuslerdorf", PHP_BCRYPT_2Y_COST10), true);
  assert.equal(await hasher.verify("bad", PHP_BCRYPT_2Y_COST10), false);
  // argon2id path — parameters exactly per D-04
  const h = await hasher.hash("correct horse battery staple");
  assert.ok(h.startsWith("$argon2id$v=19$m=19456,t=2,p=1$"), `unexpected prefix: ${h.slice(0, 32)}`);
  assert.equal(await hasher.verify("correct horse battery staple", h), true);
  assert.equal(await hasher.verify("wrong", h), false);
});

test("rehash policy: bcrypt → rehash; D-04 argon2id → no rehash", () => {
  assert.equal(identifyHash(PHP_BCRYPT_2Y_COST10), "bcrypt");
  assert.equal(needsRehash(PHP_BCRYPT_2Y_COST10), true);
  assert.equal(needsRehash("$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA"), false);
  assert.equal(needsRehash("$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA"), true); // off-spec params
});

test("S3 GATE: generated Argon2id hash encodes the EXACT ADR-005 parameters (decoded, not just prefix-matched)", async () => {
  const hasher = new VeloraHasher();
  const h = await hasher.hash("exact-parameter-compliance-proof");
  // Decode the actual generated hash's parameter segment: $argon2id$v=19$m=…,t=…,p=…$
  const m = h.match(/^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/);
  assert.ok(m, `encoded argon2id parameter segment not found in: ${h.slice(0, 40)}…`);
  assert.equal(m?.[1], "19456", "memory must be exactly 19456 KiB (ADR-005)");
  assert.equal(m?.[2], "2", "iterations must be exactly 2 (ADR-005)");
  assert.equal(m?.[3], "1", "parallelism must be exactly 1 (ADR-005)");
  // The policy constants themselves are pinned to ADR-005 (defense in depth)
  assert.equal(ARGON2ID_PARAMS.memoryKiB, 19456);
  assert.equal(ARGON2ID_PARAMS.iterations, 2);
  assert.equal(ARGON2ID_PARAMS.parallelism, 1);
  // Verification + wrong-password rejection on the freshly generated hash
  assert.equal(await hasher.verify("exact-parameter-compliance-proof", h), true);
  assert.equal(await hasher.verify("wrong-password", h), false);
});
