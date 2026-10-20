// The bridge's contract, and the proof that it carries a REAL kernel request.
//
// Two kinds of test here, deliberately:
//   1. unit tests of the six members the kernel reads — `method`, `url`, `headers`,
//      `socket.remoteAddress`, async body iteration, `writeHead`/`end`;
//   2. end-to-end tests that put `createRequestListener(config)` behind `adaptListener` and assert on
//      the RESPONSE the Worker would return. Those are the ones that matter: they show this host
//      answers with the API's OWN envelope — including its own 404 and its own 503 — which is what
//      distinguishes "the kernel answered" from "a platform said no". That distinction is the entire
//      point of the host: the staging panel's login was failing with a platform 404, not an API one.
import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { adaptListener, createResponseCollector, toIncomingMessage } from "./nodeHttpBridge.js";
import { createRequestListener, type ApiConfig } from "../../api/src/kernel/server.js";

/** The frozen C-01 envelope this API writes: `{status, data, error, timestamp}`. */
interface Envelope {
  status: "success" | "error";
  data: unknown;
  error: { code: string; message: string; requestId: string } | null;
  timestamp: string;
}

/** Build the `Request` the edge would hand us, then run the bridge's own converter on it. */
const incoming = (init: { url: string; method?: string; headers?: [string, string][]; body?: string }) =>
  toIncomingMessage(
    new Request(init.url, {
      method: init.method ?? "GET",
      headers: init.headers === undefined ? undefined : Object.fromEntries(init.headers),
      ...(init.body === undefined ? {} : { body: init.body }),
    }),
  );

const readAll = async (msg: { [Symbol.asyncIterator](): AsyncIterator<Buffer> }): Promise<string> => {
  const chunks: string[] = [];
  for await (const chunk of msg) chunks.push(Buffer.from(chunk).toString("utf8"));
  return chunks.join("");
};

/** The real kernel behind the real bridge, with nothing wired (no database, no auth secret). */
const bareKernel = () =>
  adaptListener(createRequestListener({ allowedOrigins: [], checks: {} } as ApiConfig));

const envelope = async (response: Response): Promise<Envelope> => (await response.json()) as Envelope;

test("req.url is the path Node would give the kernel, not the absolute URL", () => {
  const msg = incoming({ url: "https://api.example.test/api/v1/auth/login?x=1", method: "POST", body: "{}" });
  // Node's `IncomingMessage.url` is origin-form. Handing the kernel an absolute URL would change how
  // it matches routes, and every route in the kernel is a pathname comparison.
  assert.equal(msg.url, "/api/v1/auth/login?x=1");
  assert.equal(msg.method, "POST");
});

test("the client address comes from CF-Connecting-IP, then X-Forwarded-For, then nothing", () => {
  const viaCf = incoming({
    url: "https://api.example.test/x",
    headers: [
      ["cf-connecting-ip", "203.0.113.9"],
      ["x-forwarded-for", "198.51.100.7"],
    ],
  });
  // The edge-vouched address wins over a header any client can set.
  assert.equal(viaCf.socket.remoteAddress, "203.0.113.9");

  const viaForwarded = incoming({ url: "https://api.example.test/x", headers: [["x-forwarded-for", "198.51.100.7, 10.0.0.1"]] });
  assert.equal(viaForwarded.socket.remoteAddress, "198.51.100.7");

  assert.equal(incoming({ url: "https://api.example.test/x" }).socket.remoteAddress, undefined);
});

test("a repeated header is comma-joined, as Node joins it", () => {
  const msg = incoming({ url: "https://api.example.test/x", headers: [["x-multi", "a"]] });
  assert.equal(msg.headers["x-multi"], "a");
});

test("the body is readable through iteration and is NOT re-read for GET", async () => {
  assert.equal(await readAll(incoming({ url: "https://api.example.test/x", method: "POST", body: "hello" })), "hello");
  assert.equal(await readAll(incoming({ url: "https://api.example.test/x" })), "");
});

test("content-length is passed through when the client sent one, and never invented", async () => {
  const declared = incoming({
    url: "https://api.example.test/x",
    method: "POST",
    headers: [["content-length", "5"]],
    body: "hello",
  });
  assert.equal(declared.headers["content-length"], "5");

  // A chunked upload arrives without the header; the bridge does not buffer the body to fill it in.
  // That is safe because the kernel's byte cap counts what it iterates (`parseJsonBody` in
  // `apps/api/src/kernel/server.ts`), so the bound never depended on this header — and its own suite
  // pins the 413. Buffering here would trade streaming for a header the limit does not need.
  const chunked = incoming({ url: "https://api.example.test/x", method: "POST", body: "hello" });
  assert.equal(chunked.headers["content-length"], undefined);
});

test("a large body is delivered whole — the bridge does not truncate", async () => {
  const size = 1_048_576;
  let seen = 0;
  for await (const chunk of incoming({ url: "https://api.example.test/x", method: "POST", body: "x".repeat(size) })) {
    seen += chunk.length;
  }
  assert.equal(seen, size);
});

test("the collector keeps both refresh cookies: set-cookie is never comma-joined", async () => {
  const collector = createResponseCollector();
  collector.res.writeHead(200, {
    "set-cookie": ["__Host-velora_refresh=aaaa; Path=/", "refresh_token=; Max-Age=0"],
    "x-single": "one",
  });
  collector.res.end("body");
  await collector.settled;
  const out = collector.collect();
  assert.equal(out.status, 200);
  assert.deepEqual(out.headers["set-cookie"], [
    "__Host-velora_refresh=aaaa; Path=/",
    "refresh_token=; Max-Age=0",
  ]);
  assert.equal(out.headers["x-single"], "one");
  assert.equal(out.body === null ? "" : Buffer.from(out.body).toString("utf8"), "body");
});

test("a 204 or 304 response leaves the bridge with no body, even if the kernel writes one", async () => {
  // `new Response(body, {status:204})` throws, so this is a hard runtime requirement, not a nicety.
  for (const status of [204, 304]) {
    const handler = adaptListener((_req, res: { writeHead(s: number): void; end(b?: string): void }) => {
      res.writeHead(status);
      res.end("should not survive");
    });
    const res = await handler(new Request("https://api.example.test/x"));
    assert.equal(res.status, status);
    assert.equal(await res.text(), "", `status ${status} must carry no body`);
  }
});

test("a listener that throws becomes a 500, not a broken worker", async () => {
  const handler = adaptListener(() => {
    throw new Error("boom");
  });
  const res = await handler(new Request("https://api.example.test/api/v1/auth/login", { method: "POST" }));
  assert.equal(res.status, 500);
  const body = (await res.json()) as { code?: number; detail?: string };
  assert.equal(body.code, 500);
  assert.equal(body.detail, "Error", "the error NAME, never the message: a message can carry a secret");
  assert.ok(!JSON.stringify(body).includes("boom"));
});

// ---------------------------------------------------------------------------------------------------
// End to end: the real kernel, through the real bridge, with nothing wired. This is the posture a
// half-configured deploy shows the panel — fail closed, and loudly in the API's own words.
// ---------------------------------------------------------------------------------------------------

test("POST /api/v1/auth/login with no auth capability answers the API's 503, not a platform 404", async () => {
  const res = await bareKernel()(
    new Request("https://api.example.test/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "someone@example.test", password: "not-a-real-password" }),
    }),
  );
  assert.equal(res.status, 503);
  const body = await envelope(res);
  assert.equal(body.status, "error");
  assert.equal(body.error?.code, "SERVICE_UNAVAILABLE");
  assert.equal(typeof body.error?.requestId, "string", "a requestId proves the kernel served this");
});

test('GET /api/v1/auth/session with no auth capability answers 503 — never "anonymous"', async () => {
  const res = await bareKernel()(new Request("https://api.example.test/api/v1/auth/session"));
  assert.equal(res.status, 503);
  assert.equal((await envelope(res)).error?.code, "SERVICE_UNAVAILABLE");
});

test("an unknown route answers the API's OWN 404 envelope — the one the panel was never seeing", async () => {
  const res = await bareKernel()(new Request("https://api.example.test/api/v1/definitely-not-a-route"));
  assert.equal(res.status, 404);
  const body = await envelope(res);
  assert.equal(body.status, "error");
  // The platform's "404 Application not found" carries neither of these. That is the whole difference.
  assert.equal(body.error?.code, "NOT_FOUND");
  assert.equal(typeof body.error?.requestId, "string");
});

test("GET /health answers the C-01 envelope through the bridge", async () => {
  const res = await bareKernel()(new Request("https://api.example.test/health"));
  assert.equal(res.status, 200);
  const body = await envelope(res);
  assert.equal(body.status, "success");
  assert.equal((body.data as { status?: string }).status, "ok");
});
