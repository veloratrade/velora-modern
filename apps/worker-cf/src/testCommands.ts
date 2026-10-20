/**
 * The command layer of PRIVATE TEST MODE.
 *
 * Why this file exists at all
 * ---------------------------
 * `handleTestUpdate` used to answer every message with one generic acknowledgement, so `/start`
 * — the first thing a human types, and the only command the product treats as an entry point —
 * was recorded and answered like any other text. That was the visible half of the owner's report
 * that «/start did not work». The other half was delivery (no webhook registered), which no code
 * can fix. This file fixes what code can fix, and fixes it here rather than inside the handler
 * because the planner is then a pure function: the Persian copy, the command grammar and the
 * capability statement are all checkable without a database, a Bot API stub or a Worker runtime.
 *
 * What the product does, and what this may not imitate
 * ----------------------------------------------------
 * The real `/start` lives in `apps/api/src/telegram/telegramBot.ts`:
 *
 *   `/start`            → `sendOnboarding` (unlinked) or `sendMenu` (linked)
 *   `/start <payload>`  → `completeLink`, the one-time deep-link handshake
 *
 * Both need the PostgreSQL stores (`telegram_identities`, journal drafts, audit trail). Under D1
 * those objects are never constructed — `composeRuntime` returns `pipeline: null` and `journal:
 * null` for `storage === "d1-test"`, which is the enforcement, not a convention. So this planner
 * deliberately answers `/start <payload>` with a refusal instead of a handshake: a payload that
 * arrives over an unauthenticated ingress is untrusted input, and minting, matching or consuming
 * a link token is not something the private-test surface may pretend to do. Same rule as
 * `callback_query.data` in `handleTestUpdate`: the shape of the delivery is recorded, its payload
 * grants nothing.
 *
 * Copy is Persian-first because that is the product's primary locale (`telegramCopy.ts`), and it
 * states the disabled capabilities in the same message, so a test can never be mistaken for the
 * journal. No reply here echoes the sender's text back: an excerpt is stored, not reflected.
 */

import type { StoreCounts } from "./d1TestStore.js";

/** `parse_mode: "HTML"` is set by `HttpTelegramBotApi.sendMessage` for every send, so any value
 * interpolated into a reply must be escaped or it changes the message's markup instead of its text.
 * Fixed copy is authored HTML-safe; numbers and names pass through here. */
export const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const COMMAND_SUFFIX = "(?:@[A-Za-z0-9_]{3,32})?";
const START_RE = new RegExp(`^/start${COMMAND_SUFFIX}(?:\\s+(\\S+))?$`);
const HELP_RE = new RegExp(`^/help${COMMAND_SUFFIX}$`);
const STATS_RE = new RegExp(`^/stats${COMMAND_SUFFIX}$`);

export type TestCommand = "start" | "start_payload" | "help" | "stats" | "record" | "callback";

export interface CommandPlan {
  readonly command: TestCommand;
  /** `/stats` is the one reply whose text depends on a query, so the caller must read the store. */
  readonly needsCounts: boolean;
  /** Does this command reach the store at all? Everything here does — the claim happens first. */
  readonly readOnly: boolean;
}

/**
 * Grammar only, no I/O. `text` is the trimmed message text (or caption); `kind` is the update
 * shape the gate already attested. A callback query never becomes a command, whatever its `data`
 * says, because that data is the one field in a Telegram update that an attacker fully controls.
 */
export function planCommand(input: {
  readonly kind: "message" | "callback_query" | "edited_message";
  readonly text: string | null;
}): CommandPlan {
  if (input.kind === "callback_query") return { command: "callback", needsCounts: false, readOnly: true };
  const text = (input.text ?? "").trim();
  if (text === "") return { command: "record", needsCounts: false, readOnly: false };
  if (START_RE.test(text)) {
    const payload = START_RE.exec(text)?.[1];
    return payload === undefined || payload === ""
      ? { command: "start", needsCounts: false, readOnly: false }
      : { command: "start_payload", needsCounts: false, readOnly: false };
  }
  if (HELP_RE.test(text)) return { command: "help", needsCounts: false, readOnly: true };
  if (STATS_RE.test(text)) return { command: "stats", needsCounts: true, readOnly: true };
  // Any other leading slash is a command this build does not serve: say so, and never fall through
  // to the journal's "unknown text means chat" behaviour, which would silently do nothing.
  if (text.startsWith("/")) return { command: "record", needsCounts: false, readOnly: false };
  return { command: "record", needsCounts: false, readOnly: false };
}

const countLine = (counts: StoreCounts): string =>
  `ردیف=${counts.rows} · handled=${counts.handled} · failed=${counts.failed}` +
  ` · claimed=${counts.claimed} · retry=${counts.retries}`;

export interface ReplyContext {
  readonly plan: CommandPlan;
  readonly counts: StoreCounts;
  readonly updateId: number;
  readonly kind: "message" | "callback_query" | "edited_message";
  readonly storage: "d1-test";
}

const DISABLED = "ژورنال، ثبت معامله، اتصال حساب و تحلیل به دیتابیس اصلی PostgreSQL نیاز دارند و در این نسخه ساخته نشده‌اند.";

/**
 * The reply for one planned command. Every string is fixed except the interpolated numbers, all of
 * which are escaped anyway so a future edit cannot turn a number into markup.
 */
export function replyFor(ctx: ReplyContext): string {
  const id = escapeHtml(String(ctx.updateId));
  switch (ctx.plan.command) {
    case "start":
      return [
        "🏛 ولورا — حالت تست خصوصی",
        "",
        "ربات در دسترس است و پیام‌های این گفت‌وگو را در حافظهٔ آزمایشی D1 ثبت می‌کند.",
        "",
        "همین‌جا کار می‌کند:",
        "• ثبت هر پیام با update_id یکتا — ارسال دوبارهٔ همان update رکورد تکراری نمی‌سازد",
        "• /stats — شمارش واقعی، خوانده‌شده از همان دیتابیس",
        "• /help — فهرست دستورات همین نسخه",
        "• غربالگری بر پایهٔ شناسهٔ فرستنده، پیش از هر دسترسی به دیتابیس",
        "• پیام صوتی و تصویر: در این build غیرفعال (نه provider، نه سرویس پیوست) — فقط متن ثبت می‌شود",
        "",
        DISABLED,
        "",
        `حافظهٔ فعال: ${escapeHtml(ctx.storage)} · update ${id}`,
      ].join("\n");
    case "start_payload":
      return [
        "🔐 اتصال حساب در این نسخه انجام نمی‌شود.",
        "",
        "دستور /start با payload همان دست‌دادنِ یک‌بارهٔ اتصال حساب است و به خدمات PostgreSQL نیاز دارد.",
        "این build آن خدمات را نمی‌سازد، و هیچ متنی یا داده‌ای از درون پیام، دسترسی‌ای نمی‌خرد.",
        "",
        DISABLED,
      ].join("\n");
    case "help":
      return [
        "❓ راهنمای حالت تست خصوصی",
        "",
        "/start — معرفی همین نسخه و آنچه کار می‌کند",
        "/help — همین پیام",
        "/stats — شمارش رکوردها از دیتابیس مقصد",
        "صوت/تصویر — غیرفعال در این نسخه (وابستگی: ترادکشن و بینایی در خدمات اصلی، این‌جا UnconfiguredMediaInterpreter)",
        "هر پیام متنی دیگر — ثبت و بازیابی، با پاسخ تأیید",
        "",
        "این نسخه جایگزین ژورنال ولورا نیست؛ یک جدول آزمایشی مستقل است.",
        DISABLED,
      ].join("\n");
    case "stats":
      return [
        "📊 شمارش واقعی، خوانده‌شده از دیتابیس مقصد",
        "",
        `حافظه: ${escapeHtml(ctx.storage)}`,
        countLine(ctx.counts),
      ].join("\n");
    case "callback":
      return "✓ رویداد دکمه دریافت و ثبت شد. دادهٔ callback در این نسخه پردازش نمی‌شود و دسترسی‌ای نمی‌دهد.";
    case "record":
      return [
        `✓ ثبت شد (حالت تست خصوصی D1) · update ${id} · kind ${escapeHtml(ctx.kind)}.`,
        DISABLED,
      ].join("\n");
  }
}
