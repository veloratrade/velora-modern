// Telegram journal client — database evidence for migration 0023.
//
// WHY THIS BATTERY EXISTS. The Telegram tables carry the SECURITY and
// IDEMPOTENCY invariants of the whole client: one live link per identity, a
// single-use token, one draft per source message, a confirmation that can only
// be claimed once, and a channel mirror that cannot post twice or post someone
// else's trade. The services rely on those being enforced by PostgreSQL, but a
// service test against an in-memory double cannot falsify them — the double is
// written by the same hand as the service. This battery therefore exercises the
// CONSTRAINTS THEMSELVES, on the migration as shipped.
//
// EVIDENCE LABEL: PGlite (real PostgreSQL semantics in-wasm, in-process). This
// is dev/test evidence only — it is NOT production-hosting evidence, and it is
// NOT real-PostgreSQL concurrency evidence (no two sessions race here). The
// `*.pg.test.ts` batteries remain the real-server evidence path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createEngine, migrate, type MigrationEngine } from "../migrate.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

/** A migrated, disposable instance. Callers must close it. */
async function migrated(): Promise<MigrationEngine> {
  const engine = await createEngine();
  await migrate(engine, MIGRATIONS);
  return engine;
}

async function seedUser(engine: MigrationEngine, email: string): Promise<string> {
  const { rows } = await engine.query("INSERT INTO users(email, password_hash) VALUES ($1,$2) RETURNING id", [email, "not-a-real-hash"]);
  return String(rows[0]!["id"]);
}

async function seedTrade(engine: MigrationEngine, userId: string, symbol = "XAUUSD"): Promise<string> {
  const { rows } = await engine.query(
    // A complete CLOSED trade (0025): exit price, realized PnL and a close instant.
    // 2650 → 2660 on 0.5 lots with contract size 1 = +5.00.
    `INSERT INTO trades(user_id, symbol, direction, status, entry_price, exit_price, volume,
                        net_pnl, occurred_at, occurred_close_at_utc)
     VALUES ($1,$2,'buy','CLOSED',2650,2660,0.5,5.00, now(), now()) RETURNING id`,
    [userId, symbol],
  );
  return String(rows[0]!["id"]);
}

async function seedIdentity(engine: MigrationEngine, userId: string, telegramUserId: string): Promise<string> {
  const { rows } = await engine.query(
    "INSERT INTO telegram_identities(user_id, telegram_user_id, username) VALUES ($1,$2,$3) RETURNING id",
    [userId, telegramUserId, "trader_one"],
  );
  return String(rows[0]!["id"]);
}

test("0023: the six tables exist and the widened vocabularies accept exactly the new values", async () => {
  const engine = await migrated();
  try {
    const tables = await engine.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name LIKE 'telegram\\_%' ORDER BY table_name`,
    );
    assert.deepEqual(
      tables.rows.map((r) => r["table_name"]),
      ["telegram_channel_posts", "telegram_channels", "telegram_identities", "telegram_journal_drafts", "telegram_link_tokens", "telegram_updates"],
    );

    // audit_log: the SIX telegram actions and the second provider are vocabulary,
    // not free text — a typo in a service must be rejected by the database.
    const actions = String(
      (await engine.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='audit_log_action_check'")).rows[0]!["def"],
    );
    for (const action of ["TELEGRAM_LINK_STARTED", "TELEGRAM_LINK_COMPLETED", "TELEGRAM_LINK_FAILED", "TELEGRAM_UNLINKED", "TELEGRAM_CHANNEL_BOUND", "TELEGRAM_CHANNEL_UNBOUND"]) {
      assert.ok(actions.includes(action), `audit vocabulary must contain ${action}`);
    }
    assert.ok(actions.includes("ACCOUNT_BINDING_CHANGED"), "the previous vocabulary must survive the widening");
    const provider = String(
      (await engine.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='audit_log_provider_check'")).rows[0]!["def"],
    );
    assert.ok(provider.includes("TELEGRAM") && provider.includes("METAAPI"));

    // ai_coaching_logs.feature: NOT NULL with the pre-0023 meaning as its default,
    // so every existing row and every un-migrated caller keeps working.
    const feature = (
      await engine.query("SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name='ai_coaching_logs' AND column_name='feature'")
    ).rows[0]!;
    assert.equal(feature["is_nullable"], "NO");
    assert.ok(String(feature["column_default"]).includes("coach"));
  } finally {
    await engine.close();
  }
});

test("telegram_identities: one LIVE link per Telegram id and per account; revocation frees both", async () => {
  const engine = await migrated();
  try {
    const alice = await seedUser(engine, "alice@velora.ir");
    const bob = await seedUser(engine, "bob@velora.ir");
    await seedIdentity(engine, alice, "555000111");

    // A second account cannot capture an identity that is already connected.
    await assert.rejects(seedIdentity(engine, bob, "555000111"), /duplicate key|unique/i);
    // An account cannot accumulate a second live Telegram identity.
    await assert.rejects(seedIdentity(engine, alice, "555000222"), /duplicate key|unique/i);

    // Unlink is a revocation, and a revoked row must SAY it was revoked.
    await assert.rejects(
      engine.query("UPDATE telegram_identities SET status='REVOKED' WHERE user_id=$1", [alice]),
      /check constraint|violates/i,
    );
    await engine.query("UPDATE telegram_identities SET status='REVOKED', revoked_at=now() WHERE user_id=$1", [alice]);

    // Both partial indexes exempt revoked rows, so the freed identity and the
    // freed account can each be linked again — as NEW rows (re-link = new episode).
    await seedIdentity(engine, bob, "555000111");
    await seedIdentity(engine, alice, "555000333");
    const live = await engine.query("SELECT count(*)::int AS n FROM telegram_identities WHERE status='LINKED'");
    assert.equal(live.rows[0]!["n"], 2);
  } finally {
    await engine.close();
  }
});

test("telegram_link_tokens: opaque hash shape, one PENDING per user, coherent terminal states", async () => {
  const engine = await migrated();
  try {
    const alice = await seedUser(engine, "alice@velora.ir");
    const hash = "a".repeat(64);

    // The stored value is a sha256 hex digest — never a token, never base64.
    await assert.rejects(
      engine.query("INSERT INTO telegram_link_tokens(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '10 minutes')", [alice, "NOT-A-HASH"]),
      /check constraint|violates/i,
    );
    await engine.query("INSERT INTO telegram_link_tokens(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '10 minutes')", [alice, hash]);
    // At most ONE pending transaction per user: a stale deep link can never win
    // a race against a freshly started one.
    await assert.rejects(
      engine.query("INSERT INTO telegram_link_tokens(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '10 minutes')", [alice, "b".repeat(64)]),
      /duplicate key|unique/i,
    );
    // Expiry must be in the future relative to creation.
    await assert.rejects(
      engine.query("INSERT INTO telegram_link_tokens(user_id, token_hash, expires_at) VALUES ($1,$2, now() - interval '1 minute')", [alice, "c".repeat(64)]),
      /check constraint|violates/i,
    );
    // Consumption is a single conditional UPDATE that also records who consumed.
    const consumed = await engine.query(
      `UPDATE telegram_link_tokens SET status='CONSUMED', consumed_at=now(), consumed_by_telegram_user_id=$2
        WHERE user_id=$1 AND status='PENDING' AND expires_at > now() RETURNING id`,
      [alice, "555000111"],
    );
    assert.equal(consumed.rows.length, 1);
    // The loser of a concurrent delivery matches zero rows — this is the replay
    // protection, at the statement level.
    const again = await engine.query(
      "UPDATE telegram_link_tokens SET status='CONSUMED', consumed_at=now() WHERE user_id=$1 AND status='PENDING' AND expires_at > now() RETURNING id",
      [alice],
    );
    assert.equal(again.rows.length, 0);
    // Terminal-state coherence: CONSUMED without consumed_at is not representable.
    await assert.rejects(
      engine.query("UPDATE telegram_link_tokens SET consumed_at=NULL WHERE user_id=$1", [alice]),
      /check constraint|violates/i,
    );
  } finally {
    await engine.close();
  }
});

test("telegram_updates: update_id is the dedupe claim, and stored classifications are bounded", async () => {
  const engine = await migrated();
  try {
    await engine.query("INSERT INTO telegram_updates(update_id, telegram_user_id, chat_id, update_kind) VALUES ($1,$2,$3,$4)", [9001, "555000111", "555000111", "message"]);
    // A redelivered update cannot claim twice.
    await assert.rejects(
      engine.query("INSERT INTO telegram_updates(update_id, telegram_user_id, chat_id, update_kind) VALUES ($1,$2,$3,$4)", [9001, "555000111", "555000111", "message"]),
      /duplicate key|unique/i,
    );
    // Only what classifyUpdate() can produce is storable.
    await assert.rejects(
      engine.query("INSERT INTO telegram_updates(update_id, update_kind) VALUES ($1,$2)", [9002, "edited"]),
      /check constraint|violates/i,
    );
    // An error code is a bounded, non-secret classification — never a message.
    await assert.rejects(
      engine.query("UPDATE telegram_updates SET error_code=$1 WHERE update_id=$2", ["telegram said: bad request", 9001]),
      /check constraint|violates/i,
    );
    await engine.query("UPDATE telegram_updates SET outcome='handled', error_code='SEND_FAILED', processed_at=now() WHERE update_id=$1", [9001]);
    const row = (await engine.query("SELECT outcome, error_code FROM telegram_updates WHERE update_id=$1", [9001])).rows[0]!;
    assert.equal(row["outcome"], "handled");
    assert.equal(row["error_code"], "SEND_FAILED");
  } finally {
    await engine.close();
  }
});

test("telegram_journal_drafts: one draft per source message, a real confirmation claim, and no confirmed draft without a trade", async () => {
  const engine = await migrated();
  try {
    const alice = await seedUser(engine, "alice@velora.ir");
    const draft = JSON.stringify({ symbol: "XAUUSD", direction: "buy" });
    const insert = (state: string, tradeId: string | null = null, missing: string = '["entryPrice","exitPrice","volume"]') =>
      engine.query(
        `INSERT INTO telegram_journal_drafts(user_id, telegram_user_id, chat_id, source_message_id, source_kind, state, draft, missing_fields, expires_at, confirmed_trade_id)
         VALUES ($1,$2,$3,$4,'TEXT',$5,$6::jsonb,$7::jsonb, now() + interval '30 minutes', $8) RETURNING id`,
        [alice, "555000111", "555000111", 4242, state, draft, missing, tradeId],
      );

    const open = await insert("AWAITING_CONFIRMATION");
    const draftId = String(open.rows[0]!["id"]);

    // One message can open exactly one draft — re-processing a delivery cannot
    // produce a second card for the same content.
    await assert.rejects(insert("NEEDS_DETAIL"), /duplicate key|unique/i);
    // The claim transition the service performs is representable…
    await engine.query("UPDATE telegram_journal_drafts SET state='CONFIRMING' WHERE id=$1", [draftId]);
    // …and an invented state is not.
    await assert.rejects(engine.query("UPDATE telegram_journal_drafts SET state='SAVING' WHERE id=$1", [draftId]), /check constraint|violates/i);
    // A confirmed draft must name the trade the ledger actually created.
    await assert.rejects(engine.query("UPDATE telegram_journal_drafts SET state='CONFIRMED' WHERE id=$1", [draftId]), /check constraint|violates/i);
    // …and an UNCONFIRMED draft must not name one.
    const tradeId = await seedTrade(engine, alice);
    await assert.rejects(engine.query("UPDATE telegram_journal_drafts SET confirmed_trade_id=$2 WHERE id=$1", [draftId, tradeId]), /check constraint|violates/i);
    await assert.rejects(
      engine.query("UPDATE telegram_journal_drafts SET state='CANCELLED', confirmed_trade_id=$2 WHERE id=$1", [draftId, tradeId]),
      /check constraint|violates/i,
    );
    await engine.query("UPDATE telegram_journal_drafts SET state='CONFIRMED', confirmed_trade_id=$2 WHERE id=$1", [draftId, tradeId]);
    const row = (await engine.query("SELECT state, confirmed_trade_id FROM telegram_journal_drafts WHERE id=$1", [draftId])).rows[0]!;
    assert.equal(row["state"], "CONFIRMED");
    assert.equal(String(row["confirmed_trade_id"]), tradeId);

    // A draft is a MAP and its missing-field list is an ARRAY — the service reads
    // both structurally, so a bare string must not be storable.
    await assert.rejects(
      engine.query(
        `INSERT INTO telegram_journal_drafts(user_id, telegram_user_id, chat_id, source_message_id, source_kind, draft, expires_at)
         VALUES ($1,$2,$3,$4,'TEXT','"XAUUSD"'::jsonb, now() + interval '30 minutes')`,
        [alice, "555000111", "555000111", 4243],
      ),
      /check constraint|violates/i,
    );
  } finally {
    await engine.close();
  }
});

test("telegram_channel_posts: the mirror is idempotent and cannot publish another account's trade", async () => {
  const engine = await migrated();
  try {
    const alice = await seedUser(engine, "alice@velora.ir");
    const bob = await seedUser(engine, "bob@velora.ir");
    const trade = await seedTrade(engine, alice);
    const channel = String(
      (await engine.query(
        `INSERT INTO telegram_channels(user_id, chat_id, title, chat_type, status, can_post, verified_at)
         VALUES ($1,$2,'My Journal','channel','ACTIVE',true, now()) RETURNING id`,
        [alice, "-1001234567890"],
      )).rows[0]!["id"],
    );

    // Only a VERIFIED, posting-capable channel may be ACTIVE, and only one per user.
    await assert.rejects(
      engine.query(
        `INSERT INTO telegram_channels(user_id, chat_id, chat_type, status, can_post) VALUES ($1,$2,'channel','ACTIVE',true)`,
        [alice, "-1009999999999"],
      ),
      /duplicate key|unique/i,
    );

    const publish = (userId: string, tradeId: string, messageId: string | null) =>
      engine.query(
        "INSERT INTO telegram_channel_posts(channel_id, user_id, trade_id, status, message_id, published_at) VALUES ($1,$2,$3,$4,$5, now())",
        [channel, userId, tradeId, messageId === null ? "FAILED" : "PUBLISHED", messageId],
      );

    await publish(alice, trade, "7001");
    // The retry that would duplicate a post is refused by the database.
    await assert.rejects(publish(alice, trade, "7002"), /duplicate key|unique/i);
    // Cross-account publishing is impossible: the composite FK ties (trade, user).
    const bobTrade = await seedTrade(engine, bob, "EURUSD");
    await assert.rejects(publish(alice, bobTrade, "7003"), /foreign key|violates/i);
    // A PUBLISHED row must carry the message it published: the ledger cannot
    // claim a post that Telegram never acknowledged.
    const gbp = await seedTrade(engine, alice, "GBPUSD");
    await assert.rejects(
      engine.query("INSERT INTO telegram_channel_posts(channel_id, user_id, trade_id, status, message_id) VALUES ($1,$2,$3,'PUBLISHED',NULL)", [channel, alice, gbp]),
      /check constraint|violates/i,
    );
    // A FAILED publish, by contrast, is recordable — and stays visible.
    await engine.query("INSERT INTO telegram_channel_posts(channel_id, user_id, trade_id, status, error_code) VALUES ($1,$2,$3,'FAILED','CHAT_NOT_FOUND')", [channel, alice, gbp]);
    const failed = (await engine.query("SELECT status, error_code FROM telegram_channel_posts WHERE trade_id=$1", [gbp])).rows[0]!;
    assert.equal(failed["status"], "FAILED");
    assert.equal(failed["error_code"], "CHAT_NOT_FOUND");
  } finally {
    await engine.close();
  }
});
