// Telegram configuration — fail-closed resolution and secret hygiene.
//
// A bot token is a credential that can speak as the bot, so the two properties
// pinned here are: a missing or malformed token removes the capability instead of
// producing a half-working one, and the resolved value cannot leak through a log,
// a JSON dump or an error message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTelegramConfig, webhookSecretMatches } from "./telegramConfig.js";

const TOKEN = "123456789:AAHtest-token-value-0123456789abcdef";
const SECRET = "whsec_test_0123456789abcdef";

const base = {
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_BOT_USERNAME: "velora_journal_bot",
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  TELEGRAM_UPDATE_MODE: "webhook",
  VELORA_APP_URL: "https://app.velora.example",
  APP_ENV: "development",
} as const;

test("a fully configured environment resolves every capability, and the token never prints", async () => {
  const resolved = resolveTelegramConfig(base);
  assert.deepEqual(resolved.findings, []);
  assert.equal(resolved.configured, true);
  assert.equal(resolved.linkingConfigured, true);
  assert.equal(resolved.webhookConfigured, true);
  assert.equal(resolved.updateMode, "webhook");
  assert.equal(resolved.updatesConsumed, true);

  // The holder reveals nothing through the two paths a log line would take.
  assert.equal(String(resolved.botToken), "[redacted]");
  assert.equal(JSON.stringify(resolved), JSON.stringify({ ...resolved, botToken: "[redacted]", webhookSecret: "[redacted]" }));
  assert.ok(!JSON.stringify(resolved).includes(TOKEN));
  assert.ok(!JSON.stringify(resolved).includes(SECRET));
  // The single reviewable choke point still returns the real value.
  assert.equal(resolved.botToken?.reveal(), TOKEN);
});

test("a missing token removes the whole capability (the web product is unaffected)", async () => {
  const resolved = resolveTelegramConfig({ ...base, TELEGRAM_BOT_TOKEN: "" });
  assert.equal(resolved.configured, false);
  assert.equal(resolved.updatesConsumed, false);
  assert.deepEqual(
    resolved.findings.map((f) => f.code),
    ["TG-001"],
  );
  // The finding message is FIXED TEXT: it names the variable, never its value.
  assert.ok(resolved.findings.every((f) => !f.message.includes(TOKEN)));
});

test("a malformed token is refused by shape, before any request is attempted", async () => {
  for (const wrong of ["not-a-token", "123456789", "abc:def", "123456789:short"]) {
    const resolved = resolveTelegramConfig({ ...base, TELEGRAM_BOT_TOKEN: wrong });
    assert.equal(resolved.configured, false, `${wrong} must not resolve`);
    assert.ok(resolved.findings.some((f) => f.code === "TG-002"));
  }
  // A key belonging to ANOTHER service pasted into the Telegram variable is
  // caught by the same rule (a real one is not shaped like `<id>:<secret>`).
  const wrongVariable = resolveTelegramConfig({ ...base, TELEGRAM_BOT_TOKEN: "example-gemini-api-key-pasted-in-error" });
  assert.equal(wrongVariable.configured, false);
});

test("a missing bot username disables LINKING only, and a missing secret disables INGRESS only", async () => {
  const noUsername = resolveTelegramConfig({ ...base, TELEGRAM_BOT_USERNAME: "" });
  assert.equal(noUsername.configured, true);
  assert.equal(noUsername.linkingConfigured, false);
  assert.equal(noUsername.webhookConfigured, true);
  assert.deepEqual(noUsername.findings.map((f) => f.code), ["TG-003"]);

  const noSecret = resolveTelegramConfig({ ...base, TELEGRAM_WEBHOOK_SECRET: "" });
  assert.equal(noSecret.configured, true);
  assert.equal(noSecret.webhookConfigured, false);
  // TWO distinct facts are reported (the secret is missing, and the requested
  // webhook mode cannot be honoured) — both are TG-004, and neither is silent.
  assert.deepEqual([...new Set(noSecret.findings.map((f) => f.code))], ["TG-004"]);
  assert.equal(noSecret.updateMode, "off");
});

test("a non-https application URL is refused, with loopback allowed for development", async () => {
  const plain = resolveTelegramConfig({ ...base, VELORA_APP_URL: "http://app.velora.example" });
  assert.equal(plain.appUrl, null);
  assert.ok(plain.findings.some((f) => f.code === "TG-005"));

  const loopback = resolveTelegramConfig({ ...base, VELORA_APP_URL: "http://127.0.0.1:3000" });
  assert.equal(loopback.appUrl, "http://127.0.0.1:3000");
  assert.equal(loopback.linkingConfigured, true);

  // APP_ORIGIN is the fallback (the same origin the platform already binds to).
  const fallback = resolveTelegramConfig({ ...base, VELORA_APP_URL: "", APP_ORIGIN: "https://app.velora.example" });
  assert.equal(fallback.appUrl, "https://app.velora.example");
});

test("the consumer is an explicit choice: no mode means no consumer, polling is refused in production", async () => {
  const unset = resolveTelegramConfig({ ...base, TELEGRAM_UPDATE_MODE: "" });
  assert.equal(unset.updateMode, "off");
  assert.equal(unset.updatesConsumed, false);
  assert.ok(unset.findings.some((f) => f.code === "TG-006"));

  const nonsense = resolveTelegramConfig({ ...base, TELEGRAM_UPDATE_MODE: "longpoll" });
  assert.equal(nonsense.updateMode, "off");
  assert.ok(nonsense.findings.some((f) => f.code === "TG-006"));

  // Webhook mode without a secret would accept unsigned deliveries: refused.
  const webhookNoSecret = resolveTelegramConfig({ ...base, TELEGRAM_WEBHOOK_SECRET: "", TELEGRAM_UPDATE_MODE: "webhook" });
  assert.equal(webhookNoSecret.updateMode, "off");
  assert.ok(webhookNoSecret.findings.some((f) => f.code === "TG-004"));

  // Polling in development is allowed…
  const dev = resolveTelegramConfig({ ...base, TELEGRAM_UPDATE_MODE: "polling", APP_ENV: "development" });
  assert.equal(dev.updateMode, "polling");

  // …and refused in production, because a second replica would become a second
  // consumer of the same update stream.
  const prod = resolveTelegramConfig({ ...base, TELEGRAM_UPDATE_MODE: "polling", APP_ENV: "production" });
  assert.equal(prod.updateMode, "off");
  assert.equal(prod.updatesConsumed, false);
  assert.ok(prod.findings.some((f) => f.code === "TG-007"));
});

test("the secret token comparison is exact and fails closed on absence", async () => {
  assert.equal(webhookSecretMatches(SECRET, SECRET), true);
  assert.equal(webhookSecretMatches(SECRET, `${SECRET} `), true); // trimmed, like the header
  assert.equal(webhookSecretMatches(SECRET, "whsec_other_0123456789abcdef"), false);
  assert.equal(webhookSecretMatches(SECRET, SECRET.slice(0, -1)), false); // prefix is not enough
  assert.equal(webhookSecretMatches(SECRET, ""), false);
  assert.equal(webhookSecretMatches(SECRET, null), false);
  assert.equal(webhookSecretMatches(SECRET, undefined), false);
});
