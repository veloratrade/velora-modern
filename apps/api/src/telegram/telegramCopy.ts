// Bot copy — Persian-first with English parity (ADR-009 locale contract).
//
// WHY NOT A TRANSLATION LAYER OR A TEMPLATE ENGINE
//   Every string the bot can send is here, in both locales, as a pure function of
//   its inputs. There is no runtime lookup that can fail, and a reviewer reads
//   the exact text a user will see. The product's primary locale is Persian, so
//   `fa` is the default for a user whose Velora profile has not been consulted
//   (an unlinked visitor has no profile yet) and the profile locale governs once
//   the account is known.
//
// ESCAPING IS PART OF THE CONTRACT. Messages are sent with `parse_mode: "HTML"`,
// so every value that came from a user (a note, a transcript, a broker symbol)
// passes through `esc()` before it is interpolated. A note containing `<` must
// render as text, and a note containing a tag must not become markup.
import { TELEGRAM_MAX_MESSAGE_CHARS } from "@velora/contracts";
import type { JournalDraftView } from "../journal/journalApplicationService.js";

export type Locale = "fa" | "en";

const FA = {
  menuTitle: "🏛 <b>ولورا — ژورنال معاملاتی</b>",
  menuBody: "دستیار ژورنال ولورا. یکی از گزینه‌ها را انتخاب کنید:",
  btnNewJournal: "📝 ژورنال جدید",
  btnLastTrade: "📊 آخرین معامله",
  btnHistory: "📚 تاریخچه ژورنال",
  btnAnalyze: "🧠 تحلیل",
  btnSettings: "⚙️ تنظیمات",
  btnConfirm: "✅ تأیید",
  btnEdit: "✏️ ویرایش",
  btnCancel: "✖️ لغو",
  btnConnect: "🔐 اتصال امن به Velora",
  btnChannelTest: "📤 ارسال آزمایشی به کانال",

  // ── Onboarding (the security explanation; deliberate wording) ──────────────
  onboardingTitle: "🔐 <b>اتصال حساب ولورا</b>",
  onboardingBody: [
    "این حساب تلگرام به هیچ حساب ولورایی متصل نیست.",
    "برای دسترسی به ژورنال معاملاتی، ابتدا باید حساب ولورای خود را متصل کنید. این کار برای محافظت از داده‌های معاملاتی شما انجام می‌شود: بدون اتصال، هیچ راه امنی برای تشخیص اینکه ژورنال به کدام کاربر تعلق دارد وجود ندارد.",
    "<b>مراحل اتصال:</b>",
    "۱. روی دکمهٔ زیر بزنید تا وارد وب‌سایت رسمی ولورا شوید.",
    "۲. اگر وارد نشده‌اید، با ایمیل و رمز عبور خود وارد شوید.",
    "۳. در صفحهٔ اتصال، روی «اتصال تلگرام» بزنید تا یک لینک یک‌بار‌مصرف ساخته شود.",
    "۴. با همان لینک به تلگرام بازگردید؛ اتصال به‌صورت خودکار انجام می‌شود.",
    "<b>نکات امنیتی:</b>",
    "• رمز عبور خود را هرگز در تلگرام (و نه برای این ربات) ارسال نکنید.",
    "• ولورا هیچ‌وقت رمز عبور، کد تأیید یا توکن نشست شما را در تلگرام درخواست نمی‌کند.",
    "• لینک اتصال کوتاه‌مدت و یک‌بار‌مصرف است و پس از استفاده باطل می‌شود.",
  ].join("\n"),
  onboardingUnavailable:
    "🔐 <b>اتصال حساب ولورا</b>\n\nاین حساب تلگرام به هیچ حساب ولورایی متصل نیست. در حال حاضر امکان ساخت لینک اتصال روی این نصب فراهم نیست؛ لطفاً از طریق وب‌سایت ولورا وارد شوید و از بخش تنظیمات، تلگرام را متصل کنید.",

  linkedWelcome: "✅ اتصال حساب شما برقرار است. خوش آمدید 👋",
  linkSuccess: "✅ <b>اتصال با موفقیت انجام شد.</b>\nحساب تلگرام شما به حساب ولورای شما متصل شد.",
  linkAlready: "✅ اتصال شما از قبل برقرار است.",
  linkFailUnknown: "❌ این لینک معتبر نیست. لطفاً از تنظیمات وب‌سایت ولورا یک لینک جدید بسازید.",
  linkFailExpired: "⌛️ این لینک منقضی شده است. لطفاً از تنظیمات وب‌سایت ولورا یک لینک جدید بسازید.",
  linkFailUsed: "❌ این لینک قبلاً استفاده شده است. برای اتصال مجدد یک لینک جدید بسازید.",
  linkFailRevoked: "❌ این لینک باطل شده است. لطفاً یک لینک جدید بسازید.",
  linkFailIdentityTaken: "❌ این حساب تلگرام از قبل به یک حساب ولورای دیگر متصل است. ابتدا آن اتصال را از طرف مقابل قطع کنید.",
  linkFailAccountTaken: "❌ حساب ولورای شما از قبل به یک حساب تلگرام دیگر متصل است. ابتدا اتصال فعلی را قطع کنید.",
  linkFailPartner: "❌ انجام اتصال ممکن نشد. لطفاً دوباره تلاش کنید یا از طریق وب‌سایت ولورا اقدام کنید.",

  // ── Journal ───────────────────────────────────────────────────────────────
  journalPrompt: "📝 معامله را با زبان خودتان بنویسید یا پیام صوتی بفرستید. مثال:\n«امروز XAUUSD خرید گرفتم، ورود ۲۶۵۰، استاپ ۲۶۴۴ و تارگت ۲۶۶۵»",
  journalNoData:
    "🤔 از این پیام چیزی برای ثبت پیدا نکردم.\nنماد، جهت، ورود، خروج و حجم را ذکر کنید. مثال:\n«XAUUSD خرید، ورود ۲۶۵۰، خروج ۲۶۶۰، حجم ۰٫۵»",
  confirmTitle: "📋 <b>پیش‌نویس ژورنال</b>",
  confirmAsk: "ثبت شود؟",
  confirmSaved: (id: string) => `✅ ژورنال ثبت شد (شناسه: <code>${id}</code>).\nهمین معامله در وب‌سایت ولورا هم قابل مشاهده است.`,
  confirmAlready: "ℹ️ این ژورنال قبلاً ثبت شده است.",
  confirmInProgress: "⏳ این ژورنال در حال ثبت است. لطفاً چند لحظه صبر کنید.",
  confirmedRejected: (field: string) => `⚠️ مقدار «${field}» پذیرفته نشد. لطفاً مقدار درست را بفرستید.`,
  confirmSaveFailed: "⚠️ ثبت انجام نشد. لطفاً دوباره تلاش کنید.",
  cancelDone: "✖️ پیش‌نویس لغو شد.",
  cancelNothing: "پیش‌نویسی برای لغو وجود ندارد.",
  editHelp: (fields: string) => `✏️ فیلدهای باقی‌مانده: ${fields}\nمقدار مورد نظر را به‌صورت یک پیام بفرستید.`,
  draftExpired: "⌛️ پیش‌نویس منقضی شد. لطفاً معامله را دوباره بفرستید.",

  missingLabel: "کامل نیست",
  fieldSymbol: "نماد",
  fieldDirection: "جهت",
  fieldEntry: "ورود",
  fieldExit: "خروج",
  fieldVolume: "حجم",
  promptFor: {
    symbol: "نماد معامله را بفرستید (مثلاً XAUUSD).",
    direction: "جهت معامله را بفرستید: خرید یا فروش.",
    entryPrice: "قیمت ورود را بفرستید.",
    exitPrice: "قیمت خروج را بفرستید.",
    volume: "حجم معامله را بفرستید (مثلاً 0.5).",
  } as Record<string, string>,

  labelSymbol: "نماد",
  labelDirection: "جهت",
  labelEntry: "ورود",
  labelExit: "خروج",
  labelStop: "حد ضرر",
  labelTarget: "حد سود",
  labelVolume: "حجم",
  labelPnl: "سود/زیان",
  labelR: "R",
  labelStrategy: "استراتژی",
  labelEmotion: "احساس",
  labelTime: "زمان",
  labelNotes: "یادداشت",
  labelSource: "منبع",
  labelTranscript: "متن پیام صوتی",
  dirBuy: "خرید",
  dirSell: "فروش",
  unknown: "نامشخص",

  lastTitle: "📊 <b>آخرین معامله</b>",
  lastEmpty: "📊 هنوز معامله‌ای ثبت نشده است.",
  historyTitle: "📚 <b>تاریخچه ژورنال</b>",
  historyEmpty: "📚 ژورنالی ثبت نشده است.",
  historyFooter: (page: number, totalPages: number, total: number) => `صفحهٔ ${page} از ${totalPages} — مجموع ${total} مورد`,
  btnMore: "بیشتر",

  // ── Voice / image ─────────────────────────────────────────────────────────
  voiceWorking: "🎧 در حال تبدیل پیام صوتی به متن...",
  voiceEmpty: "🎧 در پیام صوتی متنی پیدا نشد. لطفاً واضح‌تر بفرستید.",
  voiceUnavailable: "🎧 تبدیل پیام صوتی روی این نصب فعال نیست. لطفاً معامله را متنی بفرستید.",
  voiceTooLarge: "🎧 حجم فایل صوتی بیش از حد مجاز است.",
  voiceTranscriptLabel: "متن پیام صوتی",
  photoStored: "🖼 تصویر ذخیره شد.",
  photoUnreadable: "🖼 متن یا مقادیری از تصویر خوانده نشد. مقادیر را به‌صورت پیام متنی بفرستید تا ثبت شود.",
  photoTooLarge: "🖼 حجم تصویر بیش از حد مجاز (۵ مگابایت) است.",
  photoNoFields: "🖼 از تصویر مقدار جدیدی استخراج نشد؛ از مقادیر متنی خودتان استفاده می‌شود.",
  photoSignOnly: "🖼 تصویر ذخیره می‌شود اما مبالغ از آن خوانده نمی‌شود.",

  // ── AI analysis ───────────────────────────────────────────────────────────
  analyzeWorking: "🧠 در حال تحلیل...",
  analyzeDisabled: "🧠 تحلیل هوش‌مصنوعی روی این نصب فعال نیست (کلید ارائه‌دهنده تنظیم نشده است).",
  analyzeConsent: "🔒 برای تحلیل، ابتدا باید رضایت پردازش هوش‌مصنوعی را در وب‌سایت ولورا (بخش تنظیمات) ثبت کنید.",
  analyzeEmpty: "🧠 داده‌ای برای تحلیل وجود ندارد.",
  analyzeTitle: "🧠 <b>تحلیل ژورنال</b>",
  analyzeFailed: "⚠️ تحلیل با خطا مواجه شد. لطفاً بعداً تلاش کنید.",
  analyzeDisclaimer: "ℹ️ این تحلیل با هوش مصنوعی تولید شده و توصیهٔ سرمایه‌گذاری نیست؛ سوابق معاملاتی شما را تغییر نمی‌دهد.",

  // ── Settings / channel / unlink ───────────────────────────────────────────
  settingsTitle: "⚙️ <b>تنظیمات</b>",
  settingsBody: (username: string) => `اتصال ولورا: ✅ متصل${username}\n\nبرای قطع اتصال از دکمهٔ زیر استفاده کنید.`,
  settingsNoChannel: "کانال ژورنال: تعیین نشده",
  settingsChannel: (title: string) => `کانال ژورنال: ${title}`,
  channelHint:
    "برای تعیین کانال: ربات را به کانال خود اضافه کنید و به‌عنوان ادمین با اجازهٔ ارسال پیام تنظیم کنید، سپس دستور /channel را با آی‌دی کانال بفرستید. مثال:\n<code>/channel -1001234567890</code>",
  channelVerified: (title: string) => `✅ کانال «${title}» تأیید و فعال شد.`,
  channelNoRights: "❌ ربات در این کانال اجازهٔ ارسال پیام ندارد. ربات را ادمین کنید و اجازهٔ ارسال را فعال کنید.",
  channelNotFound: "❌ کانال پیدا نشد یا ربات عضو آن نیست.",
  channelBadId: "❌ آی‌دی کانال نامعتبر است. آی‌دی عددی منفی کانال را بفرستید.",
  channelPrivate: "❌ کانال ژورنال باید یک کانال یا سوپرگروه باشد. چت خصوصی پشتیبانی نمی‌شود؛ ربات را به کانال خود اضافه کنید و آی‌دی کانال را بفرستید.",
  channelCleared: "✅ کانال ژورنال قطع شد.",
  channelTestOk: "📤 پیام آزمایشی ارسال شد.",
  channelTestFailed: "⚠️ ارسال آزمایشی ناموفق بود.",
  channelPublishFailed: "ℹ️ ژورنال ثبت شد، اما ارسال به کانال انجام نشد.",
  channelNone: "ℹ️ کانالی تنظیم نشده است.",

  unlinkConfirm: "⚠️ با قطع اتصال، دسترسی این حساب تلگرام به ژورنال ولورا پایان می‌یابد.\nآیا مطمئن هستید؟",
  btnUnlinkYes: "بله، قطع کن",
  btnUnlinkNo: "انصراف",
  unlinkDone: "✅ اتصال حساب تلگرام قطع شد. داده‌های ژورنال شما در ولورا محفوظ است.",
  unlinkNothing: "ℹ️ اتصالی برای قطع کردن وجود ندارد.",

  helpTitle: "❓ <b>راهنما</b>",
  helpBody: [
    "/start — منوی اصلی",
    "/journal — ثبت ژورنال جدید (متن یا پیام صوتی)",
    "/last — آخرین معامله",
    "/history — تاریخچهٔ ژورنال",
    "/analyze — تحلیل ژورنال",
    "/settings — وضعیت اتصال و کانال",
    "/link — اتصال حساب ولورا",
    "/unlink — قطع اتصال",
    "/channel — تعیین کانال ژورنال",
  ].join("\n"),

  rateLimited: "⏳ تعداد درخواست‌های شما زیاد است. لطفاً کمی بعد تلاش کنید.",
  notLinkedAction: "🔐 برای این بخش باید حساب ولورا متصل باشد.",
  genericError: "⚠️ خطایی رخ داد. لطفاً دوباره تلاش کنید.",
  voiceNote: "🎙 پیام صوتی",
  screenshotNote: "🖼 تصویر چارت",
  alreadyAnswered: "ℹ️ پیش‌نویس جدیدی نیست؛ برای شروع دستور /journal را بفرستید.",
};

const EN: typeof FA = {
  menuTitle: "🏛 <b>Velora — Trading Journal</b>",
  menuBody: "Velora journal assistant. Choose an option:",
  btnNewJournal: "📝 New Journal",
  btnLastTrade: "📊 Last Trade",
  btnHistory: "📚 Journal History",
  btnAnalyze: "🧠 Analyze",
  btnSettings: "⚙️ Settings",
  btnConfirm: "✅ Confirm",
  btnEdit: "✏️ Edit",
  btnCancel: "✖️ Cancel",
  btnConnect: "🔐 Connect to Velora securely",
  btnChannelTest: "📤 Send test to channel",

  onboardingTitle: "🔐 <b>Connect your Velora account</b>",
  onboardingBody: [
    "This Telegram account is not connected to a Velora account.",
    "To use the trading journal, connect your Velora account first. This protects your trading data: without a connection there is no secure way to know which journal belongs to which user.",
    "<b>Steps:</b>",
    "1. Tap the button below to open the official Velora website.",
    "2. Sign in if you are not already signed in.",
    "3. On the connection page press “Connect Telegram” to create a single-use link.",
    "4. Return to Telegram with that link — the connection completes automatically.",
    "<b>Security notes:</b>",
    "• Never send your password to Telegram or to this bot.",
    "• Velora never asks for your password, a verification code or a session token in Telegram.",
    "• The linking link is short-lived, single-use, and invalidated once used.",
  ].join("\n"),
  onboardingUnavailable:
    "🔐 <b>Connect your Velora account</b>\n\nThis Telegram account is not connected to a Velora account. Creating a linking link is not available on this installation right now; please sign in on the Velora website and connect Telegram from Settings.",

  linkedWelcome: "✅ Your account is connected. Welcome 👋",
  linkSuccess: "✅ <b>Connection completed.</b>\nYour Telegram account is now linked to your Velora account.",
  linkAlready: "✅ Your account is already connected.",
  linkFailUnknown: "❌ This link is not valid. Please create a new one from Velora Settings.",
  linkFailExpired: "⌛️ This link has expired. Please create a new one from Velora Settings.",
  linkFailUsed: "❌ This link was already used. Create a new one to reconnect.",
  linkFailRevoked: "❌ This link was revoked. Please create a new one.",
  linkFailIdentityTaken: "❌ This Telegram account is already linked to a different Velora account. Unlink it there first.",
  linkFailAccountTaken: "❌ Your Velora account is already linked to a different Telegram account. Disconnect the current one first.",
  linkFailPartner: "❌ The connection could not be completed. Please try again or use the Velora website.",

  journalPrompt: "📝 Describe your trade in your own words, or send a voice message. Example:\n“XAUUSD buy, entry 2650, stop 2644, target 2665”",
  journalNoData:
    "🤔 I could not find anything to record in that message.\nInclude symbol, direction, entry, exit and volume. Example:\n“XAUUSD buy, entry 2650, exit 2660, volume 0.5”",
  confirmTitle: "📋 <b>Journal draft</b>",
  confirmAsk: "Save this entry?",
  confirmSaved: (id: string) => `✅ Journal saved (id: <code>${id}</code>).\nThe same entry is visible in the Velora web application.`,
  confirmAlready: "ℹ️ This entry was already saved.",
  confirmInProgress: "⏳ This entry is being saved. Please wait a moment.",
  confirmedRejected: (field: string) => `⚠️ The value for “${field}” was rejected. Please send a valid value.`,
  confirmSaveFailed: "⚠️ The entry could not be saved. Please try again.",
  cancelDone: "✖️ Draft discarded.",
  cancelNothing: "There is no draft to discard.",
  editHelp: (fields: string) => `✏️ Still missing: ${fields}\nSend the value as a single message.`,
  draftExpired: "⌛️ The draft expired. Please send the trade again.",

  missingLabel: "incomplete",
  fieldSymbol: "symbol",
  fieldDirection: "direction",
  fieldEntry: "entry",
  fieldExit: "exit",
  fieldVolume: "volume",
  promptFor: {
    symbol: "Send the symbol (for example XAUUSD).",
    direction: "Send the direction: buy or sell.",
    entryPrice: "Send the entry price.",
    exitPrice: "Send the exit price.",
    volume: "Send the trade volume (for example 0.5).",
  } as Record<string, string>,

  labelSymbol: "Symbol",
  labelDirection: "Direction",
  labelEntry: "Entry",
  labelExit: "Exit",
  labelStop: "Stop loss",
  labelTarget: "Take profit",
  labelVolume: "Volume",
  labelPnl: "P/L",
  labelR: "R",
  labelStrategy: "Strategy",
  labelEmotion: "Emotion",
  labelTime: "Time",
  labelNotes: "Notes",
  labelSource: "Source",
  labelTranscript: "Voice transcript",
  dirBuy: "Buy",
  dirSell: "Sell",
  unknown: "unknown",

  lastTitle: "📊 <b>Last trade</b>",
  lastEmpty: "📊 No trades recorded yet.",
  historyTitle: "📚 <b>Journal history</b>",
  historyEmpty: "📚 No journal entries yet.",
  historyFooter: (page: number, totalPages: number, total: number) => `Page ${page} of ${totalPages} — ${total} entries`,
  btnMore: "More",

  voiceWorking: "🎧 Transcribing your voice message...",
  voiceEmpty: "🎧 No text was found in the voice message. Please send it more clearly.",
  voiceUnavailable: "🎧 Voice transcription is not enabled on this installation. Please send the trade as text.",
  voiceTooLarge: "🎧 The voice file exceeds the allowed size.",
  voiceTranscriptLabel: "Voice transcript",
  photoStored: "🖼 The image was stored.",
  photoUnreadable: "🖼 No values could be read from the image. Send them as text so the entry can be recorded.",
  photoTooLarge: "🖼 The image exceeds the 5 MB limit.",
  photoNoFields: "🖼 No new values were extracted from the image; your typed values are used.",
  photoSignOnly: "🖼 The image will be stored, but no amounts are read from it.",

  analyzeWorking: "🧠 Analyzing...",
  analyzeDisabled: "🧠 AI analysis is not enabled on this installation (no provider credential configured).",
  analyzeConsent: "🔒 Analysis requires AI-processing consent, which you can grant in Velora Settings.",
  analyzeEmpty: "🧠 There is no data to analyze yet.",
  analyzeTitle: "🧠 <b>Journal analysis</b>",
  analyzeDisclaimer: "ℹ️ Generated by AI from your own journal. It is not investment advice and it never modifies your trading records.",
  analyzeFailed: "⚠️ The analysis failed. Please try again later.",

  settingsTitle: "⚙️ <b>Settings</b>",
  settingsBody: (username: string) => `Velora connection: ✅ connected${username}\n\nUse the button below to disconnect.`,
  settingsNoChannel: "Journal channel: not set",
  settingsChannel: (title: string) => `Journal channel: ${title}`,
  channelHint:
    "To set a channel: add the bot to your channel as an administrator with permission to post, then send /channel with the channel id. Example:\n<code>/channel -1001234567890</code>",
  channelVerified: (title: string) => `✅ Channel “${title}” verified and active.`,
  channelNoRights: "❌ The bot is not allowed to post in this channel. Make it an administrator with posting permission.",
  channelNotFound: "❌ The channel was not found, or the bot is not a member.",
  channelBadId: "❌ Invalid channel id. Send the numeric (negative) channel id.",
  channelPrivate: "❌ The journal channel must be a channel or a supergroup. A private chat is not supported; add the bot to your channel and send its id.",
  channelCleared: "✅ Journal channel disconnected.",
  channelTestOk: "📤 Test message sent.",
  channelTestFailed: "⚠️ The test message failed.",
  channelPublishFailed: "ℹ️ The entry was saved, but publishing to the channel failed.",
  channelNone: "ℹ️ No channel is configured.",

  unlinkConfirm: "⚠️ Disconnecting ends this Telegram account's access to your Velora journal.\nAre you sure?",
  btnUnlinkYes: "Yes, disconnect",
  btnUnlinkNo: "Cancel",
  unlinkDone: "✅ The Telegram connection was removed. Your journal data stays in Velora.",
  unlinkNothing: "ℹ️ There is no connection to remove.",

  helpTitle: "❓ <b>Help</b>",
  helpBody: [
    "/start — main menu",
    "/journal — record a new entry (text or voice)",
    "/last — last trade",
    "/history — journal history",
    "/analyze — analyze the journal",
    "/settings — connection and channel",
    "/link — connect a Velora account",
    "/unlink — disconnect",
    "/channel — set the journal channel",
  ].join("\n"),

  rateLimited: "⏳ Too many requests. Please try again shortly.",
  notLinkedAction: "🔐 This requires a connected Velora account.",
  genericError: "⚠️ Something went wrong. Please try again.",
  voiceNote: "🎙 Voice message",
  screenshotNote: "🖼 Chart image",
  alreadyAnswered: "ℹ️ No draft is open; send /journal to start.",
};

export const COPY: Readonly<Record<Locale, typeof FA>> = { fa: FA, en: EN };

export function copyFor(locale: Locale | null | undefined): typeof FA {
  return locale === "en" ? EN : FA;
}

/** HTML-escape a user-supplied value before it enters a `parse_mode: "HTML"` message. */
export function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Telegram rejects a message over 4096 characters; truncate rather than fail. */
export function clamp(text: string): string {
  return text.length <= TELEGRAM_MAX_MESSAGE_CHARS ? text : `${text.slice(0, TELEGRAM_MAX_MESSAGE_CHARS - 4)}…`;
}

/** The confirmation card: exactly what will be written, nothing invented. */
export function renderDraft(copy: typeof FA, view: JournalDraftView, locale: Locale): string {
  const f = view.fields;
  const rows: string[] = [];
  const kv = (label: string, value: string | null): void => {
    rows.push(`${label}: <b>${value === null || value === "" ? copy.unknown : esc(value)}</b>`);
  };
  kv(copy.labelSymbol, f.symbol);
  kv(copy.labelDirection, f.direction === "buy" ? copy.dirBuy : f.direction === "sell" ? copy.dirSell : null);
  kv(copy.labelEntry, f.entryPrice);
  kv(copy.labelExit, f.exitPrice);
  kv(copy.labelStop, f.stopLoss);
  kv(copy.labelTarget, f.takeProfit);
  kv(copy.labelVolume, f.volume);
  if (f.strategyTag !== null) kv(copy.labelStrategy, f.strategyTag);
  if (f.emotionalScore !== null) kv(copy.labelEmotion, f.emotionalScore);
  kv(copy.labelTime, f.openTime);
  if (view.transcript !== null) rows.push(`${copy.labelTranscript}: <i>${esc(view.transcript)}</i>`);
  if (f.notes !== null) rows.push(`${copy.labelNotes}: <i>${esc(f.notes)}</i>`);

  const missing =
    view.missingFields.length === 0
      ? ""
      : `\n⚠️ ${copy.missingLabel}: ${esc(view.missingFields.map((m) => labelForField(copy, m, locale)).join(", "))}`;
  return clamp(`${copy.confirmTitle}\n\n${rows.join("\n")}${missing}\n\n${copy.confirmAsk}`);
}

/** Locale-correct label for a required field name (used in prompts and lists). */
export function labelForField(copy: typeof FA, field: string, _locale: Locale): string {
  switch (field) {
    case "symbol":
      return copy.fieldSymbol;
    case "direction":
      return copy.fieldDirection;
    case "entryPrice":
      return copy.fieldEntry;
    case "exitPrice":
      return copy.fieldExit;
    case "volume":
      return copy.fieldVolume;
    default:
      return field;
  }
}

/** Render one journal entry as a compact, readable block. */
export function renderTrade(copy: typeof FA, trade: Record<string, unknown>): string {
  const value = (key: string): string | null => {
    const raw = trade[key];
    if (raw === null || raw === undefined || raw === "") return null;
    return String(raw);
  };
  const direction = value("direction");
  const rows = [
    `${copy.labelSymbol}: <b>${esc(value("symbol") ?? copy.unknown)}</b> (${direction === "buy" ? copy.dirBuy : direction === "sell" ? copy.dirSell : copy.unknown})`,
    `${copy.labelEntry}: <b>${esc(value("entryPrice") ?? copy.unknown)}</b> → ${copy.labelExit}: <b>${esc(value("exitPrice") ?? copy.unknown)}</b>`,
    `${copy.labelVolume}: <b>${esc(value("volume") ?? copy.unknown)}</b>`,
  ];
  const stop = value("stopLoss");
  const target = value("takeProfit");
  if (stop !== null || target !== null) {
    rows.push(`${copy.labelStop}: ${esc(stop ?? copy.unknown)} — ${copy.labelTarget}: ${esc(target ?? copy.unknown)}`);
  }
  const pnl = value("profitLoss");
  if (pnl !== null) {
    const r = value("rMultiple");
    rows.push(`${copy.labelPnl}: <b>${esc(pnl)}</b>${r === null ? "" : ` (${copy.labelR}: ${esc(r)})`}`);
  }
  const notes = value("notes");
  if (notes !== null) rows.push(`${copy.labelNotes}: <i>${esc(notes.length > 400 ? `${notes.slice(0, 400)}…` : notes)}</i>`);
  rows.push(`${copy.labelTime}: ${esc((value("openTime") ?? "").slice(0, 16).replace("T", " "))}`);
  return rows.join("\n");
}
