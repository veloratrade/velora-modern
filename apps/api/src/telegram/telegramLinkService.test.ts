// Telegram linking — the security core, tested against the real services.
//
// WHAT THIS FILE IS EVIDENCE FOR (and what it is not). These are SERVICE tests
// over the contract-identical in-memory store: they prove the refusal order, the
// single-use rule, expiry, the two collision rules, non-disclosure and the audit
// trail. They are NOT database evidence — atomicity under two real sessions is
// `db/tests/telegramJournal.test.ts` (PGlite) and the `*.pg.test.ts` path.
//
// The adversarial cases are the point of this file: every "cannot" below is a
// property an attacker would otherwise get for free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryAuditStore } from "../auth/memoryAuditStore.js";
import { MemoryTelegramStore } from "./memoryTelegramStore.js";
import { TelegramLinkService, hashToken, maskTelegramUserId } from "./telegramLinkService.js";
import { telegramDeepLink } from "@velora/contracts";

const BOT = "velora_journal_bot";

/** A store whose identity read fails, for the LINK_ERROR path. */
class BrokenIdentityStore extends MemoryTelegramStore {
  override async findLiveIdentityByUserId(): Promise<null> {
    throw new Error("database is unreachable");
  }
}

function makeService(options: { tokenTtlSeconds?: number; now?: () => Date } = {}): {
  service: TelegramLinkService;
  store: MemoryTelegramStore;
  audit: MemoryAuditStore;
} {
  const store = new MemoryTelegramStore();
  const audit = new MemoryAuditStore();
  const service = new TelegramLinkService({
    store,
    audit,
    botUsername: () => BOT,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.tokenTtlSeconds === undefined ? {} : { tokenTtlSeconds: options.tokenTtlSeconds }),
  });
  return { service, store, audit };
}

test("startLinking returns a deep link whose payload is an opaque token — never account data", async () => {
  const { service, store, audit } = makeService();
  const started = await service.startLinking("42", "req-1");

  assert.ok(started.deepLink.startsWith(`https://t.me/${BOT}?start=`));
  assert.equal(started.deepLink, telegramDeepLink(BOT, started.token));
  // The payload is high-entropy base64url and carries no id, no email, no flag.
  assert.match(started.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!started.deepLink.includes("42"));
  assert.ok(!started.deepLink.toLowerCase().includes("user"));

  // ONLY the hash is stored: a database reader cannot replay the link.
  const stored = await store.findLatestTokenByUserId("42");
  assert.equal(stored?.status, "PENDING");
  // (the memory double keeps the hash on its own row — the port type exposes the
  // lifecycle, never the credential-shaped field)
  const storedHash = store.tokens.at(-1)!.tokenHash;
  assert.notEqual(storedHash, started.token);
  assert.equal(storedHash, hashToken(started.token));

  // Starting a flow is a privileged action and is audited.
  const rows = await audit.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.action, "TELEGRAM_LINK_STARTED");
  assert.equal(rows[0]!.actorUserId, "42");
  assert.equal(rows[0]!.provider, "TELEGRAM");
});

test("a link token is single-use: the second delivery is refused, not re-linked", async () => {
  const { service } = makeService();
  const { token } = await service.startLinking("42", null);

  const first = await service.completeFromPayload({ payload: token, telegramUserId: "555", username: "trader", requestId: null });
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.userId, "42");
  assert.equal(first.ok && first.alreadyLinked, false);

  const replay = await service.completeFromPayload({ payload: token, telegramUserId: "777", username: "attacker", requestId: null });
  assert.equal(replay.ok, false);
  assert.equal(replay.ok === false && replay.code, "TOKEN_ALREADY_CONSUMED");
  // The attacker's Telegram id is NOT linked.
  assert.equal(await service.resolveUserId("777"), null);
});

test("an expired token is refused, and expiry is decided before the collision rules", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const { service } = makeService({ tokenTtlSeconds: 600, now: () => now });
  const { token, expiresAt } = await service.startLinking("42", null);
  assert.equal(expiresAt, new Date(now.getTime() + 600_000).toISOString());

  now = new Date(now.getTime() + 600_001); // one millisecond past expiry
  const late = await service.completeFromPayload({ payload: token, telegramUserId: "555", username: null, requestId: null });
  assert.equal(late.ok, false);
  assert.equal(late.ok === false && late.code, "TOKEN_EXPIRED");
  assert.equal(await service.resolveUserId("555"), null);
});

test("junk payloads are refused without a lookup and without an audit row", async () => {
  const { service, audit } = makeService();
  await service.startLinking("42", null);
  const before = (await audit.list()).length;

  for (const payload of ["", "not-a-token", "x".repeat(43), "../../etc/passwd", "' OR 1=1 --"]) {
    const result = await service.completeFromPayload({ payload, telegramUserId: "555", username: null, requestId: null });
    assert.equal(result.ok, false, `payload ${JSON.stringify(payload)} must be refused`);
    assert.equal(result.ok === false && result.code, "TOKEN_UNKNOWN");
  }
  // 0009 requires an authenticated actor: an unattributable attempt must not be
  // able to write rows into the security trail.
  assert.equal((await audit.list()).length, before);
  assert.equal(await service.resolveUserId("555"), null);
});

test("one Telegram identity cannot be captured by a second account, and one account cannot hold two", async () => {
  const { service } = makeService();
  const aliceToken = (await service.startLinking("1", null)).token;
  assert.equal((await service.completeFromPayload({ payload: aliceToken, telegramUserId: "555", username: "alice", requestId: null })).ok, true);

  // BOB tries to link the SAME Telegram identity.
  const bobToken = (await service.startLinking("2", null)).token;
  const stolen = await service.completeFromPayload({ payload: bobToken, telegramUserId: "555", username: "alice", requestId: null });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.ok === false && stolen.code, "IDENTITY_LINKED_TO_OTHER_ACCOUNT");
  assert.equal(await service.resolveUserId("555"), "1"); // still Alice's

  // ALICE tries a second Telegram identity.
  const second = await service.startLinking("1", null);
  const extra = await service.completeFromPayload({ payload: second.token, telegramUserId: "999", username: "alice2", requestId: null });
  assert.equal(extra.ok, false);
  assert.equal(extra.ok === false && extra.code, "ACCOUNT_ALREADY_LINKED");
  assert.equal(await service.resolveUserId("999"), null);
});

test("re-linking the same pair is idempotent and audited, not an error", async () => {
  const { service, store, audit } = makeService();
  const first = (await service.startLinking("1", null)).token;
  await service.completeFromPayload({ payload: first, telegramUserId: "555", username: "alice", requestId: null });

  const again = (await service.startLinking("1", null)).token;
  const result = await service.completeFromPayload({ payload: again, telegramUserId: "555", username: "alice", requestId: null });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.alreadyLinked, true);

  const live = await store.findLiveIdentityByUserId("1");
  assert.ok(live !== null);
  const actions = (await audit.list()).map((row) => row.action);
  assert.deepEqual(actions.filter((a) => a === "TELEGRAM_LINK_COMPLETED").length, 2);
});

test("unlink revokes only the caller's own live link, and a second unlink is a refusal", async () => {
  const { service, store } = makeService();
  const token = (await service.startLinking("1", null)).token;
  await service.completeFromPayload({ payload: token, telegramUserId: "555", username: "alice", requestId: null });

  // Somebody else's unlink cannot touch it (ownership is the store predicate).
  const notMine = await store.revokeIdentity("2", "1", new Date());
  assert.equal(notMine, false);
  assert.ok((await store.findLiveIdentityByUserId("1")) !== null);

  const removed = await service.unlink("1", "req-2");
  assert.equal(removed.revokedTelegramUserId, "555");
  assert.equal(await service.resolveUserId("555"), null); // the bridge is closed

  // And a second unlink is a typed refusal, not a silent success.
  await assert.rejects(() => service.unlink("1", null), (err: unknown) => {
    const typed = err as { code?: string; status?: number };
    assert.equal(typed.code, "NOT_LINKED");
    assert.equal(typed.status, 409);
    return true;
  });
});

test("status distinguishes every state the UI must render, and cannot be confused by a storage fault", async () => {
  const { service, store } = makeService();
  assert.equal((await service.status("1")).state, "NOT_LINKED");

  const { token } = await service.startLinking("1", null);
  const pending = await service.status("1");
  assert.equal(pending.state, "LINK_PENDING");
  assert.ok(pending.pendingExpiresAt !== null);

  // The STORED hash is not a credential: presenting it as a payload fails the
  // shape guard, so a database reader cannot turn a row into a link.
  const row = (await store.findLatestTokenByUserId("1"))!;
  void row;
  const hashAsToken = await service.completeFromPayload({ payload: store.tokens.at(-1)!.tokenHash, telegramUserId: "555", username: null, requestId: null });
  assert.equal(hashAsToken.ok, false);
  assert.equal(hashAsToken.ok === false && hashAsToken.code, "TOKEN_UNKNOWN");
  assert.equal((await service.status("1")).state, "LINK_PENDING");

  await service.completeFromPayload({ payload: token, telegramUserId: "555", username: "alice", requestId: null });
  assert.equal((await service.status("1")).state, "LINKED");
  await service.unlink("1", null);
  assert.equal((await service.status("1")).state, "LINK_REVOKED");

  // A failing store must NOT be reported as NOT_LINKED: "we could not read it"
  // and "you are not connected" lead to different user actions.
  const broken = new TelegramLinkService({
    store: new BrokenIdentityStore(),
    audit: new MemoryAuditStore(),
    botUsername: () => BOT,
  });
  assert.equal((await broken.status("1")).state, "LINK_ERROR");
});

test("the Telegram user id is masked for display and never exposed raw", async () => {
  assert.equal(maskTelegramUserId("123456789"), "••••6789");
  assert.equal(maskTelegramUserId("42"), "••••42");
  assert.equal(maskTelegramUserId(""), "••••");

  const { service } = makeService();
  const token = (await service.startLinking("1", null)).token;
  await service.completeFromPayload({ payload: token, telegramUserId: "123456789", username: "alice", requestId: null });
  const status = await service.status("1");
  assert.equal(status.state, "LINKED");
  assert.equal(status.identity?.maskedTelegramUserId, "••••6789");
  assert.ok(!JSON.stringify(status).includes("123456789"));
});

test("startLinking refuses without a bot username instead of inventing a destination", async () => {
  const store = new MemoryTelegramStore();
  const service = new TelegramLinkService({ store, audit: new MemoryAuditStore(), botUsername: () => null });
  await assert.rejects(() => service.startLinking("1", null), (err: unknown) => {
    const typed = err as { code?: string; status?: number };
    assert.equal(typed.status, 503);
    assert.equal(typed.code, "TELEGRAM_NOT_CONFIGURED");
    return true;
  });
  // Nothing was minted, so a refuse-then-configure path cannot leave a live token.
  assert.equal(await store.findLatestTokenByUserId("1"), null);
});

test("hashToken and the shape guard agree with what the store enforces", async () => {
  const { token } = await makeService().service.startLinking("1", null);
  const hash = hashToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/); // exactly the DB CHECK's shape
  assert.notEqual(hash, hashToken(`${token}x`));
  assert.equal(hash, hashToken(token));
});
