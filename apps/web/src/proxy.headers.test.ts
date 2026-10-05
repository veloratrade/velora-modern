// Proxy security-header contract (unit level) — audit §10.2 S2/S4/S5 evidence.
//
// S4 (MG-SEC-HSTS): Legacy sets `Strict-Transport-Security: max-age=31536000`
// on EVERY response via .htaccess (`Header always set`), redirects included —
// no includeSubDomains, no preload (commitments Legacy never made). This pins
// that parity for all three proxy response shapes: normalized redirects, the
// SEC-04 denial (edge gate), and the served page.
//
// S5: a protected route with an unreachable API proves the gate is FAIL-CLOSED
// (Legacy: `$sessionIsValid = false` when the check cannot run) — 302 to
// login, no-store, never the protected HTML.
//
// S2: if a CSP nonce cannot be generated, the request is refused (503), never
// served under a forgeable policy.
//
// The API side of S4 is pinned in apps/api/src/kernel/server.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// Point the session probe at a port where nothing listens (port 9 = discard):
// the probe fails fast (ECONNREFUSED) and the gate must fail CLOSED.
process.env.VELORA_API_ORIGIN = "http://127.0.0.1:9";

const { proxy } = await import("./proxy.js");

const HSTS = "max-age=31536000"; // Legacy .htaccess:49 — exact value, no extensions

test("S4: a served page carries HSTS + the full header set", async () => {
  const res = await proxy(new NextRequest("http://localhost/en/markets"));
  assert.equal(res.headers.get("Strict-Transport-Security"), HSTS);
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(res.headers.get("X-Frame-Options"), "DENY");
  assert.equal(res.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.equal(res.headers.get("Permissions-Policy"), "geolocation=(), microphone=(), camera=()");
  assert.equal(res.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assert.match(res.headers.get("Vary")!, /Cookie/);
  const csp = res.headers.get("Content-Security-Policy") ?? "";
  assert.match(csp, /'nonce-/); // nonce-based strict CSP, not unsafe-inline
});

test("S4: a redirect normalization response carries HSTS (Legacy: Header always set)", async () => {
  const res = await proxy(new NextRequest("http://localhost/en"));
  assert.ok([307, 308].includes(res.status), `expected a normalization redirect, got ${res.status}`);
  assert.equal(res.headers.get("Location"), "http://localhost/en/");
  assert.equal(res.headers.get("Strict-Transport-Security"), HSTS);
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
});

test("S5: a protected route with an unreachable API fails CLOSED — 302 to login, HSTS, never the HTML", async () => {
  const res = await proxy(new NextRequest("http://localhost/dashboard"));
  assert.equal(res.status, 302);
  const location = res.headers.get("Location") ?? "";
  assert.ok(location.includes("/login"), `expected login redirect, got ${location}`);
  assert.equal(res.headers.get("X-Velora-Edge-Gate"), "gate-unavailable");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(res.headers.get("Strict-Transport-Security"), HSTS);
});

test("S2: nonce generation failure is refused (503), never a predictable nonce", async () => {
  const cryptoObj = globalThis.crypto as Crypto & { randomUUID?: () => string };
  const original = cryptoObj.randomUUID;
  // Shadow the prototype method with a throwing own property…
  Object.defineProperty(cryptoObj, "randomUUID", {
    value: () => {
      throw new Error("entropy exhausted (test)");
    },
    configurable: true,
  });
  try {
    const res = await proxy(new NextRequest("http://localhost/en/markets"));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("Retry-After"), "30");
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.equal(res.headers.get("Content-Security-Policy"), null, "no policy may be emitted");
  } finally {
    delete (cryptoObj as { randomUUID?: unknown }).randomUUID;
    assert.equal(cryptoObj.randomUUID, original, "crypto restored");
  }
});
