// Email locale resolution + recipient naming — the port of Legacy
// NotificationService::resolveEmailLocale / formatName (@edede31,
// READ-ONLY source-read 2026-10-06).
//
// WHAT LEGACY DOES (source-verified):
//   - resolveEmailLocale(savedLocale, clientLocale): the user's STORED locale
//     (users.locale) is the primary source; the request hint is only a
//     fallback for paths with no stored user (fresh signup, anti-enumeration).
//     Unsupported candidates are skipped; nothing usable → null (the caller
//     then falls back to the manifest default).
//   - formatName(fullName, email, locale): an empty name, or a name that IS
//     the email address, renders as the localized "recipient" copy instead of
//     a bare address — emails never say "Hi ,".
//
// PORT SHAPE: pure functions; the manifest default (fa — LocaleManager
// `defaultLocale`) is a constant the caller applies, keeping this module
// decision-free about environment.

import { emailCopy, type EmailLocale } from "./emailCopy.js";

const SUPPORTED: readonly EmailLocale[] = ["fa", "en"];

/** LocaleManager::normalize + supports, then first-match-wins. */
export function resolveEmailLocale(
  savedLocale: string | null | undefined,
  clientLocale: string | null | undefined,
): EmailLocale | null {
  for (const candidate of [savedLocale, clientLocale]) {
    const trimmed = (candidate ?? "").trim();
    if (trimmed === "") continue;
    const normalized = trimmed.toLowerCase();
    if (SUPPORTED.includes(normalized as EmailLocale)) {
      return normalized as EmailLocale;
    }
  }
  return null;
}

/** The manifest default locale when neither stored nor hinted locale works. */
export const DEFAULT_EMAIL_LOCALE: EmailLocale = "fa";

/** resolveEmailLocale with the manifest default applied — the common path. */
export function emailLocaleOrDefault(
  savedLocale: string | null | undefined,
  clientLocale: string | null | undefined,
): EmailLocale {
  return resolveEmailLocale(savedLocale, clientLocale) ?? DEFAULT_EMAIL_LOCALE;
}

/** Clean recipient name; bare/absent names become the localized "recipient". */
export function formatEmailName(
  fullName: string | null | undefined,
  email: string,
  locale: EmailLocale,
): string {
  const name = (fullName ?? "").trim();
  if (name === "" || name.toLowerCase() === email.trim().toLowerCase()) {
    return emailCopy(locale, "email.common.recipient");
  }
  return name;
}
