// MetaApiProvisioningService — AUTHORIZATION, CREDENTIAL BOUNDARY, IDEMPOTENCY
// and DISCONNECT (OD-MP-1/2/3; Phase 18 A, E, F, G).
//
// The store fakes below implement the REAL ports. The MemoryAccountStore is the
// production in-memory adapter, not a hand-written stand-in, so the binding
// semantics exercised here are the ones the adapter actually implements.
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAccountStore } from "../accounts/memoryAccountStore.js";
import { MemoryAuditStore } from "../auth/memoryAuditStore.js";
import { MemoryCredentialStore } from "../credentials/memoryCredentialStore.js";
import { resolveCredentialKey } from "../credentials/credentialConfig.js";
import type {
  ProvisioningOperation,
  ProvisioningReserveInput,
  ProvisioningStatus,
  ProvisioningStore,
} from "./provisioningStore.js";
import { MetaApiProvisioningService, ProvisioningServiceError } from "./provisioningService.js";

const BROKER_PASSWORD = "Sup3rSecret-BrokerPassword!";
const PLATFORM_TOKEN = "platform-token-not-real";
const OWNER = "1";
const OTHER_USER = "2";
const ADMIN = "99"; // an installation admin / System Owner identity

/** In-memory ProvisioningStore honouring the (user, key) uniqueness rule. */
class MemoryProvisioningStore implements ProvisioningStore {
  readonly rows = new Map<string, ProvisioningOperation>();
  private seq = 0;

  async reserve(input: ProvisioningReserveInput) {
    const k = `${input.userId}|${input.operationKey}`;
    const existing = this.rows.get(k);
    if (existing !== undefined) return { operation: existing, created: false };
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

  async findByKey(userId: string, operationKey: string) {
    return this.rows.get(`${userId}|${operationKey}`) ?? null;
  }

  async markStatus(
    id: string,
    status: ProvisioningStatus,
    now: Date,
    fields: {
      providerAccountId?: string | undefined;
      lastErrorCode?: string | undefined;
      incrementAttempts?: boolean | undefined;
    } = {},
  ) {
    for (const [k, op] of this.rows) {
      if (op.id !== id) continue;
      this.rows.set(k, {
        ...op,
        status,
        providerAccountId: fields.providerAccountId ?? op.providerAccountId,
        lastErrorCode: fields.lastErrorCode ?? op.lastErrorCode,
        attempts: op.attempts + (fields.incrementAttempts === true ? 1 : 0),
        updatedAt: now.toISOString(),
      });
      return;
    }
  }
}

const KEY = resolveCredentialKey({
  CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  CREDENTIAL_MASTER_KEY_VERSION: "1",
}).key!;

interface Harness {
  service: MetaApiProvisioningService;
  accounts: MemoryAccountStore;
  audit: MemoryAuditStore;
  operations: MemoryProvisioningStore;
  credentialId: string;
  accountId: string;
  otherAccountId: string;
  calls: { url: string; body: string | undefined }[];
  logs: string[];
}

async function harness(
  responder?: (call: number, url: string) => Response,
): Promise<Harness> {
  const accounts = new MemoryAccountStore();
  const audit = new MemoryAuditStore();
  const operations = new MemoryProvisioningStore();
  const credentials = new MemoryCredentialStore(KEY);

  const cred = await credentials.create({
    userId: OWNER,
    provider: "METAAPI",
    secret: BROKER_PASSWORD,
    now: new Date("2026-09-16T00:00:00Z"),
  });

  const mk = async (userId: string) =>
    (
      await accounts.create(
        userId,
        {
          provider: "MT5", platform: "MT5", label: "acct", accountNumber: "50194988",
          currency: "USD", leverage: "100", timezone: null, timezoneSource: "unknown",
          status: "disconnected",
        },
        new Date("2026-09-16T00:00:00Z"),
      )
    ).id;

  const accountId = await mk(OWNER);
  const otherAccountId = await mk(OTHER_USER);

  const calls: { url: string; body: string | undefined }[] = [];
  let n = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: typeof init?.body === "string" ? init.body : undefined });
    n += 1;
    if (responder !== undefined) return responder(n, String(url));
    return new Response(JSON.stringify({ id: "prov-acct-1" }), {
      status: 201, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const logs: string[] = [];
  const service = new MetaApiProvisioningService({
    accounts,
    credentials,
    operations,
    audit,
    platformToken: () => PLATFORM_TOKEN,
    clientOptions: { fetchImpl, baseUrl: "https://provisioning.test" },
    now: () => new Date("2026-09-16T12:00:00Z"),
    sleep: async () => {}, // no real waiting in tests
  });

  return { service, accounts, audit, operations, credentialId: cred.id, accountId, otherAccountId, calls, logs };
}

const body = (over: Record<string, unknown> = {}) => ({
  login: "50194988", server: "ICMarkets-Demo", platform: "mt5", ...over,
});

// ==========================================================================
// A. AUTHORIZATION / OWNERSHIP
// ==========================================================================
test("the owner can connect their own account with their own credential", async () => {
  const h = await harness();
  const out = await h.service.connect(
    { id: OWNER, requestId: "req-1" },
    h.accountId,
    body({ credentialId: h.credentialId }),
  );
  assert.equal(out.metaapiAccountId, "prov-acct-1");
  assert.equal(out.status, "connected");
  assert.equal(out.alreadyConnected, false);
  assert.equal(await h.accounts.getMetaApiBinding(h.accountId, OWNER), "prov-acct-1");
});

test("another user cannot connect an account they do not own (non-disclosing 404)", async () => {
  const h = await harness();
  await assert.rejects(
    () => h.service.connect({ id: OTHER_USER }, h.accountId, body({ credentialId: h.credentialId })),
    (e: unknown) =>
      e instanceof ProvisioningServiceError && e.status === 404 && e.code === "NOT_FOUND",
  );
  assert.equal(h.calls.length, 0, "no provider call may happen for a non-owned account");
});

test("an ADMIN / System Owner cannot use another user's credential", async () => {
  const h = await harness();
  // The admin owns no account here, so ownership fails first; and even given an
  // account, `reveal(credentialId, admin)` could not return the owner's secret.
  await assert.rejects(
    () => h.service.connect({ id: ADMIN }, h.accountId, body({ credentialId: h.credentialId })),
    (e: unknown) => e instanceof ProvisioningServiceError && e.status === 404,
  );
  assert.equal(h.calls.length, 0);
});

test("a user cannot spend another user's credential on their OWN account", async () => {
  const h = await harness();
  // OTHER_USER owns otherAccountId, but the credential belongs to OWNER.
  await assert.rejects(
    () =>
      h.service.connect({ id: OTHER_USER }, h.otherAccountId, body({ credentialId: h.credentialId })),
    (e: unknown) =>
      e instanceof ProvisioningServiceError && e.status === 404 && e.code === "NOT_FOUND",
  );
  assert.equal(h.calls.length, 0, "a foreign credential must never reach the provider");
  const denied = (await h.audit.list()).filter((r) => r.action === "CREDENTIAL_USED");
  assert.equal(denied.length, 1);
  assert.equal(denied[0]!.outcome, "denied");
  assert.equal(denied[0]!.actorUserId, OTHER_USER);
});

test("a client-supplied userId in the body is ignored entirely", async () => {
  const h = await harness();
  await h.service.connect(
    { id: OWNER },
    h.accountId,
    body({ credentialId: h.credentialId, userId: OTHER_USER, user_id: OTHER_USER }),
  );
  const rows = await h.audit.list();
  for (const r of rows) {
    assert.equal(r.actorUserId, OWNER);
    assert.equal(r.targetUserId, OWNER);
  }
});

// ==========================================================================
// B. CREDENTIAL / SECRET BOUNDARY
// ==========================================================================
test("the broker password never appears in any audit row", async () => {
  const h = await harness();
  await h.service.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId }));
  const dump = JSON.stringify(await h.audit.list());
  assert.ok(!dump.includes(BROKER_PASSWORD));
  assert.ok(!dump.includes(PLATFORM_TOKEN));
});

test("the password reaches the provider body and nothing else", async () => {
  const h = await harness();
  await h.service.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId }));
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0]!.body!.includes(BROKER_PASSWORD), "the provider must receive the secret");
  // …and it must not have been persisted anywhere observable.
  assert.ok(!JSON.stringify([...h.operations.rows.values()]).includes(BROKER_PASSWORD));
  assert.ok(!JSON.stringify(await h.accounts.listByUser(OWNER)).includes(BROKER_PASSWORD));
});

test("a returned ConnectResult carries no secret material", async () => {
  const h = await harness();
  const out = await h.service.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId }));
  const dump = JSON.stringify(out);
  assert.ok(!dump.includes(BROKER_PASSWORD));
  assert.ok(!dump.includes(PLATFORM_TOKEN));
  assert.deepEqual(Object.keys(out).sort(), [
    "accountId", "alreadyConnected", "metaapiAccountId", "status",
  ]);
});

test("a provider failure never leaks the password into the thrown error", async () => {
  const h = await harness(() => new Response(JSON.stringify({ m: BROKER_PASSWORD }), { status: 400 }));
  await assert.rejects(
    () => h.service.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId })),
    (e: unknown) => {
      assert.ok(e instanceof ProvisioningServiceError);
      const dump = `${e.message}|${String(e.stack)}|${JSON.stringify(e)}`;
      assert.ok(!dump.includes(BROKER_PASSWORD));
      assert.ok(!dump.includes(PLATFORM_TOKEN));
      return true;
    },
  );
});

// ==========================================================================
// C. AUDIT VOCABULARY (OD-MP-2)
// ==========================================================================
test("a successful connect writes CREDENTIAL_USED then ACCOUNT_BINDING_CHANGED", async () => {
  const h = await harness();
  await h.service.connect({ id: OWNER, requestId: "req-7" }, h.accountId, body({ credentialId: h.credentialId }));
  const rows = [...(await h.audit.list())].reverse(); // oldest first

  assert.deepEqual(rows.map((r) => r.action), ["CREDENTIAL_USED", "ACCOUNT_BINDING_CHANGED"]);

  const used = rows[0]!;
  assert.equal(used.outcome, "success");
  assert.equal(used.actorUserId, OWNER);
  assert.equal(used.targetUserId, OWNER);
  assert.equal(used.provider, "METAAPI");
  assert.equal(used.credentialId, h.credentialId);
  assert.equal(used.tradingAccountId, h.accountId);
  assert.equal(used.requestId, "req-7");

  const bound = rows[1]!;
  assert.equal(bound.beforeState, null);
  assert.equal(bound.afterState, "prov-acct-1");
  assert.equal(bound.tradingAccountId, h.accountId);
});

test("CREDENTIAL_REVEALED is never emitted", async () => {
  const h = await harness();
  await h.service.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId }));
  // Widened to string so the check needs no cast: the point is that the
  // literal never appears, not that it typechecks as an AuditAction.
  const actions: string[] = (await h.audit.list()).map((r) => String(r.action));
  assert.ok(!actions.includes("CREDENTIAL_REVEALED"));
});

// ==========================================================================
// D. IDEMPOTENCY / RECOVERY
// ==========================================================================
test("a repeated connect converges on the same binding and calls the provider once", async () => {
  const h = await harness();
  const first = await h.service.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId }));
  const second = await h.service.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId }));
  assert.equal(first.alreadyConnected, false);
  assert.equal(second.alreadyConnected, true);
  assert.equal(second.metaapiAccountId, first.metaapiAccountId);
  assert.equal(h.calls.length, 1, "the second attempt must not re-provision");
});

test("an ambiguous 5xx is recorded AMBIGUOUS, and the retry RECONCILES instead of re-creating", async () => {
  // call 1: POST create -> 503 (ambiguous)   call 2: GET reconcile -> found
  const h = await harness((n) =>
    n === 1
      ? new Response("{}", { status: 503 })
      : new Response(JSON.stringify([{ _id: "recovered-1", name: markerOf(h) }]), {
          status: 200, headers: { "content-type": "application/json" },
        }),
  );

  await assert.rejects(
    () => h.service.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId })),
    (e: unknown) => e instanceof ProvisioningServiceError && e.status === 503,
  );
  const op = [...h.operations.rows.values()][0]!;
  assert.equal(op.status, "AMBIGUOUS", "an unknown provider outcome must never be FAILED");

  const retry = await h.service.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId }));
  assert.equal(retry.metaapiAccountId, "recovered-1");
  const posts = h.calls.filter((c) => !c.url.includes("?query="));
  assert.equal(posts.length, 1, "reconciliation must not POST a second account");
});

test("a 202 is polled with a bounded budget and resolves by marker", async () => {
  const h = await harness((n, url) => {
    if (n === 1) return new Response(JSON.stringify({ id: "AcceptedError" }), { status: 202 });
    if (url.includes("?query=")) {
      return new Response(JSON.stringify(n >= 3 ? [{ _id: "late-1", name: markerOf(h) }] : []), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 500 });
  });
  const out = await h.service.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId }));
  assert.equal(out.metaapiAccountId, "late-1");
});

test("a 202 that never resolves ends AMBIGUOUS, not FAILED", async () => {
  const h = await harness((n, url) =>
    n === 1
      ? new Response(JSON.stringify({ id: "AcceptedError" }), { status: 202 })
      : new Response(JSON.stringify([]), {
          status: 200, headers: { "content-type": "application/json" },
        }),
  );
  await assert.rejects(
    () => h.service.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId })),
    (e: unknown) => e instanceof ProvisioningServiceError && e.status === 503,
  );
  assert.equal([...h.operations.rows.values()][0]!.status, "AMBIGUOUS");
});

test("two markers matching is refused as AMBIGUOUS_RECONCILIATION, never guessed", async () => {
  const h = await harness((n) =>
    n === 1
      ? new Response("{}", { status: 503 })
      : new Response(
          JSON.stringify([
            { _id: "a", name: markerOf(h) },
            { _id: "b", name: markerOf(h) },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
  );
  await assert.rejects(
    () => h.service.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId })),
    () => true,
  );
  await assert.rejects(
    () => h.service.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId })),
    (e: unknown) =>
      e instanceof ProvisioningServiceError && e.code === "AMBIGUOUS_RECONCILIATION" && e.status === 409,
  );
});

/** The deterministic marker the service derives for the harness's operation. */
function markerOf(h: Harness): string {
  const op = [...h.operations.rows.values()][0];
  return op?.providerMarker ?? "velora-00000000000000000000000000000000";
}

// ==========================================================================
// E. VALIDATION / ERROR MODEL
// ==========================================================================
test("missing MetaAPI configuration fails closed with 503, never a crash", async () => {
  const h = await harness();
  const svc = new MetaApiProvisioningService({
    accounts: h.accounts,
    credentials: new MemoryCredentialStore(KEY),
    operations: h.operations,
    audit: h.audit,
    platformToken: () => null,
  });
  await assert.rejects(
    () => svc.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId })),
    (e: unknown) =>
      e instanceof ProvisioningServiceError && e.status === 503 && e.code === "SERVICE_UNAVAILABLE",
  );
});

test("invalid input is rejected before ownership or provider work", async () => {
  const h = await harness();
  for (const bad of [
    body({ credentialId: h.credentialId, login: "bad login!" }),
    body({ credentialId: h.credentialId, platform: "mt6" }),
    body({ credentialId: h.credentialId, server: "x".repeat(200) }),
    body({ credentialId: "not-a-number" }),
    {},
  ]) {
    await assert.rejects(
      () => h.service.connect({ id: OWNER }, h.accountId, bad),
      (e: unknown) =>
        e instanceof ProvisioningServiceError && e.status === 400 && e.code === "VALIDATION_FAILED",
    );
  }
  assert.equal(h.calls.length, 0);
});

// ==========================================================================
// F. DISCONNECT (OD-MP-3)
// ==========================================================================
test("disconnect unbinds locally and audits the transition", async () => {
  const h = await harness();
  await h.service.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId }));
  const out = await h.service.disconnect({ id: OWNER }, h.accountId, {});

  assert.deepEqual(out, {
    accountId: h.accountId, status: "disconnected", providerAccountDeleted: false,
  });
  assert.equal(await h.accounts.getMetaApiBinding(h.accountId, OWNER), null);

  const last = (await h.audit.list())[0]!;
  assert.equal(last.action, "ACCOUNT_BINDING_CHANGED");
  assert.equal(last.beforeState, "prov-acct-1");
  assert.equal(last.afterState, null);
  assert.equal(last.tradingAccountId, h.accountId);
});

test("disconnect does NOT delete the provider account unless explicitly asked", async () => {
  const h = await harness();
  await h.service.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId }));
  const before = h.calls.length;
  await h.service.disconnect({ id: OWNER }, h.accountId, {});
  assert.equal(h.calls.length, before, "no provider call for a local unbind");
});

test("disconnect with deleteProviderAccount performs the documented DELETE", async () => {
  const h = await harness((n) =>
    n === 1
      ? new Response(JSON.stringify({ id: "prov-acct-1" }), {
          status: 201, headers: { "content-type": "application/json" },
        })
      : new Response(null, { status: 204 }),
  );
  await h.service.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId }));
  const out = await h.service.disconnect({ id: OWNER }, h.accountId, { deleteProviderAccount: true });
  assert.equal(out.providerAccountDeleted, true);
  assert.ok(h.calls[1]!.url.endsWith("/users/current/accounts/prov-acct-1"));
});

test("a 404 from provider deletion still disconnects (OD-MP-3 G)", async () => {
  const h = await harness((n) =>
    n === 1
      ? new Response(JSON.stringify({ id: "prov-acct-1" }), {
          status: 201, headers: { "content-type": "application/json" },
        })
      : new Response(JSON.stringify({ m: "gone" }), { status: 404 }),
  );
  await h.service.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId }));
  const out = await h.service.disconnect({ id: OWNER }, h.accountId, { deleteProviderAccount: true });
  assert.equal(out.providerAccountDeleted, true);
  assert.equal(await h.accounts.getMetaApiBinding(h.accountId, OWNER), null);
});

test("a failed provider deletion leaves the binding INTACT and recoverable", async () => {
  const h = await harness((n) =>
    n === 1
      ? new Response(JSON.stringify({ id: "prov-acct-1" }), {
          status: 201, headers: { "content-type": "application/json" },
        })
      : new Response("{}", { status: 500 }),
  );
  await h.service.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId }));
  await assert.rejects(
    () => h.service.disconnect({ id: OWNER }, h.accountId, { deleteProviderAccount: true }),
    (e: unknown) => e instanceof ProvisioningServiceError && e.status === 503,
  );
  assert.equal(
    await h.accounts.getMetaApiBinding(h.accountId, OWNER),
    "prov-acct-1",
    "the binding must survive a failed provider deletion",
  );
});

test("only the owner can disconnect", async () => {
  const h = await harness();
  await h.service.connect({ id: OWNER }, h.accountId, body({ credentialId: h.credentialId }));
  for (const intruder of [OTHER_USER, ADMIN]) {
    await assert.rejects(
      () => h.service.disconnect({ id: intruder }, h.accountId, {}),
      (e: unknown) => e instanceof ProvisioningServiceError && e.status === 404,
    );
  }
  assert.equal(await h.accounts.getMetaApiBinding(h.accountId, OWNER), "prov-acct-1");
});

test("disconnecting an unconnected account is a 409, not a silent success", async () => {
  const h = await harness();
  await assert.rejects(
    () => h.service.disconnect({ id: OWNER }, h.accountId, {}),
    (e: unknown) => e instanceof ProvisioningServiceError && e.status === 409 && e.code === "NOT_CONNECTED",
  );
});

test("disconnect never revokes the credential (OD-MP-3 F: distinct operations)", async () => {
  const credentials = new MemoryCredentialStore(KEY);
  const cred = await credentials.create({
    userId: OWNER, provider: "METAAPI", secret: BROKER_PASSWORD, now: new Date(),
  });
  const accounts = new MemoryAccountStore();
  const acct = await accounts.create(
    OWNER,
    {
      provider: "MT5", platform: "MT5", label: "a", accountNumber: "1", currency: "USD",
      leverage: "100", timezone: null, timezoneSource: "unknown", status: "disconnected",
    },
    new Date(),
  );
  const svc = new MetaApiProvisioningService({
    accounts,
    credentials,
    operations: new MemoryProvisioningStore(),
    audit: new MemoryAuditStore(),
    platformToken: () => PLATFORM_TOKEN,
    clientOptions: {
      baseUrl: "https://provisioning.test",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ id: "p-1" }), {
          status: 201, headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    },
    sleep: async () => {},
  });
  await svc.connect({ id: OWNER }, acct.id, body({ credentialId: cred.id }));
  await svc.disconnect({ id: OWNER }, acct.id, {});
  // The credential must still exist and still be usable by its owner.
  assert.equal(await credentials.reveal(cred.id, OWNER), BROKER_PASSWORD);
});
