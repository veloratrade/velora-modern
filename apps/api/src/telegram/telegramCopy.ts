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
import type { ChecklistCoverage, ChecklistItem, DailyChecklist, JournalStats } from "@velora/domain";

export type Locale = "fa" | "en";

/**
 * What this runtime can actually do, as far as the copy is concerned. `media` is true only when a
 * real `MediaInterpreter` is wired. On the Cloudflare Worker `apps/worker-cf/src/runtime.ts` installs
 * `UnconfiguredMediaInterpreter`, whose every call throws `MediaInterpreterNotConfiguredError`, so
 * advertising "or send a voice message" there is a promise the build cannot keep. Text journaling is
 * unaffected either way. A `GEMINI_API_KEY` on the Worker does NOT imply this: no AI manager, relay or
 * tesseract is constructed there, so the interpreter stays unconfigured regardless of the environment.
 */
export interface TelegramCopyOptions {
  readonly media: boolean;
  /**
   * Whether channel-post publishing is wired in THIS deployment. Optional because most call sites ask
   * for copy that does not care; `/help` and the menu are the two places that must not advertise a
   * capability the runtime does not have, so they pass it explicitly.
   */
  readonly posts?: boolean;
  /**
   * Which agent tools THIS runtime can honour, read from the services rather than from a wish list.
   * `undefined` means "nothing was checked", which renders the conservative answer: the free-text line
   * says the two external tools are unavailable. Understating a capability costs a user one question they
   * could have asked; overstating one costs them trust in everything else the help text says.
   */
  readonly tools?: {
    readonly search: boolean;
    readonly capture: boolean;
    /**
     * Whether a MODEL may extend a request into further steps. `/help` may only promise multi-step
     * planning where a planner is actually wired, because a deployment without one answers the same
     * sentence in exactly one step — and an advertised ceiling the runtime cannot reach is the kind of
     * line this file exists to prevent.
     */
    readonly planner?: boolean | undefined;
    /** The step ceiling, quoted from `MAX_AGENT_TOOL_STEPS` by the caller rather than restated here. */
    readonly maxSteps?: number | undefined;
  };
}

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
  journalPrompt: (o: TelegramCopyOptions) =>
    `📝 معامله را با زبان خودتان بنویسید${o.media ? " یا پیام صوتی/تصویری بفرستید" : ""}. مثال:\n«امروز XAUUSD خرید گرفتم، ورود ۲۶۵۰، استاپ ۲۶۴۴ و تارگت ۲۶۶۵»`,
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
  helpBody: (o: TelegramCopyOptions) =>
    [
    "/start — منوی اصلی",
    `/journal — ثبت ژورنال جدید (متن${o.media ? " یا پیام صوتی/تصویری" : ""})`,
    "/last — آخرین معامله",
    "/history — تاریخچهٔ ژورنال",
    "/analyze — تحلیل ژورنال",
    "/stats — آمار ساخته‌شده از رکوردهای ذخیره‌شده",
    "/stats <today|yesterday|week|YYYY-MM-DD|jalali> — همان آمار برای یک بازه؛ تاریخ شمسی هم پذیرفته می‌شود",
    "/checklist coverage — پوشش چک‌لیست در بازه (پیش‌فرض ۷ روز، تا ۶۰)",
    "/checklist — چک‌لیست روزانه؛ با متن ثبت می‌شود و با گزارش بعدی ادغام می‌شود",
    "/checklist <YYYY-MM-DD> — خواندن آن روز؛ با متن، نوشتن در همان روز",
    "/checklist recent — پوشش چند روز اخیر",
    "/trade <id> — جزئیات یک معامله و دکمهٔ حذف",
    "/edit <id> <strategy|emotion|notes> <مقدار> — اصلاح برچسب/احساس/یادداشت",
    "/settings — وضعیت اتصال و کانال",
    "/link — اتصال حساب ولورا",
    "/unlink — قطع اتصال",
    "/channel — تعیین کانال ژورنال",
    // این بلوک فقط وقتی تبلیغ می‌شود که سرویس پست در این استقرار سیم‌کشی شده باشد؛ هر خط کاری را
    // انجام می‌دهد. جست‌وجوی وب و گرفتن اسکرین‌شات چارت به‌جای سکوت، صریحاً «غیرقابل‌دسترس» اعلام
    // می‌شوند تا کاربر با یک پاسخ ناقص روبه‌رو نشود.
    ...(o.posts === true
      ? [
          "/post — پیش‌نویس پست کانال از داده‌های واقعی؛ انتشار فقط با تأیید شما",
          "/post <قالب> <تاریخ> — مثال: /post velora.bias ۱۴۰۵-۰۷-۲۷",
          "/template — فهرست قالب‌ها · /template save <نام> <متن> · /template delete <نام>",
          "/channel list — کانال‌های ثبت‌شده و کانال فعال",
          "/channel use <شناسه> — انتخاب کانال فعال از کانال‌های تأییدشده",
          `نوشتن آزاد هم کار می‌کند: «آمار این هفته» یا «کارت بایاس دیروز را آماده کن».${
            o.tools?.search === true ? " جست‌وجوی وب در دسترس است: «آخرین خبر X را پیدا کن»." : ""
          }${o.tools?.capture === true ? " گرفتن تصویر چارت از میزبان‌های مورد تأیید ولورا در دسترس است." : ""}${
            o.tools?.search === true && o.tools?.capture === true
              ? ""
              : ` ${[o.tools?.search === true ? null : "جست‌وجوی وب", o.tools?.capture === true ? null : "تصویر چارت"].filter((x) => x !== null).join(" و ")} در این runtime در دسترس ${o.tools?.search === true || o.tools?.capture === true ? "نیست" : "نیستند"}.`
          }${
            o.tools?.planner === true
              ? ` هر جمله که جدول بشناسد یک‌بار و رایگان اجرا می‌شود؛ جمله‌ای که جدول نشناسد تا ${String(o.tools?.maxSteps ?? 0)} مرحلهٔ محدود برنامه‌ریزی می‌شود و نتیجه‌های میانی به مرحلهٔ بعد داده می‌شود. هر اثر جانبی همچنان دکمهٔ تأیید خود شما را می‌خواهد.`
              : ""
          }`,
        ]
      : []),
    ].join("\n"),

  rateLimited: "⏳ تعداد درخواست‌های شما زیاد است. لطفاً کمی بعد تلاش کنید.",
  notLinkedAction: "🔐 برای این بخش باید حساب ولورا متصل باشد.",
  genericError: "⚠️ خطایی رخ داد. لطفاً دوباره تلاش کنید.",
  voiceNote: "🎙 پیام صوتی",
  screenshotNote: "🖼 تصویر چارت",
  alreadyAnswered: "ℹ️ پیش‌نویس جدیدی نیست؛ برای شروع دستور /journal را بفرستید.",

  // ── journal maintenance surfaces (0036 round) ──
  // Every string here is a real capability: each key below is reached by a command or a button that
  // performs the work, so none of these lines promises an action the bot does not have.
  btnStats: "📊 آمار",
  btnChecklist: "✅ چک‌لیست روزانه",
  btnPost: "📤 پست کانال",
  statsTitle: "📊 آمار ژورنال",
  statsEmpty: "هنوز معاملهٔ تأییدشده‌ای ثبت نشده که بتوانم از آن آمار بسازم.",
  statsSampled: (n: number) => `⚠️ فقط ${n} معاملهٔ اخیر دیدم، نه همهٔ تاریخچه را؛ اعداد می‌توانند کم‌شده باشند.`,
  statsFromData: "این اعداد از رکوردهای خودت حساب شده‌اند.",
  statsClosedLabel: "بسته",
  statsOpenLabel: "باز",
  // A window is the user's OWN calendar day, resolved by the journal service through the profile
  // timezone — so these labels name a period without ever implying the server's clock.
  statsWindowToday: "امروز",
  statsWindowYesterday: "دیروز",
  statsWindowWeek: "۷ روز اخیر",
  statsWindowLabel: "بازه",
  statsEmptyWindow: (label: string) => `📭 در بازهٔ «${label}» رکورد تأییدشده‌ای نیست. برای همهٔ تاریخچه /stats را بدون پارامتر بفرستید.`,
  statsBadWindow: (arg: string) => `⚠️ «${arg}» را به‌عنوان بازه نمی‌شناسم. گزینه‌ها: today · yesterday · week · ۱۴۰۵-۰۷-۲۷ · YYYY-MM-DD · all`,
  // ── HONESTY ABOUT WHAT WAS AND WAS NOT READ (added by the correctness patch) ───────────────
  // A sample is not a population and a bounded fetch is not a full one. Where a figure cannot be
  // computed from what this build actually holds, the card prints `—` (the marker this file already
  // uses for "not available") and says WHY, instead of printing a confident number over 200 rows or
  // over a clamped fetch. No new category is introduced anywhere in these lines.
  statsSampledWinRate: "نسبت برد از نمونهٔ ۲۰۰تایی حساب می‌شد و نسبتی از کل نیست؛ برای عدد درست، گزارش کامل را بگیرید.",
  statsSampledProfitFactor: "ضریب سود از نمونهٔ ۲۰۰تایی به دست نمی‌آید؛ این دو مبلغ را می‌توانید از جمع نمونه بخوانید، نسبت را نه.",
  statsSampledExtremes: "بهترین/بدترین از همین نمونه است؛ ممکن است معاملهٔ بهتری بیرون از ۲۰۰ ردیف اخیر باشد.",
  coverageTruncated: (n: number) => `⚠️ بازه کامل خوانده نشد: ${String(n)} روز بررسی شدنی نبود. روزهای جدول معتبرند، ولی «بدون رکورد» برای آن ${String(n)} روز حکم نیست.`,
  coverageRecords: "رکورد خوانده‌شده / روزهای بازه (سقف فروشگاه)",
  statsWindowGarbage: (arg: string) => `⚠️ «${arg}» در هیچ دو تقویمی یک روز واقعی نیست. جلالی: j:1405-07-27 · میلادی: g:2026-10-19`,
  statsWindowAmbiguous: (arg: string) => `⚠️ «${arg}» را نمی‌توانم از روی عدد تقویم بفهمم. تقویم را بنویسید: j: یا g:. تاریخ را حدس نمی‌زنم.`,
  checklistWindowAmbiguous: (arg: string) => `⚠️ «${arg}» ممکن است جلالی یا میلادی باشد. j: یا g: را اولش بگذارید؛ روز را حدس نمی‌زنم.`,
  checklistWindowGarbage: (arg: string) => `⚠️ «${arg}» یک روز واقعی نیست (ماه ۱ تا ۱۲ و روز موجود در همان ماه، با در نظر گرفتن سال کبیسه).`,
  journalDateUnclear: (arg: string) => `⚠️ تاریخ «${arg}» را قطعی نخواندم؛ برای اینکه معامله روی روز اشتباه ثبت نشود، تقویم را مشخص کن: j:1405-07-27 یا g:2026-10-19.`,
  // Coverage of the DAILY CHECKLIST — an aggregate of RECORDED states, nothing more. "unreviewed"
  // means the row does not mention that item; it is not a broken rule. This build has no
  // mistake/violation model (audited: none exists in the schema or domain), and the copy says so.
  coverageTitle: "🗓 پوشش چک‌لیست",
  coveragePeriod: (days: number, range: string) => `بازه: ${String(days)} روز · ${range}`,
  coverageDaysReviewed: "روزهای دارای رکورد",
  coverageComplete: "کامل (۱۱ از ۱۱ تأییدشده)",
  coveragePartial: "ناتمام",
  coverageNoRecord: "بدون رکورد",
  coverageUnreviewedLabel: "بیشترین بررسی‌نشده",
  coverageUnknownLabel: "«نمی‌دانم» ثبت‌شده",
  coverageEmpty: "در این بازه هیچ چک‌لیستی ثبت نشده. این «بررسی‌نشده» است، نه نقض قاعده‌ای.",
  coverageDaysBad: (arg: string) => `⚠️ «${arg}» عدد روز نیست. مثال: /checklist coverage 14 (۱ تا ۶۰)`,
  checklistTitle: "✅ چک‌لیست معامله",
  checklistIntro: "📝 آیتم‌هایی که بررسی کردی را بنویسید؛ هرچه ننویسید «بررسی‌نشده» می‌ماند.",
  checklistExampleLabel: "نمونه — کپی کن و پر کن",
  checklistSavedNew: "✅ چک‌لیست این روز برای اول‌بار ساخته شد.",
  checklistSavedMerge: "✅ چک‌لیست به‌روزرسانی شد؛ آیتم‌های نام‌برده‌شده دست‌نخورده ماندند.",
  checklistUnparsed: "⚠️ این کلیدها را نشناختم و ذخیره نکردم:",
  checklistUnknownHint: "برای «ندارم» بنویسید none و برای «بررسی‌نشده» بنویسید ?.",
  checklistNone: "—",
  tradeDetailTitle: "🧾 معامله",
  tradeEditHelp: (id: string) => `فیلدهای ژورنالینگ را این‌طور اصلاح کنید:\n/edit ${id} strategy <متن>\n/edit ${id} emotion <1 تا 5>\n/edit ${id} notes <متن>`,
  tradeEditDone: "✏️ اصلاح شد.",
  tradeDeleteAsk: "🗑 این معامله حذف (tombstone) شود؟ رکورد در ledger می‌ماند و در لیست‌ها دیده نمی‌شود.",
  btnTradeDelete: "🗑 حذف معامله",
  btnTradeEdit: "✏️ اصلاح یادداشت",
  btnTradeDeleteYes: "بله، حذف کن",
  btnTradeDeleteNo: "نه",
  tradeDeleteDone: "🗑 معامله حذف شد (tombstone).",
  tradeNotFound: "این معامله را پیدا نکردم یا متعلق به شما نیست.",
  tradeStale: "⚠️ این معامله از وقتی دیدی تغییر کرده؛ دوباره /last یا /history را بزن.",
  fieldsImmutable: "قیمت‌ها و اندازهٔ معامله قابل ویرایش نیست (ADR-002). باید معامله را حذف و دوباره ثبت کنید.",
  editUsage: "استفاده: /edit <شناسه> <strategy|emotion|notes> <مقدار>",
  checklistBadDate: "📅 تاریخ باید YYYY-MM-DD و یک روز واقعی باشد.",
  checklistRecentTitle: "🗓 روزهای اخیر",
  checklistEmptyDay: "برای این روز چیزی ثبت نشده؛ هر یازده آیتم بررسی‌نشده است.",
  emotionPrompt: "🙂 هنگام این معامله چه حسی داشتی؟ (۱ آرام تا ۵ بسیار مضطرب)",
  btnTradeEmotion: "🙂 ثبت احساس",
  // ── قالب و پست آماده (0037/0038) ──
  postNoService: "🚫 ساخت پست آماده در این استقرار فعال نیست.",
  postUsage: "استفاده: /post [قالب] — مثال: /post velora.bias",
  postPreviewTitle: "📋 پیش‌نویس پست برای کانال",
  postNoChannel: "کانال فعالی نداری. با /channel کانالت را ببند و تأیید کن.",
  postChannelNotOurs: "این کانال را نمی‌شناسم یا متعلق به شما نیست.",
  postGaps: (n: number) => `⚠️ ${n} فیلد ثبت‌نشده دارد؛ همان‌طور که هست نمایش داده می‌شود.`,
  postTruncated: "✂️ متن طولانی بود و بریده شد.",
  postUnknownFields: (names: readonly string[]) => `قالب این فیلدها را نمی‌شناسد و آن‌ها را حذف نمی‌کنم: ${names.join("، ")}`,
  postUnsupportedExpr: "محاسبه در قالب مجاز نیست؛ عبارت را عیناً نگه داشتم.",
  postMarkupDropped: "⚠️ برای رعایت محدودیت طول، قالب‌بندی حذف شد.",
  btnPublish: "✅ انتشار در کانال",
  btnDismiss: "لغو",
  postPublished: (messageId: string) => `✅ منتشر شد (پیام ${messageId}).`,
  postAlreadyPublished: "این پست قبلاً منتشر شده؛ دوباره ارسال نمی‌کنم.",
  postInFlight: "⏳ این پست در حال ارسال است؛ برای جلوگیری از انتشار تکراری صبر کنید.",
  postNotApproved: "متن پس از پیش‌نمایش تغییر کرده — باید دوباره تأیید شود.",
  postBlocked: (reason: string) => `⛔ انتشار مسدود است: ${reason}`,
  postFailed: (code: string, retryAfter: number | null) =>
    retryAfter === null ? `❌ ارسال نشد (${code}).` : `❌ ارسال نشد (${code}). حدود ${retryAfter} ثانیه بعد دوباره تلاش کنید.`,
  postNeedsApproval: "برای انتشار، دکمهٔ «انتشار در کانال» را بزن — این یعنی همین متن به همین کانال.",
  postDismissed: "لغو شد؛ چیزی ارسال نشد.",
  postReused: "این همان پیش‌نویس قبلی است (تازیده نشد).",
  postBannerPreview: (shown: number, dropped: number) =>
    `بنر آماده شد: ${shown} ردیف${dropped > 0 ? `، ${dropped} ردیف جا افتاد` : ""}. تصویر در این پیام نیست؛ هنگام انتشار ضمیمه می‌شود.`,
  postNoBanner: "بنری ساخته نشد؛ فقط متن ارسال می‌شود.",
  postBannerImage: "پیش‌نمایش بنر",
  postBannerNotRendered: "بنر متنی است: این محیط تصویرساز ندارد، پس پیش‌نمایش/ارسال تصویر ساخته نشد.",
  searchHeader: (count: number, provider: string, latency: string) =>
    `جست‌وجوی وب — ${count} نتیجه از ${provider} (${latency}). این‌ها منبع‌های بیرونی‌اند؛ ولورا آن‌ها را راستی‌آزمایی نکرده است.`,
  searchNoDate: "تاریخ: نامشخص",
  searchNoResults: "جست‌وجوی وب نتیجه‌ای نداشت.",
  searchFooter: "متن نتیجه‌ها عیناً از سرویس جست‌وجو است، نه تحلیل ولورا و نه توصیهٔ معاملاتی.",
  chartCaptured: (source: string) => `تصویر چارت گرفته شد — ${source}`,
  chartObserved: (observed: string, missing: string) => `خوانده‌شده از تصویر: ${observed}. ${missing}`,
  chartMissing: (fields: string) => `خوانده‌نشده: ${fields}.`,
  chartNothingMissing: "فیلد دیگری در تصویر نبود.",
  chartNothingReadable: "از تصویر چیزی به‌طور قطعی خوانده نشد؛ هیچ مقداری حدس زده نمی‌شود.",
  chartNotStored: "هیچ چیزی در ژورنال ثبت نشد: خواندنِ تصویر، تأییدِ کاربر نیست.",
  templateUsage: "دستورها: /template (لیست) · /template save <نام> <متن> · /template delete <نام>",
  templateListTitle: "🧩 قالب‌های شما",
  templateEmpty: "قالب شخصی نداری؛ قالب‌های آماده: velora.bias، velora.setup، velora.weekly",
  templateSaved: (name: string, version: number) => `✅ قالب «${name}» نسخهٔ ${version} ذخیره شد.`,
  templateConflict: "⚠️ این قالب هم‌زمان ویرایش شده؛ فهرست را دوباره ببینید تا نسخهٔ فعلی را ببینید.",
  templateExists: "این نام قبلاً ذخیره شده. برای ویرایش، اول /template را ببینید و شمارهٔ نسخه را بدهید.",
  templateDeleted: (name: string) => `🗑 قالب «${name}» بایگانی شد (نسخه‌ها می‌مانند).`,
  templateNotFound: "چنین قالبی نداری.",
  templateEmptyBody: "متن قالب خالی است.",
  templateTooLong: (limit: number) => `قالب از ${limit} کاراکتر بلندتر است؛ ذخیره نشد.`,
  templateUnknown: (names: readonly string[]) => `این‌ها را نمی‌شناسم (در متن می‌مانند): ${names.join("، ")}`,
  templateExpr: "«{{ }}» فقط اسم فیلد است؛ فرمول و کد پشتیبانی نمی‌شود.",
  channelListTitle: "📡 کانال‌های ثبت‌شده",
  channelUseUsage: "استفاده: /channel use <شناسهٔ کانال> — شناسه را از /channel بگیرید.",
  channelActivated: (chatId: string) => `✅ کانال ${chatId} فعال شد؛ کانال قبلی در حالت انتظار است.`,
  channelStandbyNow: "کانال فعال قبلی به حالت انتظار رفت (تأییدشده باقی می‌ماند).",
  channelNotVerified: "این کانال تأییدشده نیست یا اجازهٔ ارسال ندارد؛ اول /channel آن را تأیید کنید.",
  channelStatusActive: "فعال",
  channelStatusStandby: "در انتظار",
  agentBlocked: (reason: string) => `این در دسترس نیست: ${reason}. وابستگی لازم در این runtime نصب/پیکربندی نشده است.`,
  agentAmbiguous: (question: string) => `برای ادامه: ${question}`,
  agentDid: (tool: string) => `انجام شد: ${tool}`,
  // سه جمله‌ای که حلقهٔ چندمرحله‌ای لازم دارد. «کامل نشد» دلیل نگه‌داشتن را می‌گوید و تعداد مراحلی که
  // واقعاً اجرا شده — نتیجه‌های بالاتر در این حالت ناقص‌اند و گفتنِ ناقص‌بودن وظیفهٔ ماست، نه کاربر.
  agentStopped: (reason: string, steps: number) =>
    steps > 0
      ? `این درخواست کامل نشد (${reason}). ${String(steps)} مرحله اجرا شد و نتیجه‌هایشان بالا هست.`
      : `این درخواست اجرا نشد (${reason}).`,
  agentNeedsApproval: (tool: string) =>
    `«${tool}» را خودکار انجام نمی‌دهم: به دکمهٔ تأیید شما نیاز دارد. اول پیش‌نویس را ببینید، سپس تأیید کنید.`,
  agentUnverifiedTarget: (arg: string) =>
    `مرحلهٔ بعد نشانی/شناسه‌ای خواست («${arg}») که در این گفت‌وگو و در نتیجه‌های ابزارها دیده نشده بود، پس اجرا نشد. مقصد را خودتان بنویسید.`,
  mediaUnavailable: "در این runtime پردازش رسانهٔ زنده فعال نیست؛ متن به‌عنوان یادداشت ثبت می‌شود.",
  // ── navigable menu (round 7) ──
  // Every label here is wired to a handler in `telegramBot.ts`; `telegramMenus.test.ts` asserts that
  // every button the menu renders parses back into a known action, so a decorative button cannot ship.
  navTitle: "🏛 <b>ولورا</b>",
  navHome: "منوی اصلی — یک بخش را انتخاب کنید:",
  btnHome: "🏠 منوی اصلی",
  btnBack: "◀️ بازگشت",
  btnCancelFlow: "✖️ لغو",
  navJournalTitle: "📝 <b>ژورنال</b>",
  navJournalBody: "ثبت معامله، دیدن آخرین معامله، تاریخچه و آمار — همه از همین‌جا.",
  navPostsTitle: "📤 <b>پست و انتشار</b>",
  navPostsBody: "پیش‌نهاده پست از داده‌های واقعی ژورنال ساخته می‌شود؛ هیچ عددی حدس زده نمی‌شود و انتشار فقط با تأیید خودتان انجام می‌شود.",
  navPostsUnavailable:
    "این استقرار سرویس پست را ندارد، پس ساخت و انتشار پست در آن ممکن نیست. بقیهٔ بخش‌ها کار می‌کنند.",
  btnPostNew: "🆕 پست تازه",
  btnPostTplList: "📄 انتخاب قالب",
  btnPostPreview: "👁 پیش‌نمایش پست",
  btnPostResult: "📬 نتیجهٔ انتشار",
  navTplTitle: "🗂 <b>قالب‌ها</b>",
  navTplBody: "قالب‌های شما. متن هر قالب با متغیرهایی مثل {symbol} پر می‌شود.",
  tplEmpty: "هنوز قالبی نساخته‌اید. با «قالب تازه» یکی بسازید؛ متن از داده‌های همان روز پر می‌شود.",
  btnTplNew: "🆕 قالب تازه",
  btnTplEdit: "✏️ ویرایش",
  btnTplDelete: "🗑 حذف",
  btnTplDefault: "⭐ پیش‌فرض",
  btnTplPreview: "👁 پیش‌نمایش",
  tplDefaultMark: "⭐",
  tplAskName: "نام قالب را بفرستید (۱ تا ۶۴ نویسه، مثل morning-card). برای لغو: /cancel",
  tplAskBody:
    "متن قالب را بفرستید. متغیرها: {symbol} {direction} {entryPrice} {exitPrice} {winRate} {closedCount} {netPnl} {averageR} {checked} {date}. برای لغو: /cancel",
  tplNameInvalid: "این نام پذیرفته نشد: نام باید ۱ تا ۶۴ نویسه باشد و فقط برای همان نام فارسی/لاتین مجاز است. دوباره بفرستید یا /cancel.",
  tplNameTaken: "قالبی با این نام دارید. نام دیگری بفرستید یا همان را با «ویرایش» عوض کنید.",
  tplSaved: (name: string, version: number) => `✅ قالب «${esc(name)}» ذخیره شد (نسخه ${String(version)}).`,
  tplUpdated: (name: string, version: number) => `✅ نسخهٔ ${String(version)} قالب «${esc(name)}» ساخته شد؛ نسخه‌های قبلی برای مراجعه می‌مانند.`,
  tplDeleteAsk: (name: string) =>
    `🗑 قالب «${esc(name)}» بازنشسته شود؟ پست‌هایی که از آن ساخته شده‌اند دست‌نخورده می‌مانند.`,
  tplDeleted: (name: string) => `✅ قالب «${esc(name)}» بازنشسته شد.`,
  tplDefaultSet: (name: string) => `⭐ از این پس «${esc(name)}» قالب پیش‌فرض /post است.`,
  tplDefaultCleared: "⭐ قالب پیش‌فرض برداشته شد؛ /post بدون نام، قالب را از شما می‌پرسد.",
  btnTplClearDefault: "✖️ برداشتن پیش‌فرض",
  tplNotFound: "این قالب پیدا نشد؛ شاید بازنشسته شده باشد. فهرست را از «قالب‌ها» ببینید.",
  tplCanceled: "✖️ لغو شد؛ چیزی ذخیره نشد.",
  tplFlowExpired: "⏳ این مرحله منقضی شد و چیزی ذخیره نشد. از «قالب‌ها → قالب تازه» دوباره شروع کنید.",
  tplBodyTooLong: (max: number) => `متن بلندتر از ${String(max)} نویسه است؛ پذیرفته نشد. کوتاه‌تر بفرستید.`,
  tplBodyEmpty: "متن خالی است؛ چیزی ذخیره نشد.",
  tplPreviewTitle: (name: string) => `👁 پیش‌نمایش قالب «${esc(name)}»`,
  tplPreviewMissing: (vars: readonly string[]) =>
    `⚠️ این متغیرها در داده‌های شما مقدار نداشتند و صریحاً «ثبت نشده» نمایش داده می‌شوند: ${vars.join("، ")}`,
  navBannerTitle: "🖼 <b>بنر و ظاهر</b>",
  navBannerBody: (o: { readonly enabled: boolean; readonly title: string | null; readonly canRaster: boolean }) =>
    [
      `استایل موجود: کارت طلایی تیره (تنها استایلی که این نسخه می‌شناسد).`,
      `وضعیت بنر: ${o.enabled ? "روشن — همراه پست ساخته می‌شود" : "خاموش — فقط کارت متنی"}`,
      `عنوان سفارشی: ${o.title === null ? "تنظیم نشده (عنوان قالب استفاده می‌شود)" : `«${esc(o.title)}»`}`,
      o.canRaster
        ? "رندر تصویری در این runtime فعال است."
        : "⚠️ رندر تصویری (PNG) در این runtime در دسترس نیست، پس کارت <b>متنی</b> فرستاده می‌شود و همین را هم می‌گوید. هیچ تصویری جایگزین نمی‌شود.",
    ].join("\n"),
  bnUnavailable:
    "⚠️ ساخت تصویر PNG در این استقرار ممکن نیست (کتابخانهٔ رندر نیتیو روی Cloudflare Workers اجرا نمی‌شود). کارت متنی فرستاده می‌شود — تصویری ساخته نمی‌شود و ادعای آن هم نمی‌شود.",
  btnBnToggle: "روشن/خاموش",
  btnBnTitle: "✏️ عنوان بنر",
  btnBnClearTitle: "✖️ حذف عنوان",
  bnAskTitle: "عنوان بنر را بفرستید (تا ۶۰ نویسه) یا /cancel.",
  bnTitleSet: (title: string) => `✅ عنوان بنر: «${esc(title)}»`,
  bnTitleCleared: "✅ عنوان سفارشی حذف شد؛ عنوان قالب استفاده می‌شود.",
  bnTitleTooLong: "عنوان بلندتر از ۶۰ نویسه است؛ پذیرفته نشد.",
  navAiTitle: "🤖 <b>ابزارهای هوش مصنوعی</b>",
  aiOn: "فعال",
  aiOff: "غیرفعال",
  aiMissing: (keys: readonly string[]) => `کلید تنظیم‌نشده: ${keys.join("، ")}`,
  aiNoSecretNote: "مقدار کلیدها هرگز نمایش داده نمی‌شود؛ فقط این‌که تنظیم شده یا نه.",
  aiConsentNote: "همهٔ این ابزارها همان رضایت، سهمیه و دفتر تلاش مسیر اصلی را رعایت می‌کنند.",
  navSettingsTitle: "⚙️ <b>تنظیمات ربات</b>",
  navHelpTitle: "❓ <b>راهنما</b>",
  navHelpBody: "همهٔ کارهای روزمره از دکمه‌ها انجام می‌شود؛ دستورهای اسلش برای سازگاری مانده‌اند.",
  flowJournalWins:
    "ℹ️ متن شما ارزش ژورنالی داشت، پس به‌عنوان معامله ثبت می‌شود و پرسش قبلی (قالب) باز می‌ماند. برای پاسخ دادن به آن، بعد از این پیام متن را بفرستید؛ برای بستنش /cancel.",
  // ── publish result + post editing (round 7) ──
  postResultTitle: "📬 <b>نتیجهٔ انتشار</b>",
  postResultEmpty: "هنوز پستی از این حساب آماده یا منتشر نشده است. از «پست تازه» شروع کنید.",
  postStatusDraft: "پیش‌نویس (منتشر نشده)",
  postStatusApproved: "تأییدشده، در صف ارسال",
  postStatusPublishing: "در حال ارسال",
  postStatusPublished: "منتشر شد",
  postStatusFailed: "ناموفق",
  postStatusCancelled: "لغو شد",
  postResultLine: (o: { readonly when: string; readonly status: string; readonly excerpt: string; readonly messageId: string | null; readonly errorCode: string | null }) =>
    `• ${o.when} — <b>${o.status}</b>${o.messageId === null ? "" : ` (پیام ${o.messageId})`}${o.errorCode === null ? "" : ` — کد: ${o.errorCode}`}\n  <i>${esc(o.excerpt)}</i>`,
  postResultUnavailable: (reason: string) => `⚠️ انتشار در حال حاضر ممکن نیست: ${reason}`,
  btnPostEdit: "✏️ ویرایش متن",
  postEditAsk:
    "متن جدید پست را بفرستید. با این کار تأیید قبلی باطل می‌شود و باید پیش‌نمایش تازه را دوباره تأیید کنید. برای لغو /cancel.",
  postEdited: "✅ متن پست اصلاح شد؛ تأیید قبلی باطل شد. پیش‌نمایش تازه را ببینید و اگر درست است منتشر کنید.",
  postEditNotEditable: "این پست دیگر قابل ویرایش نیست (یا منتشر شده یا لغو شده).",
  postEditInvalid: "این متن پذیرفته نشد: خالی است، بیش از حد بلند است، یا متغیر ناشناخته دارد. متن دیگری بفرستید یا /cancel.",
  postEditExpiredPost: "⏳ این ویرایش منقضی شد؛ پست دست‌نخورده ماند. دوباره از پیش‌نمایش شروع کنید.",
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

  journalPrompt: (o: TelegramCopyOptions) =>
    `📝 Describe your trade in your own words${o.media ? ", or send a voice message" : ""}. Example:\n“XAUUSD buy, entry 2650, stop 2644, target 2665”`,
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
  helpBody: (o: TelegramCopyOptions) =>
    [
    "/start — main menu",
    `/journal — record a new entry (text${o.media ? " or voice/image" : ""})`,
    "/last — last trade",
    "/history — journal history",
    "/analyze — analyze the journal",
    "/stats — statistics computed from your stored records",
    "/stats <today|yesterday|week|YYYY-MM-DD|jalali> — the same numbers for one period (Jalali accepted)",
    "/checklist coverage — checklist coverage for a period (default 7 days, up to 60)",
    "/checklist — daily checklist; with text it is stored and MERGED into that day",
    "/checklist <YYYY-MM-DD> — read that day; with text, write that day",
    "/checklist recent — coverage of the last days",
    "/trade <id> — one trade with its delete action",
    "/edit <id> <strategy|emotion|notes> <value> — fix a tag, emotion or note",
    "/settings — connection and channel",
    "/link — connect a Velora account",
    "/unlink — disconnect",
    "/channel — set the journal channel",
    // Mirrors the Farsi block: lines exist only for what this deployment can do, and the two blocked
    // capabilities are named as absent rather than left for the user to discover by a non-answer.
    ...(o.posts === true
      ? [
          "/post — draft a channel post from recorded data; it is published only when you confirm",
          "/post <template> <date> — e.g. /post velora.bias 2026-10-19",
          "/template — list · /template save <name> <text> · /template delete <name>",
          "/channel list — your registered channels and which one is active",
          "/channel use <id> — pick the active channel among the verified ones",
          `Free text works too: “stats for this week” or “prepare yesterday’s bias card” are handled as commands.${
            o.tools?.search === true ? " Web research is available: “find the latest news on X”." : ""
          }${o.tools?.capture === true ? " Chart capture is available for Velora's approved chart hosts." : ""}${
            o.tools?.search === true && o.tools?.capture === true
              ? ""
              : ` ${[o.tools?.search === true ? null : "Web search", o.tools?.capture === true ? null : "chart capture"].filter((x) => x !== null).join(" and ")} ${[o.tools?.search === true ? null : "chart capture", o.tools?.capture === true ? null : "web search"].filter((x) => x !== null).length > 1 ? "are" : "is"} not available in this runtime.`
          }${
            o.tools?.planner === true
              ? ` A sentence the table recognises runs once, for free. One it does not may be planned in up to ${String(o.tools?.maxSteps ?? 0)} bounded steps, each fed by the results before it. Every side effect still needs your own approval button.`
              : ""
          }`,
        ]
      : []),
    ].join("\n"),

  rateLimited: "⏳ Too many requests. Please try again shortly.",
  notLinkedAction: "🔐 This requires a connected Velora account.",
  genericError: "⚠️ Something went wrong. Please try again.",
  voiceNote: "🎙 Voice message",
  screenshotNote: "🖼 Chart image",
  alreadyAnswered: "ℹ️ No draft is open; send /journal to start.",

  // ── journal maintenance surfaces (0036 round) — English twin of the block above ──
  btnStats: "📊 Statistics",
  btnChecklist: "✅ Daily checklist",
  btnPost: "📤 Channel post",
  statsTitle: "📊 Journal statistics",
  statsEmpty: "There are no confirmed trades yet for me to build statistics from.",
  statsSampled: (n: number) => `⚠️ I saw only the ${n} most recent trades, not the whole history; these totals can be short.`,
  statsFromData: "These numbers are computed from your own records.",
  statsClosedLabel: "closed",
  statsOpenLabel: "open",
  statsWindowToday: "today",
  statsWindowYesterday: "yesterday",
  statsWindowWeek: "last 7 days",
  statsWindowLabel: "Window",
  statsEmptyWindow: (label: string) => `📭 No confirmed records in "${label}". Send /stats with no argument for the whole history.`,
  statsBadWindow: (arg: string) => `⚠️ I don't read "${arg}" as a window. Options: today · yesterday · week · 1405-07-27 (Jalali) · YYYY-MM-DD · all`,
  coverageTruncated: (n: number) => `⚠️ This period was not read whole: ${String(n)} day(s) could not be checked. The days in the table stand; 'no record' is not a verdict for those ${String(n)}.`,
  coverageRecords: "records read / days in period (store bound)",
  statsSampledWinRate: "Win rate would need every trade; this was a 200-row sample, so it is not shown. Take a full export for the real ratio.",
  statsSampledProfitFactor: "Profit factor is not computable from a sample. Read the summed amounts, not a ratio built on them.",
  statsSampledExtremes: "Best/worst come from this sample; a better trade may sit outside the newest 200 rows.",
  statsWindowGarbage: (arg: string) => `⚠️ \"${arg}\" is not a real day in either calendar. Jalali: j:1405-07-27 · Gregorian: g:2026-10-19`,
  statsWindowAmbiguous: (arg: string) => `⚠️ I cannot tell which calendar \"${arg}\" is written in. Name it: j: or g:. I will not guess a date.`,
  checklistWindowAmbiguous: (arg: string) => `⚠️ \"${arg}\" could be Jalali or Gregorian. Put j: or g: in front of it; I will not guess the day.`,
  checklistWindowGarbage: (arg: string) => `⚠️ \"${arg}\" is not a real day (month 1-12, and a day that exists in that month, leap years included).`,
  journalDateUnclear: (arg: string) => `⚠️ I could not read the date \"${arg}\" with certainty. To keep this trade off the wrong day, name the calendar: j:1405-07-27 or g:2026-10-19.`,
  coverageTitle: "🗓 Checklist coverage",
  coveragePeriod: (days: number, range: string) => `Period: ${String(days)} days · ${range}`,
  coverageDaysReviewed: "days with a record",
  coverageComplete: "complete (11 of 11 confirmed)",
  coveragePartial: "partial",
  coverageNoRecord: "no record",
  coverageUnreviewedLabel: "left unreviewed most often",
  coverageUnknownLabel: "recorded as \"I don't know\"",
  coverageEmpty: "No checklist was filed in this period. That is unreviewed, not a broken rule.",
  coverageDaysBad: (arg: string) => `⚠️ "${arg}" is not a number of days. Example: /checklist coverage 14 (1 to 60)`,
  checklistTitle: "✅ Trade checklist",
  checklistIntro: "📝 Write the items you actually reviewed; anything you leave out stays unreviewed.",
  checklistExampleLabel: "Example — copy and fill it in",
  checklistSavedNew: "✅ Checklist created for that day.",
  checklistSavedMerge: "✅ Checklist updated; items you did not name were left as they were.",
  checklistUnparsed: "⚠️ I did not recognise these keys and did not store them:",
  checklistUnknownHint: 'Write "none" for "I checked, there was nothing" and "?" for "not reviewed".',
  checklistNone: "—",
  tradeDetailTitle: "🧾 Trade",
  tradeEditHelp: (id: string) => `Correct a journaling field like this:\n/edit ${id} strategy <text>\n/edit ${id} emotion <1 to 5>\n/edit ${id} notes <text>`,
  tradeEditDone: "✏️ Updated.",
  tradeDeleteAsk: "🗑 Delete this trade (tombstone)? The record stays in the ledger but leaves every list.",
  btnTradeDelete: "🗑 Delete trade",
  btnTradeEdit: "✏️ Edit notes",
  btnTradeDeleteYes: "Yes, delete",
  btnTradeDeleteNo: "Cancel",
  tradeDeleteDone: "🗑 Trade deleted (tombstoned).",
  tradeNotFound: "I could not find that trade, or it is not yours.",
  tradeStale: "⚠️ That trade changed since you saw it; run /last or /history again.",
  fieldsImmutable: "Prices and size cannot be edited (ADR-002). Delete the trade and create it again.",
  editUsage: "Usage: /edit <id> <strategy|emotion|notes> <value>",
  checklistBadDate: "📅 A date must be YYYY-MM-DD and a real calendar day.",
  checklistRecentTitle: "🗓 Recent days",
  checklistEmptyDay: "Nothing was filed for that day; all eleven items are unreviewed.",
  emotionPrompt: "🙂 How did you feel during this trade? (1 calm to 5 very anxious)",
  btnTradeEmotion: "🙂 Log emotion",
  // ── prepared posts and templates (0037/0038) ──
  postNoService: "🚫 Prepared posts are not enabled in this deployment.",
  postUsage: "Usage: /post [template] — e.g. /post velora.bias",
  postPreviewTitle: "📋 Draft post for your channel",
  postNoChannel: "You have no active channel. Bind and verify one with /channel first.",
  postChannelNotOurs: "I do not know that channel, or it is not yours.",
  postGaps: (n: number) => `⚠️ ${n} field(s) were never recorded; they stay shown as such.`,
  postTruncated: "✂️ The text was too long and has been cut.",
  postUnknownFields: (names: readonly string[]) => `The template uses fields I do not know; I left them in place: ${names.join(", ")}`,
  postUnsupportedExpr: "Templates cannot compute. I kept the expression as plain text.",
  postMarkupDropped: "⚠️ Formatting was dropped to respect the length limit.",
  btnPublish: "✅ Publish to the channel",
  btnDismiss: "Cancel",
  postPublished: (messageId: string) => `✅ Published (message ${messageId}).`,
  postAlreadyPublished: "That post is already published; I will not send it twice.",
  postInFlight: "⏳ That post is being sent right now. Waiting avoids a duplicate publication.",
  postNotApproved: "The text changed after the preview — it has to be approved again.",
  postBlocked: (reason: string) => `⛔ Publishing is blocked: ${reason}`,
  postFailed: (code: string, retryAfter: number | null) =>
    retryAfter === null ? `❌ Send failed (${code}).` : `❌ Send failed (${code}). Try again in about ${retryAfter} seconds.`,
  postNeedsApproval: "To publish, press “Publish to the channel” — that means exactly this text to exactly this channel.",
  postDismissed: "Dismissed; nothing was sent.",
  postReused: "This is the same draft as before (nothing was re-created).",
  postBannerPreview: (shown: number, dropped: number) =>
    `Banner ready: ${shown} row(s)${dropped > 0 ? `, ${dropped} dropped` : ""}. The image is not in this message; it is attached when the post is published.`,
  postNoBanner: "No banner was composed; only the text will be posted.",
  postBannerImage: "Banner preview",
  postBannerNotRendered: "The banner stays text: this runtime has no rasterizer, so no image was previewed or sent.",
  searchHeader: (count: number, provider: string, latency: string) =>
    `Web search — ${count} results from ${provider} (${latency}). These are external sources; Velora has not verified them.`,
  searchNoDate: "date: not given",
  searchNoResults: "The web search returned nothing.",
  searchFooter: "The result text is verbatim from the search service — not Velora's analysis and not trade advice.",
  chartCaptured: (source: string) => `Chart captured — ${source}`,
  chartObserved: (observed: string, missing: string) => `Read from the image: ${observed}. ${missing}`,
  chartMissing: (fields: string) => `Not read: ${fields}.`,
  chartNothingMissing: "No other field was visible.",
  chartNothingReadable: "Nothing could be read from the image with confidence; no value is guessed.",
  chartNotStored: "Nothing was written to the journal: a model reading an image is not a confirmation from you.",
  templateUsage: "Commands: /template (list) · /template save <name> <text> · /template delete <name>",
  templateListTitle: "🧩 Your templates",
  templateEmpty: "No personal templates. Built-in cards: velora.bias, velora.setup, velora.weekly",
  templateSaved: (name: string, version: number) => `✅ Saved “${name}” as version ${version}.`,
  templateConflict: "⚠️ That template changed while you were editing. Run /template again to see the current version.",
  templateExists: "That name is already saved. Run /template first, then pass the version you saw.",
  templateDeleted: (name: string) => `🗑 Template “${name}” archived (its versions are kept).`,
  templateNotFound: "You do not have a template by that name.",
  templateEmptyBody: "The template body is empty.",
  templateTooLong: (limit: number) => `Templates are limited to ${limit} characters; nothing was saved.`,
  templateUnknown: (names: readonly string[]) => `Unknown fields (kept in the text, not removed): ${names.join(", ")}`,
  templateExpr: "A {{placeholder}} is a field name only. Formulas and code are not supported.",
  channelListTitle: "📡 Registered channels",
  channelUseUsage: "Usage: /channel use <chat id> — take the id from /channel.",
  channelActivated: (chatId: string) => `✅ Channel ${chatId} is now active; the previous one is on standby.`,
  channelStandbyNow: "The previously active channel moved to standby (it stays verified).",
  channelNotVerified: "That channel is not verified or cannot post; verify it with /channel first.",
  channelStatusActive: "active",
  channelStatusStandby: "standby",
  agentBlocked: (reason: string) => `Not available: ${reason}. The dependency it needs is not installed or configured in this runtime.`,
  agentAmbiguous: (question: string) => `To continue: ${question}`,
  agentDid: (tool: string) => `Done: ${tool}`,
  // The three sentences a multi-step loop needs. "Did not finish" names WHY the run stopped and how many
  // steps really ran: the results above are partial in that case, and saying so is our job, not the
  // user's inference.
  agentStopped: (reason: string, steps: number) =>
    steps > 0
      ? `This request did not finish (${reason}). ${String(steps)} step(s) ran and their results are above.`
      : `This request was not run (${reason}).`,
  agentNeedsApproval: (tool: string) =>
    `I do not run “${tool}” on my own: it needs your approval button. Look at the draft first, then confirm.`,
  agentUnverifiedTarget: (arg: string) =>
    `The next step asked for a “${arg}” that never appeared in this conversation or in a tool result, so it was not run. Please give the target yourself.`,
  mediaUnavailable: "Live media processing is not enabled in this runtime; the text is recorded as a note.",
  // ── navigable menu (round 7) ──
  navTitle: "🏛 <b>Velora</b>",
  navHome: "Main menu — pick a section:",
  btnHome: "🏠 Main menu",
  btnBack: "◀️ Back",
  btnCancelFlow: "✖️ Cancel",
  navJournalTitle: "📝 <b>Journal</b>",
  navJournalBody: "Log a trade, see the last one, the history and the stats — all from here.",
  navPostsTitle: "📤 <b>Posts and publishing</b>",
  navPostsBody: "A post is built from your real journal data; no number is invented, and publishing happens only after your confirmation.",
  navPostsUnavailable: "This deployment has no post service, so building and publishing are unavailable here. Everything else works.",
  btnPostNew: "🆕 New post",
  btnPostTplList: "📄 Choose template",
  btnPostPreview: "👁 Preview post",
  btnPostResult: "📬 Publish result",
  navTplTitle: "🗂 <b>Templates</b>",
  navTplBody: "Your templates. Each body is filled with variables such as {symbol}.",
  tplEmpty: "No templates yet. Use “New template” to create one; the body is filled from that day’s data.",
  btnTplNew: "🆕 New template",
  btnTplEdit: "✏️ Edit",
  btnTplDelete: "🗑 Delete",
  btnTplDefault: "⭐ Default",
  btnTplPreview: "👁 Preview",
  tplDefaultMark: "⭐",
  tplAskName: "Send the template name (1–64 characters, e.g. morning-card). To cancel: /cancel",
  tplAskBody:
    "Send the template body. Variables: {symbol} {direction} {entryPrice} {exitPrice} {winRate} {closedCount} {netPnl} {averageR} {checked} {date}. To cancel: /cancel",
  tplNameInvalid: "That name was refused: it must be 1–64 characters. Send another or /cancel.",
  tplNameTaken: "You already have a template with that name. Send another name, or change this one with “Edit”.",
  tplSaved: (name: string, version: number) => `✅ Template “${esc(name)}” saved (version ${String(version)}).`,
  tplUpdated: (name: string, version: number) => `✅ Version ${String(version)} of “${esc(name)}” created; earlier versions stay readable.`,
  tplDeleteAsk: (name: string) => `🗑 Retire the template “${esc(name)}”? Posts already made from it are untouched.`,
  tplDeleted: (name: string) => `✅ Template “${esc(name)}” retired.`,
  tplDefaultSet: (name: string) => `⭐ “${esc(name)}” is now the default template for /post.`,
  tplDefaultCleared: "⭐ Default template cleared; /post will ask which template to use.",
  btnTplClearDefault: "✖️ Clear default",
  tplNotFound: "That template was not found; it may have been retired. See the list under “Templates”.",
  tplCanceled: "✖️ Cancelled; nothing was saved.",
  tplFlowExpired: "⏳ That step expired and nothing was saved. Start again from “Templates → New template”.",
  tplBodyTooLong: (max: number) => `The body is longer than ${String(max)} characters; refused. Send a shorter one.`,
  tplBodyEmpty: "The body is empty; nothing was saved.",
  tplPreviewTitle: (name: string) => `👁 Preview of “${esc(name)}”`,
  tplPreviewMissing: (vars: readonly string[]) =>
    `⚠️ These variables had no value in your data and are shown explicitly as “not recorded”: ${vars.join(", ")}`,
  navBannerTitle: "🖼 <b>Banner and appearance</b>",
  navBannerBody: (o: { readonly enabled: boolean; readonly title: string | null; readonly canRaster: boolean }) =>
    [
      "Available style: the dark gold card (the only style this build knows).",
      `Banner: ${o.enabled ? "on — built with the post" : "off — text card only"}`,
      `Custom title: ${o.title === null ? "not set (the template title is used)" : `“${esc(o.title)}”`}`,
      o.canRaster
        ? "Image rendering is available in this runtime."
        : "⚠️ PNG rendering is NOT available in this runtime, so the <b>text</b> card is sent and says so. No image is substituted.",
    ].join("\n"),
  bnUnavailable:
    "⚠️ PNG rendering is not possible in this deployment (the native renderer cannot run on Cloudflare Workers). The text card is sent — no image is produced, and none is claimed.",
  btnBnToggle: "On/off",
  btnBnTitle: "✏️ Banner title",
  btnBnClearTitle: "✖️ Clear title",
  bnAskTitle: "Send the banner title (up to 60 characters) or /cancel.",
  bnTitleSet: (title: string) => `✅ Banner title: “${esc(title)}”`,
  bnTitleCleared: "✅ Custom title cleared; the template title is used.",
  bnTitleTooLong: "The title is longer than 60 characters; refused.",
  navAiTitle: "🤖 <b>AI tools</b>",
  aiOn: "enabled",
  aiOff: "disabled",
  aiMissing: (keys: readonly string[]) => `Unset key(s): ${keys.join(", ")}`,
  aiNoSecretNote: "Key values are never displayed — only whether one is set.",
  aiConsentNote: "Every tool honours the same consent, quota and attempt ledger as the main path.",
  navSettingsTitle: "⚙️ <b>Bot settings</b>",
  navHelpTitle: "❓ <b>Help</b>",
  navHelpBody: "Daily work is done from the buttons; slash commands remain for compatibility.",
  flowJournalWins:
    "ℹ️ That text had journal value, so it is being filed as a trade and the earlier question (template) stays open. Send your answer after this message, or /cancel to close it.",
  // ── publish result + post editing (round 7) ──
  postResultTitle: "📬 <b>Publish result</b>",
  postResultEmpty: "No post has been prepared or published from this account yet. Start with “New post”.",
  postStatusDraft: "draft (not published)",
  postStatusApproved: "approved, queued to send",
  postStatusPublishing: "sending",
  postStatusPublished: "published",
  postStatusFailed: "failed",
  postStatusCancelled: "cancelled",
  postResultLine: (o: { readonly when: string; readonly status: string; readonly excerpt: string; readonly messageId: string | null; readonly errorCode: string | null }) =>
    `• ${o.when} — <b>${o.status}</b>${o.messageId === null ? "" : ` (message ${o.messageId})`}${o.errorCode === null ? "" : ` — code: ${o.errorCode}`}\n  <i>${esc(o.excerpt)}</i>`,
  postResultUnavailable: (reason: string) => `⚠️ Publishing is not possible right now: ${reason}`,
  btnPostEdit: "✏️ Edit text",
  postEditAsk:
    "Send the post's new text. This REVOKES the previous approval, so you will approve the fresh preview again. To cancel: /cancel",
  postEdited: "✅ The post text was revised; the previous approval is void. Review the fresh preview and publish it if it is right.",
  postEditNotEditable: "That post can no longer be edited (it was published or cancelled).",
  postEditInvalid: "That text was refused: it is empty, too long, or has an unknown variable. Send another or /cancel.",
  postEditExpiredPost: "⏳ That edit expired; the post is unchanged. Start again from the preview.",
};

/** The copy object's type. Both locales are this shape — `EN` is annotated `typeof FA`, so a key added
 * for one language and not the other is a compile error rather than a runtime hole in one locale. */
export type TelegramCopy = typeof FA;

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

/** "0.6000" -> "60.00", "-0.5" -> "-50.00", "0" -> "0.00". String-only: no float in the path. */
function shiftPercent(value: string): string {
  const sign = value.startsWith("-") ? "-" : "";
  const digits = value.startsWith("-") || value.startsWith("+") ? value.slice(1) : value;
  const [whole = "0", frac = ""] = digits.split(".");
  const padded = `${whole}${frac.padEnd(2, "0")}`;
  const moved = `${padded.slice(0, Math.max(0, whole.length + 2)) || "0"}.${padded.slice(Math.max(0, whole.length + 2)).padEnd(2, "0").slice(0, 2)}`;
  return `${sign}${moved}`;
}

/**
 * Statistics for the chat, built ONLY from the numbers the domain derived. A percent is formatted
 * here by shifting the decimal point of the exact decimal string `computeSummary` produced — never
 * through a float — so a win rate cannot arrive in the chat as a different fact.
 *
 * Nothing is added to these figures. `flags` is the domain's machine-readable statement of what could
 * NOT be computed (e.g. "NO_CLOSED_TRADES"), and it is shown rather than turned into a friendly zero,
 * because a user deciding whether to trust a profit factor needs to know it had no losses to divide by.
 */
/**
 * The stats card. `sampledOf` is the TOTAL number of rows when the store could not read them all
 * (it is `null` when every row was read), and it changes WHAT MAY BE PRINTED, not just the footer:
 *
 *   • a SUM over the newest 200 rows is a LOWER BOUND on the real sum — a legitimate, true statement;
 *   • a RATIO over that same sample (win rate, profit factor) is not a lower bound of anything. It is
 *     a different number from the population's, with no stated error bar, and next to a caveat line
 *     it still reads as a fact about the account. So both ratio lines print `—` — the marker this
 *     file already uses for "not available", the same one the fee line uses — followed by the reason.
 *
 * Nothing here is computed differently; only what is DISPLAYED changes, and only while `sampledOf`
 * is non-null. An unsampled card renders exactly as it did before this patch (pinned by a test).
 */
export function renderStats(copy: typeof FA, stats: JournalStats, sampledOf: number | null): string {
  const sampled = sampledOf !== null;
  const line = (label: string, value: string): string => `${label}: ${value}`;
  const pct = (value: string | null): string => (value === null ? copy.checklistNone : `${shiftPercent(value)} %`);
  const rows = [
    line("🪙", `${String(stats.tradeCount)} · ${copy.statsClosedLabel} ${String(stats.closedCount)} · ${copy.statsOpenLabel} ${String(stats.openCount)}`),
    line("✅/❌/➖", `${String(stats.wins)} / ${String(stats.losses)} / ${String(stats.breakeven)}`),
    // A sample's COUNT of wins is still a count of real wins; its RATE is not a rate of the account.
    sampled
      ? line("📈", `${copy.checklistNone} — ${copy.statsSampledWinRate}`)
      : line("📈", `${pct(stats.winRate)}`),
    line("💰", stats.totalPnl),
    line("🧾", `${stats.totalFees} (${stats.averageFee})`),
    sampled
      ? line("⚖️", `${copy.checklistNone} — ${copy.statsSampledProfitFactor}`)
      : line("⚖️", stats.profitFactor ?? copy.checklistNone),
    line("R", `${stats.averageR} · ${stats.averageWin} / ${stats.averageLoss}`),
    sampled
      ? line("↕️", `${stats.bestTrade} / ${stats.worstTrade} — ${copy.statsSampledExtremes}`)
      : line("↕️", `${stats.bestTrade} / ${stats.worstTrade}`),
  ];
  if (sampledOf !== null) rows.push(copy.statsSampled(sampledOf));
  // The fee/PnL relation is a business rule this repository has not decided, so the card says so
  // instead of letting "realized" and "fees" sitting next to each other imply one.
  rows.push(`ℹ️ ${stats.feesCombinedWithPnl ? "fees included in P/L" : "fees NOT included in P/L"}`);
  for (const flag of stats.flags) rows.push(`• ${flag}`);
  rows.push("");
  rows.push(copy.statsFromData);
  return rows.join("\n");
}

/**
 * One day's review, read back exactly as it was stored. The difference between "I checked and there
 * was nothing" and "I did not look" is the entire value of this card, so both get their own glyph and
 * neither is ever rendered as the other.
 */
export function renderChecklist(
  copy: typeof FA,
  list: DailyChecklist,
  coverage: ChecklistCoverage,
  itemLabels: readonly string[],
): string {
  const glyph = (state: string): string => (state === "CONFIRMED" ? "✅" : state === "UNKNOWN" ? "⬜" : "➖");
  const rows = itemLabels.map((label) => {
    const entry = list.values[label as ChecklistItem];
    if (entry === undefined) return `➖ ${label}: ${copy.checklistNone}`;
    return `${glyph(entry.state)} ${label}: ${entry.value ?? copy.checklistNone}`;
  });
  if (list.notes !== null) rows.push(`🗒 ${list.notes}`);
  const sl = list.values.stopLoss.value === null ? "" : ` · SL ${list.values.stopLoss.value}`;
  const risk = list.values.risk.value === null ? "" : ` · ${list.values.risk.value}${list.riskUnit}`;
  rows.push(
    `✅ ${String(coverage.confirmed)} · ⬜ ${String(coverage.unknown)} · ➖ ${String(coverage.unreviewed)}/${String(coverage.total)}${sl}${risk}`,
  );
  return rows.join("\n");
}

/**
 * The example block of the checklist form. THE KEYS ARE THE DOMAIN'S OWN — `CHECKLIST_PROMPT_LINES`
 * is generated from the same alias table `parseChecklistText` reads, so a user who copies this template
 * cannot be handed a key that will not parse back. A test asserts every line below round-trips, which
 * is the only reason a prompt like this can be trusted to still work next month.
 */
export const CHECKLIST_EXAMPLE_VALUES: Readonly<Record<string, string>> = {
  bias: "bullish",
  leg: "bullish",
  location: "premium",
  h4: "fvg",
  h1: "none",
  m15: "none",
  cisd: "yes",
  smt: "no",
  macro: "09:30",
  sl: "2655",
  risk: "0.5%",
} as const;

export function renderChecklistPrompt(copy: typeof FA, promptLines: readonly string[]): string {
  const example = promptLines
    .map((line) => {
      const key = line.replace(/:\s*$/, "");
      const value = CHECKLIST_EXAMPLE_VALUES[key];
      return value === undefined ? line.trimEnd() : `${key}: ${value}`;
    })
    .join("\n");
  // The example block only: the hint line below the block would read as prose the parser has to
  // ignore, and a copy of the form must parse cleanly on its own.
  return `${copy.checklistIntro}\n\n${copy.checklistExampleLabel}\n${example}`;
}
