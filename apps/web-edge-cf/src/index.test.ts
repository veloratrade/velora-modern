import test from "node:test";
import assert from "node:assert/strict";
import { createHandler, type EdgeEnv } from "./handler.ts";

/**
 * src/index.ts is the Workers entry point: a five-line wiring of the tested pure handler. It must
 * contain no logic — logic lives in handler.ts where node --test can reach it.
 */
test("the exported fetch handler delegates every request to the tested router", async () => {
  const calls: string[] = [];
  const env: EdgeEnv = { VELORA_API_ORIGIN: "https://app.internal" };
  const handler = createHandler(
    env,
    { fetch: async () => new Response("", { status: 404 }) },
    async (input) => {
      calls.push(new URL(String(input)).pathname);
      return new Response("proxied", { status: 200, headers: { "content-type": "text/html" } });
    },
  );
  const res = await handler(new Request("https://edge/some/page"));
  assert.equal(await res.text(), "proxied");
  assert.deepEqual(calls, ["/some/page"]);
});
