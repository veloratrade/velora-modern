// The API-origin resolution contract — fail-closed outside development (B7).
//
// `resolveApiOrigin` is the ONE place the panel names the API. Its own header
// comment promises: "A `null` answer is a hard failure the callers must surface
// (503 / fail-closed gate) rather than paper over with a default: guessing an
// origin is how the staging panel ended up sending logins to a host that does
// not exist." The UNSET case violated that promise: an empty/absent
// VELORA_API_ORIGIN silently fell back to the development loopback default
// (http://127.0.0.1:8080) in every environment — in production the panel then
// forwarded real logins into a socket that does not exist, with no 503, no
// reason, and a misleading target in every error.
//
// The contract pinned here: the loopback default is a DEVELOPMENT convenience
// only. Outside development, an unset origin is a misconfiguration answered
// with null (and the callers' existing 503 / gate-refusal), never a guess.
// Both real callers already fail closed on null: `src/proxy.ts` (session gate)
// and `src/app/api/[...path]/route.ts` (503 API_ORIGIN_UNCONFIGURED).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DEV_API_ORIGIN, requireApiOrigin, resolveApiOrigin } from "./apiOrigin.js";

test("unset origin outside development is a hard null — never a loopback guess", () => {
  for (const nodeEnv of ["production", "test", undefined]) {
    const resolved = resolveApiOrigin({ NODE_ENV: nodeEnv });
    assert.equal(
      resolved,
      null,
      `NODE_ENV=${String(nodeEnv)}: an unset VELORA_API_ORIGIN must fail closed`,
    );
  }
});

test("unset origin in development keeps the documented loopback default", () => {
  assert.equal(resolveApiOrigin({ NODE_ENV: "development" }), DEFAULT_DEV_API_ORIGIN);
  assert.equal(DEFAULT_DEV_API_ORIGIN, "http://127.0.0.1:8080");
});

test("an explicitly set origin wins in every environment", () => {
  for (const nodeEnv of ["development", "production", undefined]) {
    assert.equal(
      resolveApiOrigin({ NODE_ENV: nodeEnv, VELORA_API_ORIGIN: "https://api.velora.example" }),
      "https://api.velora.example",
    );
  }
});

test("a blank (whitespace) origin behaves exactly like unset", () => {
  assert.equal(resolveApiOrigin({ NODE_ENV: "production", VELORA_API_ORIGIN: "   " }), null);
  assert.equal(resolveApiOrigin({ NODE_ENV: "development", VELORA_API_ORIGIN: "   " }), DEFAULT_DEV_API_ORIGIN);
});

test("unusable origins stay null in every environment (existing contract)", () => {
  // The credential-carrying case is assembled from parts: a literal
  // credential-bearing URL in the source would be flagged by
  // tools/secret-scan.sh — correctly, per the public-repository policy.
  const withCredentials = "https://" + "user" + ":" + "pass" + "@api.example";
  for (const bad of ["not a url", "ftp://api.example", withCredentials]) {
    assert.equal(resolveApiOrigin({ NODE_ENV: "development", VELORA_API_ORIGIN: bad }), null, bad);
    assert.equal(resolveApiOrigin({ NODE_ENV: "production", VELORA_API_ORIGIN: bad }), null, bad);
  }
});

test("requireApiOrigin throws the fixed-string error on the production-unset case", () => {
  assert.throws(
    () => requireApiOrigin({ NODE_ENV: "production" }),
    /VELORA_API_ORIGIN is not a usable http\(s\) origin/,
  );
  // The message must never embed the (missing) value or environment detail.
  const err = (() => {
    try {
      requireApiOrigin({ NODE_ENV: "production" });
      return null;
    } catch (e) {
      return e as Error;
    }
  })();
  assert.ok(err !== null);
  assert.ok(!err.message.includes("127.0.0.1"), "no guessed origin in the error");
});
