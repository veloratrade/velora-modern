// FirstTradeNotifier tests — MG-EMAIL-TYPES (AC-33).
//
// Guards the Legacy first-trade decision:
//   - count === 1 → first-trade email + FIRST_TRADE unlock + achievement email
//   - count > 1 → nothing (not first)
//   - trades preference off → no first-trade email, but the achievement still
//     unlocks (the unlock is not a preference; only its EMAIL is gated)
//   - unlock idempotence: pre-unlocked → achievement email suppressed
//   - any failure inside → swallowed (the trade already exists)

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { LogMailProvider } from "../mail/logMailProvider.js";
import { NotificationService } from "./notificationService.js";
import { FirstTradeNotifier } from "./firstTradeNotifier.js";
import {
  MemoryAchievementStore,
  MemoryEmailNotificationLog,
} from "./notificationStores.js";
import { ACHIEVEMENTS } from "@velora/domain";

interface NotifierHarness {
  notifier: FirstTradeNotifier;
  mail: LogMailProvider;
  log: MemoryEmailNotificationLog;
  achievements: MemoryAchievementStore;
  counts: Map<string, number>;
  tradesAllowed: () => boolean;
}

function makeNotifier(opts: {
  counts?: Map<string, number>;
  preUnlocked?: boolean;
  tradesAllowed?: boolean;
} = {}): NotifierHarness {
  const mail = new LogMailProvider();
  const log = new MemoryEmailNotificationLog();
  const achievements = new MemoryAchievementStore();
  const now = () => new Date("2026-10-06T10:00:00Z");
  const notifications = new NotificationService({
    mail,
    log,
    appOrigin: "https://veloratrade.ir",
    now,
    iconsDir: join(import.meta.dirname, "..", "..", "assets", "email-icons"),
  });
  const counts = opts.counts ?? new Map<string, number>();
  const tradesAllowed = { value: opts.tradesAllowed ?? true };
  notifications.preferences = async (_userId, gate) =>
    gate === "trades" ? tradesAllowed.value : true;
  const notifier = new FirstTradeNotifier({
    notifications,
    achievements,
    countActiveTrades: async (userId) => counts.get(userId) ?? 0,
    findUser: async () => ({
      id: "7",
      email: "trader@example.test",
      fullName: "Trader",
      locale: "fa",
    }),
  });
  if (opts.preUnlocked === true) {
    // simulate a previously-unlocked FIRST_TRADE
    void achievements.insert({
      userId: "7",
      achievementKey: "FIRST_TRADE",
      achievedAt: "2026-01-01 00:00:00",
      metadataJson: "{}",
    });
  }
  return { notifier, mail, log, achievements, counts, tradesAllowed: () => tradesAllowed.value };
}

test("first trade: count === 1 → first-trade email + FIRST_TRADE unlock + achievement email", async () => {
  const h = makeNotifier({ counts: new Map([["7", 1]]) });
  await h.notifier.onTradeCreated({ userId: "7", symbol: "XAUUSD", direction: "buy" });

  assert.equal(h.mail.outbox.length, 2, "first-trade + achievement emails");
  assert.equal(h.log.count("FIRST_TRADE_RECORDED"), 1);
  assert.equal(h.log.count("ACHIEVEMENT_UNLOCKED"), 1);
  const unlocked = await h.achievements.list("7");
  assert.equal(unlocked.filter((a) => a.achievementKey === "FIRST_TRADE").length, 1);
  const tradeMail = h.mail.outbox[0]!;
  assert.ok(tradeMail.html?.includes("XAUUSD"), "symbol in the email");
});

test("first trade: count > 1 → nothing fires (not the first trade)", async () => {
  const h = makeNotifier({ counts: new Map([["7", 3]]) });
  await h.notifier.onTradeCreated({ userId: "7", symbol: "XAUUSD", direction: "sell" });
  assert.equal(h.mail.outbox.length, 0);
  assert.equal(h.log.entries.length, 0);
  assert.equal((await h.achievements.list("7")).length, 0);
});

test("first trade: trades preference off → email skipped, achievement still unlocks", async () => {
  const h2 = makeNotifier({ counts: new Map([["7", 1]]), tradesAllowed: false });
  await h2.notifier.onTradeCreated({ userId: "7", symbol: "EURUSD", direction: "buy" });
  // preference-off ⇒ no first-trade EMAIL…
  assert.equal(h2.log.count("FIRST_TRADE_RECORDED"), 0);
  // …but the achievement itself still unlocked (only its email is gated —
  // and here achievements preference is on, so that mail DOES go out)
  assert.equal((await h2.achievements.list("7")).length, 1);
  assert.equal(h2.log.count("ACHIEVEMENT_UNLOCKED"), 1);
});

test("first trade: pre-unlocked achievement → only the first-trade email", async () => {
  const h = makeNotifier({ counts: new Map([["7", 1]]), preUnlocked: true });
  await h.notifier.onTradeCreated({ userId: "7", symbol: "XAUUSD", direction: "buy" });
  assert.equal(h.log.count("FIRST_TRADE_RECORDED"), 1);
  assert.equal(h.log.count("ACHIEVEMENT_UNLOCKED"), 0, "unlock idempotent — no second email");
  assert.equal(h.mail.outbox.length, 1);
});

test("first trade: unknown user → silent no-op; thrown errors → swallowed", async () => {
  const mail = new LogMailProvider();
  const log = new MemoryEmailNotificationLog();
  const achievements = new MemoryAchievementStore();
  const notifications = new NotificationService({
    mail, log,
    appOrigin: "https://veloratrade.ir",
    now: () => new Date("2026-10-06T10:00:00Z"),
    iconsDir: join(import.meta.dirname, "..", "..", "assets", "email-icons"),
  });
  const notifier = new FirstTradeNotifier({
    notifications,
    achievements,
    countActiveTrades: async () => 1,
    findUser: async () => null, // user vanished
  });
  await notifier.onTradeCreated({ userId: "404", symbol: "X", direction: "buy" });
  assert.equal(mail.outbox.length, 0);

  const throwing = new FirstTradeNotifier({
    notifications,
    achievements,
    countActiveTrades: async () => {
      throw new Error("store down");
    },
    findUser: async () => null,
  });
  await throwing.onTradeCreated({ userId: "7", symbol: "X", direction: "buy" }); // must not throw
  assert.ok(true);
});

test("first trade: ACHIEVEMENTS carries the two legacy definitions", () => {
  assert.equal(ACHIEVEMENTS["FIRST_TRADE"]!.key, "FIRST_TRADE");
  assert.equal(ACHIEVEMENTS["EMAIL_VERIFIED"]!.key, "EMAIL_VERIFIED");
});
