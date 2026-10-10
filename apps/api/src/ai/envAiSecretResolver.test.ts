import { test } from "node:test";
import assert from "node:assert/strict";
import { EnvironmentAiSecretResolver } from "./envAiSecretResolver.js";

test("environment-only AI secret resolution trims values and reports no configured secret honestly", async () => {
  const values: Record<string, string | undefined> = {
    GEMINI_API_KEY: "  test-key  ",
    GEMINI_RELAY_URL: "   ",
  };
  const resolver = new EnvironmentAiSecretResolver((key) => values[key]);

  assert.deepEqual(await resolver.resolve("GEMINI_API_KEY"), { value: "test-key", source: "env" });
  assert.deepEqual(await resolver.resolve("GEMINI_RELAY_URL"), { value: null, source: null });
  assert.deepEqual(await resolver.resolve("OPENAI_API_KEY"), { value: null, source: null });
});
