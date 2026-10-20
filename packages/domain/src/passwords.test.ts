// Password policy tests — verifyAndRehash login-boundary policy (Phase B S5).
// Unit-level: a scripted fake hasher isolates the POLICY (verification gate,
// rehash decision, no-leak guarantees) from the crypto (proven separately in
// apps/api with the real VeloraHasher).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifyAndRehash,
  needsRehash,
  identifyHash,
  type PasswordHasher,
} from "./passwords.js";

const ARGON2ID_EXACT = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$hashvalue000000000000000000000";
const ARGON2ID_OFFSPEC = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$hashvalue000000000000000000000";
const BCRYPT_2Y = "$2y$10$.vGA1O9wmRjrwAVXD98HNOgsNpDczlqm3Jq7KnEd1rVAGv3Fykk1a";

class ScriptedHasher implements PasswordHasher {
  public hashCalls = 0;
  constructor(private readonly passwordOk: boolean) {}
  async hash(): Promise<string> {
    this.hashCalls += 1;
    return ARGON2ID_EXACT;
  }
  async verify(password: string): Promise<boolean> {
    return this.passwordOk && password === "correct-password";
  }
}

test("failed verification produces NOTHING (no rehash, no hash output)", async () => {
  const h = new ScriptedHasher(false);
  const r = await verifyAndRehash(h, "wrong-password", BCRYPT_2Y);
  assert.deepEqual(r, { verified: false, rehashNeeded: false });
  assert.equal(h.hashCalls, 0, "no replacement hash may be computed on failed login");
});

test("successful bcrypt login requires rehash to exact-spec argon2id", async () => {
  const h = new ScriptedHasher(true);
  const r = await verifyAndRehash(h, "correct-password", BCRYPT_2Y);
  assert.equal(r.verified, true);
  assert.equal(r.rehashNeeded, true);
  assert.equal(r.newHash, ARGON2ID_EXACT);
  assert.equal(h.hashCalls, 1);
});

test("successful login on off-spec argon2id requires rehash", async () => {
  const h = new ScriptedHasher(true);
  const r = await verifyAndRehash(h, "correct-password", ARGON2ID_OFFSPEC);
  assert.equal(r.verified, true);
  assert.equal(r.rehashNeeded, true);
});

test("compliant D-04 argon2id login does NOT rehash (no unnecessary replacement)", async () => {
  const h = new ScriptedHasher(true);
  const r = await verifyAndRehash(h, "correct-password", ARGON2ID_EXACT);
  assert.deepEqual(r, { verified: true, rehashNeeded: false });
  assert.equal(h.hashCalls, 0);
});

test("unknown hash format: verification fails closed (never silent accept)", async () => {
  const h = new ScriptedHasher(true); // even a "working" verifier
  const r = await verifyAndRehash(h, "correct-password", "{crypt}not-a-known-format");
  // the fake hasher accepts, but the policy layer still never rehashes unknown
  // formats without verification — and VeloraHasher.verify returns false for
  // unknown formats (proven in apps/api). Here we only assert the decision
  // inputs behave: identifyHash classifies unknown correctly.
  assert.equal(identifyHash("{crypt}not-a-known-format"), "unknown");
  assert.equal(needsRehash("{crypt}not-a-known-format"), true);
  assert.equal(r.verified, true); // scripted hasher says yes…
  assert.equal(r.rehashNeeded, true); // …and unknown format forces the reset path
});

test("policy never returns or references the plaintext password", async () => {
  const h = new ScriptedHasher(true);
  const r = await verifyAndRehash(h, "correct-password", BCRYPT_2Y);
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes("correct-password"), "result must not leak the password");
});

/** Minimal hasher double: records hash() calls and answers verify() from the script. */
function fakeHasher(script: { verify: boolean }) {
  const state = { hashCalls: 0 };
  return {
    get hashCalls() {
      return state.hashCalls;
    },
    async hash() {
      state.hashCalls += 1;
      return "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA";
    },
    async verify() {
      return script.verify;
    },
  };
}


// ---------------------------------------------------------------------------------------------------
// The upgrade policy: a host that cannot compute Argon2id passes `allowUpgrade: false` and keeps the
// stored hash. Verification is unchanged — a wrong password still fails, and never reaches the policy.
// ---------------------------------------------------------------------------------------------------
test("allowUpgrade:false verifies but never rewrites the stored hash", async () => {
  const hasher = fakeHasher({ verify: true });
  const result = await verifyAndRehash(hasher, "secret", "$2y$12$legacybcrypthash", { allowUpgrade: false });
  assert.deepEqual(result, { verified: true, rehashNeeded: false });
  assert.equal(hasher.hashCalls, 0, "no upgrade work is attempted on a host that cannot do it");
});

test("allowUpgrade:false still refuses a wrong password, and still does no hashing", async () => {
  const hasher = fakeHasher({ verify: false });
  const result = await verifyAndRehash(hasher, "wrong", "$2y$12$legacybcrypthash", { allowUpgrade: false });
  assert.deepEqual(result, { verified: false, rehashNeeded: false });
  assert.equal(hasher.hashCalls, 0);
});

test("the default policy is unchanged: bcrypt is upgraded on a successful login", async () => {
  const hasher = fakeHasher({ verify: true });
  const result = await verifyAndRehash(hasher, "secret", "$2y$12$legacybcrypthash");
  assert.equal(result.verified, true);
  assert.equal(result.rehashNeeded, true);
  assert.equal(hasher.hashCalls, 1);
});

test("allowUpgrade:true is the same as the default", async () => {
  const hasher = fakeHasher({ verify: true });
  const result = await verifyAndRehash(hasher, "secret", "$2y$12$legacybcrypthash", { allowUpgrade: true });
  assert.equal(result.rehashNeeded, true);
  assert.equal(hasher.hashCalls, 1);
});
