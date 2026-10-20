import test from "node:test";
import assert from "node:assert/strict";
import { routeEdgeRequest, type AssetsNamespace, type EdgeEnv } from "./handler.ts";

const env: EdgeEnv = {
  VELORA_API_ORIGIN: "https://app.internal",
  VELORA_NOINDEX: "true",
};

function makeAssets(hit: boolean): AssetsNamespace & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async fetch() {
      calls++;
      return hit
        ? new Response("css-bytes", { status: 200, headers: { "content-type": "text/css" } })
        : new Response("not found", { status: 404 });
    },
  };
}

test("asset hit is served by the assets binding and never proxies", async () => {
  const assets = makeAssets(true);
  let proxied = 0;
  const res = await routeEdgeRequest(new Request("https://edge/next/static/app.css".replace("/next", "/_next")), env, {
    assets,
    fetch: async () => {
      proxied++;
      throw new Error("must not proxy");
    },
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "css-bytes");
  assert.equal(proxied, 0);
  assert.equal(assets.calls, 1);
});

test("asset miss falls through to the proxy (no accidental 404 on a page asset)", async () => {
  const assets = makeAssets(false);
  const res = await routeEdgeRequest(new Request("https://edge/_next/static/late.css"), env, {
    assets,
    fetch: async () => new Response("from app", { status: 200, headers: { "content-type": "text/css" } }),
  });
  assert.equal(await res.text(), "from app");
});

test("page paths proxy with method, query and manual redirect handling", async () => {
  let seen: { url: string; method: string; init: RequestInit | undefined } | null = null;
  const res = await routeEdgeRequest(new Request("https://edge/en/dashboard?x=1", { headers: { cookie: "a=b" } }), env, {
    assets: makeAssets(false),
    fetch: async (url, init) => {
      seen = { url: String(url), method: String(init?.method), init };
      return new Response(null, { status: 302, headers: { location: "/en/login", "cache-control": "no-store" } });
    },
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/en/login"); // verbatim, not followed
  assert.equal(seen!.url, "https://app.internal/en/dashboard?x=1");
  assert.equal(seen!.method, "GET");
  assert.equal((seen!.init!.headers as Headers).get("cookie"), "a=b");
  assert.equal(seen!.init!.redirect, "manual");
});

test("non-GET forwards a body", async () => {
  let bodySeen: BodyInit | null | undefined = "unset";
  await routeEdgeRequest(new Request("https://edge/api/v1/login", { method: "POST", body: "{}" }), env, {
    assets: makeAssets(false),
    fetch: async (_u, init) => {
      bodySeen = init?.body as BodyInit;
      return new Response("ok", { status: 200 });
    },
  });
  assert.ok(bodySeen, "body must reach the upstream");
});

test("x-robots-tag is added to HTML only, and never overrides an existing value", async () => {
  const html = await routeEdgeRequest(new Request("https://edge/"), env, {
    assets: makeAssets(false),
    fetch: async () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
  });
  assert.equal(html.headers.get("x-robots-tag"), "noindex, nofollow");

  const json = await routeEdgeRequest(new Request("https://edge/api/v1/health"), env, {
    assets: makeAssets(false),
    fetch: async () => Response.json({ code: 404 }, { status: 404 }),
  });
  assert.equal(json.headers.get("x-robots-tag"), null, "API JSON must not get the HTML contract");

  const app = await routeEdgeRequest(new Request("https://edge/"), { ...env, VELORA_NOINDEX: "true" }, {
    assets: makeAssets(false),
    fetch: async () =>
      new Response("<html></html>", { status: 200, headers: { "content-type": "text/html", "x-robots-tag": "noindex" } }),
  });
  assert.equal(app.headers.get("x-robots-tag"), "noindex", "the app's own value wins");

  const off = await routeEdgeRequest(new Request("https://edge/"), { ...env, VELORA_NOINDEX: "false" }, {
    assets: makeAssets(false),
    fetch: async () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
  });
  assert.equal(off.headers.get("x-robots-tag"), null, "noindex off means off");
});

test("a malformed origin is a loud 503, not a silent pass-through", async () => {
  const res = await routeEdgeRequest(new Request("https://edge/"), { ...env, VELORA_API_ORIGIN: "app.internal" }, {
    assets: makeAssets(false),
    fetch: async () => {
      throw new Error("unreachable");
    },
  });
  assert.equal(res.status, 503);
  const body = (await res.json()) as { message: string };
  assert.match(body.message, /edge_misconfigured/);
});

// ── a dead origin is not a missing route ───────────────────────────────────
//
// Observed live on 2026-10-20: every `/api/*` call, and the login POST itself, came back as
// `{"status":"error","code":404,"message":"Application not found","request_id":…}` — the fronting
// platform's envelope for a service that is not running. Passed through unchanged it reads as "this
// route does not exist", which is the wrong diagnosis and hides the actual blocker (no API origin).
test("the host's 'Application not found' envelope becomes a 503 that names the real cause", async () => {
  const platformBody = JSON.stringify({
    status: "error",
    code: 404,
    message: "Application not found",
    request_id: "abc123",
  });
  const fetchImpl = async () =>
    new Response(platformBody, { status: 404, headers: { "content-type": "application/json" } });

  const res = await routeEdgeRequest(
    new Request("https://staging.example/api/v1/auth/login", { method: "POST", body: "{}" }),
    env,
    { assets: makeAssets(false), fetch: fetchImpl },
  );
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("x-velora-edge"), "origin-unavailable");
  const body = (await res.json()) as { error: string; message: string };
  assert.equal(body.error, "edge_app_origin_unavailable");
  assert.ok(body.message.includes("not running"), "the sentence says what is wrong");
});

test("the app's OWN 404 keeps its status, its body and its headers", async () => {
  // The distinction is the whole point: a route the app does not have is the app's answer, and the
  // edge must not launder it into an infrastructure error.
  const appBody = JSON.stringify({ status: "error", code: 404, message: "NOT_FOUND", request_id: "r1" });
  const fetchImpl = async () =>
    new Response(appBody, { status: 404, headers: { "content-type": "application/json" } });

  const res = await routeEdgeRequest(
    new Request("https://staging.example/api/v1/nope"),
    env,
    { assets: makeAssets(false), fetch: fetchImpl },
  );
  assert.equal(res.status, 404);
  assert.equal(await res.text(), appBody);
});

test("a server-rendered page still reaches the browser untouched", async () => {
  // Nothing above may touch a healthy origin: the no-index rule adds one header and changes nothing else.
  const html = "<!doctype html><html><body>login</body></html>";
  const fetchImpl = async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

  const res = await routeEdgeRequest(
    new Request("https://staging.example/login"),
    env,
    { assets: makeAssets(false), fetch: fetchImpl },
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(await res.text(), html);
});
