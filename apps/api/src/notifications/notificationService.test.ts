// NotificationService tests — MG-EMAIL-TYPES (AC-33).
//
// Exercises the REAL icon assets (vendored byte-identical from Legacy), the
// REAL domain builders, and the LogMailProvider outbox — no network, no key.
// Guards the four Legacy behavioral contracts:
//   1. preference gating happens exactly on the four gated types
//   2. every attempt lands in the delivery log with its honest outcome
//   3. a missing icon asset fails the send (sendWithIcon parity)
//   4. no path ever throws into the caller's flow

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { LogMailProvider } from "../mail/logMailProvider.js";
import {
  NotificationService,
  type NotificationRecipient,
} from "./notificationService.js";
import { MemoryEmailNotificationLog } from "./notificationStores.js";

const RECIPIENT: NotificationRecipient = {
  userId: "42",
  email: "trader@example.test",
  fullName: "Trader One",
  locale: "fa",
};

function makeService(overrides: {
  preferences?: (userId: string, gate: string) => Promise<boolean>;
  iconsDir?: string;
  supportDeskEmail?: string;
} = {}) {
  const mail = new LogMailProvider();
  const log = new MemoryEmailNotificationLog();
  const service = new NotificationService({
    mail,
    log,
    appOrigin: "https://veloratrade.ir",
    now: () => new Date("2026-10-06T10:00:00Z"),
    ...(overrides.supportDeskEmail !== undefined ? { supportDeskEmail: overrides.supportDeskEmail } : {}),
    iconsDir: overrides.iconsDir ?? join(import.meta.dirname, "..", "..", "assets", "email-icons"),
  });
  if (overrides.preferences) service.preferences = overrides.preferences;
  return { mail, log, service };
}

test("notification: verification email sends branded mail and logs sent", async () => {
  const { mail, log, service } = makeService();
  const res = await service.sendVerificationEmail(RECIPIENT, "https://v.ir/verify?t=1", "fa");

  assert.equal(res.outcome, "sent");
  const sent = mail.lastTo(RECIPIENT.email);
  assert.ok(sent !== null);
  assert.ok(sent.html?.includes("cid:velora-logo"));
  assert.ok(sent.html?.includes("cid:velora-verification"));
  assert.equal(sent.inlineImages?.length, 2);
  // log: sent with the legacy event type
  assert.equal(log.count("VERIFICATION_EMAIL"), 1);
  assert.equal(log.entries[0]!.status, "sent");
  assert.equal(log.entries[0]!.errorMessage, null);
  assert.ok(log.entries[0]!.subject.length > 3);
});

test("notification: preference gates — welcome/security/trades/achievements", async () => {
  // All preferences OFF.
  const { mail, log, service } = makeService({
    preferences: async () => false,
  });

  const gated = [
    () => service.sendWelcomeEmail(RECIPIENT, "https://v.ir/d", "fa"),
    () => service.sendNewDeviceDetectedEmail(RECIPIENT, { ip: "1.1.1.1", userAgent: "UA", time: "t" }, "fa"),
    () => service.sendFirstTradeEmail(RECIPIENT, { symbol: "XAUUSD", direction: "buy" }, "fa"),
    () => service.sendAchievementUnlockedEmail(RECIPIENT, { achievementTitle: "achievements.firstTrade.title", achievementDescription: "achievements.firstTrade.description" }, "fa"),
  ];
  for (const call of gated) {
    const res = await call();
    assert.deepEqual(res, { outcome: "skipped", reason: "preference-off" });
  }
  assert.equal(mail.outbox.length, 0);
  assert.equal(log.entries.length, 0); // skipped ≠ attempted: nothing logged

  // Ungated essentials still go out with every preference off.
  const essentials = [
    () => service.sendVerificationEmail(RECIPIENT, "https://v.ir/v", "fa"),
    () => service.sendPasswordResetTokenEmail(RECIPIENT, "https://v.ir/r", "fa"),
    () => service.sendPasswordChangedEmail(RECIPIENT, "fa"),
    () => service.sendAdminInviteEmail(RECIPIENT, "https://v.ir/i", "fa"),
  ];
  for (const call of essentials) {
    const res = await call();
    assert.equal(res.outcome, "sent");
  }
  assert.equal(mail.outbox.length, essentials.length);
});

test("notification: preferences default to ALLOW and fail open", async () => {
  const { service, mail } = makeService({
    preferences: async () => {
      throw new Error("store down");
    },
  });
  const res = await service.sendWelcomeEmail(RECIPIENT, "https://v.ir/d", "fa");
  assert.equal(res.outcome, "sent"); // absent/failed preference read must not drop mail
  assert.equal(mail.outbox.length, 1);
});

test("notification: transport failure is logged failed, never thrown", async () => {
  const { log, service } = makeService();
  // A mail port that always fails — reason surfaced through the log.
  serviceWithFailingMail(service);
  const res = await service.sendPasswordChangedEmail(RECIPIENT, "en");
  assert.deepEqual(res, { outcome: "failed", reason: "rejected" });
  assert.equal(log.entries[0]!.status, "failed");
  assert.equal(log.entries[0]!.errorMessage, "rejected");
  assert.equal(log.entries[0]!.eventType, "PASSWORD_CHANGED");
});

function serviceWithFailingMail(service: NotificationService): void {
  // reach in through the same seam the constructor uses
  (service as unknown as { mail: { send: () => Promise<{ ok: false; reason: "rejected" }> } }).mail = {
    send: async () => ({ ok: false, reason: "rejected" }),
  };
}

test("notification: missing icon asset fails the send and logs (sendWithIcon parity)", async () => {
  const { mail, log, service } = makeService({ iconsDir: join(import.meta.dirname, "no-such-dir") });
  const res = await service.sendWelcomeEmail(RECIPIENT, "https://v.ir/d", "fa");
  assert.deepEqual(res, { outcome: "failed", reason: "icon-missing" });
  assert.equal(mail.outbox.length, 0);
  assert.equal(log.entries[0]!.status, "failed");
  assert.equal(log.entries[0]!.errorMessage, "Email icon asset is missing");
});

test("notification: support emails address the desk / the user, log under their types", async () => {
  const { mail, log, service } = makeService({ supportDeskEmail: "desk@example.test" });
  const res1 = await service.sendSupportNewTicketEmail(
    RECIPIENT,
    { ticketId: 7, subject: "مشکل ورود", userLabel: "Trader One", preview: "پیش‌نمایش" },
    null, // unknown reporter locale → desk locale en (Legacy rule)
  );
  assert.equal(res1.outcome, "sent");
  const desk = mail.lastTo("desk@example.test");
  assert.ok(desk !== null);
  assert.ok(desk.html?.includes("#7"));
  assert.equal(log.entries[0]!.eventType, "SUPPORT_NEW_TICKET");

  const res2 = await service.sendSupportReplyEmail(
    RECIPIENT,
    { ticketId: 7, subject: "مشکل ورود", preview: "پاسخ پشتیبانی" },
    "fa",
  );
  assert.equal(res2.outcome, "sent");
  const user = mail.lastTo(RECIPIENT.email);
  assert.ok(user !== null);
  assert.ok(user.html?.includes("cid:velora-security")); // legacy support icon
  assert.equal(log.entries[1]!.eventType, "SUPPORT_FIRST_REPLY");
});

test("notification: EN locale renders ltr + resolved copy end-to-end", async () => {
  const { mail, service } = makeService();
  await service.sendFirstTradeEmail(
    { ...RECIPIENT, locale: "en" },
    { symbol: "EURUSD", direction: "sell" },
    "en",
  );
  const sent = mail.lastTo(RECIPIENT.email);
  assert.ok(sent?.html?.includes('dir="ltr"'));
  assert.ok(!sent?.html?.includes('dir="rtl"'));
});
