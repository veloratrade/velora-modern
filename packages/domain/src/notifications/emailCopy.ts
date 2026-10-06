// Email + achievement copy — byte-verbatim port of Legacy's catalog entries
// for the transactional-email capability (MG-EMAIL-TYPES, audit §12.3).
//
// PROVENANCE (READ-ONLY source-read 2026-10-06, veloratrade/veloratrade @edede31):
//   every key/value below is a byte copy of `public/locales/{fa,en}.json` —
//   the SAME catalog Legacy's NotificationService/EmailTemplate read at runtime
//   (LocaleManager::translateFor). Nothing is re-authored; param placeholders
//   ({name}, {id}, {year}, {user}) are Legacy's own substitution syntax
//   (translateFor replaces both `{name}` and `:name`).
//
// HOUSE RULES (domain is framework-free and I/O-free): this module is pure
// data + a pure translator. No digits latinization here — Legacy emails print
// catalog values verbatim, so the port does too (the web-app digit rule is a
// UI concern, not an email concern).

export type EmailLocale = "fa" | "en";

const FA_COPY: Readonly<Record<string, string>> = {
  "achievements.emailVerified.description": "تأیید ایمیل و عضویت رسمی در پلتفرم VELORA Trade با موفقیت تکمیل شد.",
  "achievements.emailVerified.title": "تأیید ایمیل کاربری",
  "achievements.firstTrade.description": "اولین معامله شما در ژورنال VELORA Trade ثبت شد و مسیر تحلیل حرفه‌ای عملکرد آغاز شد.",
  "achievements.firstTrade.title": "اولین معامله در VELORA",
  "email.achievement.after": "با ادامه ثبت معاملات و بهبود شاخص‌ها، دستاوردهای بیشتری آزاد کنید.",
  "email.achievement.badge": "دستاورد جدید",
  "email.achievement.cta": "مشاهده دستاوردها",
  "email.achievement.intro": "در مسیر حرفه‌ای معامله‌گری خود در VELORA Trade یک دستاورد جدید کسب کردید.",
  "email.achievement.notice": "دستاوردهای شما نشان‌دهنده انضباط، استمرار و رشد مهارت معامله‌گری است.",
  "email.achievement.subject": "VELORA TRADE | دستاورد جدید",
  "email.achievement.title": "دستاورد جدید باز شد!",
  "email.common.about": "درباره ما",
  "email.common.contact": "تماس با ما",
  "email.common.copyright": "© {year} VELORA Trade",
  "email.common.footerPlatform": "پلتفرم هوشمند تحلیل معاملات",
  "email.common.greeting": "سلام {name}،",
  "email.common.managePreferences": "مدیریت ترجیحات ایمیل",
  "email.common.privacy": "حریم خصوصی",
  "email.common.recipient": "معامله‌گر گرامی",
  "email.common.rightsReserved": "تمام حقوق محفوظ است.",
  "email.common.subtitleAnalytics": "TRADE · SMART ANALYTICS PLATFORM",
  "email.common.subtitleSecurity": "TRADE · ACCOUNT SECURITY",
  "email.common.terms": "قوانین",
  "email.common.unknownDevice": "دستگاه ناشناخته",
  "email.firstTrade.after": "ثبت منظم معاملات، نخستین گام برای تحلیل حرفه‌ای عملکرد، بهبود استراتژی و کنترل بهتر ریسک است.",
  "email.firstTrade.badge": "ثبت اولین معامله",
  "email.firstTrade.buy": "خرید",
  "email.firstTrade.cta": "مشاهده تحلیل عملکرد",
  "email.firstTrade.intro": "تبریک! اولین معامله شما با موفقیت در ژورنال معاملاتی VELORA ثبت شد.",
  "email.firstTrade.notice": "برای دریافت شاخص‌ها و آمار دقیق‌تر، معاملات سودده و زیان‌ده خود را ثبت کنید.",
  "email.firstTrade.sell": "فروش",
  "email.firstTrade.status": "وضعیت: ثبت موفق در ژورنال معاملاتی",
  "email.firstTrade.subject": "VELORA TRADE | ثبت اولین معامله",
  "email.firstTrade.title": "اولین معامله شما در VELORA ثبت شد",
  "email.invite.after": "برای فعال‌سازی حساب و تعیین گذرواژه، دکمه زیر را انتخاب کنید.",
  "email.invite.badge": "دعوت مدیریت",
  "email.invite.cta": "فعال‌سازی حساب",
  "email.invite.intro": "برای این ایمیل یک حساب مدیریتی در پنل VELORA ایجاد شده است. برای تعیین گذرواژه و فعال‌سازی حساب از لینک زیر استفاده کنید.",
  "email.invite.notice": "این لینک ۲۴ ساعت اعتبار دارد و فقط یک‌بار قابل استفاده است. اگر این دعوت را انتظار نداشتید، ایمیل را نادیده بگیرید.",
  "email.invite.subject": "VELORA TRADE | دعوت به پنل مدیریت",
  "email.invite.title": "دعوت به پنل مدیریت VELORA",
  "email.newDevice.after": "اگر این ورود توسط شما انجام شده است، اقدامی لازم نیست.",
  "email.newDevice.badge": "هشدار ورود جدید",
  "email.newDevice.cta": "بررسی امنیت حساب",
  "email.newDevice.device": "دستگاه یا مرورگر",
  "email.newDevice.intro": "یک ورود جدید به حساب VELORA Trade شما شناسایی شد.",
  "email.newDevice.ip": "آدرس IP",
  "email.newDevice.notice": "اگر شما وارد نشده‌اید، فوراً رمز عبور را تغییر دهید و نشست‌های فعال را لغو کنید.",
  "email.newDevice.subject": "VELORA TRADE | هشدار ورود جدید",
  "email.newDevice.time": "زمان ورود",
  "email.newDevice.title": "ورود از دستگاه جدید",
  "email.passwordChanged.after": "اگر این تغییر را شما انجام نداده‌اید، فوراً با پشتیبانی تماس بگیرید و رمز عبور را بازنشانی کنید.",
  "email.passwordChanged.badge": "امنیت حساب",
  "email.passwordChanged.intro": "رمز عبور حساب زیر با موفقیت تغییر یافت.",
  "email.passwordChanged.notice": "برای حفظ امنیت حساب، همه نشست‌های فعال قبلی باطل شدند.",
  "email.passwordChanged.subject": "VELORA TRADE | تغییر رمز عبور",
  "email.passwordChanged.title": "رمز عبور شما تغییر کرد",
  "email.passwordReset.after": "برای انتخاب رمز عبور جدید و ورود به حساب، دکمه زیر را انتخاب کنید.",
  "email.passwordReset.badge": "بازیابی رمز عبور",
  "email.passwordReset.cta": "تغییر رمز عبور",
  "email.passwordReset.intro": "برای حساب زیر درخواست بازیابی رمز عبور ثبت شده است.",
  "email.passwordReset.notice": "این لینک یک ساعت اعتبار دارد. اگر این درخواست را ثبت نکرده‌اید، ایمیل را نادیده بگیرید.",
  "email.passwordReset.subject": "VELORA TRADE | بازیابی رمز عبور",
  "email.passwordReset.title": "رمز عبور VELORA را تغییر دهید",
  "email.support.badge": "پشتیبانی VELORA",
  "email.support.newTicket.cta": "مشاهده در مرکز ارتباطات",
  "email.support.newTicket.intro": "تیکت جدیدی از {user} ثبت شده است.",
  "email.support.newTicket.subject": "تیکت پشتیبانی جدید #{id}",
  "email.support.newTicket.title": "تیکت پشتیبانی جدید",
  "email.support.notice": "این یک اعلان رویدادی است؛ برای هر پیام ایمیل ارسال نمی‌شود.",
  "email.support.reply.cta": "مشاهده پاسخ",
  "email.support.reply.intro": "{name} عزیز، تیم پشتیبانی VELORA به تیکت شما پاسخ داد.",
  "email.support.reply.subject": "پاسخ پشتیبانی به تیکت #{id}",
  "email.support.reply.title": "پشتیبانی پاسخ داد",
  "email.verification.after": "پس از تأیید، امکان ورود و استفاده از ژورنال معاملاتی برای شما فعال می‌شود.",
  "email.verification.badge": "تأیید ایمیل",
  "email.verification.cta": "تأیید ایمیل",
  "email.verification.intro": "برای فعال‌سازی حساب مرتبط با ایمیل زیر و دسترسی به امکانات پلتفرم، دکمه تأیید را انتخاب کنید.",
  "email.verification.notice": "این لینک 24 ساعت اعتبار دارد. اگر ایمیل را در Inbox نمی‌بینید، پوشه Spam را بررسی کنید. پس از انقضا می‌توانید لینک جدیدی درخواست کنید.",
  "email.verification.subject": "VELORA TRADE | تأیید ایمیل",
  "email.verification.title": "ایمیل خود را تأیید کنید",
  "email.welcome.after": "اکنون می‌توانید معاملات را ثبت کنید، ریسک را مدیریت کنید و عملکرد خود را در VELORA Trade به‌صورت حرفه‌ای تحلیل کنید.",
  "email.welcome.badge": "حساب شما آماده است",
  "email.welcome.cta": "ورود به داشبورد",
  "email.welcome.intro": "حساب شما با آدرس ایمیل زیر با موفقیت فعال شد.",
  "email.welcome.notice": "مسیر حرفه‌ای معامله‌گری شما از همین‌جا آغاز می‌شود.",
  "email.welcome.subject": "VELORA TRADE | خوش آمدید",
  "email.welcome.title": "به VELORA TRADE خوش آمدید"
};

const EN_COPY: Readonly<Record<string, string>> = {
  "achievements.emailVerified.description": "Email verification and official VELORA Trade membership completed successfully.",
  "achievements.emailVerified.title": "Email verified",
  "achievements.firstTrade.description": "Your first trade was recorded in the VELORA Trade journal, beginning your professional performance analysis journey.",
  "achievements.firstTrade.title": "First trade in VELORA",
  "email.achievement.after": "Keep recording trades and improving your metrics to unlock more achievements.",
  "email.achievement.badge": "New achievement",
  "email.achievement.cta": "View achievements",
  "email.achievement.intro": "You unlocked a new achievement on your professional trading journey in VELORA Trade.",
  "email.achievement.notice": "Your achievements reflect your discipline, consistency and growth as a trader.",
  "email.achievement.subject": "VELORA TRADE | Achievement unlocked",
  "email.achievement.title": "Achievement unlocked!",
  "email.common.about": "About",
  "email.common.contact": "Contact",
  "email.common.copyright": "© {year} VELORA Trade",
  "email.common.footerPlatform": "Smart Trading Analytics Platform",
  "email.common.greeting": "Hello {name},",
  "email.common.managePreferences": "Manage email preferences",
  "email.common.privacy": "Privacy",
  "email.common.recipient": "Valued trader",
  "email.common.rightsReserved": "All rights reserved.",
  "email.common.subtitleAnalytics": "TRADE · SMART ANALYTICS PLATFORM",
  "email.common.subtitleSecurity": "TRADE · ACCOUNT SECURITY",
  "email.common.terms": "Terms",
  "email.common.unknownDevice": "Unknown device",
  "email.firstTrade.after": "Recording trades consistently is the first step towards professional performance analysis, strategy improvement and better risk control.",
  "email.firstTrade.badge": "First trade recorded",
  "email.firstTrade.buy": "Buy",
  "email.firstTrade.cta": "View performance analysis",
  "email.firstTrade.intro": "Congratulations! Your first trade was recorded successfully in your VELORA trading journal.",
  "email.firstTrade.notice": "Record both winning and losing trades to receive the most accurate metrics and statistics.",
  "email.firstTrade.sell": "Sell",
  "email.firstTrade.status": "Status: recorded successfully in the trading journal",
  "email.firstTrade.subject": "VELORA TRADE | First trade recorded",
  "email.firstTrade.title": "Your first VELORA trade was recorded",
  "email.invite.after": "Select the button below to activate your account and choose a password.",
  "email.invite.badge": "Admin invitation",
  "email.invite.cta": "Activate account",
  "email.invite.intro": "An administrative account has been created for this email address in the VELORA admin console. Use the link below to choose your password and activate the account.",
  "email.invite.notice": "This link is valid for 24 hours and can be used only once. If you were not expecting this invitation, ignore this email.",
  "email.invite.subject": "VELORA TRADE | Admin invitation",
  "email.invite.title": "You are invited to the VELORA admin console",
  "email.newDevice.after": "If this was you, no action is required.",
  "email.newDevice.badge": "New sign-in alert",
  "email.newDevice.cta": "Review account security",
  "email.newDevice.device": "Device or browser",
  "email.newDevice.intro": "A new sign-in to your VELORA Trade account was detected.",
  "email.newDevice.ip": "IP address",
  "email.newDevice.notice": "If this was not you, change your password immediately and revoke active sessions.",
  "email.newDevice.subject": "VELORA TRADE | New sign-in alert",
  "email.newDevice.time": "Sign-in time",
  "email.newDevice.title": "Sign-in from a new device",
  "email.passwordChanged.after": "If you did not make this change, contact support immediately and reset your password.",
  "email.passwordChanged.badge": "Account security",
  "email.passwordChanged.intro": "The password for the account below was changed successfully.",
  "email.passwordChanged.notice": "For account security, all previously active sessions have been revoked.",
  "email.passwordChanged.subject": "VELORA TRADE | Password changed",
  "email.passwordChanged.title": "Your password was changed",
  "email.passwordReset.after": "Select the button below to choose a new password and sign in.",
  "email.passwordReset.badge": "Password reset",
  "email.passwordReset.cta": "Change password",
  "email.passwordReset.intro": "A password reset was requested for the account below.",
  "email.passwordReset.notice": "This link is valid for one hour. If you did not request it, ignore this email.",
  "email.passwordReset.subject": "VELORA TRADE | Password reset",
  "email.passwordReset.title": "Change your VELORA password",
  "email.support.badge": "VELORA Support",
  "email.support.newTicket.cta": "Open in Communication Center",
  "email.support.newTicket.intro": "A new ticket has been submitted by {user}.",
  "email.support.newTicket.subject": "New support ticket #{id}",
  "email.support.newTicket.title": "New support ticket",
  "email.support.notice": "This is an event-based notification; not every message triggers an email.",
  "email.support.reply.cta": "View reply",
  "email.support.reply.intro": "Hi {name}, the VELORA support team has replied to your ticket.",
  "email.support.reply.subject": "Support replied to ticket #{id}",
  "email.support.reply.title": "Support has replied",
  "email.verification.after": "After verification, you can sign in and use your trading journal.",
  "email.verification.badge": "Email verification",
  "email.verification.cta": "Verify email",
  "email.verification.intro": "To activate the account associated with the email below and access the platform, select the verification button.",
  "email.verification.notice": "This link is valid for 24 hours. If the email is not in your inbox, check your spam folder. You can request a new link after it expires.",
  "email.verification.subject": "VELORA TRADE | Verify your email",
  "email.verification.title": "Verify your email address",
  "email.welcome.after": "You can now record trades, manage risk and analyse your performance professionally in VELORA Trade.",
  "email.welcome.badge": "Your account is ready",
  "email.welcome.cta": "Open dashboard",
  "email.welcome.intro": "Your account with the email address below has been activated successfully.",
  "email.welcome.notice": "Your professional trading journey starts here.",
  "email.welcome.subject": "VELORA TRADE | Welcome",
  "email.welcome.title": "Welcome to VELORA TRADE"
};

/**
 * Resolve one catalog entry for a locale with Legacy's fallback semantics
 * (LocaleManager::translateFor): missing key → fallback locale (en,
 * per manifest.json fallbackLocale) → the raw key. `{name}`/`:name` params are substituted,
 * Legacy-style. Pure — no IO, no locale sniffing.
 */
export function emailCopy(
  locale: EmailLocale,
  key: string,
  params: Readonly<Record<string, string>> = {},
): string {
  // manifest.json fallbackLocale = "en" — Legacy tries the requested locale,
  // then en, then hands back the raw key.
  const catalog = locale === "en" ? EN_COPY : FA_COPY;
  let message: string = catalog[key] ?? EN_COPY[key] ?? key;
  for (const [name, value] of Object.entries(params)) {
    message = message.split(`{${name}}`).join(value).split(`:${name}`).join(value);
  }
  return message;
}

/** RTL for fa, LTR for en — LocaleManager::directionFor. */
export function emailDirection(locale: EmailLocale): "rtl" | "ltr" {
  return locale === "fa" ? "rtl" : "ltr";
}

/** The full copy key set (both locales share it) — used by parity tests. */
export const EMAIL_COPY_KEYS: readonly string[] = Object.keys(FA_COPY).sort();
