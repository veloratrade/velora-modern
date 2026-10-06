// EmailTemplate — the port of Legacy api/src/Core/EmailTemplate.php
// (READ-ONLY source-read 2026-10-06, @edede31) plus `Mailer::htmlToPlain`.
//
// WHAT LEGACY SHIPS (source-verified):
//   - A table-based, client-safe XHTML email shell (Gmail/Outlook/Apple Mail)
//     in the VELORA identity: dark card (#0e1626), gold accents (#d4af37),
//     CID logo + per-type icon, direction-aware (fa → rtl) text alignment and
//     notice border side, footer with contact/terms/privacy/manage-preferences
//     links and a localized copyright with the current UTC year.
//   - `Mailer::htmlToPlain` — the plain-text alternative derived from the HTML
//     so no email is HTML-only (MIME_HTML_ONLY spam penalty).
//
// PORT SHAPE (house rules): pure string building — no DOM, no IO. Escaping is
// the port's own responsibility exactly where Legacy had it: `escape()` on
// every interpolated value (ENT_QUOTES | ENT_SUBSTITUTE semantics). Builders
// that pass pre-escaped fragments (contentHtml) document that contract.
//
// DIVERGENCE (cosmetic, documented): Legacy interpolated `gmdate('Y')` for the
// copyright year; the port takes `year` as a parameter so the function stays
// deterministic and clock-free (testable; the caller supplies new Date()).

import { emailCopy, emailDirection, type EmailLocale } from "./emailCopy.js";

/** htmlspecialchars($v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
    // ENT_SUBSTITUTE: never emit a bare replacement char for invalid input —
    // encodeURIComponent-style percent escapes are NOT email-safe; drop them.
    .replace(/\uFFFD/g, "");
}

export interface EmailTemplateInput {
  readonly locale: EmailLocale;
  /** Badge label above the title (e.g. "Security"). */
  readonly badge: string;
  readonly title: string;
  /** Pre-built, ALREADY-ESCAPED inner content (paragraphs/boxes). */
  readonly contentHtml: string;
  /** Optional CTA button; omit either field to skip the button. */
  readonly buttonLabel?: string | null;
  readonly buttonUrl?: string | null;
  /** Optional highlighted notice paragraph below the content. */
  readonly notice?: string | null;
  /** Header subtitle; defaults to email.common.subtitleSecurity. */
  readonly subtitle?: string | null;
  /** Icon CID suffix (validated /^[a-z0-9-]+$/); omit for no icon. */
  readonly iconName?: string | null;
  /** Icon alt text; defaults to the badge. */
  readonly iconAlt?: string | null;
  /** Frontend base URL (no trailing slash) for header/footer links. */
  readonly frontendBase: string;
  /** UTC year for the localized copyright line. */
  readonly year: number;
}

/** Render the full email HTML — the byte-faithful shape of Legacy's shell. */
export function renderEmailTemplate(input: EmailTemplateInput): string {
  const { locale } = input;
  const direction = emailDirection(locale);
  const textAlign = direction === "rtl" ? "right" : "left";
  const noticeBorder = direction === "rtl" ? "border-right" : "border-left";
  const t = (key: string, params?: Record<string, string>): string =>
    emailCopy(locale, key, params);

  const badgeSafe = escapeHtml(input.badge);
  const titleSafe = escapeHtml(input.title);
  const subtitleSafe = escapeHtml(
    input.subtitle === null || input.subtitle === undefined
      ? t("email.common.subtitleSecurity")
      : input.subtitle,
  );
  const frontendBase = input.frontendBase.replace(/\/+$/, "");
  const langSafe = escapeHtml(locale);

  let iconHtml = "";
  if (typeof input.iconName === "string" && /^[a-z0-9-]+$/.test(input.iconName)) {
    const iconCidSafe = escapeHtml(`velora-${input.iconName}`);
    const iconAltSafe = escapeHtml(input.iconAlt ?? input.badge);
    iconHtml =
      `<table role="presentation" align="center" width="78" height="78" cellspacing="0" cellpadding="0" border="0" bgcolor="#141f31" style="width:78px;height:78px;margin:0 auto 22px;background:#141f31;border:1px solid #9b782e;border-radius:24px;border-collapse:separate;box-shadow:inset 0 0 0 3px #0e1829,0 12px 28px rgba(0,0,0,0.28);">` +
      `<tr><td align="center" valign="middle" style="width:78px;height:78px;padding:0;">` +
      `<img src="cid:${iconCidSafe}" width="56" height="56" alt="${iconAltSafe}" style="display:block;margin:0 auto;width:56px;height:56px;border:0;outline:none;" />` +
      `</td></tr>` +
      `</table>`;
  }

  let button = "";
  if (input.buttonLabel != null && input.buttonUrl != null) {
    const labelSafe = escapeHtml(input.buttonLabel);
    const urlSafe = escapeHtml(input.buttonUrl);
    button =
      `<table role="presentation" align="center" width="230" height="48" cellspacing="0" cellpadding="0" border="0" style="width:230px;height:48px;margin:30px auto 10px;border-collapse:separate;">` +
      `<tr><td align="center" bgcolor="#d4af37" style="background:#d4af37;background-image:linear-gradient(135deg,#fce38a 0%,#d4af37 50%,#b88d1d 100%);border-radius:10px;box-shadow:0 6px 18px rgba(212,175,55,0.32);">` +
      `<a href="${urlSafe}" style="display:block;padding:14px 18px;font-family:Tahoma,Arial,sans-serif;font-size:15px;font-weight:bold;color:#0b121e;text-decoration:none;text-shadow:0 1px 0 rgba(255,255,255,0.35);">${labelSafe}</a>` +
      `</td></tr>` +
      `</table>`;
  }

  let noticeHtml = "";
  if (input.notice != null && input.notice !== "") {
    const noticeSafe = escapeHtml(input.notice);
    noticeHtml =
      `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:28px;background:#141f32;border:1px solid #344460;${noticeBorder}:4px solid #d4af37;border-radius:8px;">` +
      `<tr><td style="padding:15px 18px;color:#e2e8f0;font-size:13px;line-height:2.0;font-family:Tahoma,Arial,sans-serif;">${noticeSafe}</td></tr>` +
      `</table>`;
  }

  const platform = escapeHtml(t("email.common.footerPlatform"));
  const terms = escapeHtml(t("email.common.terms"));
  const privacy = escapeHtml(t("email.common.privacy"));
  const managePrefs = escapeHtml(t("email.common.managePreferences"));
  const contact = escapeHtml(t("email.common.contact"));
  const rights = escapeHtml(t("email.common.rightsReserved"));
  const copyright = escapeHtml(t("email.common.copyright", { year: String(input.year) }));

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="${langSafe}" dir="${direction}">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="format-detection" content="telephone=no" />
<meta name="color-scheme" content="light dark" />
<title>${titleSafe}</title>
</head>
<body style="margin:0;padding:0;background-color:#eef1f6;font-family:Tahoma,Arial,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;">${titleSafe} — ${subtitleSafe}</div>
<table lang="${langSafe}" dir="${direction}" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#eef1f6;padding:32px 10px;font-family:Tahoma,Arial,sans-serif;">
<tr><td align="center">
<table role="presentation" width="620" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:620px;background:#0e1626;border:1px solid #26334d;border-radius:16px;overflow:hidden;box-shadow:0 12px 32px rgba(10,16,29,0.22);">
<tr><td align="center" style="padding:28px 25px 22px;background:#0a101d;border-bottom:1px solid #26334d;">
<a href="${frontendBase}" style="text-decoration:none;display:inline-block;">
  <img src="cid:velora-logo" width="52" height="52" alt="VELORA TRADE" style="display:block;margin:0 auto 10px;width:52px;height:52px;border:0;outline:none;" />
</a>
<div style="font-family:Arial,Tahoma,sans-serif;font-size:24px;line-height:28px;font-weight:bold;letter-spacing:4px;color:#d4af37;text-align:center;direction:ltr;">VELORA</div>
<div style="margin-top:6px;font-family:Arial,Tahoma,sans-serif;font-size:11px;letter-spacing:3px;color:#cbd5e1;text-align:center;direction:ltr;">${subtitleSafe}</div>
</td></tr>
<tr><td style="padding:30px 26px;font-family:Tahoma,Arial,sans-serif;color:#f3f4f6;direction:${direction};text-align:${textAlign};">
<!-- Gold Outline content module: static, table-based and safe for email clients. -->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#101b2d" style="width:100%;background:#101b2d;border:1px solid #9b782e;border-radius:16px;border-collapse:separate;">
<tr><td style="padding:4px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#0d1829" style="width:100%;background:#0d1829;border:1px solid #3b465a;border-radius:12px;border-collapse:separate;">
<tr><td style="padding:30px 28px;font-family:Tahoma,Arial,sans-serif;color:#f3f4f6;direction:${direction};text-align:${textAlign};">
${iconHtml}
<div style="margin:0 0 12px;color:#e7ca73;font-size:13px;font-weight:bold;letter-spacing:0.5px;">${badgeSafe}</div>
<h1 style="margin:0 0 20px;font-size:24px;line-height:1.6;color:#ffffff;font-weight:bold;">${titleSafe}</h1>
<div style="font-size:15px;line-height:2.1;color:#f3f4f6;">${input.contentHtml}</div>
${button}
${noticeHtml}
</td></tr>
</table>
</td></tr>
</table>
</td></tr>
<tr><td align="center" style="padding:24px 20px;background:#090e18;border-top:1px solid #26334d;font-family:Tahoma,Arial,sans-serif;color:#9eabc0;">
<div style="font-family:Arial,Tahoma,sans-serif;font-size:12px;font-weight:bold;color:#e2e8f0;">${copyright}</div>
<div style="margin-top:5px;font-size:11px;letter-spacing:.5px;color:#9eabc0;">${platform}</div>
<div style="margin-top:14px;font-family:Arial,Tahoma,sans-serif;font-size:12px;direction:ltr;"><a href="${frontendBase}" style="color:#d4af37;text-decoration:none;font-weight:bold;">veloratrade.ir</a><span style="color:#4a5568;"> &nbsp;|&nbsp; </span><a href="mailto:support@veloratrade.ir" style="color:#d4af37;text-decoration:none;">support@veloratrade.ir</a></div>
<div style="margin-top:12px;font-size:11px;line-height:1.9;"><a href="${frontendBase}/support" style="color:#cbd5e1;text-decoration:none;">${contact}</a><span style="color:#4a5568;"> &nbsp;•&nbsp; </span><a href="${frontendBase}/terms" style="color:#cbd5e1;text-decoration:none;">${terms}</a><span style="color:#4a5568;"> &nbsp;•&nbsp; </span><a href="${frontendBase}/privacy" style="color:#cbd5e1;text-decoration:none;">${privacy}</a><span style="color:#4a5568;"> &nbsp;•&nbsp; </span><a href="${frontendBase}/profile?focus=email-preferences" style="color:#cbd5e1;text-decoration:none;">${managePrefs}</a></div>
<div style="margin-top:13px;font-size:10px;color:#718096;">${rights}</div>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * Plain-text alternative — the port of Legacy `Mailer::htmlToPlain`
 * (head/style/script stripped, links folded to `label (url)`, structural
 * tags to newlines, entities decoded). Pure.
 */
export function htmlToPlain(html: string): string {
  let text = html
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

  // <a href="url">label</a> → label (url)  [url alone when labelless/equal]
  text = text.replace(
    /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, url: string, labelHtml: string) => {
      const urlTrim = url.trim();
      const label = labelHtml.replace(/<[^>]*>/g, "").trim();
      if (label === "" || label === urlTrim) return urlTrim;
      return `${label} (${urlTrim})`;
    },
  );

  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|table)>/gi, "\n\n")
    .replace(/<td[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "");

  // html_entity_decode(ENT_QUOTES | ENT_HTML5) for the entities we emit.
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Collapse the whitespace runs the tag folds introduced.
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text;
}
