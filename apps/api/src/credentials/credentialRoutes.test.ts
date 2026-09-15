// B-1 — credential HTTP routes (authenticated self-service).
//
// Exercises the real server over a real socket, following the existing route
// test convention (accountRoutes.test.ts): register → verify → login → use the
// bearer token. Covers authentication, ownership isolation across two real
// users, the non-disclosing 404, fail-closed 503, and the absence of secret
// material from every response body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createApp, listen } from "../kernel/server.js";
import { AuthService } from "../auth/authService.js";
import { LogMailProvider } from "../mail/logMailProvider.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { VeloraHasher } from "../auth/hashing.js";
import { JwtService } from "../auth/jwt.js";
import { MasterKey, MASTER_KEY_BYTES } from "./credentialCrypto.js";
import { MemoryCredentialStore } from "./memoryCredentialStore.js";
import { CredentialService } from "./credentialService.js";

const JWT_SECRET = "credential-routes-test-secret-0123456789abcdef"; // test-only
const SECRET = "metaapi-token-routes-7c1f22ab-DO-NOT-LEAK";

interface Envelope<T = unknown> {
  status: string;
  data: T;
  error: { code: string; message: string; details?: Record<string, string | number> } | null;
  timestamp: string;
}

async function withServer(
  fn: (
    base: string,
    ctx: { ownerToken: string; otherToken: string },
  ) => Promise<void>,
  options: { credentials?: boolean } = {},
): Promise<void> {
  const tokens: string[] = [];
  const auth = new AuthService({
    store: new MemoryUserStore(),
    hasher: new VeloraHasher(),
    jwt: JwtService.create(JWT_SECRET),
    generateVerificationToken: () => {
      const t = `cred-routes-verification-token-${Math.random().toString(36).slice(2)}-0123456789`;
      tokens.push(t);
      return t;
    },
    mail: new LogMailProvider(),
  });
  const key = MasterKey.fromBase64(randomBytes(MASTER_KEY_BYTES).toString("base64"));
  const credentials =
    options.credentials === false
      ? undefined
      : new CredentialService({ store: new MemoryCredentialStore(key) });

  const app = createApp({
    allowedOrigins: ["https://veloratrade.ir"],
    checks: { database: async () => "ok" as const },
    auth,
    ...(credentials === undefined ? {} : { credentials }),
  });
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;

  async function makeUser(email: string): Promise<string> {
    const reg = await fetch(`${base}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "a-strong-password-123" }),
    });
    assert.equal(reg.status, 201);
    await fetch(`${base}/api/v1/auth/verify-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: tokens.shift() }),
    });
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "a-strong-password-123" }),
    });
    assert.equal(login.status, 200);
    return ((await login.json()) as Envelope<{ tokens: { accessToken: string } }>).data.tokens
      .accessToken;
  }

  try {
    const ownerToken = await makeUser("cred-owner@velora.example");
    const otherToken = await makeUser("cred-other@velora.example");
    await fn(base, { ownerToken, otherToken });
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

const authHeaders = (token: string): Record<string, string> => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
});

test("CREDENTIALS HTTP: unauthenticated → 401 on every credential route", async () => {
  await withServer(async (base) => {
    const calls = [
      fetch(`${base}/api/v1/credentials`),
      fetch(`${base}/api/v1/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "METAAPI", secret: SECRET }),
      }),
      fetch(`${base}/api/v1/credentials/1`, { method: "DELETE" }),
    ];
    for (const res of await Promise.all(calls)) {
      assert.equal(res.status, 401);
      const body = (await res.json()) as Envelope;
      assert.equal(body.error?.code, "UNAUTHENTICATED");
    }
  });
});

test("CREDENTIALS HTTP: owner journey — create → list → delete", async () => {
  await withServer(async (base, { ownerToken }) => {
    const created = await fetch(`${base}/api/v1/credentials`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ provider: "METAAPI", secret: SECRET }),
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as Envelope<{
      credential: { id: string; provider: string; userId: string };
    }>;
    const id = createdBody.data.credential.id;
    assert.equal(createdBody.data.credential.provider, "METAAPI");

    const listed = await fetch(`${base}/api/v1/credentials`, { headers: authHeaders(ownerToken) });
    assert.equal(listed.status, 200);
    const listBody = (await listed.json()) as Envelope<{ credentials: unknown[] }>;
    assert.equal(listBody.data.credentials.length, 1);

    const deleted = await fetch(`${base}/api/v1/credentials/${id}`, {
      method: "DELETE",
      headers: authHeaders(ownerToken),
    });
    assert.equal(deleted.status, 200);

    const after = await fetch(`${base}/api/v1/credentials`, { headers: authHeaders(ownerToken) });
    assert.equal(((await after.json()) as Envelope<{ credentials: unknown[] }>).data.credentials.length, 0);
  });
});

test("CREDENTIALS HTTP: no response ever contains the plaintext secret", async () => {
  await withServer(async (base, { ownerToken }) => {
    const created = await fetch(`${base}/api/v1/credentials`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ provider: "METAAPI", secret: SECRET }),
    });
    const createdText = await created.text();
    assert.equal(createdText.includes(SECRET), false, "create response leaked the secret");

    const id = (JSON.parse(createdText) as Envelope<{ credential: { id: string } }>).data.credential.id;

    const listText = await (
      await fetch(`${base}/api/v1/credentials`, { headers: authHeaders(ownerToken) })
    ).text();
    assert.equal(listText.includes(SECRET), false, "list response leaked the secret");
    // No crypto material either.
    for (const marker of ["ciphertext", "authTag", "\"iv\"", "secret_ciphertext"]) {
      assert.equal(listText.includes(marker), false, `list response exposed ${marker}`);
    }

    const delText = await (
      await fetch(`${base}/api/v1/credentials/${id}`, {
        method: "DELETE",
        headers: authHeaders(ownerToken),
      })
    ).text();
    assert.equal(delText.includes(SECRET), false, "delete response leaked the secret");
  });
});

test("CREDENTIALS HTTP: cross-user access is isolated and non-disclosing", async () => {
  await withServer(async (base, { ownerToken, otherToken }) => {
    const created = await fetch(`${base}/api/v1/credentials`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ provider: "METAAPI", secret: SECRET }),
    });
    const id = ((await created.json()) as Envelope<{ credential: { id: string } }>).data.credential.id;

    // The other user cannot see it.
    const theirList = await fetch(`${base}/api/v1/credentials`, { headers: authHeaders(otherToken) });
    assert.equal(((await theirList.json()) as Envelope<{ credentials: unknown[] }>).data.credentials.length, 0);

    // …and cannot delete it. The 404 must be identical to a nonexistent id.
    const cross = await fetch(`${base}/api/v1/credentials/${id}`, {
      method: "DELETE",
      headers: authHeaders(otherToken),
    });
    const missing = await fetch(`${base}/api/v1/credentials/99999999`, {
      method: "DELETE",
      headers: authHeaders(otherToken),
    });
    assert.equal(cross.status, 404);
    assert.equal(missing.status, 404);
    const crossBody = (await cross.json()) as Envelope;
    const missingBody = (await missing.json()) as Envelope;
    assert.equal(crossBody.error?.code, missingBody.error?.code);
    assert.equal(crossBody.error?.message, missingBody.error?.message);

    // The owner's credential survived the attempt.
    const stillThere = await fetch(`${base}/api/v1/credentials`, { headers: authHeaders(ownerToken) });
    assert.equal(((await stillThere.json()) as Envelope<{ credentials: unknown[] }>).data.credentials.length, 1);
  });
});

test("CREDENTIALS HTTP: a userId in the request body cannot redirect ownership", async () => {
  await withServer(async (base, { ownerToken, otherToken }) => {
    // The owner submits a body naming the OTHER user.
    const res = await fetch(`${base}/api/v1/credentials`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ provider: "METAAPI", secret: SECRET, userId: "999", user_id: "999" }),
    });
    assert.equal(res.status, 201);

    // It belongs to the authenticated caller, and the other user sees nothing.
    const mine = await fetch(`${base}/api/v1/credentials`, { headers: authHeaders(ownerToken) });
    assert.equal(((await mine.json()) as Envelope<{ credentials: unknown[] }>).data.credentials.length, 1);
    const theirs = await fetch(`${base}/api/v1/credentials`, { headers: authHeaders(otherToken) });
    assert.equal(((await theirs.json()) as Envelope<{ credentials: unknown[] }>).data.credentials.length, 0);
  });
});

test("CREDENTIALS HTTP: validation and duplicate handling follow existing conventions", async () => {
  await withServer(async (base, { ownerToken }) => {
    const bad = await fetch(`${base}/api/v1/credentials`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ provider: "BINANCE", secret: SECRET }),
    });
    assert.equal(bad.status, 400);
    const badBody = (await bad.json()) as Envelope;
    assert.equal(badBody.error?.code, "VALIDATION_FAILED");

    const noSecret = await fetch(`${base}/api/v1/credentials`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ provider: "METAAPI" }),
    });
    assert.equal(noSecret.status, 400);

    // First succeeds, second conflicts (uniqueness per provider).
    assert.equal(
      (
        await fetch(`${base}/api/v1/credentials`, {
          method: "POST",
          headers: authHeaders(ownerToken),
          body: JSON.stringify({ provider: "METAAPI", secret: SECRET }),
        })
      ).status,
      201,
    );
    const dup = await fetch(`${base}/api/v1/credentials`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ provider: "METAAPI", secret: "another-secret" }),
    });
    assert.equal(dup.status, 409);
    assert.equal(((await dup.json()) as Envelope).error?.code, "CREDENTIAL_EXISTS");
  });
});

test("CREDENTIALS HTTP: routes fail closed (503) when the capability is unconfigured", async () => {
  await withServer(
    async (base, { ownerToken }) => {
      // Mirrors a deployment with a missing/invalid CREDENTIAL_MASTER_KEY: the
      // service is never constructed, so the capability is ABSENT rather than
      // degraded — it must not fall back to unencrypted storage.
      const res = await fetch(`${base}/api/v1/credentials`, { headers: authHeaders(ownerToken) });
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as Envelope).error?.code, "SERVICE_UNAVAILABLE");

      const post = await fetch(`${base}/api/v1/credentials`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ provider: "METAAPI", secret: SECRET }),
      });
      assert.equal(post.status, 503);
    },
    { credentials: false },
  );
});
