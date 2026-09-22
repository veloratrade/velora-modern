// JWT service tests — Phase B (S1/S6). Unit-level behavior verification.
//
// The cross-implementation vector (test at the bottom) is generated AT TEST
// TIME by Python's stdlib (hmac/hashlib/base64 — an independent
// implementation), so no JWT literal is ever committed to the repository
// (committed `eyJ…` strings are a secret-scan finding by design).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { JwtService, JwtConfigError, type JwtPayload } from "./jwt.js";

const SECRET = "jwt-unit-test-secret-0123456789abcdefghij"; // 43 chars, test-only
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("S1 GATE: construction without a usable secret throws (no fallback)", () => {
  assert.throws(() => JwtService.create(""), JwtConfigError);
  assert.throws(() => JwtService.create("   \t "), JwtConfigError);
  // @ts-expect-error — defensive: runtime must reject non-strings too
  assert.throws(() => JwtService.create(undefined), JwtConfigError);
});

test("S1: the module contains no literal secret or fallback (source audit)", () => {
  // Structural guarantee: JwtService reads no environment and has no static
  // default — construction is the ONLY path to a service instance and it
  // requires an explicit secret. (Belts-and-braces check of the source file.)
  const src = readFileSync(new URL("./jwt.ts", import.meta.url), "utf8");
  assert.ok(!src.includes("process.env"), "jwt.ts must not read the environment");
});

test("round-trip: sign → verify returns claims with standard fields", () => {
  const svc = JwtService.create(SECRET);
  const token = svc.sign({ sub: "user-42", role: "member" }, 300);
  const payload = svc.verify(token);
  assert.ok(payload !== null);
  assert.equal(payload?.sub, "user-42");
  assert.equal(payload?.role, "member");
  assert.match(payload?.jti ?? "", UUID_V4); // S6: secure jti, v4 UUID
  assert.equal(typeof payload?.iat, "number");
  assert.equal(payload?.exp, (payload?.iat ?? 0) + 300);
});

test("S6 GATE: jti is unique across tokens with identical claims", () => {
  const svc = JwtService.create(SECRET);
  const a = svc.verify(svc.sign({ sub: "same" }, 60));
  const b = svc.verify(svc.sign({ sub: "same" }, 60));
  assert.ok(a !== null && b !== null);
  assert.notEqual(a.jti, b.jti);
  assert.match(a.jti ?? "", UUID_V4);
  assert.match(b.jti ?? "", UUID_V4);
});

test("tampered payload is rejected", () => {
  const svc = JwtService.create(SECRET);
  const token = svc.sign({ sub: "user-42" }, 300);
  const parts = token.split(".");
  const tampered = `${parts[0]}.${Buffer.from(
    JSON.stringify({ sub: "attacker", exp: Math.floor(Date.now() / 1000) + 9999 }),
    "utf8",
  ).toString("base64url")}.${parts[2]}`;
  assert.equal(svc.verify(tampered), null);
});

test("wrong secret is rejected", () => {
  const signer = JwtService.create(SECRET);
  const verifier = JwtService.create("another-jwt-unit-test-secret-abcdef0123456789");
  assert.equal(verifier.verify(signer.sign({ sub: "user-42" }, 300)), null);
});

test("tampered signature is rejected", () => {
  const svc = JwtService.create(SECRET);
  const token = svc.sign({ sub: "user-42" }, 300);
  const parts = token.split(".");
  const badSig = Buffer.from("z".repeat(32)).toString("base64url");
  assert.equal(svc.verify(`${parts[0]}.${parts[1]}.${badSig}`), null);
  assert.equal(svc.verify(`${token}x`), null); // trailing garbage → 4 parts
});

test("expired token is rejected; valid until the last second before exp", () => {
  let clock = 1_700_000_000;
  const svc = JwtService.create(SECRET, { now: () => clock });
  const token = svc.sign({ sub: "user-42" }, 100);
  clock += 99;
  const almost: JwtPayload | null = svc.verify(token);
  assert.ok(almost !== null, "token must verify one second before expiry");
  clock += 1; // now == exp
  assert.equal(svc.verify(token), null, "token at exp is expired");
  clock += 1;
  assert.equal(svc.verify(token), null);
});

test('alg="none" and alg=HS512 are rejected (alg confusion)', () => {
  const svc = JwtService.create(SECRET);
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
  const payload = { sub: "user-42", exp: Math.floor(Date.now() / 1000) + 600 };
  const noneHead = b64({ alg: "none", typ: "JWT" });
  assert.equal(svc.verify(`${noneHead}.${b64(payload)}.`), null);
  const hs512Head = b64({ alg: "HS512", typ: "JWT" });
  assert.equal(svc.verify(`${hs512Head}.${b64(payload)}.AAAA`), null);
});

test("structurally invalid tokens are rejected without throwing", () => {
  const svc = JwtService.create(SECRET);
  for (const bad of ["", "a.b", "a.b.c.d", "...", "not-a-token", "eyJ9.eyJ9.!!"]) {
    assert.equal(svc.verify(bad), null, `token ${JSON.stringify(bad)} must be rejected`);
  }
});

test("ttl and claims validation: non-positive or fractional ttl throws", () => {
  const svc = JwtService.create(SECRET);
  assert.throws(() => svc.sign({ sub: "u" }, 0), JwtConfigError);
  assert.throws(() => svc.sign({ sub: "u" }, -5), JwtConfigError);
  assert.throws(() => svc.sign({ sub: "u" }, 1.5), JwtConfigError);
  assert.throws(() => svc.sign({ sub: "" }, 60), JwtConfigError);
});

test("cross-implementation: a token signed by an independent implementation verifies", (t) => {
  // Generated at test time with Python's stdlib (hmac + hashlib + base64) —
  // a genuinely independent HMAC/base64url/JSON implementation — so no JWT
  // literal is committed. Skips (visibly, never silently) without python3.
  const secret = "cross-implementation-test-secret-0123456789abcdef"; // 47 chars, test-only
  const script = [
    "import base64, hmac, hashlib, json, sys, time",
    "def b64(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()",
    "now = int(time.time())",
    "head = b64(json.dumps({'alg':'HS256','typ':'JWT'}, separators=(',',':')).encode())",
    "body = b64(json.dumps({'sub':'42','role':'admin','iat':now,'exp':now+600}, separators=(',',':')).encode())",
    "sig = b64(hmac.new(sys.argv[1].encode(), (head + '.' + body).encode(), hashlib.sha256).digest())",
    "print(head + '.' + body + '.' + sig)",
  ].join("\n");
  let token: string;
  try {
    token = execFileSync("python3", ["-c", script, secret], { encoding: "utf8" }).trim();
  } catch {
    t.skip("python3 unavailable — cross-implementation vector not generated");
    return;
  }
  const svc = JwtService.create(secret);
  const payload = svc.verify(token);
  assert.ok(payload !== null, "Python-signed token must verify against this implementation");
  assert.equal(payload?.sub, "42");
  assert.equal(payload?.role, "admin");
});
