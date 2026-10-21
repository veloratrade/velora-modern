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

    assert.equal(await h.store.beginUpdateProcessing("900001", at(2)), true, "only one worker may acquire the durable start marker");
    assert.equal(await h.store.beginUpdateProcessing("900001", at(2)), false, "a worker retry after start must not replay side effects");
    await h.store.finishUpdate("900001", "handled", null, at(3));
    const { rows } = await h.engine.query("SELECT processing_started_at, outcome, error_code, processed_at FROM telegram_updates WHERE update_id = $1::bigint", ["900001"]);
    assert.notEqual(rows[0]!["processing_started_at"], null);
    assert.equal(rows[0]!["outcome"], "handled");
    assert.equal(rows[0]!["error_code"], null);
    assert.notEqual(rows[0]!["processed_at"], null, "finishing is what records that the work happened");
    assert.equal(await h.store.beginUpdateProcessing("900001", at(4)), false, "a completed row cannot start again");
    await h.store.finishUpdate("900001", "failed", "REPLAY", at(5));
    const unchanged = (await h.engine.query("SELECT outcome, error_code FROM telegram_updates WHERE update_id = $1::bigint", ["900001"])).rows[0]!;
    assert.equal(unchanged["outcome"], "handled", "a repeated finish cannot overwrite its terminal outcome");

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
      // complete CLOSED shape (0025): 2650 → 2660 on 0.5 lots with contract size 1 = +5.00
      `INSERT INTO trades(user_id, symbol, direction, status, entry_price, exit_price, volume,
                          net_pnl, occurred_at, occurred_close_at_utc)
       VALUES ($1::bigint,'XAUUSD','buy','CLOSED',2650,2660,0.5,5.00, now(), now()) RETURNING id::text AS id`,
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
      `INSERT INTO trades(user_id, symbol, direction, status, entry_price, exit_price, volume,
                          net_pnl, occurred_at, occurred_close_at_utc)
       VALUES ($1::bigint,'XAUUSD','buy','CLOSED',2650,2660,0.5,5.00, now(), now()) RETURNING id::text AS id`,
      [alice],
    );
    const tradeId = String(tradeRows[0]!["id"]);
    const { rows: bobTradeRows } = await h.engine.query(
      `INSERT INTO trades(user_id, symbol, direction, status, entry_price, exit_price, volume,
                          net_pnl, occurred_at, occurred_close_at_utc)
       VALUES ($1::bigint,'EURUSD','sell','CLOSED',1.1,1.09,0.1,0.00, now(), now()) RETURNING id::text AS id`,
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

test("templates append a version instead of overwriting one, and a stale save is a conflict not a loss", async () => {
  const h = await harness();
  try {
    const alice = await h.user("tpl@example.com");
    const bob = await h.user("tpl-bob@example.com");
    const body = "Bias {{checklist.dailyBias}}";

    assert.equal(await h.store.findCurrentTemplate(alice, "morning"), null);
    const first = await h.store.saveTemplate({ userId: alice, name: "  morning  ", body, expectedVersion: null, at: T0 });
    assert.equal(first.status, "saved");
    if (first.status !== "saved") return;
    // The name is trimmed on write, so what the user typed and what is stored agree.
    assert.equal(first.record.name, "morning");
    assert.equal(first.record.version, 1);

    // Creating a name that already exists is a conflict, never a replace or a rename.
    const clash = await h.store.saveTemplate({ userId: alice, name: "morning", body: "other", expectedVersion: null, at: at(1) });
    assert.equal(clash.status, "conflict");

    // The safe update: version 2 becomes current and version 1 is still readable.
    const second = await h.store.saveTemplate({ userId: alice, name: "morning", body: `${body} v2`, expectedVersion: 1, at: at(2) });
    assert.equal(second.status, "saved");
    if (second.status !== "saved") return;
    assert.equal(second.record.version, 2);
    const current = await h.store.findCurrentTemplate(alice, "morning");
    assert.equal(current?.version, 2);
    const { rows: history } = await h.engine.query(
      `SELECT version, superseded_at IS NOT NULL AS retired FROM telegram_post_templates
        WHERE user_id = $1::bigint AND name = 'morning' ORDER BY version`,
      [alice],
    );
    assert.deepEqual(
      history.map((r) => ({ version: Number(r["version"]), retired: r["retired"] === true })),
      [{ version: 1, retired: true }, { version: 2, retired: false }],
      "0037 stores the whole lineage",
    );

    // A save made from a preview the user has since replaced cannot write: the version they were
    // shown is not the stored current one, so this is reported instead of overwriting their edit.
    const stale = await h.store.saveTemplate({ userId: alice, name: "morning", body: "lost update", expectedVersion: 1, at: at(3) });
    assert.equal(stale.status, "conflict");
    assert.equal(await (async () => (await h.store.findCurrentTemplate(alice, "morning"))?.version)(), 2);

    // Ownership: same name, different user, two independent templates.
    await h.store.saveTemplate({ userId: bob, name: "morning", body: "bob's", expectedVersion: null, at: at(4) });
    assert.equal((await h.store.findCurrentTemplate(bob, "morning"))?.body, "bob's");
    assert.equal((await h.store.findCurrentTemplate(alice, "morning"))?.body, `${body} v2`);
    assert.deepEqual((await h.store.listTemplates(alice)).map((t) => t.name), ["morning"]);

    // Retiring is a tombstone: the name stops resolving, the rows stay.
    assert.equal(await h.store.retireTemplate(alice, "morning", at(5)), true);
    assert.equal(await h.store.findCurrentTemplate(alice, "morning"), null);
    assert.equal(await h.store.retireTemplate(alice, "morning", at(6)), false, "retiring twice is a no-op, not an error");
    const { rows: still } = await h.engine.query(`SELECT count(*)::int AS n FROM telegram_post_templates WHERE user_id = $1::bigint`, [alice]);
    assert.equal(still[0]!["n"], 2, "a retired name never deletes history");
    // And the name is free again for a NEW template at version 1 (no current row to conflict with).
    const again = await h.store.saveTemplate({ userId: alice, name: "morning", body: "fresh", expectedVersion: null, at: at(7) });
    assert.equal(again.status, "saved");
    if (again.status === "saved") assert.equal(again.record.version, 3, "versions never repeat for one name");
  } finally {
    await h.engine.close();
  }
});

test("a prepared post is claimed once, approved only for its exact bytes, and published by a single claim", async () => {
  const h = await harness();
  try {
    const alice = await h.user("post@example.com");
    const bob = await h.user("post-bob@example.com");
    const { rows: chRows } = await h.engine.query(
      `INSERT INTO telegram_channels (user_id, chat_id, title, chat_type, status, can_post, verified_at)
       VALUES ($1::bigint, -100123, 'Velora Journal', 'channel', 'ACTIVE', true, now()) RETURNING id::text AS id`,
      [alice],
    );
    const channelId = String(chRows[0]!["id"]);
    const hash = "a".repeat(64);
    const claim = (over: Record<string, unknown> = {}) =>
      h.store.claimPost({
        userId: alice,
        channelId,
        chatId: "-100123",
        body: "Bias bullish",
        contentHash: hash,
        dedupeKey: "update:42",
        bannerSvg: null,
        imageFileId: null,
        templateKey: "velora.bias",
        templateVersion: 1,
        at: T0,
        ...over,
      });

    const fresh = await claim();
    assert.equal(fresh.status, "claimed");
    assert.equal(fresh.post.status, "DRAFT");
    // A re-delivered update with the same dedupe key gets the SAME row back and must not send.
    const again = await claim({ at: at(1) });
    assert.equal(again.status, "duplicate");
    assert.equal(again.post.id, fresh.post.id);

    // bob cannot borrow alice's channel binding: the composite (channel_id, user_id) owner FK in
    // 0037 refuses it in the database, so a guessed channel id can never queue someone else's post.
    await assert.rejects(
      () => claim({ userId: bob, channelId, dedupeKey: "update:42", at: at(2) }),
      /violates foreign key constraint/i,
      "the channel a post is aimed at must belong to the user who prepared it",
    );
    // With a channel of his own, the SAME dedupe key is a different row: the key is scoped to the
    // owner, so two users never collide on `update:42`.
    const { rows: bobChannel } = await h.engine.query(
      `INSERT INTO telegram_channels (user_id, chat_id, title, chat_type, status, can_post, verified_at)
       VALUES ($1::bigint, -100456, 'Bob Journal', 'channel', 'ACTIVE', true, now()) RETURNING id::text AS id`,
      [bob],
    );
    const theirs = await claim({ userId: bob, channelId: String(bobChannel[0]!["id"]), chatId: "-100456", dedupeKey: "update:42", at: at(2) });
    assert.equal(theirs.status, "claimed");

    // Approval is bound to content: a preview whose bytes moved on cannot be approved by an old tap.
    assert.equal(await h.store.approvePost({ userId: alice, postId: fresh.post.id, contentHash: "b".repeat(64), at: at(3) }), null);
    const approved = await h.store.approvePost({ userId: alice, postId: fresh.post.id, contentHash: hash, at: at(4) });
    assert.equal(approved?.status, "APPROVED");
    // Re-approving the same bytes is idempotent (a retry of the button, not a second event).
    assert.equal((await h.store.approvePost({ userId: alice, postId: fresh.post.id, contentHash: hash, at: at(5) }))?.status, "APPROVED");

    // Publication is a claim, so two simultaneous "Publish" taps produce one send.
    assert.equal(await h.store.claimPublish({ userId: alice, postId: fresh.post.id, maxAttempts: 3, at: at(6) }), true);
    assert.equal(await h.store.claimPublish({ userId: alice, postId: fresh.post.id, maxAttempts: 3, at: at(7) }), false, "already PUBLISHING");
    // A different user cannot claim it even knowing the id, and cannot finish it either.
    assert.equal(await h.store.claimPublish({ userId: bob, postId: fresh.post.id, maxAttempts: 3, at: at(8) }), false);
    assert.equal(await h.store.finishPost({ userId: bob, postId: fresh.post.id, status: "PUBLISHED", message_id: "9", errorCode: null, at: at(9) }), null);

    const published = await h.store.finishPost({ userId: alice, postId: fresh.post.id, status: "PUBLISHED", message_id: "555", errorCode: null, at: at(10) });
    assert.equal(published?.status, "PUBLISHED");
    assert.equal(published?.telegramMessageId, "555");
    assert.equal(published?.publishedAt, at(10).toISOString());
    // Published is terminal: a replay of the whole flow cannot post it a second time.
    assert.equal(await h.store.claimPublish({ userId: alice, postId: fresh.post.id, maxAttempts: 3, at: at(11) }), false);
    assert.equal((await h.store.findPost(alice, fresh.post.id))?.attempts, 1);

    // A failure keeps the row retryable, labels WHY, and stops at the attempt bound.
    const failed = await claim({ dedupeKey: "update:43", at: at(12) });
    await h.store.approvePost({ userId: alice, postId: failed.post.id, contentHash: hash, at: at(13) });
    await h.store.claimPublish({ userId: alice, postId: failed.post.id, maxAttempts: 3, at: at(14) });
    const f = await h.store.finishPost({ userId: alice, postId: failed.post.id, status: "FAILED", message_id: null, errorCode: "CHANNEL_UNVERIFIED", at: at(15) });
    assert.equal(f?.status, "FAILED");
    assert.equal(f?.errorCode, "CHANNEL_UNVERIFIED");
    assert.equal(f?.publishedAt, null, "a failure never reads as published");
    assert.equal(await h.store.claimPublish({ userId: alice, postId: failed.post.id, maxAttempts: 3, at: at(16) }), true, "a FAILED post may be retried");
    await h.store.finishPost({ userId: alice, postId: failed.post.id, status: "FAILED", message_id: null, errorCode: "SEND_FAILED", at: at(17) });
    await h.store.claimPublish({ userId: alice, postId: failed.post.id, maxAttempts: 3, at: at(18) });
    await h.store.finishPost({ userId: alice, postId: failed.post.id, status: "FAILED", message_id: null, errorCode: "SEND_FAILED", at: at(19) });
    assert.equal(
      await h.store.claimPublish({ userId: alice, postId: failed.post.id, maxAttempts: 3, at: at(20) }),
      false,
      "retries are bounded — a stuck destination is reported, not hammered",
    );
    const recent = await h.store.listRecentPosts(alice, 10);
    assert.equal(recent.length, 2);
    assert.deepEqual(recent.map((r) => r.status), ["FAILED", "PUBLISHED"], "newest first");
    // The bound is clamped the same way the checklist reads are, whatever a caller asks for.
    assert.equal((await h.store.listRecentPosts(alice, 10_000)).length, 2);
  } finally {
    await h.engine.close();
  }
});

test("an image file id is written WITH the transition and can never be wiped by a later finish", async () => {
  // WHY THIS IS ITS OWN TEST. `image_file_id` is the only column in the outbox that survives a state
  // change on purpose: it is what lets a retry reuse a file Telegram already stores instead of uploading
  // the same banner a second time, and it is what a reader would otherwise conclude was lost when a
  // publication FAILED. So the write has to be ATOMIC with the transition (a follow-up UPDATE would leave
  // a PUBLISHED row that briefly claims to have no image), and it has to be a COALESCE (a finish that
  // carries no id must not erase the one already there). Both halves are pinned here.
  const h = await harness();
  try {
    const alice = await h.user("img@example.com");
    const { rows: chRows } = await h.engine.query(
      `INSERT INTO telegram_channels (user_id, chat_id, title, chat_type, status, can_post, verified_at)
       VALUES ($1::bigint, -100777, 'Velora Images', 'channel', 'ACTIVE', true, now()) RETURNING id::text AS id`,
      [alice],
    );
    const channelId = String(chRows[0]!["id"]);
    const hash = "c".repeat(64);
    const claim = (over: Record<string, unknown> = {}) =>
      h.store.claimPost({
        userId: alice,
        channelId,
        chatId: "-100777",
        body: "Bias bullish",
        contentHash: hash,
        dedupeKey: "update:70",
        bannerSvg: null,
        imageFileId: null,
        templateKey: "velora.bias",
        templateVersion: 1,
        at: T0,
        ...over,
      });

    // (1) A post created with no image learns the id in the SAME statement that publishes it.
    const fresh = await claim();
    assert.equal(fresh.post.imageFileId, null);
    await h.store.approvePost({ userId: alice, postId: fresh.post.id, contentHash: hash, at: at(1) });
    assert.equal(await h.store.claimPublish({ userId: alice, postId: fresh.post.id, maxAttempts: 3, at: at(2) }), true);
    const sent = await h.store.finishPost({
      userId: alice,
      postId: fresh.post.id,
      status: "PUBLISHED",
      message_id: "501",
      errorCode: null,
      imageFileId: "AGENT-BANNER-1",
      at: at(3),
    });
    assert.equal(sent?.status, "PUBLISHED", "the transition happened");
    assert.equal(sent?.imageFileId, "AGENT-BANNER-1", "and the id arrived with it, not after it");
    assert.equal((await h.store.findPost(alice, fresh.post.id))?.imageFileId, "AGENT-BANNER-1", "it is the row, not a projection");

    // (2) A row that already has an id keeps it through a finish that names none — the retry-reuse case,
    // and the reason `imageFileId: null` must mean "nothing to say", never "erase it".
    const withChart = await claim({ dedupeKey: "update:71", imageFileId: "AGENT-CHART-9", at: at(4) });
    assert.equal(withChart.post.imageFileId, "AGENT-CHART-9");
    await h.store.approvePost({ userId: alice, postId: withChart.post.id, contentHash: hash, at: at(5) });
    await h.store.claimPublish({ userId: alice, postId: withChart.post.id, maxAttempts: 3, at: at(6) });
    const failed = await h.store.finishPost({
      userId: alice,
      postId: withChart.post.id,
      status: "FAILED",
      message_id: null,
      errorCode: "SEND_FAILED",
      at: at(7),
    });
    assert.equal(failed?.status, "FAILED");
    assert.equal(failed?.imageFileId, "AGENT-CHART-9", "a failed send must not throw away the upload");
    await h.store.claimPublish({ userId: alice, postId: withChart.post.id, maxAttempts: 3, at: at(8) });
    const retried = await h.store.finishPost({
      userId: alice,
      postId: withChart.post.id,
      status: "PUBLISHED",
      message_id: "502",
      errorCode: null,
      imageFileId: null,
      at: at(9),
    });
    assert.equal(retried?.imageFileId, "AGENT-CHART-9", "an explicit null is 'nothing to add'");

    // (3) Only a real transition touches it: while a row is DRAFT there is nothing to finish, so a stray
    // call must not park a file id on a post nobody approved for sending.
    const draft = await claim({ dedupeKey: "update:72", at: at(10) });
    assert.equal(
      await h.store.finishPost({
        userId: alice,
        postId: draft.post.id,
        status: "PUBLISHED",
        message_id: "503",
        errorCode: null,
        imageFileId: "AGENT-BANNER-2",
        at: at(11),
      }),
      null,
      "a DRAFT row is not publishable, so nothing is written at all",
    );
    assert.equal((await h.store.findPost(alice, draft.post.id))?.imageFileId, null);
  } finally {
    await h.engine.close();
  }
});

// ── THE PENDING-FLOW UPSERT ───────────────────────────────────────────────────────────────────────────
// REGRESSION (found 2026-10-21 by driving the real bot end to end): `setPendingFlow` bound ONE parameter to
// both `flow_started_at` and `updated_at`. Clearing a flow sends `null` for the start time BY DEFINITION, so
// `/cancel` — the command that exists only to clear a flow — raised 23502 (not-null violation on
// `updated_at`) and the user got "خطایی رخ داد" instead of a cancellation. Both directions are pinned
// below, because the bug lives in the pair: starting a flow always passed (the parameter was non-null) and
// only the clearing path was broken.
test("a flow can be started AND cleared: updated_at never borrows the flow's start time", async () => {
  const h = await harness();
  try {
    const alice = await h.user("flow@velora.test");

    await h.store.setPendingFlow({ userId: alice, flow: { kind: "tpl_new_name", name: null, body: null, templateId: null, postId: null, startedAt: at(1) }, at: at(1) });
    assert.equal((await h.store.getPostPreferences(alice)).pendingFlow?.kind, "tpl_new_name");

    // The clearing path: this is what `/cancel` and every finished flow call.
    await h.store.setPendingFlow({ userId: alice, flow: null, at: at(2) });
    assert.equal((await h.store.getPostPreferences(alice)).pendingFlow, null, "the flow is cleared, not kept");

    // And it is reusable afterwards — the row is an upsert keyed by user, so a second start must work too.
    // `tpl_edit_body` is the shape that carries a template id (0042's check requires it for this kind).
    await h.store.setPendingFlow({ userId: alice, flow: { kind: "tpl_edit_body", name: null, body: null, templateId: "1", postId: null, startedAt: at(3) }, at: at(3) });
    assert.equal((await h.store.getPostPreferences(alice)).pendingFlow?.kind, "tpl_edit_body");
  } finally {
    await h.engine.close();
  }
});
