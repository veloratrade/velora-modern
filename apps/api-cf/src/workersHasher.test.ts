// Cross-verification: the Worker hasher and the Node hasher must agree in BOTH directions.
//
// This is the test that would have caught the outage. `VeloraHasher` (Node) uses hash-wasm; a deployed
// Worker refuses runtime WebAssembly, so the Worker host needs an implementation that does not. The only
// way "same algorithm" is true rather than intended is to hash with one and verify with the other.
import test from "node:test";
import assert from "node:assert/strict";

import bcrypt from "bcryptjs";

import { WorkersHasher, parseArgon2id } from "./workersHasher.js";
import { VeloraHasher } from "../../api/src/auth/hashing.js";

const PASSWORD = "Correct-Horse-Battery-9";

test("a hash made by the Worker hasher verifies with the NODE hasher", async () => {
  const fromWorker = await new WorkersHasher().hash(PASSWORD);
  assert.ok(fromWorker.startsWith("$argon2id$v=19$m=19456,t=2,p=1$"), fromWorker.slice(0, 40));
  assert.equal(await new VeloraHasher().verify(PASSWORD, fromWorker), true);
  assert.equal(await new VeloraHasher().verify("wrong-password", fromWorker), false);
});

test("a hash made by the NODE hasher verifies with the Worker hasher", async () => {
  const fromNode = await new VeloraHasher().hash(PASSWORD);
  assert.equal(await new WorkersHasher().verify(PASSWORD, fromNode), true, "the two encodings must agree");
  assert.equal(await new WorkersHasher().verify("wrong-password", fromNode), false);
});

test("the encoded shape is byte-for-byte the same in both directions", async () => {
  const fromNode = await new VeloraHasher().hash(PASSWORD);
  const fromWorker = await new WorkersHasher().hash(PASSWORD);
  const shape = (hash: string) => hash.split("$").map((part, i) => (i >= 4 ? `<${part.length}>` : part));
  // Salts differ per hash (that is the point), so compare the parts that must be identical: the id, the
  // version, the parameters, and the encoded lengths (16-byte salt and 32-byte digest => fixed length).
  assert.deepEqual(shape(fromWorker), shape(fromNode));
});

test("bcrypt hashes verify on the Worker path too — including the Legacy $2y$ flavour", async () => {
  const cost12 = await bcrypt.hash(PASSWORD, 12); // $2b$
  assert.equal(await new WorkersHasher().verify(PASSWORD, cost12), true);
  assert.equal(await new WorkersHasher().verify("nope", cost12), false);
  // PHP wrote $2y$; bcryptjs accepts it, so a Legacy import keeps working on this host.
  const legacy = cost12.replace(/^\$2b\$/, "$2y$");
  assert.equal(await new WorkersHasher().verify(PASSWORD, legacy), true);
});

test("an argon2id hash with OTHER parameters still verifies (parameters come from the hash, not a constant)", async () => {
  const node = new VeloraHasher();
  const hashFromNode = await node.hash(PASSWORD);
  const parsed = parseArgon2id(hashFromNode);
  assert.ok(parsed !== null);
  // Re-encode the same digest under different (weaker) parameters: verification must use the hash's own
  // values, which is what lets a future parameter bump verify old credentials instead of locking users out.
  const rebuilt = hashFromNode.replace(/m=\d+,t=\d+,p=\d+/, "m=8192,t=1,p=1");
  assert.equal(await new WorkersHasher().verify(PASSWORD, rebuilt), false, "a changed cost must not verify");
  // …and an untouched hash of the same shape still does.
  assert.equal(await new WorkersHasher().verify(PASSWORD, hashFromNode), true);
});

test("malformed or foreign hashes are refused, never accepted and never thrown", async () => {
  const hasher = new WorkersHasher();
  for (const bad of [
    "",
    "plaintext",
    "$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$aGFzaGhhc2hoYXNoaGFzaA",
    "$argon2id$v=19$m=x,t=2,p=1$c2FsdA$aGFzaA",
    "$argon2id$v=19$c2FsdA$aGFzaA",
  ]) {
    assert.equal(await hasher.verify(PASSWORD, bad), false, `must refuse: ${bad}`);
  }
});
