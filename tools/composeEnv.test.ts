// Compose ↔ boot-gate contract (OPS-1).
//
// `infra/docker-compose.yml` is the reproducible dev/staging stack, but the
// walker in tools/run-tests.mjs deliberately skips `infra/`, so the contract is
// asserted from here instead: the api service must supply every variable the
// boot gate (`apps/api/src/kernel/boot.ts` → ADR-013 EO-*, SC-*) treats as a
// BLOCK when missing, must bind the container interface (HOST=0.0.0.0 — the
// server's own default is loopback, which the web service cannot reach), and
// the stack must apply migrations (the api image now carries db/ and a one-shot
// migrate service runs the same command `railway.json` uses).
//
// The YAML extraction below is a targeted parser for THIS file's map-style
// `environment:` blocks — not a general YAML implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBootable } from "../apps/api/src/kernel/boot.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const composeText = readFileSync(join(ROOT, "infra", "docker-compose.yml"), "utf8");
const dockerfileText = readFileSync(join(ROOT, "infra", "Dockerfile.api"), "utf8");

/** The lines of one top-level (2-space-indented) service block. */
function serviceBlock(name: string): string[] {
  const lines = composeText.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.notEqual(start, -1, `compose must define the '${name}' service`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^  [A-Za-z0-9_-]+:$/.test(l));
  return rest.slice(0, end === -1 ? rest.length : end);
}

/** The map-style `environment:` entries of a service block. */
function envOf(block: string[]): Record<string, string> {
  const envStart = block.findIndex((l) => /^    environment:$/.test(l));
  const env: Record<string, string> = {};
  if (envStart === -1) return env;
  for (const line of block.slice(envStart + 1)) {
    if (/^      #/.test(line) || line.trim() === "") continue; // comments inside the block
    const m = /^      ([A-Z0-9_]+):\s?(.*)$/.exec(line);
    if (!m) break; // dedent to the next key of the service
    env[m[1]!] = m[2]!.trim();
  }
  return env;
}

const apiEnv = envOf(serviceBlock("api"));

test("api environment carries every variable the boot gate BLOCKs without (ADR-013 EO-*, SC-*)", () => {
  for (const key of [
    "DATABASE_URL", // SC-006 (PERSISTENCE=postgres requires it)
    "API_ALLOWED_ORIGINS", // SC-007 (explicit allowlist outside development)
    "APP_ENV", // EO-001 (no implicit default)
    "APP_ORIGIN", // EO-002 (no implicit default)
    "CANONICAL_STAGING_ORIGINS", // EO-008 (staging cannot validate without it)
    "CANONICAL_PRODUCTION_ORIGINS", // EO-009
    "JWT_SECRET", // SC-001/SC-002 (required outside development)
    "PERSISTENCE", // SC-005 (explicit outside development)
    "HOST", // the server defaults to loopback; the web service cannot reach that
  ]) {
    assert.ok(key in apiEnv, `api environment is missing ${key}`);
  }
});

test("the container binds the service interface and stays durable-by-construction", () => {
  assert.equal(apiEnv["HOST"], "0.0.0.0", "api must listen on the container interface, not loopback");
  assert.equal(apiEnv["PERSISTENCE"], "postgres", "this stack IS postgres-backed; memory must not be reachable");
});

test("identity/secret values are passed through from .env, never defaulted in the template", () => {
  assert.equal(apiEnv["APP_ENV"], "${APP_ENV}");
  assert.equal(apiEnv["APP_ORIGIN"], "${APP_ORIGIN}");
  assert.ok(apiEnv["JWT_SECRET"]!.startsWith("${JWT_SECRET"), "JWT_SECRET must come from the environment");
});

test("the stack applies migrations: api image carries db/ and a one-shot migrate service runs first", () => {
  assert.ok(dockerfileText.includes("COPY db/ db/"), "Dockerfile.api must COPY db/ for the migration runner");
  const migrateBlock = serviceBlock("migrate").join("\n");
  assert.ok(migrateBlock.includes("db/migrate.ts"), "migrate service must run the real migration CLI");
  assert.ok(/restart:\s*"?no"?/.test(migrateBlock), "migrate is one-shot, not a long-running service");
  const apiBlock = serviceBlock("api").join("\n");
  assert.ok(
    /migrate:\s*\n\s*condition:\s*service_completed_successfully/.test(apiBlock),
    "api must not start before migrations completed successfully",
  );
});

test("web keeps its API origin (same-origin forwarding contract)", () => {
  const webEnv = envOf(serviceBlock("web"));
  assert.ok((webEnv["VELORA_API_ORIGIN"] ?? "").length > 0, "web needs VELORA_API_ORIGIN");
});

test("a development .env satisfies the boot gate through the compose variable set", () => {
  const env = substitute(apiEnv, {
    APP_ENV: "development",
    APP_ORIGIN: "http://127.0.0.1:3000",
    JWT_SECRET: "",
    API_ALLOWED_ORIGINS: "",
    CANONICAL_STAGING_ORIGINS: "",
    CANONICAL_PRODUCTION_ORIGINS: "",
  });
  // Must not throw (a missing JWT_SECRET is the documented SC-009 WARN in development).
  const config = assertBootable(env);
  assert.equal(config.environment, "development");
  assert.equal(config.persistence.kind, "postgres");
});

test("a staging .env satisfies the boot gate through the compose variable set", () => {
  const env = substitute(apiEnv, {
    APP_ENV: "staging",
    APP_ORIGIN: "https://staging.velora.example",
    JWT_SECRET: "staging-secret-0123456789abcdef0123456789abcdef",
    API_ALLOWED_ORIGINS: "https://staging.velora.example",
    CANONICAL_STAGING_ORIGINS: "https://staging.velora.example",
    CANONICAL_PRODUCTION_ORIGINS: "",
  });
  const config = assertBootable(env);
  assert.equal(config.environment, "staging");
  assert.equal(config.persistence.kind, "postgres");
});

/** Resolve the compose `${VAR}` placeholders with representative .env values. */
function substitute(env: Record<string, string>, values: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, raw] of Object.entries(env)) {
    const m = /^\$\{([A-Z0-9_]+)(:-([^}]*))?\}$/.exec(raw);
    resolved[key] = m ? (values[m[1]!] ?? m[3] ?? "") : raw;
  }
  return resolved;
}
