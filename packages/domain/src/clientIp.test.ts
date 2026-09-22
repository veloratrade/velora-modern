// Client-IP resolution — PHP Core/RateLimiter.php::clientIp + matchesAnyCidr
// parity (inc 7). Pure-logic tests; every assertion traces to PHP behavior:
// REMOTE_ADDR validated (0.0.0.0 fallback), X-Forwarded-For honored only for
// trusted-proxy peers (fail-closed default), byte-exact CIDR matching.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ipToBytes, matchesAnyCidr, resolveClientIp } from "./clientIp.js";

test("ipToBytes: IPv4 dotted-quad → 4 bytes; invalid forms rejected", () => {
  assert.deepEqual(Array.from(ipToBytes("127.0.0.1") ?? []), [127, 0, 0, 1]);
  assert.deepEqual(Array.from(ipToBytes("203.0.113.9") ?? []), [203, 0, 113, 9]);
  assert.equal(ipToBytes("1.2.3"), null);
  assert.equal(ipToBytes("1.2.3.4.5"), null);
  assert.equal(ipToBytes("256.1.1.1"), null);
  assert.equal(ipToBytes("1.2.3.x"), null);
  assert.equal(ipToBytes(""), null);
});

test("ipToBytes: IPv6 (full, ::, embedded IPv4 tail) → 16 bytes; malformed rejected", () => {
  assert.deepEqual(Array.from(ipToBytes("::1") ?? []), [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
  ]);
  const full = ipToBytes("2001:0db8:0000:0000:0000:0000:0000:0042");
  assert.ok(full instanceof Uint8Array && full.length === 16);
  assert.equal(full[15], 0x42);
  // IPv4-mapped tail (::ffff:1.2.3.4) — the form node reports for dual-stack peers
  const mapped = ipToBytes("::ffff:1.2.3.4");
  assert.ok(mapped instanceof Uint8Array && mapped.length === 16);
  assert.deepEqual(Array.from(mapped.slice(12)), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(ipToBytes("::") ?? []).length, 16); // all-zeros
  assert.equal(ipToBytes(":::"), null); // two compressions
  assert.equal(ipToBytes("1:2:3:4:5:6:7:8:9"), null); // too many hextets
  assert.equal(ipToBytes("1:2:3:4:5:6:7:8::"), null); // :: replaces nothing → invalid
  assert.equal(ipToBytes(":1:2:3:4:5:6:7:8"), null); // stray leading colon
  assert.equal(ipToBytes("1:2:3:4:5:6:7:8:"), null); // stray trailing colon
  assert.equal(ipToBytes("12345::"), null); // hextet > 4 digits
  assert.equal(ipToBytes("1.2.3.4:56"), null); // v4 with port-ish tail
});

test("matchesAnyCidr: byte-exact prefix matching, per-family lengths only", () => {
  assert.equal(matchesAnyCidr("127.0.0.1", ["127.0.0.1"]), true); // no prefix = /32
  assert.equal(matchesAnyCidr("127.0.0.1", ["127.0.0.0/24"]), true);
  assert.equal(matchesAnyCidr("127.0.0.255", ["127.0.0.0/24"]), true);
  assert.equal(matchesAnyCidr("127.0.1.1", ["127.0.0.0/24"]), false);
  assert.equal(matchesAnyCidr("10.1.2.3", ["10.0.0.0/8"]), true);
  assert.equal(matchesAnyCidr("11.0.0.1", ["10.0.0.0/8"]), false);
  // /17 → third octet's top bit must be 1: 200 (11001000) is in, 127 (01111111) is not
  assert.equal(matchesAnyCidr("192.168.200.1", ["192.168.128.0/17"]), true);
  assert.equal(matchesAnyCidr("192.168.127.1", ["192.168.128.0/17"]), false);
  assert.equal(matchesAnyCidr("203.0.113.9", ["0.0.0.0/0"]), true); // /0 matches the family
  // family mismatch: v4 CIDR never matches a v6 address (PHP strlen check)
  assert.equal(matchesAnyCidr("::1", ["127.0.0.0/8"]), false);
  assert.equal(matchesAnyCidr("127.0.0.1", ["::/0"]), false);
  assert.equal(matchesAnyCidr("2001:db8::1", ["2001:db8::/32"]), true);
  assert.equal(matchesAnyCidr("2001:db9::1", ["2001:db8::/32"]), false);
});

test("matchesAnyCidr: invalid entries are skipped, never throw", () => {
  assert.equal(matchesAnyCidr("127.0.0.1", ["not-a-cidr", "127.0.0.0/24"]), true);
  assert.equal(matchesAnyCidr("127.0.0.1", ["127.0.0.0/33"]), false); // prefix out of bounds
  assert.equal(matchesAnyCidr("127.0.0.1", ["127.0.0.0/xx"]), false);
  assert.equal(matchesAnyCidr("127.0.0.1", [""]), false);
  assert.equal(matchesAnyCidr("127.0.0.1", ["  127.0.0.0/24  "]), true); // trimmed entry
  assert.equal(matchesAnyCidr("127.0.0.1", []), false); // fail-closed default: nothing trusted
});

test("resolveClientIp: peer address unless the peer is a trusted proxy", () => {
  // XFF is attacker-controlled → never honored without a matching trusted CIDR
  assert.equal(resolveClientIp({ remoteAddress: "203.0.113.5", xForwardedFor: "9.9.9.9" }, []), "203.0.113.5");
  assert.equal(
    resolveClientIp({ remoteAddress: "203.0.113.5", xForwardedFor: "9.9.9.9" }, ["198.51.100.0/24"]),
    "203.0.113.5",
  );
});

test("resolveClientIp: trusted peer → first XFF entry (validated)", () => {
  assert.equal(
    resolveClientIp({ remoteAddress: "198.51.100.7", xForwardedFor: "9.9.9.9, 10.0.0.1" }, ["198.51.100.0/24"]),
    "9.9.9.9",
  );
  assert.equal(
    resolveClientIp({ remoteAddress: "198.51.100.7", xForwardedFor: "9.9.9.9, 10.0.0.1" }, ["198.51.100.7"]),
    "9.9.9.9",
  );
  // invalid first entry → fall back to the peer address (PHP parity)
  assert.equal(
    resolveClientIp({ remoteAddress: "198.51.100.7", xForwardedFor: "spoofed" }, ["198.51.100.0/24"]),
    "198.51.100.7",
  );
  // empty header → peer address
  assert.equal(resolveClientIp({ remoteAddress: "198.51.100.7", xForwardedFor: "" }, ["198.51.100.0/24"]), "198.51.100.7");
  assert.equal(resolveClientIp({ remoteAddress: "198.51.100.7", xForwardedFor: undefined }, ["0.0.0.0/0"]), "198.51.100.7");
});

test("resolveClientIp: invalid peer → 0.0.0.0 fallback (PHP parity)", () => {
  assert.equal(resolveClientIp({ remoteAddress: undefined, xForwardedFor: undefined }, []), "0.0.0.0");
  assert.equal(resolveClientIp({ remoteAddress: "not-an-ip", xForwardedFor: "9.9.9.9" }, []), "0.0.0.0");
  // PHP quirk kept faithfully: the defaulted 0.0.0.0 goes through the CIDR
  // check too (a 0.0.0.0/0 trust entry would honor XFF even then).
  assert.equal(resolveClientIp({ remoteAddress: "not-an-ip", xForwardedFor: "9.9.9.9" }, ["0.0.0.0/0"]), "9.9.9.9");
});
