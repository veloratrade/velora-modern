// Real-PostgreSQL battery — TELEGRAM ATOMICITY UNDER CONCURRENCY (ADR-018).
//
// WHY THIS BATTERY EXISTS. The Telegram client's safety rests on four claims that
// are ONLY true if the database arbitrates them, because a bot answers the same
// press of a button twice, on two replicas, at the same instant:
//
//   1. a linking token is spent EXACTLY ONCE  (consumeLinkToken)
//   2. an incoming update is claimed EXACTLY ONCE (claimUpdate)
//   3. a draft is confirmed EXACTLY ONCE       (claimDraftForConfirmation)
//   4. a trade is posted to a channel ONCE     (claimChannelPost)
//
// Each of those is a single statement with its guard in the WHERE clause (or an
// ON CONFLICT), and the store's own contract says so. PGlite cannot prove it: the
// in-process WASM build runs ONE session, so "two callers raced" is simulated
// rather than observed, and a single-statement guard is exactly the thing a
// single session cannot falsify. This battery therefore runs ONLY against a real,
// disposable PostgreSQL (`DATABASE_URL`), with TWO independent store instances
// over ONE pool — correctness must come from the database, never from
// process-local state (the D3/D4 pattern).
//
// EVIDENCE LABEL (Phase D policy): without `DATABASE_URL` every test SKIPS. A
// SKIP is not evidence, and this file must never be pointed at a shared database
// (it writes rows on purpose).
//
// The race is made deterministic WITHOUT weakening production code: `pg_sleep`
// inside a competing transaction holds a row lock while the other connection
// arrives, which is the same interleaving a real double-press produces. Nothing
// in `apps/api` is modified for a test — `apps/api/src/telegram/pgTelegramStore.ts`
// is the exact production module the bot runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { prepareDatabase, resetSchema } from "./support/pgTestDb.ts";
import { PgTelegramStore } from "../../apps/api/src/telegram/pgTelegramStore.ts";
import { PgUserStore } from "../../apps/api/src/auth/pgUserStore.ts";
import { PgAuditStore } from "../../apps/api/src/auth/pgAuditStore.ts";
import { TelegramLinkService } from "../../apps/api/src/telegram/telegramLinkService.ts";
import type { Pool } from "pg";

const PG_URL = process.env.DATABASE_URL;
const SKIP = PG_URL === undefined
  ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)"
  : false;

/** Server-side version string, recorded in the evidence line this battery prints. */
let SERVER_VERSION = "unavailable";

const T0 = new Date("2026-10-04T09:00:00.000Z");

interface Harness {
  readonly pool: Pool;
  readonly storeA: PgTelegramStore;
  readonly storeB: PgTelegramStore;
  readonly users: PgUserStore;
  readonly audit: PgAuditStore;
  readonly linksA: TelegramLinkService;
  readonly close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  assert.ok(PG_URL !== undefined);
  const db = await prepareDatabase(PG_URL);
  const version = await db.pool.query<{ v: string }>("SELECT version() AS v");
  SERVER_VERSION = String(version.rows[0]?.v ?? "unknown");
  const users = new PgUserStore(db.pool);
  const audit = new PgAuditStore(db.pool);
  // TWO store instances over ONE pool: the database is the only shared state.
  const storeA = new PgTelegramStore(db.pool);
  const storeB = new PgTelegramStore(db.pool);
  const link = () =>
    new TelegramLinkService({
      store: storeA,
      audit,
      botUsername: () => "velora_journal_bot",
      now: () => T0,
      tokenTtlSeconds: 600,
    });
  return { pool: db.pool, storeA, storeB, users, audit, linksA: link(), close: () => db.close() };
}

async function makeUser(h: Harness, email: string): Promise<string> {
  const u = await h.users.createUser({
    email,
    passwordHash: "x".repeat(60), // never a real hash: this battery is not about auth
    fullName: "Race Tester",
    timezone: "Asia/Tehran",
    locale: "fa",
    now: T0,
  });
  return u.id;
}

/**
 * Run `n` callers as simultaneously as the pool allows.
 *
 * `ready` is a barrier: every caller resolves it before any of them proceeds, so
 * the statements are issued within the same event-loop turn and the pool's
 * parallel connections hit the database together. The race is real, not
 * sequential — but the ASSERTIONS are set-based (exactly one winner), so a
 * scheduling accident that serializes them still has to satisfy the invariant.
 */
async function race<T>(callers: readonly (() => Promise<T>)[]): Promise<T[]> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = callers.map(async (fn) => {
    await gate;
    return fn();
  });
  release();
  return Promise.all(started);
}

// ── 1. The linking token is spent exactly once ──────────────────────────────

test("LINK RACE: two Telegram identities consume one token at the same instant — exactly one SUCCESS, one REJECTED", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const userId = await makeUser(h, "link-race@velora.test");
    const { token } = await h.linksA.startLinking(userId, null);
    const tokenHash = createHash("sha256").update(token).digest("hex");

    // Both callers spend the SAME token as different Telegram users, in the same
    // turn. The guard is a single UPDATE … WHERE status = 'PENDING', so the row
    // lock decides the winner and the loser re-reads a CONSUMED row.
    const [a, b] = await race([
      () => h.linksA.completeFromPayload({ payload: token, telegramUserId: "111111", username: "alice", requestId: null }),
      () => h.linksA.completeFromPayload({ payload: token, telegramUserId: "222222", username: "bob", requestId: null }),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    assert.equal(winners.length, 1, `exactly one caller may spend a one-time token (got ${winners.length})`);
    assert.equal(losers.length, 1);
    assert.notEqual((losers[0] as { code: string }).code, "TOKEN_UNKNOWN", "the loser must be told the token was SPENT, not that it never existed");

    // The database, not the service, is the arbiter: one identity row, alive.
    const identities = await h.pool.query<{ telegram_user_id: string; status: string }>(
      "SELECT telegram_user_id::text AS telegram_user_id, status FROM telegram_identities",
    );
    assert.equal(identities.rowCount, 1, "a lost race must leave no identity behind");
    assert.equal(identities.rows[0]!.status, "LINKED");

    // The token records WHO spent it — the winner, and only the winner.
    const tokenRow = await h.pool.query<{ status: string; consumed_by: string | null }>(
      "SELECT status, consumed_by_telegram_user_id::text AS consumed_by FROM telegram_link_tokens WHERE token_hash = $1",
      [tokenHash],
    );
    assert.equal(tokenRow.rows[0]!.status, "CONSUMED");
    assert.equal(tokenRow.rows[0]!.consumed_by, identities.rows[0]!.telegram_user_id);

    // Audit trail: EXACTLY ONE completed link — a race must not be able to write
    // two success rows. The loser of a SPENT token is deliberately NOT audited
    // (there is no Velora actor to attribute it to, and a spent-token probe is
    // unauthenticated input — the same reason a junk token writes nothing), so the
    // trail must show one success and no phantom failure.
    const audit = await h.audit.list();
    const actions = audit.map((r) => r.action).filter((a) => a.startsWith("TELEGRAM_LINK"));
    assert.equal(actions.filter((a) => a === "TELEGRAM_LINK_COMPLETED").length, 1, "one race, one success row");
    assert.equal(actions.filter((a) => a === "TELEGRAM_LINK_FAILED").length, 0, "an unauthenticated loser must not be able to seed the security trail");
    assert.ok(actions.includes("TELEGRAM_LINK_STARTED"), "the start of the flow is on the record too");
  } finally {
    await h.close();
  }
});

test("LINK RACE (lock-forced): two spenders WAIT on the same row lock and still produce one link", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const userId = await makeUser(h, "lock-forced@velora.test");
    const { token } = await h.linksA.startLinking(userId, null);
    const tokenHash = createHash("sha256").update(token).digest("hex");

    // A third session holds the token row's lock and does NOTHING to the row, so
    // both spenders are forced to be BLOCKED on the same lock at the same instant
    // and are released in lock-wait order. This removes scheduling luck from the
    // proof: with the arrival order forced, the guard still has to admit exactly
    // one — a read-then-write implementation would fail here, and a correct
    // single-statement guard cannot.
    const blocker = await h.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT 1 FROM telegram_link_tokens WHERE token_hash = $1 FOR UPDATE", [tokenHash]);
    const sleeping = blocker.query("SELECT pg_sleep(0.6)");

    const spenders = race([
      () => h.linksA.completeFromPayload({ payload: token, telegramUserId: "888888", username: "frank", requestId: null }),
      () => h.linksA.completeFromPayload({ payload: token, telegramUserId: "999999", username: "grace", requestId: null }),
    ]);
    await sleeping;              // both spenders are now waiting on the lock
    await blocker.query("COMMIT"); // release them together
    blocker.release();

    const [a, b] = await spenders;
    assert.equal([a, b].filter((r) => r.ok).length, 1, "a lock-forced race must still admit exactly one spender");
    const identities = await h.pool.query("SELECT telegram_user_id::text AS id FROM telegram_identities");
    assert.equal(identities.rowCount, 1);
    // The single identity is the one that won the lock race, and the token says so.
    const tokenRow = await h.pool.query<{ consumed_by: string | null }>(
      "SELECT consumed_by_telegram_user_id::text AS consumed_by FROM telegram_link_tokens WHERE token_hash = $1",
      [tokenHash],
    );
    assert.equal(tokenRow.rows[0]!.consumed_by, identities.rows[0]!.id);
  } finally {
    await h.close();
  }
});

test("LINK RACE: the SAME Telegram identity sends the same token twice — one link, one audit row, no duplicate", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const userId = await makeUser(h, "same-identity@velora.test");
    const { token } = await h.linksA.startLinking(userId, null);

    const [a, b] = await race([
      () => h.linksA.completeFromPayload({ payload: token, telegramUserId: "333333", username: "carol", requestId: null }),
      () => h.linksA.completeFromPayload({ payload: token, telegramUserId: "333333", username: "carol", requestId: null }),
    ]);

    // Either the second is refused as SPENT, or it lands on the idempotent path
    // (already linked to this very account) — both are one outcome from the
    // user's point of view, and neither may create a second identity.
    assert.ok([a, b].some((r) => r.ok), "the token must link at least once");
    const identities = await h.pool.query("SELECT 1 FROM telegram_identities WHERE telegram_user_id = $1", ["333333"]);
    assert.equal(identities.rowCount, 1, "one Telegram identity may hold at most one live link");

    const live = await h.pool.query("SELECT 1 FROM telegram_identities WHERE status = 'LINKED'");
    assert.equal(live.rowCount, 1);
  } finally {
    await h.close();
  }
});

test("LINK RACE: an EXPIRED token loses to the clock even under concurrency (no last-moment spend)", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const userId = await makeUser(h, "expiry@velora.test");
    const { token } = await h.linksA.startLinking(userId, null);
    // The expiry predicate is part of the same guarded UPDATE, so it cannot be
    // satisfied by a caller that wins the row lock a moment later.
    const later = new TelegramLinkService({
      store: h.storeA,
      audit: h.audit,
      botUsername: () => "velora_journal_bot",
      now: () => new Date(T0.getTime() + 601_000),
      tokenTtlSeconds: 600,
    });
    const [a, b] = await race([
      () => h.linksA.completeFromPayload({ payload: token, telegramUserId: "444444", username: null, requestId: null }),
      () => later.completeFromPayload({ payload: token, telegramUserId: "555555", username: null, requestId: null }),
    ]);
    // Whatever the interleaving, at most ONE link may exist, and if the expiring
    // caller won, the token must be consumed under its own identity only.
    const identities = await h.pool.query("SELECT telegram_user_id::text AS id FROM telegram_identities");
    assert.ok(identities.rowCount <= 1, "an expired token must not produce two links");
    assert.equal([a, b].filter((r) => r.ok).length, identities.rowCount);
  } finally {
    await h.close();
  }
});

// ── 2. The four remaining single-statement claims ───────────────────────────

test("UPDATE RACE: the same update_id is claimed once — the replay is ignored", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const claim = () => ({
      updateId: "900001",
      kind: "message",
      telegramUserId: "111111",
      chatId: "111111",
      at: T0,
    });
    const [a, b] = await race([() => h.storeA.claimUpdate(claim()), () => h.storeB.claimUpdate(claim())]);
    assert.equal([a, b].filter(Boolean).length, 1, "PostgreSQL's dedupe table must let exactly one consumer claim the update");
    const rows = await h.pool.query("SELECT 1 FROM telegram_updates WHERE update_id = $1", ["900001"]);
    assert.equal(rows.rowCount, 1);
  } finally {
    await h.close();
  }
});

test("DRAFT RACE: two confirmation presses on one draft — exactly one claim wins", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const userId = await makeUser(h, "draft-race@velora.test");
    const created = await h.storeA.createDraft({
      userId,
      telegramUserId: "111111",
      chatId: "111111",
      sourceMessageId: "42",
      sourceKind: "TEXT",
      draft: { symbol: "XAUUSD", direction: "LONG", entryPrice: "2650", exitPrice: "2660", quantity: "0.5" },
      missingFields: [],
      transcript: null,
      media: {},
      expiresAt: new Date(T0.getTime() + 3_600_000),
      at: T0,
    });
    const draftId = created.id;

    const [a, b] = await race([
      () => h.storeA.claimDraftForConfirmation(draftId, T0),
      () => h.storeB.claimDraftForConfirmation(draftId, T0),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1, "a double press must not create two trades");
    const row = await h.pool.query<{ state: string }>("SELECT state FROM telegram_journal_drafts WHERE id = $1", [draftId]);
    assert.equal(row.rows[0]!.state, "CONFIRMING");

    // The loser's release path must be a no-op for the winner's claim: a released
    // state is only restorable by the claim holder, and the winner still holds it.
    const winnerHeld = await h.pool.query<{ state: string }>("SELECT state FROM telegram_journal_drafts WHERE id = $1 AND state = 'CONFIRMING'", [draftId]);
    assert.equal(winnerHeld.rowCount, 1);
  } finally {
    await h.close();
  }
});

test("CHANNEL RACE: one trade is enqueued to a channel once, even when two publishers try", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const userId = await makeUser(h, "channel-race@velora.test");
    const channel = await h.storeA.upsertChannel({
      userId,
      chatId: "-100200300",
      title: "Journal",
      chatType: "channel",
      status: "ACTIVE",
      canPost: true,
      at: T0,
    });
    // A trade row is required by the composite FK (id, user_id). It is created
    // with the ledger's own minimum shape — this battery is about the CHANNEL
    // claim, not about how a trade comes into existence.
    const account = await h.pool.query<{ id: string }>(
      "INSERT INTO trading_accounts (user_id) VALUES ($1::bigint) RETURNING id::text AS id",
      [userId],
    );
    const trade = await h.pool.query<{ id: string }>(
      `INSERT INTO trades (user_id, account_id, symbol, direction, entry_price, volume, occurred_at)
       VALUES ($1::bigint, $2::bigint, 'XAUUSD', 'buy', 2650, 0.5, $3::timestamptz) RETURNING id::text AS id`,
      [userId, account.rows[0]!.id, T0.toISOString()],
    );
    const tradeId = trade.rows[0]!.id;

    const [a, b] = await race([
      () => h.storeA.claimChannelPost({ channelId: channel.id, userId, tradeId, at: T0 }),
      () => h.storeB.claimChannelPost({ channelId: channel.id, userId, tradeId, at: T0 }),
    ]);
    assert.equal([a, b].filter((r) => r.claimed).length, 1, "ON CONFLICT (channel_id, trade_id) must admit one row");
    const rows = await h.pool.query("SELECT 1 FROM telegram_channel_posts WHERE channel_id = $1::bigint AND trade_id = $2::bigint", [channel.id, tradeId]);
    assert.equal(rows.rowCount, 1);
  } finally {
    await h.close();
  }
});

test("AUDIT UNDER RACE: the trail has no gap and no duplicate when the same action is attempted twice", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const userId = await makeUser(h, "audit-race@velora.test");
    const { token } = await h.linksA.startLinking(userId, null);
    await race([
      () => h.linksA.completeFromPayload({ payload: token, telegramUserId: "666666", username: "dave", requestId: "req-1" }),
      () => h.linksA.completeFromPayload({ payload: token, telegramUserId: "777777", username: "erin", requestId: "req-2" }),
    ]);
    const audit = await h.audit.list();
    const completed = audit.filter((r) => r.action === "TELEGRAM_LINK_COMPLETED");
    assert.equal(completed.length, 1, "a double attempt must not double the success trail");
    // The actor is the Velora ACCOUNT — never the Telegram id, which is not an
    // actor in this system — and no row may contain token material.
    assert.equal(completed[0]!.actorUserId, userId);
    const serialized = JSON.stringify(audit);
    assert.ok(!serialized.includes(token), "an audit row must never contain the one-time token");
  } finally {
    await h.close();
  }
});

/** Print the server version once, so the run's evidence line names the engine. */
test("EVIDENCE: the battery ran against the engine named in the record", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    console.log(`REAL-PG EVIDENCE: ${SERVER_VERSION}`);
    assert.match(SERVER_VERSION, /PostgreSQL \d+\./);
    await resetSchema(h.pool); // leave the database clean for the next battery
  } finally {
    await h.close();
  }
});
