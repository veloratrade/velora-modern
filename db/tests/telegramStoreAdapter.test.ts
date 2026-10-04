// PgTelegramStore — the REAL PostgreSQL adapter, exercised against PGlite.
//
// WHY THIS EXISTS NEXT TO `telegramJournal.test.ts`. That battery proves the
// MIGRATION's constraints; this one proves the ADAPTER's statements — the SQL
// that the services actually call. The two are not interchangeable: an adapter
// can hold the right constraint and still use it wrongly (a read-then-write where
// the claim must be one statement), and those are exactly the bugs that cost a
// user a duplicated journal entry or a second spent link token.
//
// THE FOUR STATEMENTS THAT MUST NOT BE REWRITTEN (see the adapter's header):
//   claimUpdate             — INSERT ... ON CONFLICT DO NOTHING RETURNING
//   consumeLinkToken        — UPDATE ... WHERE status='PENDING' AND expires_at>now()
//   claimDraftForConfirmation — UPDATE ... WHERE state IN (actionable)
//   claimChannelPost        — INSERT ... ON CONFLICT (channel_id, trade_id)
// Each is asserted here for BOTH outcomes: the winner and the loser.
//
// EVIDENCE LABEL: PGlite (real PostgreSQL semantics, in-wasm, single session).
// This is dev/test evidence. It is NOT real-PostgreSQL concurrency evidence —
// no two sessions race here — and the `*.pg.test.ts` batteries remain the
// real-server evidence path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Pool } from "pg";
import { createEngine, migrate, type MigrationEngine } from "../migrate.ts";
import { PgTelegramStore } from "../../apps/api/src/telegram/pgTelegramStore.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const T0 = new Date("2026-10-01T10:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

/**
 * PGlite behind the `Pool` shape the adapter uses (`query` + `connect`).
 *
 * A shim and not a stub: every statement still runs in real PostgreSQL, so a
 * syntax error, a wrong cast or a missing column fails here exactly as it would
 * against a server. What it does NOT provide is a second session — see the label.
 */
function pglitePool(engine: MigrationEngine): Pool {
  const run = (sql: string, values?: unknown[]) => engine.query(sql, values);
  return {
    query: run,
    connect: async () => ({ query: run, release: () => undefined }),
  } as unknown as Pool;
}

interface Harness {
  readonly engine: MigrationEngine;
  readonly store: PgTelegramStore;
  user(email: string): Promise<string>;
}

async function harness(): Promise<Harness> {
  const engine = await createEngine();
  await migrate(engine, MIGRATIONS);
  const store = new PgTelegramStore(pglitePool(engine));
  return {
    engine,
    store,
    async user(email: string) {
      const { rows } = await engine.query("INSERT INTO users(email, password_hash) VALUES ($1,'not-a-real-hash') RETURNING id::text AS id", [email]);
      return String(rows[0]!["id"]);
    },
  };
}

/** A draft body that satisfies every column the adapter writes. */
const draftOf = (over: Record<string, unknown> = {}) => ({
  symbol: "XAUUSD",
  direction: "buy" as const,
  entryPrice: "2650",
  exitPrice: "2660",
  volume: "0.50",
  stopLoss: null,
  takeProfit: null,
  notes: null,
  openTime: null,
  closeTime: null,
  ...over,
});

test("claimUpdate is a primary-key claim: the first delivery wins and every later one loses", async () => {
  const h = await harness();
  try {
    const claim = { updateId: "900001", kind: "message" as const, telegramUserId: "555", chatId: "555", at: T0 };
    assert.equal(await h.store.claimUpdate(claim), true, "the first delivery owns the update");
    assert.equal(await h.store.claimUpdate({ ...claim, at: at(1) }), false, "a redelivery must not act");
    assert.equal(await h.store.claimUpdate({ ...claim, telegramUserId: "999", at: at(2) }), false, "…not even from another user id");

    await h.store.finishUpdate("900001", "handled", null, at(3));
    const { rows } = await h.engine.query("SELECT outcome, error_code, processed_at FROM telegram_updates WHERE update_id = $1::bigint", ["900001"]);
    assert.equal(rows[0]!["outcome"], "handled");
    assert.equal(rows[0]!["error_code"], null);
    assert.notEqual(rows[0]!["processed_at"], null, "finishing is what records that the work happened");

    // A finished update still cannot be re-claimed: the row IS the dedupe key.
    assert.equal(await h.store.claimUpdate(claim), false);
  } finally {
    await h.engine.close();
  }
});

test("createLinkToken supersedes the pending token, so only the newest one can ever be spent", async () => {
  const h = await harness();
  try {
    const userId = await h.user("link@example.com");
    const first = "1".repeat(64);
    const second = "2".repeat(64);

    await h.store.createLinkToken({ userId, tokenHash: first, expiresAt: at(10), at: T0 });
    await h.store.createLinkToken({ userId, tokenHash: second, expiresAt: at(10), at: at(1) });

    // Starting a second flow must not be blocked by an abandoned one, and must
    // not leave two live tokens: the older one is closed out in the same unit.
    const pending = await h.engine.query("SELECT token_hash, status FROM telegram_link_tokens WHERE user_id = $1::bigint ORDER BY created_at", [userId]);
    assert.deepEqual(pending.rows.map((r) => [r["token_hash"], r["status"]]), [[first, "REVOKED"], [second, "PENDING"]]);

    assert.deepEqual(await h.store.consumeLinkToken({ tokenHash: first, telegramUserId: "555", at: at(2) }), { ok: false, reason: "REVOKED" });
    const consumed = await h.store.consumeLinkToken({ tokenHash: second, telegramUserId: "555", at: at(2) });
    assert.equal(consumed.ok, true);
    assert.equal(consumed.ok === true ? consumed.userId : "", userId);

    // Single use, and the reason is reported rather than collapsed into "unknown".
    assert.deepEqual(await h.store.consumeLinkToken({ tokenHash: second, telegramUserId: "999", at: at(3) }), { ok: false, reason: "CONSUMED" });
    assert.deepEqual(await h.store.consumeLinkToken({ tokenHash: "3".repeat(64), telegramUserId: "555", at: at(3) }), { ok: false, reason: "UNKNOWN" });
  } finally {
    await h.engine.close();
  }
});

test("an expired link token is not spendable, whatever its status says", async () => {
  const h = await harness();
  try {
    const userId = await h.user("expired@example.com");
    const hash = "4".repeat(64);
    // Expiry is in the WHERE clause, so the engine — not a clock the caller
    // supplies — decides. The row stays PENDING; only the decision changes.
    await h.store.createLinkToken({ userId, tokenHash: hash, expiresAt: at(5), at: T0 });

    assert.deepEqual(await h.store.consumeLinkToken({ tokenHash: hash, telegramUserId: "555", at: at(5) }), { ok: false, reason: "EXPIRED" }, "expiry is exclusive at the boundary");
    assert.deepEqual(await h.store.consumeLinkToken({ tokenHash: hash, telegramUserId: "555", at: at(6) }), { ok: false, reason: "EXPIRED" });
    const still = await h.engine.query("SELECT status FROM telegram_link_tokens WHERE token_hash = $1", [hash]);
    assert.equal(still.rows[0]!["status"], "PENDING", "a refused consumption must not mutate the row");

    // One second earlier it would have worked — proving the refusal was expiry.
    const live = "5".repeat(64);
    await h.store.createLinkToken({ userId, tokenHash: live, expiresAt: at(5), at: T0 });
    assert.equal((await h.store.consumeLinkToken({ tokenHash: live, telegramUserId: "555", at: at(4) })).ok, true);
  } finally {
    await h.engine.close();
  }
});

test("one live link per account and per Telegram identity, and revocation is ownership-scoped", async () => {
  const h = await harness();
  try {
    const alice = await h.user("alice@example.com");
    const bob = await h.user("bob@example.com");

    const first = await h.store.insertLiveIdentity({ userId: alice, telegramUserId: "555", username: "alice_trader", at: T0 });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const identityId = first.identity.id;

    // The Telegram identity is taken…
    assert.deepEqual(await h.store.insertLiveIdentity({ userId: bob, telegramUserId: "555", username: "impostor_here", at: at(1) }), { ok: false, reason: "IDENTITY_TAKEN" });
    // …and the account already has a live link.
    assert.deepEqual(await h.store.insertLiveIdentity({ userId: alice, telegramUserId: "777", username: "second_account", at: at(1) }), { ok: false, reason: "ACCOUNT_TAKEN" });

    // Unlinking with the WRONG owner removes nothing, even with the right id.
    assert.equal(await h.store.revokeIdentity(bob, identityId, at(2)), false, "a guessed identity id must not unlink somebody else");
    const untouched = await h.store.findLiveIdentityByUserId(alice);
    assert.equal(untouched?.id, identityId, "the link must survive an unauthorised attempt");

    // The owner's revoke works, and then the SAME Telegram identity may re-link —
    // the partial unique index is on LIVE rows only.
    assert.equal(await h.store.revokeIdentity(alice, identityId, at(3)), true);
    assert.equal(await h.store.findLiveIdentityByUserId(alice), null);
    assert.equal(await h.store.findLatestIdentityByUserId(alice) !== null, true, "the revoked row is retained as history");
    const relinked = await h.store.insertLiveIdentity({ userId: alice, telegramUserId: "555", username: "alice_trader", at: at(4) });
    assert.equal(relinked.ok, true, "revocation frees both sides of the pair");
    // A second revoke of the already-revoked row reports "nothing was live".
    assert.equal(await h.store.revokeIdentity(alice, identityId, at(5)), false);
  } finally {
    await h.engine.close();
  }
});

test("a draft is claimed once for confirmation, and only from an actionable state", async () => {
  const h = await harness();
  try {
    const alice = await h.user("draft@example.com");
    // A confirmed draft must point at a REAL trade (FK), so the test creates one.
    const { rows: tradeRows } = await h.engine.query(
      `INSERT INTO trades(user_id, symbol, direction, entry_price, exit_price, volume, occurred_at)
       VALUES ($1::bigint,'XAUUSD','buy',2650,2660,0.5, now()) RETURNING id::text AS id`,
      [alice],
    );
    const tradeId = String(tradeRows[0]!["id"]);
    const base = { userId: alice, telegramUserId: "555", chatId: "555", sourceKind: "TEXT" as const, media: {}, at: T0 };

    const incomplete = await h.store.createDraft({
      ...base, sourceMessageId: "1000", draft: draftOf({ exitPrice: null }), missingFields: ["exitPrice"], transcript: null, expiresAt: at(30),
    });
    assert.equal(incomplete.state, "NEEDS_DETAIL", "a draft that is missing a required field is not confirmable");
    assert.deepEqual(incomplete.missingFields, ["exitPrice"]);

    const draft = await h.store.createDraft({
      ...base, sourceMessageId: "1001", draft: draftOf(), missingFields: [], transcript: null, expiresAt: at(30),
    });
    assert.equal(draft.state, "AWAITING_CONFIRMATION");
    // Only the newest actionable draft is "the" draft the user is answering.
    assert.equal((await h.store.findOpenDraft("555", at(1)))?.id, draft.id);
    // Non-numeric ids are rejected before touching SQL (a callback payload is input).
    assert.equal(await h.store.findDraftById("confirm"), null);

    // The write-once gate. Two taps ⇒ one winner.
    assert.equal(await h.store.claimDraftForConfirmation(draft.id, at(2)), true);
    assert.equal(await h.store.claimDraftForConfirmation(draft.id, at(2)), false, "the second tap must find the draft already claimed");
    assert.equal((await h.store.findDraftById(draft.id))?.state, "CONFIRMING");
    // A claimed draft is no longer open for answering. The INCOMPLETE draft is
    // still actionable, so this also proves the claimed one was filtered out by
    // STATE rather than the query simply finding nothing.
    const nextOpen = await h.store.findOpenDraft("555", at(3));
    assert.notEqual(nextOpen?.id, draft.id, "a claimed draft must never be offered again");
    assert.equal(nextOpen?.id, incomplete.id, "…while the other actionable draft stays reachable");

    // The trade is bound only from CONFIRMING, so a late confirmation cannot bind twice.
    assert.equal(await h.store.markDraftConfirmed(draft.id, tradeId, at(4)), true);
    assert.equal(await h.store.markDraftConfirmed(draft.id, tradeId, at(5)), false, "the CONFIRMED state is terminal");
    assert.equal((await h.store.findDraftById(draft.id))?.confirmedTradeId, tradeId);
    assert.equal((await h.store.findDraftById(draft.id))?.state, "CONFIRMED");

    // A failure after the claim releases it back to an actionable state.
    const other = await h.store.createDraft({ ...base, sourceMessageId: "1002", draft: draftOf(), missingFields: [], transcript: null, expiresAt: at(30) });
    await h.store.claimDraftForConfirmation(other.id, at(6));
    await h.store.releaseConfirmationClaim(other.id, "AWAITING_CONFIRMATION", at(7));
    assert.equal((await h.store.findDraftById(other.id))?.state, "AWAITING_CONFIRMATION", "the user must be able to try again after a server-side failure");
    assert.equal(await h.store.claimDraftForConfirmation(other.id, at(8)), true);
  } finally {
    await h.engine.close();
  }
});

test("expiry is a sweep, not a timer: only actionable-and-past rows are expired", async () => {
  const h = await harness();
  try {
    const alice = await h.user("expiry@example.com");
    const base = { userId: alice, telegramUserId: "555", chatId: "555", sourceKind: "TEXT" as const, media: {}, at: T0 };
    const expired = await h.store.createDraft({ ...base, sourceMessageId: "2000", draft: draftOf(), missingFields: [], transcript: null, expiresAt: at(30) });
    const fresh = await h.store.createDraft({ ...base, sourceMessageId: "2001", draft: draftOf(), missingFields: [], transcript: null, expiresAt: at(120) });

    assert.equal(await h.store.expireStaleDrafts(at(29)), 0, "an unexpired draft must not be touched");
    // findOpenDraft already refuses the expired one, so the sweep is about keeping
    // the stored state truthful rather than about correctness of the read.
    assert.equal((await h.store.findOpenDraft("555", at(31)))?.id, fresh.id);
    assert.equal(await h.store.expireStaleDrafts(at(31)), 1);
    assert.equal((await h.store.findDraftById(expired.id))?.state, "EXPIRED");
    assert.equal((await h.store.findDraftById(fresh.id))?.state, "AWAITING_CONFIRMATION");
  } finally {
    await h.engine.close();
  }
});

test("the channel mirror is bound per owner+chat and can post a given trade only once", async () => {
  const h = await harness();
  try {
    const alice = await h.user("channel@example.com");
    const bob = await h.user("channel-bob@example.com");
    const { rows: tradeRows } = await h.engine.query(
      `INSERT INTO trades(user_id, symbol, direction, entry_price, exit_price, volume, occurred_at)
       VALUES ($1::bigint,'XAUUSD','buy',2650,2660,0.5, now()) RETURNING id::text AS id`,
      [alice],
    );
    const tradeId = String(tradeRows[0]!["id"]);
    const { rows: bobTradeRows } = await h.engine.query(
      `INSERT INTO trades(user_id, symbol, direction, entry_price, exit_price, volume, occurred_at)
       VALUES ($1::bigint,'EURUSD','sell',1.1,1.09,0.1, now()) RETURNING id::text AS id`,
      [bob],
    );
    const bobTradeId = String(bobTradeRows[0]!["id"]);
    const bound = await h.store.upsertChannel({ userId: alice, chatId: "-100123", title: "Velora Journal", chatType: "channel", status: "ACTIVE", canPost: true, at: T0 });
    assert.equal(bound.canPost, true);

    // Rebinding the same chat reopens the SAME row rather than creating a second.
    await h.store.revokeChannel(alice, "-100123", at(1));
    assert.equal(await h.store.findActiveChannel(alice), null, "a revoked channel is not active");
    const rebound = await h.store.upsertChannel({ userId: alice, chatId: "-100123", title: "Velora Journal", chatType: "channel", status: "ACTIVE", canPost: true, at: at(2) });
    assert.equal(rebound.id, bound.id, "one row per (owner, chat) — not one per binding episode");
    assert.equal(await h.store.revokeChannel(alice, "-100999", at(3)), false, "revoking a chat the user never bound is a no-op");

    // Publishing: the claim is per (channel, trade), so a redelivered update or a
    // second confirmation cannot post the same trade twice.
    const first = await h.store.claimChannelPost({ channelId: bound.id, userId: alice, tradeId, at: at(4) });
    assert.equal(first.claimed, true);
    assert.equal((await h.store.claimChannelPost({ channelId: bound.id, userId: alice, tradeId, at: at(5) })).claimed, false);
    // The composite FK is the ownership guarantee: a mirror row cannot be created
    // for another user's trade, so a guessed trade id cannot publish foreign data.
    await assert.rejects(() => h.store.claimChannelPost({ channelId: bound.id, userId: alice, tradeId: bobTradeId, at: at(5) }));
    // A failed post is not "published", so the same trade may be retried…
    await h.store.finishChannelPost(first.postId!, "FAILED", null, "TELEGRAM_API_ERROR", at(6));
    assert.deepEqual(await h.store.listPublishedTradeIds(bound.id), [], "a failed post must not read as published");
    assert.equal((await h.store.claimChannelPost({ channelId: bound.id, userId: alice, tradeId, at: at(7) })).claimed, false, "the claim row still exists — retry is the caller's decision, not a second claim");
    // …and once published it is recorded with its message id.
    await h.store.finishChannelPost(first.postId!, "PUBLISHED", "321", null, at(8));
    assert.deepEqual(await h.store.listPublishedTradeIds(bound.id), [tradeId]);
  } finally {
    await h.engine.close();
  }
});
