// Password reset + resend HTTP contract tests (Phase 3B-1).
// Kernel-level evidence over real in-process HTTP: envelope shape, status
// codes, anti-enumeration parity, and fail-closed behavior when the auth
// capability port is absent.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp, listen } from "../kernel/server.js";
import { AuthService } from "./authService.js";
import { MemoryUserStore } from "./memoryUserStore.js";
import { VeloraHasher } from "./hashing.js";
import { JwtService } from "./jwt.js";
import { LogMailProvider } from "../mail/logMailProvider.js";

const SECRET = "reset-routes-test-secret-0123456789abcdefghij";
const PASSWORD = "a-strong-password-123";
const NEW_PASSWORD = "an-even-stronger-password-456";

interface Envelope<T> {
  status: "success" | "error";
  data: T;
  error: { code: string; messageKey?: string } | null;
}

async function withServer(
  fn: (ctx: {
    base: string;
    tokens: string[];
    mail: LogMailProvider;
  }) => Promise<void>,
  opts: { configureAuth?: boolean } = {},
): Promise<void> {
  const configureAuth = opts.configureAuth ?? true;
  const tokens: string[] = [];
  const mail = new LogMailProvider();
  const auth = configureAuth
    ? new AuthService({
        store: new MemoryUserStore(),
        hasher: new VeloraHasher(),
        jwt: JwtService.create(SECRET),
        mail,
        appOrigin: "https://veloratrade.ir",
        generateVerificationToken: () =>
          `route-reset-token-${Math.random().toString(36).slice(2)}-0123456789abcdef`,
      })
    : undefined;

  const app = createApp({
    allowedOrigins: ["https://veloratrade.ir"],
    checks: { database: async () => "ok" as const },
    ...(auth !== undefined ? { auth } : {}),
  });
  const port = await listen(app);
  try {
    await fn({ base: `http://127.0.0.1:${port}`, tokens, mail });
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

const post = (base: string, path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Register + verify a user through HTTP, returning its reset-capable email. */
async function seedUser(base: string, mail: LogMailProvider, email: string): Promise<void> {
  await post(base, "/api/v1/auth/register", { email, password: PASSWORD });
  const link = mail.lastTo(email)?.text ?? "";
  const token = /#token=([A-Za-z0-9-]+)/.exec(link)?.[1];
  if (token !== undefined) await post(base, "/api/v1/auth/verify-email", { token });
  mail.clear();
}

// --- envelope + anti-enumeration --------------------------------------------

test("HTTP forgot-password: 200 success envelope for a KNOWN address", async () => {
  await withServer(async ({ base, mail }) => {
    await seedUser(base, mail, "known@velora.example");

    const res = await post(base, "/api/v1/auth/forgot-password", { email: "known@velora.example" });
    const body = (await res.json()) as Envelope<{ requested: boolean }>;

    assert.equal(res.status, 200);
    assert.equal(body.status, "success");
    assert.equal(body.error, null);
    assert.equal(body.data.requested, true);
  });
});

test("HTTP forgot-password: UNKNOWN address is byte-identical (no enumeration)", async () => {
  await withServer(async ({ base, mail }) => {
    await seedUser(base, mail, "known@velora.example");

    const a = await post(base, "/api/v1/auth/forgot-password", { email: "known@velora.example" });
    const b = await post(base, "/api/v1/auth/forgot-password", { email: "ghost@velora.example" });

    assert.equal(a.status, b.status);
    assert.equal(JSON.stringify(await a.json()), JSON.stringify(await b.json()));
  });
});

test("HTTP forgot-password: malformed email → 400 validation envelope", async () => {
  await withServer(async ({ base }) => {
    const res = await post(base, "/api/v1/auth/forgot-password", { email: "not-an-email" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Envelope<null>;
    assert.equal(body.status, "error");
    assert.ok(body.error !== null);
  });
});

// --- reset over HTTP --------------------------------------------------------

test("HTTP reset-password: happy path 200, then the new password logs in", async () => {
  await withServer(async ({ base, mail }) => {
    await seedUser(base, mail, "reset@velora.example");
    await post(base, "/api/v1/auth/forgot-password", { email: "reset@velora.example" });

    const token = /#token=([A-Za-z0-9-]+)/.exec(mail.lastTo("reset@velora.example")!.text)![1]!;
    const res = await post(base, "/api/v1/auth/reset-password", {
      token,
      newPassword: NEW_PASSWORD,
    });

    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Envelope<{ reset: boolean }>).data.reset, true);

    const login = await post(base, "/api/v1/auth/login", {
      email: "reset@velora.example",
      password: NEW_PASSWORD,
    });
    assert.equal(login.status, 200);
  });
});

test("HTTP reset-password: reused token → 409 TOKEN_ALREADY_USED", async () => {
  await withServer(async ({ base, mail }) => {
    await seedUser(base, mail, "reuse@velora.example");
    await post(base, "/api/v1/auth/forgot-password", { email: "reuse@velora.example" });
    const token = /#token=([A-Za-z0-9-]+)/.exec(mail.lastTo("reuse@velora.example")!.text)![1]!;

    await post(base, "/api/v1/auth/reset-password", { token, newPassword: NEW_PASSWORD });
    const second = await post(base, "/api/v1/auth/reset-password", {
      token,
      newPassword: "third-password-000",
    });

    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as Envelope<null>).error?.code, "TOKEN_ALREADY_USED");
  });
});

test("HTTP reset-password: unknown token → 400 INVALID_TOKEN", async () => {
  await withServer(async ({ base }) => {
    const res = await post(base, "/api/v1/auth/reset-password", {
      token: "totally-unknown-token-123456",
      newPassword: NEW_PASSWORD,
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as Envelope<null>).error?.code, "INVALID_TOKEN");
  });
});

// --- resend verification ----------------------------------------------------

test("HTTP resend-verification: 200 uniform envelope regardless of existence", async () => {
  await withServer(async ({ base }) => {
    const res = await post(base, "/api/v1/auth/resend-verification", {
      email: "nobody@velora.example",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Envelope<{ requested: boolean }>;
    assert.equal(body.status, "success");
    assert.equal(body.data.requested, true);
  });
});

// --- fail-closed capability gate --------------------------------------------

test("HTTP: all three routes fail closed with 503 when auth is not configured", async () => {
  await withServer(
    async ({ base }) => {
      for (const [path, body] of [
        ["/api/v1/auth/forgot-password", { email: "a@velora.example" }],
        ["/api/v1/auth/reset-password", { token: "x".repeat(24), newPassword: NEW_PASSWORD }],
        ["/api/v1/auth/resend-verification", { email: "a@velora.example" }],
      ] as const) {
        const res = await post(base, path, body);
        assert.equal(res.status, 503, `${path} must fail closed`);
      }
    },
    { configureAuth: false },
  );
});
