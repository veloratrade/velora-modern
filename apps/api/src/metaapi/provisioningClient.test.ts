// MetaAPI provisioning client — PROVIDER HTTP CONTRACT (OD-MP-1, Phase 18 B).
//
// Every assertion here targets the WIRE: the exact URL, the exact headers, the
// exact body, and what the client refuses to do. The provider is stubbed at
// the `fetch` boundary — never the client itself — so the code under test is
// the real client.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createMetaApiAccount,
  deleteMetaApiAccount,
  findAccountByMarker,
  newTransactionId,
  ProvisioningError,
  DEFAULT_PROVISIONING_BASE_URL,
} from "./provisioningClient.js";

const TOKEN = "test-platform-token-not-real";
const MARKER = "velora-0123456789abcdef0123456789abcdef";
const PASSWORD = "Sup3rSecret-BrokerPassword!";

interface Seen {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function stub(
  status: number,
  payload: unknown,
  seen?: Seen,
  headers: Record<string, string> = {},
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (seen !== undefined) {
      // exactOptionalPropertyTypes: assign only when defined, so an absent
      // field stays absent instead of becoming an explicit `undefined`.
      seen.url = String(url);
      if (init?.method !== undefined) seen.method = init.method;
      if (init?.headers !== undefined) seen.headers = init.headers as Record<string, string>;
      if (typeof init?.body === "string") seen.body = init.body;
    }
    return new Response(payload === undefined ? null : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }) as unknown as typeof fetch;
}

const req = {
  login: "50194988",
  password: PASSWORD,
  server: "ICMarkets-Demo",
  platform: "mt5" as const,
  marker: MARKER,
};

// --------------------------------------------------------------------------
// Request shape
// --------------------------------------------------------------------------
test("create: exact URL, method and documented headers", async () => {
  const seen: Seen = {};
  const txn = newTransactionId();
  await createMetaApiAccount(TOKEN, req, txn, { fetchImpl: stub(201, { id: "acc-1" }, seen) });

  assert.equal(seen.url, `${DEFAULT_PROVISIONING_BASE_URL}/users/current/accounts`);
  assert.equal(seen.method, "POST");
  assert.equal(seen.headers?.["auth-token"], TOKEN);
  assert.equal(seen.headers?.["transaction-id"], txn);
  assert.equal(seen.headers?.["content-type"], "application/json");
  assert.equal(seen.headers?.["accept"], "application/json");
});

test("create: Idempotency-Key is NEVER sent (D-7 — undocumented by MetaAPI)", async () => {
  const seen: Seen = {};
  await createMetaApiAccount(TOKEN, req, newTransactionId(), {
    fetchImpl: stub(201, { id: "acc-1" }, seen),
  });
  const keys = Object.keys(seen.headers ?? {}).map((k) => k.toLowerCase());
  assert.ok(!keys.includes("idempotency-key"), `unexpected header: ${keys.join(",")}`);
});

test("transaction-id is 32 characters and random per call", async () => {
  const a = newTransactionId();
  const b = newTransactionId();
  assert.match(a, /^[A-Za-z0-9]{32}$/);
  assert.equal(a.length, 32);
  assert.notEqual(a, b);
});

test("create: body carries only the documented fields", async () => {
  const seen: Seen = {};
  await createMetaApiAccount(TOKEN, req, newTransactionId(), {
    fetchImpl: stub(201, { id: "acc-1" }, seen),
  });
  const body = JSON.parse(seen.body ?? "{}") as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    "login", "magic", "manualTrades", "name", "password", "platform", "server",
  ]);
  assert.equal(body["name"], MARKER);
  assert.equal(body["platform"], "mt5");
});

test("create: a malformed transaction id is refused before any network call", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => createMetaApiAccount(TOKEN, req, "too-short", { fetchImpl }),
    (e: unknown) => e instanceof ProvisioningError && e.code === "PROVIDER_REJECTED",
  );
  assert.equal(called, false);
});

// --------------------------------------------------------------------------
// Response handling
// --------------------------------------------------------------------------
test("create: account id is read from response.id", async () => {
  const out = await createMetaApiAccount(TOKEN, req, newTransactionId(), {
    fetchImpl: stub(201, { id: "1eda642a-a9a3-457c-99af-3bc5e8d5c4c9", name: MARKER }),
  });
  assert.deepEqual(out, { kind: "created", providerAccountId: "1eda642a-a9a3-457c-99af-3bc5e8d5c4c9" });
});

test("create: 202 is an ACCEPTED outcome carrying the documented retry hint", async () => {
  const out = await createMetaApiAccount(TOKEN, req, newTransactionId(), {
    fetchImpl: stub(202, { id: "AcceptedError", metadata: { recommendedRetryTime: 5 } }),
  });
  assert.equal(out.kind, "accepted");
  assert.equal(out.kind === "accepted" ? out.retryAfterMs : null, 5000);
});

test("create: Retry-After header is honoured on 202", async () => {
  const out = await createMetaApiAccount(TOKEN, req, newTransactionId(), {
    fetchImpl: stub(202, {}, undefined, { "retry-after": "3" }),
  });
  assert.equal(out.kind === "accepted" ? out.retryAfterMs : null, 3000);
});

test("create: a response without a usable id is MALFORMED and ambiguous", async () => {
  await assert.rejects(
    () => createMetaApiAccount(TOKEN, req, newTransactionId(), { fetchImpl: stub(201, { nope: 1 }) }),
    (e: unknown) => e instanceof ProvisioningError && e.code === "PROVIDER_MALFORMED" && e.ambiguous,
  );
});

test("create: an id that could alter a URL path is rejected", async () => {
  await assert.rejects(
    () =>
      createMetaApiAccount(TOKEN, req, newTransactionId(), {
        fetchImpl: stub(201, { id: "../../evil" }),
      }),
    (e: unknown) => e instanceof ProvisioningError && e.code === "PROVIDER_MALFORMED",
  );
});

test("create: 4xx is terminal and NOT ambiguous", async () => {
  await assert.rejects(
    () => createMetaApiAccount(TOKEN, req, newTransactionId(), { fetchImpl: stub(400, { m: "bad" }) }),
    (e: unknown) =>
      e instanceof ProvisioningError && e.code === "PROVIDER_REJECTED" && e.ambiguous === false,
  );
});

test("create: 5xx is retryable AND ambiguous (the account may exist)", async () => {
  await assert.rejects(
    () => createMetaApiAccount(TOKEN, req, newTransactionId(), { fetchImpl: stub(503, {}) }),
    (e: unknown) =>
      e instanceof ProvisioningError && e.code === "PROVIDER_UNAVAILABLE" && e.ambiguous === true,
  );
});

test("create: a transport failure is ambiguous and never exposes the cause", async () => {
  const fetchImpl = (async () => {
    // A real fetch error can embed the whole request, including the password.
    throw new Error(`connect ECONNREFUSED body=${PASSWORD} token=${TOKEN}`);
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => createMetaApiAccount(TOKEN, req, newTransactionId(), { fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof ProvisioningError);
      assert.equal(e.code, "PROVIDER_TIMEOUT");
      assert.equal(e.ambiguous, true);
      // THE point of this test: no secret survives into the thrown error.
      assert.ok(!e.message.includes(PASSWORD));
      assert.ok(!e.message.includes(TOKEN));
      assert.ok(!String(e.stack).includes(PASSWORD));
      return true;
    },
  );
});

test("create: an empty token fails closed before any network call", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}");
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => createMetaApiAccount("", req, newTransactionId(), { fetchImpl }),
    (e: unknown) => e instanceof ProvisioningError && e.code === "NOT_CONFIGURED",
  );
  assert.equal(called, false);
});

// --------------------------------------------------------------------------
// Reconciliation
// --------------------------------------------------------------------------
test("reconcile: queries the documented endpoint with auth-token only", async () => {
  const seen: Seen = {};
  await findAccountByMarker(TOKEN, MARKER, { fetchImpl: stub(200, [], seen) });
  assert.equal(
    seen.url,
    `${DEFAULT_PROVISIONING_BASE_URL}/users/current/accounts?query=${encodeURIComponent(MARKER)}`,
  );
  assert.equal(seen.method, "GET");
  assert.equal(seen.headers?.["auth-token"], TOKEN);
  const keys = Object.keys(seen.headers ?? {}).map((k) => k.toLowerCase());
  assert.ok(!keys.includes("transaction-id"));
  assert.ok(!keys.includes("idempotency-key"));
});

test("reconcile: exactly one marker match returns its id", async () => {
  const found = await findAccountByMarker(TOKEN, MARKER, {
    fetchImpl: stub(200, [{ _id: "acc-9", name: MARKER }]),
  });
  assert.equal(found, "acc-9");
});

test("reconcile: a near-miss name does NOT match (exact comparison)", async () => {
  const found = await findAccountByMarker(TOKEN, MARKER, {
    fetchImpl: stub(200, [{ _id: "acc-9", name: `${MARKER}-other` }]),
  });
  assert.equal(found, null);
});

test("reconcile: api-version 2 { items: [...] } shape is accepted", async () => {
  const found = await findAccountByMarker(TOKEN, MARKER, {
    fetchImpl: stub(200, { count: 1, items: [{ _id: "acc-2", name: MARKER }] }),
  });
  assert.equal(found, "acc-2");
});

test("reconcile: MORE than one match is an explicit ambiguity, never a guess", async () => {
  await assert.rejects(
    () =>
      findAccountByMarker(TOKEN, MARKER, {
        fetchImpl: stub(200, [
          { _id: "acc-1", name: MARKER },
          { _id: "acc-2", name: MARKER },
        ]),
      }),
    (e: unknown) => e instanceof ProvisioningError && /multiple/.test(e.message),
  );
});

test("reconcile: no match returns null (recoverable, not an error)", async () => {
  assert.equal(await findAccountByMarker(TOKEN, MARKER, { fetchImpl: stub(200, []) }), null);
});

// --------------------------------------------------------------------------
// Provider deletion (OD-MP-3 B/G)
// --------------------------------------------------------------------------
test("delete: documented endpoint, auth-token only, no Idempotency-Key", async () => {
  const seen: Seen = {};
  await deleteMetaApiAccount(TOKEN, "acc-1", { fetchImpl: stub(204, undefined, seen) });
  assert.equal(seen.url, `${DEFAULT_PROVISIONING_BASE_URL}/users/current/accounts/acc-1`);
  assert.equal(seen.method, "DELETE");
  assert.equal(seen.headers?.["auth-token"], TOKEN);
  const keys = Object.keys(seen.headers ?? {}).map((k) => k.toLowerCase());
  assert.ok(!keys.includes("idempotency-key"));
  assert.ok(!keys.includes("transaction-id"));
});

test("delete: 404 is SUCCESS — 'already absent' is the postcondition (OD-MP-3 G)", async () => {
  await deleteMetaApiAccount(TOKEN, "acc-gone", { fetchImpl: stub(404, { m: "not found" }) });
});

test("delete: 500 surfaces as a retryable provider failure", async () => {
  await assert.rejects(
    () => deleteMetaApiAccount(TOKEN, "acc-1", { fetchImpl: stub(500, {}) }),
    (e: unknown) => e instanceof ProvisioningError && e.code === "PROVIDER_UNAVAILABLE",
  );
});

test("delete: an unsafe account id never reaches the network", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}");
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => deleteMetaApiAccount(TOKEN, "../users/current/accounts", { fetchImpl }),
    (e: unknown) => e instanceof ProvisioningError && e.code === "PROVIDER_REJECTED",
  );
  assert.equal(called, false);
});

// --------------------------------------------------------------------------
// Provider error bodies must never surface
// --------------------------------------------------------------------------
test("a provider error body is never attached to the thrown error", async () => {
  const body = { message: `broker rejected password ${PASSWORD}`, details: TOKEN };
  await assert.rejects(
    () => createMetaApiAccount(TOKEN, req, newTransactionId(), { fetchImpl: stub(400, body) }),
    (e: unknown) => {
      assert.ok(e instanceof ProvisioningError);
      const dump = `${e.message}|${String(e.stack)}|${JSON.stringify(e)}`;
      assert.ok(!dump.includes(PASSWORD));
      assert.ok(!dump.includes(TOKEN));
      assert.equal(e.message, "status 400"); // code/status only
      return true;
    },
  );
});
