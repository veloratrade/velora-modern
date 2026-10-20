// The defect this file exists to prevent, stated plainly.
//
// `TelegramBotDeps.posts` and `.tools` are OPTIONAL — and correctly so: a local harness genuinely
// has no channel-publishing wiring, and the bot is required to say "that capability is not
// configured" instead of half-doing it. The cost of that optionality is that a runtime which simply
// never passes them still compiles, still serves /health and /ready, and still journals messages —
// while `/post`, `/template`, the inline publish buttons and the whole agent loop answer "not
// configured". That is what the deployed Worker did: the round-3/4 work was in `apps/api`, and this
// host was never updated to hand it over.
//
// A unit test cannot catch that by behaviour without a database and a live Bot API, and a
// `tsc`-only gate cannot catch it at all, because nothing is missing from a type's point of view.
// So this test pins the WIRING itself: the postgres branch of `composeRuntime` must construct and
// pass these capabilities. It reads the source rather than the object graph on purpose — the
// assertion is "the deployment composes them", which is exactly the invariant that broke.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");

/** The `new TelegramBot({...})` call in this file, from its opening brace to the matching `});`. */
function telegramBotCall(text: string): string {
  const start = text.indexOf("const bot = new TelegramBot({");
  assert.notEqual(start, -1, "composeRuntime builds exactly one TelegramBot");
  const end = text.indexOf("\n  });", start);
  assert.notEqual(end, -1, "the constructor call is closed");
  return text.slice(start, end);
}

test("the deployed runtime hands TelegramBot the prepared-posts service", () => {
  const call = telegramBotCall(source);
  assert.match(call, /\bposts,\s*\n/u, "`posts` must be passed, not left absent");
  assert.match(
    source,
    /const posts = new TelegramPostService\(\{/u,
    "and it must be the shared service, not a stand-in",
  );
});

test("the deployed runtime hands TelegramBot the agent tools and a real media interpreter", () => {
  const call = telegramBotCall(source);
  assert.match(call, /\btools:\s*\{\s*search:\s*searchTools,\s*browser:\s*browserTools,\s*planner:\s*agentPlanner\s*\}/u);
  // v39's tell: the "not configured" interpreter. Media must ride the governed manager so voice
  // notes and screenshots obey the same flag gate, consent and attempt ledger as the API path.
  assert.doesNotMatch(call, /UnconfiguredMediaInterpreter/u, "no stub interpreter on this host");
  assert.match(source, /new AiManagerMediaInterpreter\(aiManager\)/u);
});

test("the deployed runtime keeps the D-2 boundary: env-only AI secrets", () => {
  // The worker must not read admin-encrypted secrets: no CREDENTIAL_MASTER_KEY, no crypto import.
  assert.doesNotMatch(source, /CREDENTIAL_MASTER_KEY/u);
  assert.doesNotMatch(source, /credentialCrypto|credential-crypto/u);
  assert.match(source, /new EnvironmentAiSecretResolver\(aiEnv\)/u);
});

test("the deployed runtime declares the banner capability honestly", () => {
  // No native resvg in workerd: the capability is present and returns null, which the publish path
  // reads as "send the text card and say so". Silence here would be the substituted-image failure.
  assert.match(source, /renderBannerPng: async \(\) => null/u);
});

test("link buttons can only point at the configured app host", () => {
  assert.match(source, /const allowedLinkHosts = \(appUrl: string \| null\)/u);
  assert.match(source, /allowedLinkHosts: allowedLinkHosts\(/u);
});
