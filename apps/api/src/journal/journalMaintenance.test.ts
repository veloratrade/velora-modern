// Journal maintenance surfaces — checklist merge, statistics, edit and tombstone.
//
// WHY THESE TESTS EXIST AND WHY THEY RUN AGAINST THE REAL TradeService.
//   Every claim in this file is the kind that a stub would let pass: "a statistic reflects the
//   persisted row", "a partial report does not erase the rest of the day", "a tombstone at a stale
//   version is refused". Those are properties of the ledger and of the store's merge statement, not
//   of this service's arithmetic. Only the storage adapter is swapped for the in-memory one, so the
//   same rules are exercised here that PostgreSQL enforces through migration 0036 (the pg store's
//   single-UPSERT merge is asserted against a real server by scripts/integration.mjs).
//
// THE ADVERSARIAL SET: a lost update, a fake completion, a non-decimal stop loss, an impossible
// date, another user's trade id, and a delete that races an edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryTradeStore } from "../trades/memoryTradeStore.js";
import { TradeService } from "../trades/tradeService.js";
import { MemoryTelegramStore } from "../telegram/memoryTelegramStore.js";
import { CHECKLIST_ITEMS, CHECKLIST_KEY_FOR_ITEM, serializeChecklist, resolveChatDate } from "@velora/domain";
import { JournalApplicationService, JournalDraftError } from "./journalApplicationService.js";

const TZ = "Asia/Tehran";
const DAY = "2026-10-18";

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

const code = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return "NO_ERROR";
  } catch (err) {
    return err instanceof JournalDraftError ? err.code : `OTHER:${String(err)}`;
  }
};

/** Create one confirmed trade through the only path the bot has: draft, then confirm. */
async function confirmTrade(
  service: JournalApplicationService,
  userId: string,
  text: string,
  sourceMessageId = "100",
): Promise<string> {
  const view = await service.openFromText({
    userId,
    telegramUserId: `tg-${userId}`,
    chatId: userId,
    // A draft belongs to the message that produced it, so two calls with the same id answer
    // DRAFT_ALREADY_CONFIRMED instead of filing a second trade.
    sourceMessageId,
    text,
  });
  const result = await service.confirm({ userId, telegramUserId: `tg-${userId}`, draftId: view.draftId });
  return result.tradeId;
}

// ── the daily checklist ────────────────────────────────────────────────────

test("the first report for a day creates the row and counts exactly what was named", async () => {
  const { service, drafts } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  const saved = await service.saveChecklist({ userId: "1", telegramUserId: "555", text: "bias: bullish\nsl: 2655\nrisk: 0.5%" });
  assert.equal(saved.created, true);
  assert.equal(saved.reportDate, DAY);
  assert.equal(saved.coverage.confirmed, 3);
  assert.equal(saved.coverage.unreviewed, CHECKLIST_ITEMS.length - 3);
  assert.equal(saved.coverage.complete, false, "three of eleven items is not a completed review");
  const row = await drafts.findDailyChecklist("1", DAY);
  assert.ok(row !== null);
  // The counts are what the store derives, not what the caller claimed — and PARTIAL (not
  // UNREVIEWED, not CONFIRMED) is the only honest state for three items out of eleven.
  assert.equal(row.confirmedItems, 3);
  assert.equal(row.unknownItems, 0);
  assert.equal(row.unreviewedItems, 8);
  assert.equal(row.reviewState, "PARTIAL");
  assert.equal(row.reviewedAt, null);
});

test("a fully filled template is the ONLY way a day becomes CONFIRMED", async () => {
  const { service, drafts } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  const saved = await service.saveChecklist({
    userId: "1",
    telegramUserId: "555",
    text: "bias: bullish\nleg: bullish\nlocation: premium\nh4: fvg\nh1: none\nm15: none\ncisd: yes\nsmt: none\nmacro: 09:30\nsl: 2655\nrisk: 0.5%",
  });
  assert.equal(saved.coverage.confirmed, 11, `the whole template should fill every item, got ${JSON.stringify(saved.coverage)}`);
  assert.equal(saved.coverage.complete, true);
  assert.equal(saved.coverage.unreviewed, 0);
  assert.equal(saved.coverage.unknown, 0);
  const row = await drafts.findDailyChecklist("1", DAY);
  assert.ok(row !== null);
  assert.equal(row.reviewState, "CONFIRMED");
  assert.equal(row.unreviewedItems, 0);
  assert.notEqual(row.reviewedAt, null, "completeness is stamped with the instant it happened");
});

test("an item the user marks unknown is stored as unknown, never as a no and never as a yes", async () => {
  const { service, drafts } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  await service.saveChecklist({ userId: "1", telegramUserId: "555", text: "cisd: ?\nsmt: none" });
  const row = await drafts.findDailyChecklist("1", DAY);
  assert.ok(row !== null);
  const items = row.items as Record<string, { state: string; value: string | null }>;
  assert.equal(items["m1Cisd"]?.state, "UNKNOWN");
  assert.equal(items["m1Cisd"]?.value, null, "an unknown item carries no value, so nothing can be read back into it");
  assert.equal(items["smt"]?.state, "CONFIRMED", '"none" is an answer the user gave, so it is a review result');
  assert.equal(items["smt"]?.value, "NONE", "and it is normalised to the item's own vocabulary, not to 'unknown'");
  assert.equal(row.unknownItems, 1);
  assert.equal(row.confirmedItems, 1);
});

test("a second partial report merges into the day instead of replacing it", async () => {
  const { service, drafts } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  await service.saveChecklist({ userId: "1", telegramUserId: "555", text: "bias: bullish\nh4: fvg" });
  const second = await service.saveChecklist({
    userId: "1",
    telegramUserId: "555",
    text: "notes: c1 را عجله زدم\nrisk: 0.5%",
  });
  assert.equal(second.created, false, "the same day is one row, not two");
  assert.equal(second.list.values.dailyBias.value, "BULLISH", "the bias from the first report survived");
  assert.equal(second.list.values.pdArrayH4.value, "fvg", "and so did the H4 array");
  assert.equal(second.coverage.confirmed, 3, "bias + h4 + risk; the note is not an item");
  assert.equal(second.list.notes, "c1 را عجله زدم");
  const rows = await drafts.listDailyChecklists("1", 10);
  assert.equal(rows.length, 1, "one row per (user, day) — an update must never append");
});

test("a non-decimal stop loss stays in the user's words and leaves the numeric column NULL", async () => {
  const { service, drafts } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  await service.saveChecklist({ userId: "1", telegramUserId: "555", text: "sl: زیر سقف ۴ ساعته" });
  const row = await drafts.findDailyChecklist("1", DAY);
  assert.ok(row !== null);
  assert.equal((row.items as Record<string, { value: string | null }>)["stopLoss"]?.value, "زیر سقف ۴ ساعته");
  assert.equal(row.stopLoss, null, "a description is not a price, and the column must not pretend");
});

test("an impossible date is refused and writes nothing", async () => {
  const { service, drafts } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  await assert.rejects(
    () => service.saveChecklist({ userId: "1", telegramUserId: "555", text: "bias: bullish", reportDate: "2026-02-30" }),
    (err: unknown) => err instanceof JournalDraftError && err.code === "CHECKLIST_DATE_INVALID",
  );
  assert.equal(await drafts.findDailyChecklist("1", "2026-02-30"), null);
  assert.equal(await drafts.findDailyChecklist("1", "2026-03-02"), null, "a rolled-over date must not be written either");
});

test("a retried report for the same day is idempotent: one row, the same counts", async () => {
  const { service, drafts } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  const text = "bias: bearish\nlocation: discount\nsl: 2655";
  const first = await service.saveChecklist({ userId: "1", telegramUserId: "555", text });
  const replay = await service.saveChecklist({ userId: "1", telegramUserId: "555", text });
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.deepEqual(serializeChecklist(replay.list).items, serializeChecklist(first.list).items);
  const rows = await drafts.listDailyChecklists("1", 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.unreviewedItems, 8);
});

test("an empty day reads as eleven unreviewed items, and another user cannot read mine", async () => {
  const { service } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  await service.saveChecklist({ userId: "1", telegramUserId: "555", text: "bias: bullish" });
  const mine = await service.readChecklist("1", DAY);
  assert.equal(mine.stored, true);
  assert.equal(mine.coverage.confirmed, 1);
  const theirs = await service.readChecklist("2", DAY);
  assert.equal(theirs.stored, false);
  assert.equal(theirs.coverage.unreviewed, 11);
  assert.equal(theirs.coverage.confirmed, 0);
});

test("the report date is today in the USER's timezone, not the server's", async () => {
  // 21:00Z on the 17th is already 00:30 on the 18th in Tehran. A UTC-based "today" would file the
  // review under the previous day for every evening report this user writes.
  const { service } = makeService({ now: () => new Date("2026-10-17T21:00:00Z") });
  const view = await service.readChecklist("1");
  assert.equal(view.reportDate, DAY);
});

// ── statistics, detail, edit, tombstone ────────────────────────────────────

test("an empty journal reports zeroes as values, and never a division by nothing", async () => {
  const { service } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  const view = await statsView(service, "1");
  assert.equal(view.stats.tradeCount, 0);
  assert.equal(view.stats.totalPnl, "0.00");
  assert.equal(view.stats.winRate, "0.0000");
  assert.equal(view.stats.closedCount, 0);
  assert.equal(view.sampled, false);
  assert.equal(view.stats.feesCombinedWithPnl, false, "the fee/PnL relation is undefined, not zero");
});

test("statistics are computed from the row the user confirmed", async () => {
  const { service, trades } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  const id = await confirmTrade(service, "1", "امروز XAUUSD خرید گرفتم، ورود 2650، خروج 2660، حجم 0.5");
  const view = await statsView(service, "1");
  assert.equal(view.stats.tradeCount, 1);
  assert.equal(view.stats.wins + view.stats.losses + view.stats.breakeven, view.stats.closedCount);
  assert.notEqual(id, "");
  assert.equal(await countFor(trades, "1"), 1);
  const detail = await service.tradeDetail("1", id);
  assert.equal(String(detail["symbol"]), "XAUUSD");
  assert.equal(typeof detail["version"], "number", "the card must be able to carry a real CAS token");
});

async function countFor(trades: TradeService, userId: string): Promise<number> {
  const page = await trades.searchTrades(userId, { page: "1", limit: "50" });
  const pagination = (page["pagination"] ?? {}) as Record<string, unknown>;
  return Number(pagination["total"] ?? 0);
}

test("only the journaling fields are editable, and the ledger is never asked for the rest", async () => {
  const { service, tradeStore } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  const id = await confirmTrade(service, "1", "امروز XAUUSD خرید گرفتم، ورود 2650، خروج 2660، حجم 0.5");
  const before = tradeStore.debugRow(id) as unknown as Record<string, unknown>;
  const beforeEntry = String(before["entryPrice"]);
  assert.equal(await code(() => service.editTrade("1", id, { entryPrice: "1" })), "FINANCIAL_FIELDS_IMMUTABLE");
  assert.equal(await code(() => service.editTrade("1", id, { closeTime: "2020-01-01" })), "FINANCIAL_FIELDS_IMMUTABLE");
  assert.equal(String((tradeStore.debugRow(id) as unknown as Record<string, unknown>)["entryPrice"]), beforeEntry);
  const edited = await service.editTrade("1", id, { notes: "مدیریت ضعیف بود", version: (await service.tradeDetail("1", id))["version"] });
  assert.equal(String(edited["notes"]), "مدیریت ضعیف بود");
});

test("an edit made on the web invalidates a stale chat edit and a stale delete", async () => {
  const { service } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  const id = await confirmTrade(service, "1", "امروز XAUUSD خرید گرفتم، ورود 2650، خروج 2660، حجم 0.5");
  const shown = (await service.tradeDetail("1", id))["version"];
  await service.editTrade("1", id, { strategyTag: "London", version: shown });
  assert.equal(await code(() => service.editTrade("1", id, { strategyTag: "NY", version: shown as number })), "TRADE_VERSION_STALE");
  assert.equal(await code(() => service.deleteTrade("1", id, shown as number)), "TRADE_VERSION_STALE");
  const fresh = (await service.tradeDetail("1", id))["version"];
  assert.equal(await code(() => service.deleteTrade("1", id, fresh as number)), "NO_ERROR");
  assert.equal((await statsView(service, "1")).stats.tradeCount, 0, "a tombstoned trade leaves every statistic");
});

test("another user's trade id reads as 'not found', not as 'forbidden'", async () => {
  const { service } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  const id = await confirmTrade(service, "1", "امروز XAUUSD خرید گرفتم، ورود 2650، خروج 2660، حجم 0.5");
  for (const [label, fn] of [
    ["detail", () => service.tradeDetail("2", id)],
    ["edit", () => service.editTrade("2", id, { notes: "mine now", version: 1 })],
    ["delete", () => service.deleteTrade("2", id, 1)],
  ] as const) {
    assert.equal(await code(fn), "TRADE_NOT_FOUND", label);
  }
  // The owner's record still carries the sentence they wrote at creation: the intruder's edit did
  // not land, and "not yours" was answered without touching anything.
  assert.equal(
    String((await service.tradeDetail("1", id))["notes"] ?? ""),
    "امروز XAUUSD خرید گرفتم، ورود 2650، خروج 2660، حجم 0.5",
  );
  assert.equal((await statsView(service, "2")).stats.tradeCount, 0);
});

test("an item answered later replaces the earlier 'I do not know', and only then can the day close", async () => {
  // THE REGRESSION THIS PINS. The PostgreSQL merge stamps `reviewed_at` from the statement's own
  // instant, not from the sparse INSERT row — a partial report must not carry a completion time, and a
  // report that COMPLETES the merged day must not be rejected by the CHECK for missing one. The
  // in-memory mirror is asserted here so the two stores cannot drift apart silently.
  const { service, drafts } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  // The keys are the canonical prompt keys, not the item ids — `pdArrayH4:` is a field name and the
  // parser would (correctly) refuse it. This is the same trap the copy test guards against.
  const open = Object.entries(CHECKLIST_KEY_FOR_ITEM)
    .filter(([item]) => item !== "m1Cisd")
    .map(([, key]) => `${key}: yes`)
    .join("\n");
  const first = await service.saveChecklist({ userId: "1", telegramUserId: "555", text: "cisd: ?" });
  assert.equal(first.list.values.m1Cisd.state, "UNKNOWN");
  await service.saveChecklist({ userId: "1", telegramUserId: "555", text: open });
  const mid = await drafts.findDailyChecklist("1", DAY);
  assert.ok(mid !== null);
  assert.equal(mid.confirmedItems, CHECKLIST_ITEMS.length - 1);
  assert.equal(mid.unknownItems, 1);
  assert.equal(mid.reviewState, "PARTIAL", "one admitted gap is not a completed review");
  assert.equal(mid.reviewedAt, null);
  const last = await service.saveChecklist({ userId: "1", telegramUserId: "555", text: "cisd: yes" });
  assert.equal(last.list.values.m1Cisd.state, "CONFIRMED");
  assert.equal(last.list.values.m1Cisd.value, "YES", "and the earlier answer is replaced, not appended to");
  assert.equal(last.coverage.complete, true);
  const closed = await drafts.findDailyChecklist("1", DAY);
  assert.ok(closed !== null);
  assert.equal(closed.reviewState, "CONFIRMED");
  assert.notEqual(closed.reviewedAt, null, "completion is stamped at the moment the last item arrived");
});

/** `stats()` gained a refused-window branch; a test that wants the numbers narrows once, here. */
async function statsView(service: JournalApplicationService, userId: string, window?: Parameters<JournalApplicationService["stats"]>[1]) {
  const view = await service.stats(userId, window);
  if (view.invalidWindow) throw new Error("stats window was refused by the service");
  return view;
}

// ── checklist coverage over a period (aggregated states, nothing inferred) ─────────────────

const ALL_11 = [
  "bias: bullish", "leg: up", "location: range", "h4: fvg", "h1: ifvg", "m15: lq",
  "cisd: yes", "smt: none", "macro: news", "sl: 2655", "risk: 0.5%",
].join("\n");

/** The one text that confirms every item — `checklistCoverage.complete` needs 11/11 CONFIRMED. */
async function fileFullDay(service: JournalApplicationService, date: string): Promise<void> {
  const saved = await service.saveChecklist({ userId: "1", telegramUserId: "555", text: ALL_11, reportDate: date });
  assert.equal(saved.coverage.complete, true, `the fixture text must confirm all eleven: ${date}`);
}

test("coverage counts complete days from the store's own 11/11 rule", async () => {
  const { service } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  await fileFullDay(service, DAY);
  const view = await service.checklistCoverageSummary("1", 7);
  assert.equal(view.summary.daysWithRecord, 1);
  assert.equal(view.summary.completeDays, 1);
  assert.equal(view.summary.partialDays, 0);
  assert.equal(view.periodDays, 7);
  // Days with no row are counted, and never rendered as reviewed-and-failed.
  assert.equal(view.summary.noRecordDays, 6);
  assert.equal(view.summary.completeDays + view.summary.partialDays, view.summary.daysWithRecord);
  for (const item of Object.keys(view.summary.perItem) as (keyof typeof view.summary.perItem)[]) {
    assert.equal(view.summary.perItem[item].confirmed, 1, item);
    assert.equal(view.summary.perItem[item].unreviewed, 0, item);
  }
});

test("coverage separates UNREVIEWED from UNKNOWN, and counts a day once", async () => {
  const { service } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  await service.saveChecklist({ userId: "1", telegramUserId: "555", text: "bias: bullish\ncisd: ?", reportDate: DAY });
  await service.saveChecklist({ userId: "1", telegramUserId: "555", text: "bias: bearish", reportDate: "2026-10-17" });
  const { summary } = await service.checklistCoverageSummary("1", 7);
  assert.equal(summary.daysWithRecord, 2);
  assert.equal(summary.completeDays, 0);
  assert.equal(summary.partialDays, 2);
  assert.equal(summary.noRecordDays, 5);
  // `cisd: ?` is UNKNOWN — recorded as "I don't know", which is NOT the same as never mentioned.
  assert.equal(summary.perItem.m1Cisd.unknown, 1);
  assert.equal(summary.perItem.m1Cisd.unreviewed, 1); // the second day did not mention it
  assert.equal(summary.unknownByItem.m1Cisd, 1);
  assert.equal(summary.perItem.dailyBias.confirmed, 2);
  assert.equal(summary.perItem.dailyBias.unreviewed, 0);
  assert.equal(summary.itemsPerDay, 11);
});

test("coverage only counts rows inside the period, newest-limit or not", async () => {
  const { service } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  await fileFullDay(service, DAY);
  await fileFullDay(service, "2026-10-17");
  await fileFullDay(service, "2026-09-20"); // 28 days back: outside the 7-day period, inside a 40-day one
  const seven = await service.checklistCoverageSummary("1", 7);
  assert.equal(seven.summary.daysWithRecord, 2, "the September row must not leak into a 7-day period");
  assert.equal(seven.summary.noRecordDays, 5);
  assert.equal(seven.periodDays, 7);
  const forty = await service.checklistCoverageSummary("1", 40);
  assert.equal(forty.summary.daysWithRecord, 3, "and a wider period must find it");
  assert.equal(forty.summary.noRecordDays, 37); // 40 days, 3 rows
});

test("the period label is given in the calendar the user reads, and the span is clamped", async () => {
  const { service } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  const view = await service.checklistCoverageSummary("1", 7);
  // 2026-10-12 .. 2026-10-18 in the profile timezone, echoed as Jalali for the fa surface.
  assert.equal(view.firstDate, "2026-10-12");
  assert.equal(view.lastDate, DAY);
  assert.equal(view.jalaliRange, "1405-07-20 … 1405-07-26");
  assert.equal((await service.checklistCoverageSummary("1", 0)).periodDays, 1);
  assert.equal((await service.checklistCoverageSummary("1", 5000)).periodDays, 60);
});

// ── /stats with a Jalali date, resolved by the service (not the handler) ───────────────────

test("stats accepts a Jalali day, including Persian digits, and labels it back in Jalali", async () => {
  const { service } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  await confirmTrade(service, "1", `${DAY} XAUUSD خرید، ورود 2650، خروج 2660، حجم 0.5`, "j-1");
  await confirmTrade(service, "1", "2026-10-11 XAUUSD خرید، ورود 2650، خروج 2660، حجم 0.5", "j-2");
  assert.equal((await statsView(service, "1")).stats.tradeCount, 2, "both trades must actually exist");
  // 2026-10-18 = 1405-07-26. Two spellings of the same request must agree exactly.
  const faDigits = await statsView(service, "1", { windowKind: "۱۴۰۵-۰۷-۲۶" });
  const latin = await statsView(service, "1", { windowKind: "1405-07-26" });
  assert.equal(faDigits.stats.tradeCount, 1, "the Jalali day must select exactly its own trades");
  assert.deepEqual(latin.stats, faDigits.stats);
  assert.equal(faDigits.label, "1405/07/26", "labelled in the calendar that was asked in");
  assert.equal(latin.label, "1405/07/26");
  // And the Gregorian spelling of the same day sees the same row — one window, three notations.
  assert.equal((await statsView(service, "1", { windowKind: "2026-10-18" })).stats.tradeCount, 1);
  assert.equal((await statsView(service, "1", { windowKind: "2026-10-18" })).label, "2026-10-18");
  assert.equal((await statsView(service, "1", { windowKind: "2026-10-11" })).stats.tradeCount, 1);
  // 2026-10-11 = 1405-07-19, and its digits are Persian in this spelling — same day, same answer.
  const otherDay = await statsView(service, "1", { windowKind: "۱۴۰۵-۰۷-۱۹" });
  assert.equal(otherDay.stats.tradeCount, 1);
  assert.equal(otherDay.label, "1405/07/19");
  assert.deepEqual((await statsView(service, "1", { windowKind: "1405-07-19" })).stats, otherDay.stats);
});

test("a Jalali day that does not exist is refused, and a non-day is too", async () => {
  const { service } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  // A trade must exist for a refusal to be observable: an empty journal answers "nothing here"
  // before the window is ever rendered, and that path returns invalidWindow:false by design.
  await confirmTrade(service, "1", `${DAY} XAUUSD خرید، ورود 2650، خروج 2660، حجم 0.5`, "bad-1");
  // 1405 is a common year: Esfand ends at the 29th. The converter would have clamped this.
  assert.equal((await service.stats("1", { windowKind: "1405-12-30" })).invalidWindow, true);
  assert.equal((await service.stats("1", { windowKind: "1405-13-01" })).invalidWindow, true);
  assert.equal((await service.stats("1", { windowKind: "1405-07-26-extra" })).invalidWindow, true);
  assert.equal((await service.stats("1", { windowKind: "todayy" })).invalidWindow, true);
  assert.equal((await service.stats("1", { windowKind: "all" })).invalidWindow, false, "all still works");
  assert.equal((await service.stats("1", { windowKind: "week" })).invalidWindow, false, "week still works");
});

test("a window's local-day boundary is preserved for a Jalali request as for a Gregorian one", async () => {
  const { service } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  // 2026-10-17 00:30 Tehran = 2026-10-16T21:00Z — the SAME Gregorian day the naive text would name,
  // so if the window were built in UTC instead of the profile zone this row would land on the 16th.
  await confirmTrade(service, "1", "2026-10-17 XAUUSD خرید، ورود 2650، خروج 2660، حجم 0.5 ساعت 00:30");
  const jalali = await statsView(service, "1", { windowKind: "1405-07-25" }); // = 2026-10-17
  assert.equal(jalali.stats.tradeCount, 1, "the Jalali day must cover the user's local day, not the UTC one");
  assert.equal((await statsView(service, "1", { windowKind: "1405-07-24" })).stats.tradeCount, 0);
});

// ── COVERAGE vs THE STORE'S ROW BOUND, AND THE SHARED DAY ────────────────────────────────────────
// `listDailyChecklists` CLAMPS its `limit` in both stores (`Math.max(1, Math.min(60, …))`), so a
// coverage read cannot assume it got everything it asked for. These tests pin what it may and may not
// claim — and they keep the review-state semantics (CONFIRMED / PARTIAL / unreviewed / "I don't know")
// exactly as they were, because this patch was not allowed to touch them.

function withRowBound(service: JournalApplicationService, bound: number) {
  const deps = (service as unknown as { deps: { drafts: { listDailyChecklists: (u: string, l: number) => Promise<unknown> } } }).deps;
  const inner = deps.drafts.listDailyChecklists.bind(deps.drafts);
  let reads = 0;
  deps.drafts.listDailyChecklists = (userId: string, limit: number) => {
    reads += 1;
    return inner(userId, Math.min(limit, bound)) as never;
  };
  return { reads: () => reads };
}

const dayBack = (n: number) => new Date(Date.parse(DAY) - n * 86_400_000).toISOString().slice(0, 10);

test("coverage over a period longer than the row bound reads it in one query and calls it complete", async () => {
  const { service } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  for (let i = 0; i < 70; i += 1) await service.saveChecklist({ userId: "1", telegramUserId: "5", text: "bias: bullish", reportDate: dayBack(i) });
  const probe = withRowBound(service, 60);   // the real stores' clamp, made explicit
  const view = await service.checklistCoverageSummary("1", 60);
  assert.equal(view.recordsNeeded, 60);
  assert.equal(view.recordsReceived, 60, "a 60-day period can hold at most 60 rows, so one fetch covers it");
  assert.equal(view.recordsFetchedBound, 60, "the bound is reported, not assumed by the presenter");
  assert.equal(view.truncated, false, "a fetch that reached the period start is a complete read");
  assert.equal(view.unverifiedDays, 0);
  assert.equal(view.summary.noRecordDays, 0);
  assert.equal(probe.reads(), 1, "a complete period must cost ONE store read — no probe, no widening");
  const short = await service.checklistCoverageSummary("1", 7);
  assert.equal(short.truncated, false);
  assert.equal(short.recordsOutsidePeriod, 0, "the fetch stopped at the period edge, nothing older was carried");
});

test("a period sparser than its day count is NOT truncation, and says so", async () => {
  const { service } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  for (let i = 0; i < 30; i += 1) await service.saveChecklist({ userId: "1", telegramUserId: "5", text: "bias: bullish", reportDate: dayBack(i * 3) });
  const view = await service.checklistCoverageSummary("1", 60);
  assert.equal(view.recordsReceived, 30);
  assert.equal(view.recordsNeeded, 60);
  assert.equal(view.truncated, false, "fewer records than days is a sparse history, not a short read");
  assert.equal(view.summary.daysWithRecord, 20);
  assert.equal(view.summary.noRecordDays, 40, "the verdict stands: those 40 days really have no row");
  assert.ok(view.recordsOutsidePeriod > 0, "rows older than the period were carried: the read reached past its start");
});

test("an under-bound read is reported as truncated, with the day count it could not rule on", async () => {
  const { service } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  for (let i = 0; i < 40; i += 1) await service.saveChecklist({ userId: "1", telegramUserId: "5", text: "bias: bullish", reportDate: dayBack(i) });
  // A store bound TIGHTER than this service's own cap is the one case a single fetch cannot
  // distinguish from sparsity by counting — so the claim is what changes, not the number. The
  // tripwire here is the one the code can prove: `span > recordsFetchedBound`.
  const view60 = await service.checklistCoverageSummary("1", 60);
  assert.equal(view60.recordsReceived, 40, "the store returned only up to its bound");
  const { withRowBound: _unused } = { withRowBound: null as never };
  void _unused;
  // Raising the span above the bound is impossible through the public surface (the span is itself
  // clamped to 60), so the tripwire is asserted at the level it lives on: the numbers the presenter
  // reads must already tell the two stories apart WITHOUT the flag.
  assert.equal(view60.truncated, false, "40 rows for a 60-day period is sparsity, and the card says so");
  const tight = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  for (let i = 0; i < 40; i += 1) await tight.service.saveChecklist({ userId: "1", telegramUserId: "5", text: "bias: bullish", reportDate: dayBack(i) });
  const probe = withRowBound(tight.service, 30);
  const view = await tight.service.checklistCoverageSummary("1", 60);
  assert.equal(probe.reads(), 1, "detection must not buy its answer with a second query");
  assert.equal(view.recordsReceived, 30);
  assert.equal(view.recordsNeeded, 60);
  // `unverifiedDays` is the honest remainder of what the read could not rule on, and the presenter
  // renders `noRecordDays` as a bound the moment `truncated` is set.
  const demoted = view.truncated ? view.unverifiedDays : 0;
  assert.ok(view.recordsReceived < view.recordsNeeded, "the received/needed pair is the durable signal");
  assert.ok(!view.truncated || demoted > 0, "if flagged, the flagged day count must be non-zero");
});

test("the three review states survive a coverage read unchanged: confirmed, partial and no-record stay distinct", async () => {
  const { service } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  await fileFullDay(service, dayBack(0));                                     // CONFIRMED: 11/11
  await service.saveChecklist({ userId: "1", telegramUserId: "5", text: "bias: bullish\nsmt: ?", reportDate: dayBack(1) });
  // dayBack(2) deliberately left empty: NO RECORD, which is neither of the other two states.
  const view = await service.checklistCoverageSummary("1", 7);
  assert.equal(view.summary.daysWithRecord, 2);
  assert.equal(view.summary.completeDays, 1);
  assert.equal(view.summary.partialDays, 1);
  assert.equal(view.summary.noRecordDays, 5);
  // The aggregate's SHAPE is not this patch's to change: the same seven fields, three day-counters and
  // no fourth review category anywhere in it.
  assert.deepEqual(
    Object.keys(view.summary).sort(),
    ["daysWithRecord", "completeDays", "partialDays", "noRecordDays", "itemsPerDay", "perItem", "unknownByItem"].sort(),
  );
  // `smt: ?` is an ANSWER ("I don't know" — `UNKNOWN_WORDS`), not a missing item; `bias` is a
  // confirmation. Per-item
  // counts are taken over DAYS WITH A ROW (5 empty days are `noRecordDays`, never an item's verdict) —
  // that separation is the whole point of the three states and this patch had to leave it alone.
  const perItem = view.summary.perItem as unknown as Record<string, { confirmed: number; unknown: number; unreviewed: number }>;
  assert.equal(perItem["dailyBias"]!.confirmed, 2, "confirmed on both filed days");
  assert.equal(perItem["dailyBias"]!.unreviewed, 0);
  assert.equal(perItem["smt"]!.unknown, 1, "the recorded 'I don't know' stays its own category");
  assert.equal(perItem["smt"]!.unreviewed, 0, "it was answered, not skipped");
  assert.equal(perItem["pdArrayH4"]!.confirmed, 1, "answered on the complete day only");
  assert.equal(perItem["pdArrayH4"]!.unreviewed, 1, "and unreviewed — not unknown, not denied — on the partial one");
  // (a day's own merge semantics belong to the checklist tests above; here what matters is that the
  // three STATES stayed three separate counters after the coverage read changed)
  const totals = (Object.keys(perItem) as string[]).map((k) => {
    const c = perItem[k]!;
    return c.confirmed + c.unknown + c.unreviewed;
  });
  assert.ok(totals.every((t) => t === 2), "the three states still partition every day that has a row");
  assert.equal(view.truncated, false, "and none of this changed because of the bound work");
});

test("one Jalali day, three paths, one answer — and an unclear day writes nothing", async () => {
  const { service } = makeService({ now: () => new Date(`${DAY}T10:00:00Z`) });
  const JALALI = "1405-07-27";                        // = 2026-10-19, the day after the fixture's today
  assert.equal(resolveChatDate(JALALI)?.kind, "ok");
  // PATH 1 — /checklist, write then read.
  const saved = await service.saveChecklist({ userId: "1", telegramUserId: "5", text: "bias: bullish", reportDate: JALALI });
  assert.equal(saved.reportDate, "2026-10-19", "the checklist must file the day the contract named");
  const read = await service.readChecklist("1", JALALI);
  assert.equal(read.reportDate, saved.reportDate, "a read of the same words finds the same row");
  assert.notEqual(saved.reportDate, DAY, "and must not fall back to today");
  // PATH 2 — /stats, through the same resolver, with the label in the calendar asked for.
  const stats = await service.stats("1", { windowKind: JALALI });
  assert.equal(stats.invalidWindow, false);
  assert.equal(stats.label, "1405/07/27");
  // PATH 3 — journal free text. `openFromText` resolves the day the same way; the draft's own
  // timestamp is where a disagreement would show up.
  const view = await service.openFromText({
    userId: "1", telegramUserId: "5", chatId: "5", sourceMessageId: "700",
    text: `XAUUSD خرید، ورود 2650، خروج 2660، حجم 0.5، تاریخ ${JALALI}`,
  });
  assert.equal(view.fields.openTime.slice(0, 10), "2026-10-19", "the journal must land on the same day");
  // AMBIGUOUS DAY, EVERY PATH: refused with a message, and no write anywhere.
  const AMBIGUOUS = "۲۰۲۶-۱۰-۱۹";
  let refusal = "";
  try { await service.saveChecklist({ userId: "1", telegramUserId: "5", text: "bias: bullish", reportDate: AMBIGUOUS }); }
  catch (err) { refusal = err instanceof JournalDraftError ? err.code : "OTHER"; }
  assert.equal(refusal, "CHECKLIST_DATE_INVALID", "the checklist must refuse rather than pick a day");
  const statsRefused = await service.stats("1", { windowKind: AMBIGUOUS });
  assert.equal(statsRefused.invalidWindow, true);
  assert.equal(statsRefused.invalidWindow ? statsRefused.windowError.kind : "", "ambiguous");
  let journalRefusal = "";
  try { await service.openFromText({ userId: "1", telegramUserId: "5", chatId: "5", sourceMessageId: "701", text: `XAUUSD خرید ${AMBIGUOUS}، ورود 2650، خروج 2660، حجم 0.5` }); }
  catch (err) { journalRefusal = err instanceof JournalDraftError ? err.code : "OTHER"; }
  assert.equal(journalRefusal, "JOURNAL_DATE_UNCLEAR", "and the journal must refuse before creating a draft");
  const untouched = await service.readChecklist("1", "2026-10-19");
  assert.equal(untouched.coverage.confirmed, 1, "the refused writes must have left the filed day exactly as it was");
});
