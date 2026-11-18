// The relay's redirect contract — the token-exfiltration guard.
//
// SECURITY PROPERTY (S2): the relay token (`X-Velora-Relay-Token`) is the only
// secret on the wire, and the transport's own header comment promises "redirects
// are not followed (a 3xx would take the token somewhere else)". That promise is
// a property of the fetch OPTIONS, not of the fetch API default: without
// `redirect: "error"`, a 3xx from the relay origin is FOLLOWED by the runtime,
// and the redirect hop re-sends the request headers — the relay token — to
// whatever destination the (potentially compromised or misconfigured) relay
// names. 307/308 additionally replay the body.
//
// These tests pin the enforcement: the transport must create its fetch with
// `redirect: "error"`, a 3xx must surface as a classified AiFailure (never as
// content), and exactly one request must ever be made.
//
// The injected fetch emulates undici's redirect handling at the two points that
// matter: `redirect: "error"` + 3xx ⇒ TypeError ("Unexpected redirect");
// anything else + 3xx ⇒ the 3xx response object comes back (the pre-fix world
// the token must never be exposed to again).
import { test } from "node:test";
import assert from "node:assert/strict";
import { AiFailure } from "./aiErrors.js";
import { N8nRelayTransport, type RelayFetch } from "./n8nRelayTransport.js";

const URL_OK = "https://relay.example/hook";
const TOKEN = "relay-token-under-test";

interface RecordedCall {
  readonly url: string;
  readonly init?: { redirect?: string; headers?: Record<string, string> } | undefined;
}

function redirectAwareFetch(status: number, body: unknown) {
  const calls: RecordedCall[] = [];
  const impl: RelayFetch = async (url, init) => {
    calls.push({ url, init });
    const responseOf = () => ({
      ok: status === 200,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (status >= 300 && status < 400) {
      // undici with `redirect: "error"` throws instead of following.
      if ((init?.redirect ?? "follow") === "error") throw new TypeError("Unexpected redirect");
      // Pre-fix world (fetch default `follow` is emulated as "the 3xx is
      // handed back"): assertions on the captured init catch the missing
      // option regardless of how the transport classifies the 3xx.
      return responseOf();
    }
    return responseOf();
  };
  return { impl, calls };
}

test("a 3xx from the relay never yields content: redirect:'error' is set and one request is made", async () => {
  const { impl, calls } = redirectAwareFetch(302, { success: false, error: { code: "MOVED" } });
  const transport = new N8nRelayTransport({ url: URL_OK, token: TOKEN, fetchImpl: impl });

  await assert.rejects(transport.generateContent("extract", null), (err: unknown) => err instanceof AiFailure);

  assert.equal(calls.length, 1, "exactly one request — no redirect hop");
  assert.equal(calls[0]!.init?.redirect, "error", "fetch must be created with redirect:'error'");
});

test("a redirect refusal classifies as UPSTREAM_UNAVAILABLE (retryable), never as content", async () => {
  const { impl, calls } = redirectAwareFetch(307, { success: false, error: { code: "MOVED" } });
  const transport = new N8nRelayTransport({ url: URL_OK, token: TOKEN, fetchImpl: impl });

  await assert.rejects(
    transport.generateContent("extract", null),
    (err: unknown) => err instanceof AiFailure && err.code === "UPSTREAM_UNAVAILABLE",
  );
  assert.equal(calls.length, 1);
});

test("the success path is unchanged and still pins redirect:'error' + single header placement", async () => {
  const { impl, calls } = redirectAwareFetch(200, {
    success: true,
    request_id: "velora-abc",
    provider: "gemini",
    model: "gemini-relay",
    extraction: "ok",
    meta: { upstream_http_status: 200, latency_ms: 5 },
  });
  const transport = new N8nRelayTransport({ url: URL_OK, token: TOKEN, fetchImpl: impl });

  const result = await transport.generateContent("extract", null);
  assert.equal(result.text, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.init?.redirect, "error");
  // The token rides in exactly one place: the single request's header.
  assert.equal(calls[0]!.init?.headers?.["X-Velora-Relay-Token"], TOKEN);
});
