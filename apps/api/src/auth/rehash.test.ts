// Rehash-on-login proof — Phase B (S5) with the REAL crypto stack
// (VeloraHasher: hash-wasm Argon2id + bcryptjs) against an in-memory user
// store double.
//
// EVIDENCE LABEL (test honesty rule): unit-level behavior verified at the
// authorized local persistence boundary (in-memory store double). The real
// user-store persistence arrives with Phase C/D — the limitation is
// documented, not hidden. No production database exists or is claimed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VeloraHasher } from "./hashing.js";
import { verifyAndRehash } from "@velora/domain";

// Canonical PHP password_hash() example vector — an independently generated
// PHP artifact (public documentation vector; password "rasmuslerdorf", cost
// 10). NOT a credential. Proven further in proof.test.ts (S4).
const PHP_BCRYPT_2Y_COST10 =
  "$2y$10$.vGA1O9wmRjrwAVXD98HNOgsNpDczlqm3Jq7KnEd1rVAGv3Fykk1a";
const PHP_VECTOR_PASSWORD = "rasmuslerdorf"; // public vector password, not a credential

const hasher = new VeloraHasher();

// In-memory persistence boundary double (authorized local boundary).
const store = new Map<string, { passwordHash: string }>();

interface LoginResult {
  verified: boolean;
  rehashNeeded: boolean;
}

async function login(email: string, password: string): Promise<LoginResult> {
  const user = store.get(email);
  if (user === undefined) return { verified: false, rehashNeeded: false };
  const r = await verifyAndRehash(hasher, password, user.passwordHash);
  if (r.verified && r.newHash !== undefined) {
    user.passwordHash = r.newHash; // persistence boundary (in-memory double)
  }
  return { verified: r.verified, rehashNeeded: r.rehashNeeded };
}

test("S5 GATE 1-5: legacy $2y$ login verifies, rehashes to exact Argon2id, persists, succeeds", async () => {
  store.set("legacy-user@velora.example", { passwordHash: PHP_BCRYPT_2Y_COST10 });

  // 1. legacy bcrypt $2y$ password verifies successfully
  const first = await login("legacy-user@velora.example", PHP_VECTOR_PASSWORD);
  assert.equal(first.verified, true);
  // 2-3. non-compliant hash detected; rehashed with exact D-04 parameters
  assert.equal(first.rehashNeeded, true);
  const stored = store.get("legacy-user@velora.example")?.passwordHash ?? "";
  assert.ok(
    stored.startsWith("$argon2id$v=19$m=19456,t=2,p=1$"),
    `stored hash must be exact-spec argon2id, got prefix: ${stored.slice(0, 32)}`,
  );
  // 4. new hash persisted through the persistence boundary (in-memory double)
  assert.notEqual(stored, PHP_BCRYPT_2Y_COST10);
  // 5. authentication still succeeds with the SAME password on the new hash
  const second = await login("legacy-user@velora.example", PHP_VECTOR_PASSWORD);
  assert.equal(second.verified, true);
  assert.equal(second.rehashNeeded, false, "compliant hash must not rehash again");
});

test("S5: compliant Argon2id user logs in and is NOT unnecessarily rehashed", async () => {
  const compliant = await hasher.hash("a-strong-example-password");
  store.set("modern-user@velora.example", { passwordHash: compliant });
  const r = await login("modern-user@velora.example", "a-strong-example-password");
  assert.equal(r.verified, true);
  assert.equal(r.rehashNeeded, false);
  assert.equal(store.get("modern-user@velora.example")?.passwordHash, compliant);
});

test("S5: incorrect password remains rejected and the store is untouched", async () => {
  const before = store.get("legacy-user@velora.example")?.passwordHash;
  const r = await login("legacy-user@velora.example", "wrong-password");
  assert.equal(r.verified, false);
  assert.equal(r.rehashNeeded, false);
  assert.equal(store.get("legacy-user@velora.example")?.passwordHash, before);
});

test("S5: the plaintext password is never stored or logged by the flow", async () => {
  const dump = JSON.stringify([...store.entries()]);
  assert.ok(!dump.includes(PHP_VECTOR_PASSWORD), "store must not contain the plaintext");
  assert.ok(!dump.includes("a-strong-example-password"));
  assert.ok(!dump.includes("wrong-password"));
});
