// ADR-014 / D-19 — MetaAPI platform-token resolver.
//
// The token values below are obvious fakes. No real credential exists in this
// repository and none is required: the resolver performs no I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_METAAPI_BASE_URL,
  PlatformToken,
  resolveMetaApiConfig,
} from "./metaApiConfig.js";

const FAKE_TOKEN = "fake-metaapi-token-NOT-REAL-0123456789";

test("MA-001: absent token → capability unavailable, never a crash", () => {
  for (const env of [{}, { METAAPI_PLATFORM_TOKEN: "" }, { METAAPI_PLATFORM_TOKEN: "   " }]) {
    const r = resolveMetaApiConfig(env);
    assert.equal(r.configured, false);
    assert.equal(r.token, null);
    assert.equal(r.baseUrl, null);
    assert.equal(r.findings[0]?.code, "MA-001");
  }
});

test("MA-002: whitespace or control characters → malformed", () => {
  for (const bad of [`${FAKE_TOKEN} `, ` ${FAKE_TOKEN}`, "abc def", "abc\tdef", "abc\ndef", "abc\u0000def"]) {
    const r = resolveMetaApiConfig({ METAAPI_PLATFORM_TOKEN: bad });
    assert.equal(r.configured, false, `expected malformed: ${JSON.stringify(bad)}`);
    assert.equal(r.findings[0]?.code, "MA-002");
  }
});

test("MA-003: non-https or unparseable base URL → capability unavailable", () => {
  for (const bad of ["http://insecure.example", "ftp://x.example", "not-a-url", "//no-scheme"]) {
    const r = resolveMetaApiConfig({ METAAPI_PLATFORM_TOKEN: FAKE_TOKEN, METAAPI_BASE_URL: bad });
    assert.equal(r.configured, false, `expected rejection: ${bad}`);
    assert.equal(r.findings[0]?.code, "MA-003");
    assert.equal(r.token, null, "no token is exposed when the URL is rejected");
  }
});

test("valid token resolves, with the reviewed default base URL", () => {
  const r = resolveMetaApiConfig({ METAAPI_PLATFORM_TOKEN: FAKE_TOKEN });
  assert.equal(r.configured, true);
  assert.deepEqual(r.findings, []);
  assert.equal(r.baseUrl, DEFAULT_METAAPI_BASE_URL);
  assert.equal(r.token?.reveal(), FAKE_TOKEN);
});

test("an explicit https base URL overrides the default and is normalised", () => {
  const r = resolveMetaApiConfig({
    METAAPI_PLATFORM_TOKEN: FAKE_TOKEN,
    METAAPI_BASE_URL: "https://mt-client-api-v1.london.agiliumtrade.ai/",
  });
  assert.equal(r.configured, true);
  assert.equal(r.baseUrl, "https://mt-client-api-v1.london.agiliumtrade.ai");
});

test("findings never embed the configured value (ADR-014 §4)", () => {
  const cases = [
    { METAAPI_PLATFORM_TOKEN: `${FAKE_TOKEN} bad` },
    { METAAPI_PLATFORM_TOKEN: FAKE_TOKEN, METAAPI_BASE_URL: `http://${FAKE_TOKEN}.example` },
  ];
  for (const env of cases) {
    const r = resolveMetaApiConfig(env);
    const serialized = JSON.stringify(r.findings);
    assert.equal(serialized.includes(FAKE_TOKEN), false, "finding leaked the token");
    assert.equal(serialized.includes("fake-metaapi"), false);
  }
});

test("the token resists accidental serialization", () => {
  const r = resolveMetaApiConfig({ METAAPI_PLATFORM_TOKEN: FAKE_TOKEN });
  // A config object logged wholesale must not disclose the token.
  const dumped = JSON.stringify({ metaapi: r });
  assert.equal(dumped.includes(FAKE_TOKEN), false, "JSON.stringify leaked the token");
  assert.match(dumped, /\[redacted\]/);
  // Interpolation is the other common accident.
  assert.equal(`${r.token}`.includes(FAKE_TOKEN), false, "toString leaked the token");
  // reveal() remains the single deliberate accessor.
  assert.equal(r.token?.reveal(), FAKE_TOKEN);
});

test("PlatformToken redaction holds for any value", () => {
  const t = new PlatformToken("another-fake-NOT-REAL");
  assert.equal(t.toJSON(), "[redacted]");
  assert.equal(String(t), "[redacted]");
  assert.equal(JSON.stringify([t]).includes("NOT-REAL"), false);
});

test("the resolver is pure: it reads only its argument", () => {
  const before = process.env["METAAPI_PLATFORM_TOKEN"];
  process.env["METAAPI_PLATFORM_TOKEN"] = "ambient-value-NOT-REAL";
  try {
    // An empty record must still yield MA-001 despite the ambient variable.
    assert.equal(resolveMetaApiConfig({}).findings[0]?.code, "MA-001");
  } finally {
    if (before === undefined) delete process.env["METAAPI_PLATFORM_TOKEN"];
    else process.env["METAAPI_PLATFORM_TOKEN"] = before;
  }
});
