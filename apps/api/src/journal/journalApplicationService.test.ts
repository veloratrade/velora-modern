// Journal application service — the write path, against the REAL TradeService.
//
// WHY THE REAL TRADE SERVICE AND NOT A STUB. The single most important claim of
// this feature is "a journal created in Telegram IS a trade in the ledger, and
// the same record the web application reads". A fake would let that claim pass
// while the real validation rejected the payload. Here the domain fold, the
// decimal scales and the ownership checks are the ones that will run in
// production; only the STORAGE is the in-memory adapter.
//
// The adversarial cases: a draft that is not yours, a draft confirmed twice, a
// draft with an unknown required field, and a payload the domain refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryTradeStore } from "../trades/memoryTradeStore.js";
import { TradeService } from "../trades/tradeService.js";
import { MemoryTelegramStore } from "../telegram/memoryTelegramStore.js";
import { JournalApplicationService, JournalDraftError } from "./journalApplicationService.js";

const TZ = "Asia/Tehran";

function makeService(options: { now?: () => Date } = {}) {
  const tradeStore = new MemoryTradeStore();
  const trades = new TradeService({
    store: tradeStore,
    getUserTimezone: async () => TZ,
    verifyAccountOwnership: async () => true,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const drafts = new MemoryTelegramStore();
  const service = new JournalApplicationService({
    trades,
    drafts,
    getUserTimezone: async () => TZ,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { service, drafts, tradeStore, trades };
}

/** How many trades the ledger holds for one user (via the service's own read). */
async function countTrades(trades: TradeService, userId: string): Promise<number> {
  const page = await trades.searchTrades(userId, { page: "1", limit: "50" });
  const pagination = (page["pagination"] ?? {}) as Record<string, unknown>;
  return Number(pagination["total"] ?? (Array.isArray(page["items"]) ? (page["items"] as unknown[]).length : 0));
}

const COMPLETE_FA = "امروز XAUUSD خرید گرفتم، ورود 2650، خروج 2660، حجم 0.5";

test("a complete message becomes a confirmable draft and nothing is written yet", async () => {
  const { service, trades } = makeService();
  const view = await service.openFromText({
    userId: "1",
    telegramUserId: "555",
    chatId: "555",
    sourceMessageId: "100",
    text: COMPLETE_FA,
  });

  assert.equal(view.complete, true);
  assert.deepEqual(view.missingFields, []);
  assert.equal(view.fields.symbol, "XAUUSD");
  assert.equal(view.fields.direction, "buy");
  assert.equal(view.fields.entryPrice, "2650");
  assert.equal(view.fields.exitPrice, "2660");
  assert.equal(view.fields.volume, "0.5");
  // NOTHING is written before confirmation: the draft is not a trade.
  assert.equal(await countTrades(trades, "1"), 0);
});

test("missing values stay unknown and are reported — never invented", async () => {
  const { service } = makeService();
  const view = await service.openFromText({
    userId: "1",
    telegramUserId: "555",
    chatId: "555",
    sourceMessageId: "101",
    text: "امروز XAUUSD خرید گرفتم",
  });

  assert.equal(view.complete, false);
  assert.equal(view.fields.symbol, "XAUUSD");
  assert.equal(view.fields.direction, "buy");
  assert.equal(view.fields.entryPrice, null);
  assert.equal(view.fields.exitPrice, null);
  assert.equal(view.fields.volume, null);
  assert.deepEqual([...view.missingFields].sort(), ["entryPrice", "exitPrice", "volume"]);

  // Confirming an incomplete draft is refused by the service, and the store
  // never sees a trade.
  await assert.rejects(
    () => service.confirm({ userId: "1", telegramUserId: "555", draftId: view.draftId }),
    (err: unknown) => {
      const typed = err as JournalDraftError;
      assert.equal(typed.code, "DRAFT_INCOMPLETE");
      assert.equal(typed.field, "entryPrice");
      return true;
    },
  );
});

test("progressive enrichment fills one field at a time and keeps the draft open", async () => {
  const { service } = makeService();
  const opened = await service.openFromText({
    userId: "1",
    telegramUserId: "555",
    chatId: "555",
    sourceMessageId: "102",
    text: "XAUUSD خرید، ورود 2650",
  });
  assert.deepEqual([...opened.missingFields].sort(), ["exitPrice", "volume"]);

  const afterExit = await service.answer({ userId: "1", telegramUserId: "555", draftId: opened.draftId, answer: "2660" });
  assert.equal(afterExit.fields.exitPrice, "2660");
  assert.deepEqual([...afterExit.missingFields], ["volume"]);

  const afterVolume = await service.answer({ userId: "1", telegramUserId: "555", draftId: opened.draftId, answer: "0.5" });
  assert.equal(afterVolume.complete, true);
  assert.equal(afterVolume.state, "AWAITING_CONFIRMATION");

  // An unreadable answer keeps the SAME field open rather than guessing.
  const other = await service.openFromText({
    userId: "1",
    telegramUserId: "555",
    chatId: "555",
    sourceMessageId: "103",
    text: "XAUUSD خرید، ورود 2650، خروج 2660",
  });
  await assert.rejects(
    () => service.answer({ userId: "1", telegramUserId: "555", draftId: other.draftId, answer: "خیلی زیاد" }),
    (err: unknown) => {
      const typed = err as JournalDraftError;
      assert.equal(typed.code, "DRAFT_INCOMPLETE");
      assert.equal(typed.field, "volume");
      return true;
    },
  );
});

test("confirm writes exactly ONE trade through the existing ledger, and the values are the domain's", async () => {
  const { service, tradeStore, trades } = makeService();
  const view = await service.openFromText({
    userId: "1",
    telegramUserId: "555",
    chatId: "555",
    sourceMessageId: "104",
    text: COMPLETE_FA,
  });

  const result = await service.confirm({ userId: "1", telegramUserId: "555", draftId: view.draftId });
  assert.ok(result.tradeId !== "");
  assert.equal(await countTrades(trades, "1"), 1);

  const stored = tradeStore.debugRow(result.tradeId)! as unknown as Record<string, unknown>;
  assert.equal(stored["symbol"], "XAUUSD");
  assert.equal(stored["direction"], "buy");
  // ADR-001 scales are applied by the LEDGER, not by the parser: the stored row
  // carries the 8-dp representation, and what the user typed ("2650") is what it
  // means.
  assert.equal(Number(stored["entryPrice"]), 2650);
  assert.equal(Number(stored["exitPrice"]), 2660);
  assert.equal(Number(stored["volume"]), 0.5);
  assert.equal(stored["status"], "CLOSED"); // entry+exit ⇒ closed trade
  // The ADR-002 event log recorded the creation — the web app reads this row.
  assert.equal(tradeStore.eventLog().length, 1);
  assert.equal(tradeStore.eventLog()[0]!.type, "TRADE_CREATED");

  // The draft is now CONFIRMED and bound to the trade it produced.
  const after = await service.currentDraft("1", "555");
  assert.equal(after, null); // no longer ACTIONABLE — that is the correct answer

  // A second confirmation cannot write a second trade.
  await assert.rejects(
    () => service.confirm({ userId: "1", telegramUserId: "555", draftId: view.draftId }),
    (err: unknown) => {
      const typed = err as JournalDraftError;
      assert.equal(typed.code, "DRAFT_ALREADY_CONFIRMED");
      return true;
    },
  );
  assert.equal(await countTrades(trades, "1"), 1);
});

test("another user's draft is indistinguishable from a missing one", async () => {
  const { service } = makeService();
  const alice = await service.openFromText({ userId: "1", telegramUserId: "555", chatId: "555", sourceMessageId: "105", text: COMPLETE_FA });

  for (const attempt of [
    () => service.answer({ userId: "2", telegramUserId: "555", draftId: alice.draftId, answer: "2655" }),
    () => service.confirm({ userId: "2", telegramUserId: "555", draftId: alice.draftId }),
    // Same account, DIFFERENT Telegram identity: also refused, because the
    // owner is resolved from the live link, not from the conversation.
    () => service.confirm({ userId: "1", telegramUserId: "777", draftId: alice.draftId }),
    () => service.confirm({ userId: "1", telegramUserId: "555", draftId: "999999" }),
  ]) {
    await assert.rejects(attempt, (err: unknown) => {
      const typed = err as JournalDraftError;
      assert.equal(typed.code, "DRAFT_NOT_FOUND");
      return true;
    });
  }
  // Alice's draft is untouched and still confirmable.
  const still = await service.currentDraft("1", "555");
  assert.equal(still?.draftId, alice.draftId);
});

test("a draft the domain refuses is re-opened with the offending field cleared", async () => {
  const { service, drafts, trades } = makeService();
  // Volume 0 is representable in a message but rejected by the domain (a trade
  // with no size is not a trade).
  const view = await service.openFromText({
    userId: "1",
    telegramUserId: "555",
    chatId: "555",
    sourceMessageId: "106",
    text: "XAUUSD خرید، ورود 2650، خروج 2660، حجم 0",
  });

  await assert.rejects(
    () => service.confirm({ userId: "1", telegramUserId: "555", draftId: view.draftId }),
    (err: unknown) => {
      const typed = err as JournalDraftError;
      assert.equal(typed.code, "INVALID_JOURNAL_ENTRY");
      assert.equal(typed.field, "volume");
      return true;
    },
  );
  assert.equal(await countTrades(trades, "1"), 0);

  // The draft survives the refusal: the claim was released, the bad value is
  // gone, and the user is asked for it again instead of losing the entry.
  const reopened = await service.currentDraft("1", "555");
  assert.ok(reopened !== null);
  assert.equal(reopened!.fields.volume, null);
  assert.deepEqual([...reopened!.missingFields], ["volume"]);
  const record = await drafts.findDraftById(view.draftId);
  assert.equal(record?.state, "NEEDS_DETAIL");

  // …and it can then be completed and saved.
  const fixed = await service.answer({ userId: "1", telegramUserId: "555", draftId: view.draftId, answer: "0.25" });
  assert.equal(fixed.complete, true);
  const saved = await service.confirm({ userId: "1", telegramUserId: "555", draftId: view.draftId });
  assert.ok(saved.tradeId !== "");
  assert.equal(await countTrades(trades, "1"), 1);
});

test("cancel discards the draft without writing, and an expired draft stops being actionable", async () => {
  let now = new Date("2026-02-01T09:00:00.000Z");
  const { service, drafts } = makeService({ now: () => now });
  const view = await service.openFromText({ userId: "1", telegramUserId: "555", chatId: "555", sourceMessageId: "107", text: COMPLETE_FA });

  await service.cancel({ userId: "1", telegramUserId: "555", draftId: view.draftId });
  assert.equal((await drafts.findDraftById(view.draftId))?.state, "CANCELLED");
  assert.equal(await service.currentDraft("1", "555"), null);

  const second = await service.openFromText({ userId: "1", telegramUserId: "555", chatId: "555", sourceMessageId: "108", text: COMPLETE_FA });
  now = new Date(now.getTime() + 31 * 60 * 1000); // past the 30-minute TTL
  await assert.rejects(
    () => service.confirm({ userId: "1", telegramUserId: "555", draftId: second.draftId }),
    (err: unknown) => {
      const typed = err as JournalDraftError;
      assert.equal(typed.code, "DRAFT_EXPIRED");
      return true;
    },
  );
  // The sweep marks it EXPIRED so the trail says why it stopped being usable.
  await service.expireStale();
  assert.equal((await drafts.findDraftById(second.draftId))?.state, "EXPIRED");
});

test("the same Telegram message cannot open two drafts", async () => {
  const { service, drafts } = makeService();
  const first = await service.openFromText({ userId: "1", telegramUserId: "555", chatId: "555", sourceMessageId: "109", text: COMPLETE_FA });
  // A retried delivery re-opens the SAME draft rather than creating a second.
  const second = await service.openFromText({ userId: "1", telegramUserId: "555", chatId: "555", sourceMessageId: "109", text: COMPLETE_FA });
  assert.equal(second.draftId, first.draftId);
  assert.equal(drafts.drafts.length, 1);
});

test("latest and history read the same ledger the web application reads", async () => {
  // Two DISTINCT open times: "latest" is defined by the ledger's ordering
  // (`open_time DESC, id DESC`), and a tie would make this assertion a test of
  // the storage tiebreak instead of the read contract.
  let now = new Date("2026-03-01T08:00:00.000Z");
  const { service } = makeService({ now: () => now });
  const one = await service.openFromText({ userId: "1", telegramUserId: "555", chatId: "555", sourceMessageId: "110", text: COMPLETE_FA });
  await service.confirm({ userId: "1", telegramUserId: "555", draftId: one.draftId });
  now = new Date("2026-03-01T09:00:00.000Z");
  const two = await service.openFromText({
    userId: "1",
    telegramUserId: "555",
    chatId: "555",
    sourceMessageId: "111",
    text: "EURUSD فروش، ورود 1.0850، خروج 1.0800، حجم 1",
  });
  await service.confirm({ userId: "1", telegramUserId: "555", draftId: two.draftId });

  const latest = await service.latest("1");
  assert.equal(latest?.["symbol"], "EURUSD");

  const page = await service.history("1", { page: 1, limit: 5 });
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 2);
  assert.equal(page.totalPages, 1);
  // Another user's journal is empty — reads are owner-scoped.
  assert.equal((await service.history("2", { page: 1, limit: 5 })).total, 0);
  assert.equal(await service.latest("2"), null);
});

test("previewFromText decides whether a message is a journal attempt at all", async () => {
  const { service } = makeService();
  for (const chat of ["سلام", "ممنون ازت", "ok thanks", "؟"]) {
    const preview = await service.previewFromText({ userId: "1", text: chat });
    assert.equal(preview.hasValue, false, `${chat} must not be treated as a journal attempt`);
  }
  for (const attempt of ["XAUUSD خرید", "طلا فروش 2650", "eurusd sell 1.08"]) {
    const preview = await service.previewFromText({ userId: "1", text: attempt });
    assert.equal(preview.hasValue, true, `${attempt} must be treated as a journal attempt`);
  }
});
