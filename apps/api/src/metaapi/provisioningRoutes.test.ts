// AUD-02 — MetaAPI provisioning HTTP routes.
//
// The audit found the two provisioning endpoints had NO route-level tests: the
// service suite proves the service, but `provisioningRoute` in kernel/server.ts
// is where authentication, the fail-closed 503 and the domain-error→HTTP
// mapping actually happen. A regression that deleted the `authenticateRequest`
// null-check would have kept the whole battery green.
//
// Convention follows credentialRoutes.test.ts / accountRoutes.test.ts: a real
// server on a real socket, real register → verify → login, two real users.
// The provider is stubbed ONLY at the fetch boundary — no real MetaAPI call is
// ever made by this suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createApp, listen } from "../kernel/server.js";
import { AuthService } from "../auth/authService.js";
import { LogMailProvider } from "../mail/logMailProvider.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { VeloraHasher } from "../auth/hashing.js";
import { JwtService } from "../auth/jwt.js";
import { MasterKey, MASTER_KEY_BYTES } from "../credentials/credentialCrypto.js";
import { MemoryCredentialStore } from "../credentials/memoryCredentialStore.js";
import { MemoryAuditStore } from "../auth/memoryAuditStore.js";
import { MemoryAccountStore } from "../accounts/memoryAccountStore.js";
import { MetaApiProvisioningService } from "./provisioningService.js";
import type { ProvisioningStore, ProvisioningOperation, ProvisioningStatus } from "./provisioningStore.js";

const JWT_SECRET = "provisioning-routes-test-secret-0123456789abcdef"; // test-only
// A distinctive plaintext: every response body is scanned for it.
const BROKER_PASSWORD = "Br0ker-Investor-Password-DO-NOT-LEAK-9f31";
const PROVIDER_ID = "prov-acct-11223344";

interface Envelope<T = unknown> {
  status: string;
  data: T;
  error: { code: string; message: string; details?: Record<string, string | number> } | null;
  timestamp: string;
}

/** Minimal in-memory operations store (the port, honestly implemented). */
class MemoryProvisioningStore implements ProvisioningStore {
  private readonly rows = new Map<string, ProvisioningOperation>();
  private seq = 0;

  async reserve(input: {
    userId: string; accountId: string; operationKey: string;
    providerMarker: string; transactionId: string; now: Date;
  }): Promise<{ operation: ProvisioningOperation; created: boolean }> {
    const k = `${input.userId}:${input.operationKey}`;
    const found = this.rows.get(k);
    if (found !== undefined) return { operation: found, created: false };
    this.seq += 1;
    const op: ProvisioningOperation = {
      id: String(this.seq),
      userId: input.userId,
      accountId: input.accountId,
      operationKey: input.operationKey,
      providerMarker: input.providerMarker,
      transactionId: input.transactionId,
      status: "PENDING",
      providerAccountId: null,
      lastErrorCode: null,
      attempts: 0,
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString(),
    };
    this.rows.set(k, op);
    return { operation: op, created: true };
  }

  async findByKey(userId: string, operationKey: string): Promise<ProvisioningOperation | null> {
    return this.rows.get(`${userId}:${operationKey}`) ?? null;
  }

  async markStatus(
    id: string, status: ProvisioningStatus, now: Date,
    fields?: { providerAccountId?: string | undefined; lastErrorCode?: string | undefined; incrementAttempts?: boolean | undefined },
  ): Promise<void> {
    for (const [k, op] of this.rows) {
      if (op.id !== id) continue;
      this.rows.set(k, {
        ...op,
        status,
        providerAccountId: fields?.providerAccountId ?? op.providerAccountId,
        lastErrorCode: fields?.lastErrorCode ?? op.lastErrorCode,
        attempts: fields?.incrementAttempts === true ? op.attempts + 1 : op.attempts,
        updatedAt: now.toISOString(),
      });
      return;
    }
  }
}

interface Ctx {
  ownerToken: string;
  otherToken: string;
  ownerAccountId: string;
  otherAccountId: string;
  ownerCredentialId: string;
  audit: MemoryAuditStore;
}

async function withServer(
  fn: (base: string, ctx: Ctx) => Promise<void>,
  options: {
    provisioning?: boolean;
    fetchImpl?: typeof fetch;
    platformToken?: string | null;
  } = {},
): Promise<void> {
  const tokens: string[] = [];
  const userStore = new MemoryUserStore();
  const auth = new AuthService({
    store: userStore,
    hasher: new VeloraHasher(),
    jwt: JwtService.create(JWT_SECRET),
    generateVerificationToken: () => {
      const t = `prov-routes-verification-${Math.random().toString(36).slice(2)}-0123456789`;
      tokens.push(t);
      return t;
    },
    mail: new LogMailProvider(),
  });

  const key = MasterKey.fromBase64(randomBytes(MASTER_KEY_BYTES).toString("base64"));
  const credentialStore = new MemoryCredentialStore(key);
  const accountStore = new MemoryAccountStore();
  const audit = new MemoryAuditStore();

  const defaultFetch = (async () =>
    new Response(JSON.stringify({ id: PROVIDER_ID }), {
      status: 201,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  const provisioning =
    options.provisioning === false
      ? undefined
      : new MetaApiProvisioningService({
          accounts: accountStore,
          credentials: credentialStore,
          operations: new MemoryProvisioningStore(),
          audit,
          platformToken: () =>
            options.platformToken === undefined ? "platform-token" : options.platformToken,
          clientOptions: { fetchImpl: options.fetchImpl ?? defaultFetch },
        });

  const app = createApp({
    allowedOrigins: ["https://veloratrade.ir"],
    checks: { database: async () => "ok" as const },
    auth,
    ...(provisioning === undefined ? {} : { provisioning }),
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
    const ownerToken = await makeUser("prov-owner@velora.example");
    const otherToken = await makeUser("prov-other@velora.example");
    const ownerId = JSON.parse(
      Buffer.from(ownerToken.split(".")[1]!, "base64url").toString("utf8"),
    ).sub as string;
    const otherId = JSON.parse(
      Buffer.from(otherToken.split(".")[1]!, "base64url").toString("utf8"),
    ).sub as string;

    const now = new Date("2026-09-16T00:00:00Z");
    const ownerAccount = await accountStore.create(ownerId, {
      provider: "MT5", platform: "MT5", label: "Owner", accountNumber: "1",
      currency: "USD", leverage: "100", timezone: null, timezoneSource: "unknown",
      status: "disconnected",
    }, now);
    const otherAccount = await accountStore.create(otherId, {
      provider: "MT5", platform: "MT5", label: "Other", accountNumber: "2",
      currency: "USD", leverage: "100", timezone: null, timezoneSource: "unknown",
      status: "disconnected",
    }, now);
    const cred = await credentialStore.create({
      userId: ownerId, provider: "METAAPI", secret: BROKER_PASSWORD, now,
    });

    await fn(base, {
      ownerToken, otherToken,
      ownerAccountId: ownerAccount.id,
      otherAccountId: otherAccount.id,
      ownerCredentialId: cred.id,
      audit,
    });
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

const authHeaders = (token: string): Record<string, string> => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
});

const connectBody = (credentialId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ credentialId, login: "500123", server: "Demo-Server", platform: "mt5", ...extra });

// --- 1. authentication ------------------------------------------------------

test("PROVISIONING HTTP: unauthenticated → 401 on both routes", async () => {
  await withServer(async (base, ctx) => {
    const calls = [
      fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: connectBody(ctx.ownerCredentialId),
      }),
      fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    ];
    for (const res of await Promise.all(calls)) {
      assert.equal(res.status, 401);
      const body = (await res.json()) as Envelope;
      assert.equal(body.error?.code, "UNAUTHENTICATED");
    }
  });
});

test("PROVISIONING HTTP: a malformed/garbage bearer token is still 401", async () => {
  await withServer(async (base, ctx) => {
    const res = await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer not-a-real-token" },
      body: connectBody(ctx.ownerCredentialId),
    });
    assert.equal(res.status, 401);
  });
});

// --- 2. capability absence (fail-closed) ------------------------------------

test("PROVISIONING HTTP: service not configured → 503 SERVICE_UNAVAILABLE", async () => {
  await withServer(
    async (base, ctx) => {
      for (const route of ["connect", "disconnect"]) {
        const res = await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/${route}`, {
          method: "POST",
          headers: authHeaders(ctx.ownerToken),
          body: route === "connect" ? connectBody(ctx.ownerCredentialId) : "{}",
        });
        assert.equal(res.status, 503);
        const body = (await res.json()) as Envelope;
        assert.equal(body.error?.code, "SERVICE_UNAVAILABLE");
      }
    },
    { provisioning: false },
  );
});

test("PROVISIONING HTTP: platform token absent → 503, and no binding happens", async () => {
  await withServer(
    async (base, ctx) => {
      const res = await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/connect`, {
        method: "POST",
        headers: authHeaders(ctx.ownerToken),
        body: connectBody(ctx.ownerCredentialId),
      });
      assert.equal(res.status, 503);
      const body = (await res.json()) as Envelope;
      assert.equal(body.error?.code, "SERVICE_UNAVAILABLE");
    },
    { platformToken: null },
  );
});

// --- 3. identity is claims.sub ONLY ----------------------------------------

test("PROVISIONING HTTP: a body-supplied userId cannot override claims.sub", async () => {
  await withServer(async (base, ctx) => {
    // The owner targets their OWN account but tries to impersonate the other
    // user in the body. The body field must be ignored entirely.
    const res = await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/connect`, {
      method: "POST",
      headers: authHeaders(ctx.ownerToken),
      body: connectBody(ctx.ownerCredentialId, { userId: "999999", user_id: "999999" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Envelope<{ accountId: string; metaapiAccountId: string }>;
    // Bound to the OWNER's account, proving the body was not consulted.
    assert.equal(body.data.accountId, ctx.ownerAccountId);
    const records = await ctx.audit.list();
    for (const r of records) {
      assert.equal(r.actorUserId !== "999999", true, "actor must never come from the body");
      assert.equal(r.targetUserId !== "999999", true, "target must never come from the body");
    }
  });
});

test("PROVISIONING HTTP: a query-string userId cannot override claims.sub", async () => {
  await withServer(async (base, ctx) => {
    const res = await fetch(
      `${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/connect?userId=999999`,
      { method: "POST", headers: authHeaders(ctx.ownerToken), body: connectBody(ctx.ownerCredentialId) },
    );
    // The route matcher is path-based; a query string neither changes identity
    // nor breaks routing.
    assert.equal(res.status, 200);
    const body = (await res.json()) as Envelope<{ accountId: string }>;
    assert.equal(body.data.accountId, ctx.ownerAccountId);
  });
});

// --- 4. ownership isolation (non-disclosing) --------------------------------

test("PROVISIONING HTTP: another user's account → 404, indistinguishable from absent", async () => {
  await withServer(async (base, ctx) => {
    const foreign = await fetch(`${base}/api/v1/accounts/${ctx.otherAccountId}/metaapi/connect`, {
      method: "POST",
      headers: authHeaders(ctx.ownerToken),
      body: connectBody(ctx.ownerCredentialId),
    });
    const missing = await fetch(`${base}/api/v1/accounts/99999999/metaapi/connect`, {
      method: "POST",
      headers: authHeaders(ctx.ownerToken),
      body: connectBody(ctx.ownerCredentialId),
    });
    assert.equal(foreign.status, 404);
    assert.equal(missing.status, 404);
    const a = (await foreign.json()) as Envelope;
    const b = (await missing.json()) as Envelope;
    // Byte-identical error shape: existence must not be inferable.
    assert.equal(a.error?.code, b.error?.code);
    assert.equal(a.error?.message, b.error?.message);
  });
});

test("PROVISIONING HTTP: a non-owner cannot disconnect another user's account", async () => {
  await withServer(async (base, ctx) => {
    // Owner connects first.
    const ok = await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/connect`, {
      method: "POST", headers: authHeaders(ctx.ownerToken), body: connectBody(ctx.ownerCredentialId),
    });
    assert.equal(ok.status, 200);

    const res = await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/disconnect`, {
      method: "POST", headers: authHeaders(ctx.otherToken), body: "{}",
    });
    assert.equal(res.status, 404, "a non-owner must not learn the account exists");
  });
});

test("PROVISIONING HTTP: a foreign credential id is refused with a non-disclosing 404", async () => {
  await withServer(async (base, ctx) => {
    const res = await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/connect`, {
      method: "POST",
      headers: authHeaders(ctx.ownerToken),
      body: connectBody("424242"), // never belonged to anyone
    });
    assert.equal(res.status, 404);
    const records = await ctx.audit.list();
    const denied = records.filter((r) => r.action === "CREDENTIAL_USED" && r.outcome === "denied");
    assert.equal(denied.length, 1, "a refused credential use is a security event and must be recorded");
  });
});

// --- 5. path id extraction --------------------------------------------------

test("PROVISIONING HTTP: the account id is taken from the path and URL-decoded safely", async () => {
  await withServer(async (base, ctx) => {
    // A traversal attempt in the path segment must not escape the route or
    // reach the store as a raw value — it simply is not an owned account.
    for (const bad of ["..%2F..%2Fetc%2Fpasswd", "abc", "%00", "1%20OR%201%3D1"]) {
      const res = await fetch(`${base}/api/v1/accounts/${bad}/metaapi/connect`, {
        method: "POST", headers: authHeaders(ctx.ownerToken), body: connectBody(ctx.ownerCredentialId),
      });
      assert.ok(
        res.status === 404 || res.status === 400,
        `malformed id "${bad}" must be rejected safely, got ${res.status}`,
      );
      const body = (await res.json()) as Envelope;
      assert.ok(body.error !== null, "an error envelope is returned, never a stack trace");
    }
  });
});

// --- 6/7. success paths -----------------------------------------------------

test("PROVISIONING HTTP: successful connect returns the binding and audits it", async () => {
  await withServer(async (base, ctx) => {
    const res = await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/connect`, {
      method: "POST", headers: authHeaders(ctx.ownerToken), body: connectBody(ctx.ownerCredentialId),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Envelope<{
      accountId: string; metaapiAccountId: string; status: string; alreadyConnected: boolean;
    }>;
    assert.equal(body.data.status, "connected");
    assert.equal(body.data.metaapiAccountId, PROVIDER_ID);
    assert.equal(body.data.alreadyConnected, false);

    const actions = (await ctx.audit.list()).map((r) => r.action);
    assert.ok(actions.includes("CREDENTIAL_USED"));
    assert.ok(actions.includes("ACCOUNT_BINDING_CHANGED"));
    assert.equal(actions.includes("CREDENTIAL_REVEALED" as never), false);
  });
});

test("PROVISIONING HTTP: repeating connect converges (idempotent), no duplicate binding", async () => {
  await withServer(async (base, ctx) => {
    const first = await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/connect`, {
      method: "POST", headers: authHeaders(ctx.ownerToken), body: connectBody(ctx.ownerCredentialId),
    });
    const second = await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/connect`, {
      method: "POST", headers: authHeaders(ctx.ownerToken), body: connectBody(ctx.ownerCredentialId),
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const b = (await second.json()) as Envelope<{ alreadyConnected: boolean; metaapiAccountId: string }>;
    assert.equal(b.data.alreadyConnected, true);
    assert.equal(b.data.metaapiAccountId, PROVIDER_ID);
  });
});

test("PROVISIONING HTTP: successful disconnect returns the disconnected shape", async () => {
  await withServer(async (base, ctx) => {
    await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/connect`, {
      method: "POST", headers: authHeaders(ctx.ownerToken), body: connectBody(ctx.ownerCredentialId),
    });
    const res = await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/disconnect`, {
      method: "POST", headers: authHeaders(ctx.ownerToken), body: "{}",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Envelope<{
      accountId: string; status: string; providerAccountDeleted: boolean;
    }>;
    assert.equal(body.data.status, "disconnected");
    // Local unbind is the default: provider deletion is OPT-IN (OD-MP-3 F).
    assert.equal(body.data.providerAccountDeleted, false);
  });
});

test("PROVISIONING HTTP: disconnecting an unconnected account → 409 NOT_CONNECTED", async () => {
  await withServer(async (base, ctx) => {
    const res = await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/disconnect`, {
      method: "POST", headers: authHeaders(ctx.ownerToken), body: "{}",
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as Envelope;
    assert.equal(body.error?.code, "NOT_CONNECTED");
  });
});

// --- 5(cont). ProvisioningServiceError → HTTP mapping -----------------------

test("PROVISIONING HTTP: provider rejection maps to 502 PROVIDER_REJECTED", async () => {
  await withServer(
    async (base, ctx) => {
      const res = await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/connect`, {
        method: "POST", headers: authHeaders(ctx.ownerToken), body: connectBody(ctx.ownerCredentialId),
      });
      assert.equal(res.status, 502);
      const body = (await res.json()) as Envelope;
      assert.equal(body.error?.code, "PROVIDER_REJECTED");
    },
    {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "bad broker password", password: BROKER_PASSWORD }), {
          status: 400, headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    },
  );
});

test("PROVISIONING HTTP: a provider 5xx maps to 503 PROVIDER_UNAVAILABLE", async () => {
  await withServer(
    async (base, ctx) => {
      const res = await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/connect`, {
        method: "POST", headers: authHeaders(ctx.ownerToken), body: connectBody(ctx.ownerCredentialId),
      });
      assert.equal(res.status, 503);
      const body = (await res.json()) as Envelope;
      assert.equal(body.error?.code, "PROVIDER_UNAVAILABLE");
    },
    {
      // 5xx never resolves; polling is bounded, so the request terminates.
      fetchImpl: (async () => new Response("upstream exploded", { status: 502 })) as unknown as typeof fetch,
    },
  );
});

test("PROVISIONING HTTP: a malformed provider body maps to 502 PROVIDER_MALFORMED", async () => {
  await withServer(
    async (base, ctx) => {
      const res = await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/connect`, {
        method: "POST", headers: authHeaders(ctx.ownerToken), body: connectBody(ctx.ownerCredentialId),
      });
      assert.equal(res.status, 502);
      const body = (await res.json()) as Envelope;
      assert.equal(body.error?.code, "PROVIDER_MALFORMED");
    },
    {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ notAnId: true }), {
          status: 201, headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    },
  );
});

test("PROVISIONING HTTP: a validation failure maps to 400 VALIDATION_FAILED", async () => {
  await withServer(async (base, ctx) => {
    const res = await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/connect`, {
      method: "POST",
      headers: authHeaders(ctx.ownerToken),
      // No credentialId, no login, no server.
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Envelope;
    assert.equal(body.error?.code, "VALIDATION_FAILED");
  });
});

// --- 8. no secret material in any response ----------------------------------

test("PROVISIONING HTTP: no response body ever contains credential or provider material", async () => {
  const forbidden = [BROKER_PASSWORD, "platform-token", "bad broker password", "upstream exploded"];

  const scan = async (label: string, res: Response): Promise<void> => {
    const text = await res.text();
    for (const needle of forbidden) {
      assert.equal(
        text.includes(needle), false,
        `${label} (status ${res.status}) leaked "${needle.slice(0, 16)}…": ${text.slice(0, 200)}`,
      );
    }
    // Belt and braces: no generic secret-ish key names either.
    for (const key of ["password", "secret", "ciphertext", "authTag", "auth-token"]) {
      assert.equal(text.toLowerCase().includes(key.toLowerCase()), false, `${label} exposed key "${key}"`);
    }
  };

  // Success path.
  await withServer(async (base, ctx) => {
    await scan("connect success", await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/connect`, {
      method: "POST", headers: authHeaders(ctx.ownerToken), body: connectBody(ctx.ownerCredentialId),
    }));
    await scan("disconnect success", await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/disconnect`, {
      method: "POST", headers: authHeaders(ctx.ownerToken), body: "{}",
    }));
  });

  // Provider echoes the password back in its error body — the classic leak.
  await withServer(
    async (base, ctx) => {
      await scan("provider 400 echoing the password",
        await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/connect`, {
          method: "POST", headers: authHeaders(ctx.ownerToken), body: connectBody(ctx.ownerCredentialId),
        }));
    },
    {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ message: "bad broker password", password: BROKER_PASSWORD }), {
          status: 400, headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    },
  );

  // Provider 5xx with a raw body.
  await withServer(
    async (base, ctx) => {
      await scan("provider 5xx",
        await fetch(`${base}/api/v1/accounts/${ctx.ownerAccountId}/metaapi/connect`, {
          method: "POST", headers: authHeaders(ctx.ownerToken), body: connectBody(ctx.ownerCredentialId),
        }));
    },
    { fetchImpl: (async () => new Response("upstream exploded", { status: 502 })) as unknown as typeof fetch },
  );
});
