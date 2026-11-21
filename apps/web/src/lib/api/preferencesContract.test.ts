// PROFILE-01 — preference-update wire contract.
//
// `PATCH /api/v1/auth/me/preferences` is the Modern contract for updating the
// profile-relevant fields (locale, ai_consent). `GET /api/v1/auth/me` is the
// identity source the profile page reads back. This test pins the request
// shape the client sends so a silent drift (wrong method, path, or body keys)
// is caught here instead of in production.
//
// Runs with no browser: `globalThis.fetch` is doubled, so this is a pure
// wire-contract test, same class as `analyticsContract.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getMe, updatePreferences } from "./resources.js";

type Call = { path: string; method: string; body?: unknown };
const calls: Call[] = [];

// A canned profile user — the shape `GET /api/v1/auth/me` answers.
const ME_USER = {
  id: 11,
  email: "ada@example.ir",
  fullName: "Ada Lovelace",
  role: "user",
  plan: "free",
  timezone: "Asia/Tehran",
  locale: "fa",
  createdAt: "2026-01-01T00:00:00Z",
  aiConsent: true,
};

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const raw = String(input);
  const pathname = raw.startsWith("http") ? new URL(raw).pathname : raw;
  const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
  calls.push({ path: pathname, method: init?.method ?? "GET", body });

  if (pathname === "/api/v1/auth/me") {
    return new Response(JSON.stringify({ data: { user: ME_USER } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (pathname === "/api/v1/auth/me/preferences") {
    return new Response(
      JSON.stringify({ data: { locale: "en", ai_consent: true, ai_consent_at: "2026-02-02T00:00:00Z" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
};

function firstCall(): Call {
  assert.equal(calls.length, 1, "exactly one request");
  return calls[0]!;
}

test("getMe() calls GET /api/v1/auth/me and normalizes the numeric id to string", async () => {
  calls.length = 0;
  const { user } = await getMe();

  const c = firstCall();
  assert.equal(c.path, "/api/v1/auth/me");
  assert.equal(c.method, "GET");
  assert.equal(c.body, undefined, "GET /me has no body");

  // `AccountUserView.id` is a string; Modern answers numeric ids here and the
  // client normalizes (mirrors client.setSession).
  assert.equal(typeof user.id, "string");
  assert.equal(user.id, "11");
  assert.equal(user.fullName, "Ada Lovelace");
  assert.equal(user.locale, "fa");
  assert.equal(user.aiConsent, true);
});

test("updatePreferences() calls PATCH /api/v1/auth/me/preferences with {locale, ai_consent}", async () => {
  calls.length = 0;
  const result = await updatePreferences({ locale: "en", ai_consent: true });

  const c = firstCall();
  assert.equal(c.path, "/api/v1/auth/me/preferences");
  assert.equal(c.method, "PATCH");
  assert.deepEqual(c.body, { locale: "en", ai_consent: true });

  assert.equal(result.locale, "en");
  assert.equal(result.ai_consent, true);
});

test("updatePreferences() sends only the fields the caller provided", async () => {
  calls.length = 0;
  await updatePreferences({ ai_consent: false });

  const c = firstCall();
  assert.equal(c.method, "PATCH");
  assert.deepEqual(c.body, { ai_consent: false });
});
