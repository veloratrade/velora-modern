/**
 * The admin-guard battery for the only authenticated read-only route left on this Worker.
 *
 * These tests came from `src/egressProbe.test.ts`. That route was retired once the webhook was live
 * and its three questions were being answered by cheaper signals (`getWebhookInfo`, `handled` rows,
 * the `code` on a failure log) — see `velora-telegram-bot-deploy/retired/egress-probe/README.md`.
 * The guard itself is not retired, so the coverage is kept here rather than deleted with the route,
 * plus one new check that the removed path is genuinely gone (404, not 401): a route that answers 401
 * is a route still mounted.
 */
import assert from "node:assert/strict";
import test from "node:test";

import worker from "./index.js";
import { adminAuthorized } from "./runtime.js";

const BOT_TOKEN = "123456:AAguardguardguardguardguardguardg";
const ADMIN = "guardtokenfortheadminroute-0123456789ab";
const WEBHOOK_SECRET = "guardwebhooksecretguardwebhooksecret";

const ctx = { waitUntil: () => undefined, props: [] } as never;
const req = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`https://bot.test${path}`, { method, headers });
const baseEnv = () =>
  ({
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_UPDATE_MODE: "webhook",
    WORKER_ADMIN_TOKEN: ADMIN,
  }) as never;

test("adminAuthorized: the exact bearer only, and a too-short token counts as absent", () => {
  assert.equal(adminAuthorized({ WORKER_ADMIN_TOKEN: ADMIN } as never, req("/", { authorization: `Bearer ${ADMIN}` })), true);
  for (const h of [
    {},
    { authorization: "Bearer nope" },
    { authorization: ADMIN },              // the value, without the scheme
    { authorization: `Bearer ${ADMIN.slice(0, 12)}` },
    { authorization: `bearer ${ADMIN}` },  // case matters: this is a literal prefix compare first
  ]) {
    assert.equal(adminAuthorized({ WORKER_ADMIN_TOKEN: ADMIN } as never, req("/", h)), false, JSON.stringify(h));
  }
  // an unset or short admin token must read as "no such route is authorised", never as open
  assert.equal(adminAuthorized({} as never, req("/", { authorization: `Bearer ${ADMIN}` })), false);
  assert.equal(adminAuthorized({ WORKER_ADMIN_TOKEN: "short" } as never, req("/", { authorization: "Bearer short" })), false);
  // Measured, not assumed: a *trailing* space IS accepted, because the Headers API strips optional
  // whitespace per the Fetch spec — the value it hands the guard is already `Bearer <token>`. Asserting
  // otherwise would be asserting a spec violation. Padding *inside* the value — `Bearer␣␣<token>` — is
  // refused, and that is the case that would actually matter.
  assert.equal(adminAuthorized({ WORKER_ADMIN_TOKEN: ADMIN } as never, req("/", { authorization: `Bearer ${ADMIN} ` })), true);
  assert.equal(adminAuthorized({ WORKER_ADMIN_TOKEN: ADMIN } as never, req("/", { authorization: `Bearer  ${ADMIN}` })), false);
});

test("diagnostics: 401 unauthenticated, 200 with the bearer, and never a secret in the body", async () => {
  const anon = await worker.fetch!(req("/api/v1/telegram/diagnostics"), baseEnv(), ctx);
  assert.equal(anon.status, 401, "the route is not open to the internet");
  assert.match(await anon.text(), /UNAUTHENTICATED/);

  // Order matters and is asserted in both directions: an unauthenticated POST gets 401 (the route
  // does not advertise its method), an authenticated POST gets 405 (this route only reads).
  const anonPost = await worker.fetch!(
    req("/api/v1/telegram/diagnostics", { authorization: "Bearer wrong-wrong-wrong", "content-type": "application/json" }, "POST"),
    baseEnv(),
    ctx,
  );
  assert.equal(anonPost.status, 401, "a wrong bearer is refused before the method is even considered");
  const authedPost = await worker.fetch!(
    req("/api/v1/telegram/diagnostics", { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, "POST"),
    baseEnv(),
    ctx,
  );
  assert.equal(authedPost.status, 405, "a read-only route does not accept a write verb");
  assert.match(await authedPost.text(), /METHOD_NOT_ALLOWED/);

  const ok = await worker.fetch!(req("/api/v1/telegram/diagnostics", { authorization: `Bearer ${ADMIN}` }), baseEnv(), ctx);
  assert.equal(ok.status, 200);
  const text = await ok.text();
  for (const secret of [ADMIN, BOT_TOKEN, WEBHOOK_SECRET]) {
    assert.ok(!text.includes(secret), "the response describes state, never values");
  }
  const body = JSON.parse(text) as {
    data: { configured: boolean; reason: string; storage: string; disabled_features: string[] };
  };
  // `configured` is "a runtime was composed", and with neither store present that is false — the
  // route says so instead of counting a bot token as a working deployment.
  assert.equal(body.data.configured, false);
  assert.equal(body.data.reason, "NO_DATABASE_BINDING");
  assert.equal(body.data.storage, "none", "no D1 and no Hyperdrive in this env → the honest answer is 'none'");
  assert.deepEqual(body.data.disabled_features, [], "the disabled list is a D1 statement, so 'none' must not fake it");
});

test("the retired egress probe is really gone: 404, not 401 and not 405", async () => {
  // The distinction is the point. 401 would mean the handler is still mounted and merely guarded,
  // i.e. still reachable surface, still able to be probed for existence. 404 means the route left the
  // routing table, which is what "deleted" has to mean for a diagnostic endpoint.
  for (const headers of [{}, { authorization: `Bearer ${ADMIN}` }]) {
    const res = await worker.fetch!(req("/api/v1/telegram/egress", headers), baseEnv(), ctx);
    assert.equal(res.status, 404, `with ${JSON.stringify(headers)} → ${res.status}`);
    assert.match(await res.text(), /NOT_FOUND/);
  }
  const post = await worker.fetch!(
    req("/api/v1/telegram/egress", { authorization: `Bearer ${ADMIN}` }, "POST"),
    baseEnv(),
    ctx,
  );
  assert.equal(post.status, 404, "and no method resurrects it");
});

test("nothing mounted any more emits `telegram.egress_probe`, and a missing store is still a 503", async () => {
  // Two properties in one test, because both are about what the ingress does when there is no
  // destination database at all. (1) `telegram.egress_probe` was produced only by the retired
  // route; if it can still be emitted, the deletion was cosmetic. (2) With no D1 and no Hyperdrive,
  // the handler must refuse to acknowledge — a 200 here would tell Telegram the update was processed
  // when nothing was stored anywhere.
  const capture = async (env: never) => {
    const original = console.log;
    const seen: string[] = [];
    console.log = (...args: unknown[]) => { seen.push(args.map((a) => String(a)).join(" ")); };
    try {
      const res = await worker.fetch!(
        new Request("https://bot.test/api/v1/webhooks/telegram", {
          method: "POST",
          headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
          body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 1 }, from: { id: 1 }, text: "/start" } }),
        }),
        env,
        ctx,
      );
      return { status: res.status, body: await res.text(), seen };
    } finally {
      console.log = original;
    }
  };

  const unguarded = await capture(baseEnv());
  assert.equal(unguarded.status, 503, `gate unarmed must not acknowledge: ${unguarded.status}`);
  assert.match(unguarded.body, /ACCESS_GATE_UNCONFIGURED/);

  const armedNoStore = await capture({ ...baseEnv(), TELEGRAM_TEST_USER_ID: "777001" } as never);
  assert.equal(armedNoStore.status, 503, `no destination database must not acknowledge: ${armedNoStore.status}`);
  assert.match(armedNoStore.body, /TELEGRAM_NOT_CONFIGURED|NO_DATABASE_BINDING/);

  for (const run of [unguarded, armedNoStore]) {
    assert.ok(!run.seen.some((s) => s.includes("egress_probe")), "the retired probe is not emitting");
    assert.ok(!run.seen.some((s) => s.includes(WEBHOOK_SECRET) || s.includes(BOT_TOKEN) || s.includes(ADMIN)),
      "and the refusal path logs codes, never credentials");
  }
});
