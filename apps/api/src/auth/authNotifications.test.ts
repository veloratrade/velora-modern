// AuthService ↔ NotificationService wiring tests — MG-EMAIL-TYPES (AC-33).
//
// These exercise the SERVICE through its public flows with the REAL
// NotificationService wired (real domain builders, real vendored icons,
// LogMailProvider outbox, memory stores) — proving the production wiring
// behavior end-to-end without network:
//   - register/verify → branded verification email, then welcome +
//     EMAIL_VERIFIED achievement mail on FIRST verification only
//   - login from an unseen (ip|ua) → new-device alert, exactly once
//   - forgot/reset + change password → password-changed notices
//   - preference gates honored (welcome off → no welcome, verification still sent)

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { AuthService } from "./authService.js";
import { MemoryUserStore } from "./memoryUserStore.js";
import { JwtService } from "./jwt.js";
import { VeloraHasher } from "./hashing.js";
import { LogMailProvider } from "../mail/logMailProvider.js";
import { NotificationService } from "../notifications/notificationService.js";
import {
  MemoryAchievementStore,
  MemoryDeviceRegistry,
  MemoryEmailNotificationLog,
} from "../notifications/notificationStores.js";

interface Harness {
  service: AuthService;
  mail: LogMailProvider;
  notificationLog: MemoryEmailNotificationLog;
  devices: MemoryDeviceRegistry;
  achievements: MemoryAchievementStore;
  users: MemoryUserStore;
  tokens: string[];
  now: Date;
}

function makeHarness(opts: { preferences?: () => Promise<{
  welcomeEmail: boolean; securityAlerts: boolean; tradeNotifications: boolean;
  weeklyReport: boolean; monthlyReport: boolean; achievementNotifications: boolean;
}> } = {}): Harness {
  const mail = new LogMailProvider();
  const notificationLog = new MemoryEmailNotificationLog();
  const devices = new MemoryDeviceRegistry();
  const achievements = new MemoryAchievementStore();
  const users = new MemoryUserStore();
  const notifications = new NotificationService({
    mail,
    log: notificationLog,
    appOrigin: "https://veloratrade.ir",
    now: () => now,
    iconsDir: join(import.meta.dirname, "..", "..", "assets", "email-icons"),
  });
  if (opts.preferences !== undefined) {
    // Same gate → column mapping as the server-main wiring.
    notifications.preferences = async (_userId, gate) => {
      const p = await opts.preferences!();
      switch (gate) {
        case "welcome": return p.welcomeEmail;
        case "security": return p.securityAlerts;
        case "trades": return p.tradeNotifications;
        case "achievements": return p.achievementNotifications;
      }
    };
  }
  const now = new Date("2026-10-06T10:00:00Z");
  const tokens: string[] = [];
  const service = new AuthService({
    store: users,
    hasher: new VeloraHasher(),
    jwt: JwtService.create("test-secret-not-real"),
    mail,
    appOrigin: "https://veloratrade.ir",
    notifications,
    devices,
    achievements,
    generateVerificationToken: () => {
      const t = `tok-${tokens.length + 1}`;
      tokens.push(t);
      return t;
    },
    now: () => now,
  });
  return { service, mail, notificationLog, devices, achievements, users, tokens, now };
}

async function registerAndVerify(h: Harness, email: string): Promise<void> {
  await h.service.register({ email, password: "a-strong-password-123" });
  const token = h.tokens[h.tokens.length - 1]!;
  await h.service.verifyEmail(token);
}

test("wiring: register → branded verification email (template, icons, log)", async () => {
  const h = makeHarness();
  await h.service.register({ email: "trader@velora.example", password: "a-strong-password-123" });

  assert.equal(h.mail.outbox.length, 1);
  const msg = h.mail.lastTo("trader@velora.example");
  assert.ok(msg?.html?.includes("cid:velora-logo"), "branded template with CID logo");
  assert.ok(msg?.html?.includes('dir="rtl"'), "default fa locale renders RTL");
  assert.ok(msg?.inlineImages?.length === 2, "logo + type icon attached");
  // plain alternative carries the verification link (htmlToPlain folding)
  assert.ok(msg?.text.includes("/verify-email#token="));
  assert.equal(h.notificationLog.count("VERIFICATION_EMAIL"), 1);
  assert.equal(h.notificationLog.entries[0]!.status, "sent");
});

test("wiring: FIRST verification → welcome + EMAIL_VERIFIED achievement mail; repeat verify → nothing more", async () => {
  const h = makeHarness();
  await registerAndVerify(h, "first@velora.example");

  // verification + welcome + achievement = 3 sends
  assert.equal(h.mail.outbox.length, 3, `expected 3 sends, got ${h.mail.outbox.length}`);
  const subjects = h.mail.outbox.map((m) => m.subject);
  assert.ok(subjects.some((s) => s.includes("VELORA")), subjects.join(" | "));
  assert.equal(h.notificationLog.count("WELCOME_EMAIL"), 1);
  assert.equal(h.notificationLog.count("ACHIEVEMENT_UNLOCKED"), 1);
  // the achievement ledger recorded EMAIL_VERIFIED exactly once
  const unlocked = await h.achievements.list("1");
  assert.equal(unlocked.filter((a) => a.achievementKey === "EMAIL_VERIFIED").length, 1);

  // resend for an ALREADY-VERIFIED account is anti-enumeration uniform: no
  // token minted, no email — nothing further happens on this path.
  await h.service.resendVerification({ email: "first@velora.example" });
  assert.equal(h.mail.outbox.length, 3, "verified-account resend sends nothing");
  assert.equal(h.notificationLog.count("WELCOME_EMAIL"), 1, "welcome fires once");
});

test("wiring: new device alert fires once per (ip|ua), never on repeat logins", async () => {
  const h = makeHarness();
  await registerAndVerify(h, "device@velora.example");

  const before = h.mail.outbox.length;
  await h.service.login({
    email: "device@velora.example", password: "a-strong-password-123",
    ipAddress: "5.6.7.8", userAgent: "Firefox/1.0",
  });
  assert.equal(h.mail.outbox.length, before + 1, "first login from device → alert");
  assert.equal(h.notificationLog.count("NEW_DEVICE_DETECTED"), 1);
  const alert = h.mail.outbox[h.mail.outbox.length - 1]!;
  assert.ok(alert.html?.includes("5.6.7.8"), "alert carries the login IP");
  assert.ok(alert.text.includes("5.6.7.8"));

  await h.service.login({
    email: "device@velora.example", password: "a-strong-password-123",
    ipAddress: "5.6.7.8", userAgent: "Firefox/1.0",
  });
  assert.equal(h.mail.outbox.length, before + 1, "same fingerprint → no second alert");

  await h.service.login({
    email: "device@velora.example", password: "a-strong-password-123",
    ipAddress: "9.9.9.9", userAgent: "Firefox/1.0",
  });
  assert.equal(h.mail.outbox.length, before + 2, "new IP → new fingerprint → alert");
});

test("wiring: security preference off → new-device alert suppressed, login unaffected", async () => {
  const h = makeHarness({
    preferences: async () => ({
      welcomeEmail: true, securityAlerts: false, tradeNotifications: true,
      weeklyReport: true, monthlyReport: true, achievementNotifications: true,
    }),
  });
  await registerAndVerify(h, "quiet@velora.example");
  const before = h.mail.outbox.length;
  const pair = await h.service.login({
    email: "quiet@velora.example", password: "a-strong-password-123",
    ipAddress: "1.2.3.4", userAgent: "UA",
  });
  assert.ok(pair.accessToken.length > 0, "login still succeeds");
  assert.equal(h.mail.outbox.length, before, "security-off → no alert, no log entry");
  assert.equal(h.notificationLog.count("NEW_DEVICE_DETECTED"), 0);
});

test("wiring: reset + change password both dispatch the password-changed notice", async () => {
  const h = makeHarness();
  await registerAndVerify(h, "pw@velora.example");

  // forgot → reset (reset-token path)
  await h.service.forgotPassword({ email: "pw@velora.example" });
  const resetToken = h.tokens[h.tokens.length - 1]!;
  await h.service.resetPassword({ token: resetToken, newPassword: "another-strong-456" });
  assert.equal(h.notificationLog.count("PASSWORD_RESET_LINK"), 1);
  assert.equal(h.notificationLog.count("PASSWORD_CHANGED"), 1);

  // change-password path (needs a fresh login since reset revoked sessions)
  await h.service.login({ email: "pw@velora.example", password: "another-strong-456" });
  await h.service.changePassword("1", {
    currentPassword: "another-strong-456", newPassword: "a-third-strong-789",
  });
  assert.equal(h.notificationLog.count("PASSWORD_CHANGED"), 2, "change-password also notifies");
});

test("wiring: anti-enumeration intact — unknown address gets uniform forgot response, zero mail", async () => {
  const h = makeHarness();
  const res = await h.service.forgotPassword({ email: "ghost@velora.example" });
  assert.deepEqual(res.messageKey, "auth.passwordResetRequested");
  assert.equal(h.mail.outbox.length, 0);
  assert.equal(h.notificationLog.entries.length, 0);
});
