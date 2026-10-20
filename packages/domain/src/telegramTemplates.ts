// Telegram post templates — the placeholder grammar, the field catalogue it may draw on,
// and the two built-in Velora cards.
//
// WHY THIS LIVES IN THE DOMAIN PACKAGE
// The engine has to be usable from two runtimes (the Node bot process and, later, anything
// that renders the same card server-side) with no IO, no clock and no provider. Everything
// that touches the database or the Bot API is a caller's job; this module only turns a body
// plus a value map into text, and says honestly what it could not fill.
//
// THE THREE RULES THAT SHAPE IT
//  1. A placeholder is a NAME, never an expression. `{{stats.winRate}}` is a lookup;
//     `{{1+1}}`, `{{system.run(...)}}` and `{{stats.winRate.toFixed(2)}}` are not placeholders
//     at all — they are literal text, reported as `unsupported`. There is no evaluator here by
//     construction: the grammar cannot express one.
//  2. Nothing disappears silently. An UNKNOWN name is left in the output exactly as the user
//     typed it and reported in `unknown`; a KNOWN name with no value is replaced by the
//     documented "not recorded" marker and reported in `missing`. A template that renders with
//     holes still tells the user where the holes are — the alternative (dropping the line) is
//     how a post ends up asserting something the data never said.
//  3. Values are data, not template. Substitution is a single pass over the ORIGINAL body, so a
//     value that itself contains `{{symbol}}` cannot be re-scanned, and a value can never smuggle
//     a tag: every value is escaped and only the whitelisted Telegram tags survive sanitisation.
//
// WHAT A VALUE MAY BE
// `null`/`undefined`/empty means "not recorded" — it is NOT the same as `0`, which is a real
// reading. Callers map their real records onto this shape; this module never guesses.

import { escapeHtml } from "./notifications/emailTemplate.js";
import { CHECKLIST_ITEMS } from "./journalChecklist.js";

export type TemplateLocale = "fa" | "en";

/** Marker for "the user never recorded this". Distinct from `0` on purpose. */
export const NOT_RECORDED: Readonly<Record<TemplateLocale, string>> = {
  fa: "— ثبت نشد",
  en: "— not recorded",
};

/** Telegram's own limits, so a caller cannot "fix" a length problem by trusting a bigger number. */
export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;
/** A stored template body longer than this is refused at save time, not truncated. */
export const TEMPLATE_BODY_LIMIT = 8000;

// ─────────────────────────────────────────────────────────── the grammar ──────────────────
// A name is ASCII letters/digits with `.`/`_`/`-` separators, 1..48 chars, starting with an
// alphanumeric. Lowercase is the convention (`checklist.pdArrayH4` keeps the domain's own camelCase
// so a name and the field it mirrors never drift apart), and the character class is deliberately
// ASCII-only: Persian in a NAME would make `{{بایاس}}` and `{{bias}}` two spellings of one field,
// which is a support ticket, not a feature. Persian belongs in the labels and the surrounding text,
// both of which are free.
const NAME_RE = /^[a-z0-9][a-zA-Z0-9._-]{0,47}$/;
const TOKEN_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

export interface TemplateToken {
  readonly raw: string;
  readonly inner: string;
  readonly start: number;
  readonly end: number;
  /** True when `inner` is at least a syntactically legal name. */
  readonly wellFormed: boolean;
  readonly known: boolean;
}

export interface TemplateInspection {
  readonly tokens: readonly TemplateToken[];
  /** Legal names this build has no field for. */
  readonly unknown: readonly string[];
  /** `{{ … }}` shapes that are not a name at all (expressions, calls, empty). */
  readonly unsupported: readonly string[];
  readonly empty: boolean;
  readonly tooLong: boolean;
  /** Markup the caller will have to strip or escape, flagged rather than silently dropped. */
  readonly disallowedTags: readonly string[];
}

/** Every `{{ … }}` in the body, in order, classified. Pure; used by save-time validation. */
export function inspectTemplate(body: string): TemplateInspection {
  const tokens: TemplateToken[] = [];
  const unknown = new Set<string>();
  const unsupported = new Set<string>();
  for (const match of body.matchAll(TOKEN_RE)) {
    const inner = match[1] ?? "";
    const wellFormed = NAME_RE.test(inner);
    const known = wellFormed && TEMPLATE_FIELDS[inner] !== undefined;
    tokens.push({
      raw: match[0],
      inner,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      wellFormed,
      known,
    });
    if (!wellFormed) unsupported.add(inner.trim() === "" ? "(empty)" : inner.trim());
    else if (!known) unknown.add(inner);
  }
  const tags = new Set<string>();
  for (const tag of body.matchAll(/<\/?\s*([a-zA-Z][a-zA-Z0-9]*)\b/g)) {
    const name = (tag[1] ?? "").toLowerCase();
    if (!ALLOWED_TAGS.includes(name)) tags.add(name);
  }
  return {
    tokens,
    unknown: [...unknown].sort(),
    unsupported: [...unsupported].sort(),
    empty: body.trim() === "",
    tooLong: body.length > TEMPLATE_BODY_LIMIT,
    // Persian copy legitimately contains `<` in text; only tagged markup counts here, which is
    // why the scan is for `<name` and not for the character.
    disallowedTags: [...tags].sort(),
  };
}

// ─────────────────────────────────────────────────────────── the field catalogue ───────────
export type TemplateFieldKind = "text" | "money" | "number" | "percent" | "ratio" | "date" | "enum" | "state" | "link" | "image";

export interface TemplateField {
  readonly key: string;
  readonly label: Readonly<Record<TemplateLocale, string>>;
  readonly kind: TemplateFieldKind;
  /** Where a caller must read the value from. Drives the "ask for it or don't offer it" rule. */
  readonly source: "journal" | "checklist" | "stats" | "media" | "analysis" | "user";
  /** True when the value is a number/money figure and a missing one must not render as 0. */
  readonly numeric: boolean;
}

const field = (
  key: string,
  fa: string,
  en: string,
  kind: TemplateFieldKind,
  source: TemplateField["source"],
  numeric = false,
): TemplateField => ({ key, label: { fa, en }, kind, source, numeric });

/** Checklist labels: the checklist module owns the KEYS, this is the display copy. */
export const CHECKLIST_LABELS: Readonly<
  Record<(typeof CHECKLIST_ITEMS)[number], { fa: string; en: string }>
> = {
  dailyBias: { fa: "بایاس روزانه", en: "Daily bias" },
  marketLeg: { fa: "لگ بازار", en: "Market leg" },
  priceLocation: { fa: "موقعیت قیمت", en: "Price location" },
  pdArrayH4: { fa: "PD Array H4", en: "H4 PD array" },
  pdArrayH1: { fa: "PD Array H1", en: "H1 PD array" },
  pdArrayM15: { fa: "PD Array M15", en: "M15 PD array" },
  m1Cisd: { fa: "M1 CISD", en: "M1 CISD" },
  smt: { fa: "SMT", en: "SMT" },
  macroTiming: { fa: "تایمینگ ماکرو", en: "Macro timing" },
  stopLoss: { fa: "حد ضرر", en: "Stop loss" },
  risk: { fa: "ریسک", en: "Risk" },
};

/**
 * The closed set a user template may reference. `stats.*` mirrors `JournalStats`, `checklist.*`
 * mirrors CHECKLIST_ITEMS one-for-one (a new checklist item becomes available here automatically),
 * and the journal keys are the fields `openFromText` can actually carry.
 */
export const TEMPLATE_FIELDS: Readonly<Record<string, TemplateField>> = (() => {
  const list: readonly TemplateField[] = [
    // journal / draft
    field("symbol", "نماد", "Symbol", "text", "journal"),
    field("side", "جهت", "Direction", "enum", "journal"),
    field("timeframe", "تایم‌فریم", "Timeframe", "text", "journal"),
    field("entry", "ورود", "Entry", "money", "journal", true),
    field("exit", "خروج", "Exit", "money", "journal", true),
    field("stop", "استاپ", "Stop", "money", "journal", true),
    field("target", "تارگت", "Target", "money", "journal", true),
    field("risk", "ریسک", "Risk", "text", "journal"),
    field("strategy", "استراتژی", "Strategy", "text", "journal"),
    field("setup", "ستاپ", "Setup", "text", "journal"),
    field("emotion", "احساس", "Emotion", "text", "journal"),
    field("notes", "یادداشت", "Notes", "text", "journal"),
    field("date", "تاریخ", "Date", "date", "journal"),
    field("time", "ساعت", "Time", "text", "journal"),
    // checklist — one placeholder per item, plus its state. Generated from the single source of
    // truth so a 12th item could never be "in the checklist but not fillable in a template".
    ...CHECKLIST_ITEMS.map((item) => field(`checklist.${item}`, labelOf(item).fa, labelOf(item).en, "text", "checklist")),
    ...CHECKLIST_ITEMS.map((item) => field(`checklist.${item}.state`, `${labelOf(item).fa} — وضعیت`, `${labelOf(item).en} — state`, "state", "checklist")),
    field("checklist.confirmed", "موارد تأییدشده", "Confirmed items", "number", "checklist", true),
    field("checklist.unknown", "موارد نامشخص", "Unknown items", "number", "checklist", true),
    field("checklist.unreviewed", "موارد بازبینی‌نشده", "Unreviewed items", "number", "checklist", true),
    // stats
    field("stats.closedCount", "معاملات بسته", "Closed trades", "number", "stats", true),
    field("stats.openCount", "معاملات باز", "Open trades", "number", "stats", true),
    field("stats.netPnl", "سود/زیان خالص", "Net P&L", "money", "stats", true),
    field("stats.winRate", "وین‌ریت", "Win rate", "percent", "stats", true),
    field("stats.profitFactor", "پرافیت‌فاکتور", "Profit factor", "ratio", "stats", true),
    field("stats.averageR", "میانگین R", "Average R", "number", "stats", true),
    field("stats.bestTrade", "بهترین معامله", "Best trade", "number", "stats", true),
    field("stats.worstTrade", "بدترین معامله", "Worst trade", "number", "stats", true),
    field("stats.totalFees", "کارمزد کل", "Total fees", "money", "stats", true),
    field("stats.averageWin", "میانگین سود", "Average win", "money", "stats", true),
    field("stats.averageLoss", "میانگین ضرر", "Average loss", "money", "stats", true),
    field("stats.window", "بازهٔ آمار", "Stats window", "text", "stats"),
    field("stats.sampled", "نمونه‌گیری", "Sampling note", "text", "stats"),
    // media / analysis / user
    field("chart", "تصویر چارت", "Chart image", "image", "media"),
    field("link", "لینک معامله", "Trade link", "link", "media"),
    field("analysis", "تحلیل VELORA", "VELORA analysis", "text", "analysis"),
    field("title", "عنوان", "Title", "text", "user"),
  ];
  const map: Record<string, TemplateField> = {};
  for (const f of list) map[f.key] = f;
  return map;
})();

function labelOf(item: (typeof CHECKLIST_ITEMS)[number]): { fa: string; en: string } {
  return CHECKLIST_LABELS[item];
}


export function isTemplateFieldName(name: string): boolean {
  return NAME_RE.test(name) && TEMPLATE_FIELDS[name] !== undefined;
}

// ───────────────────────────────────────────────────────── rendering ───────────────────────
export type TemplateValues = Readonly<Record<string, string | number | null | undefined>>;

export interface RenderInput {
  readonly body: string;
  readonly values: TemplateValues;
  readonly locale: TemplateLocale;
  /** Escape values and keep only Telegram's own tags. Off only for a caller that sends no HTML. */
  readonly markup?: boolean | undefined;
  /**
   * Hosts an `<a href>` in the body may keep. EMPTY BY DEFAULT, AND EMPTY MEANS NO LINK SURVIVES: a
   * caller that forgets to configure this gets text, not a clickable destination to anywhere.
   */
  readonly allowedLinkHosts?: readonly string[] | undefined;
  readonly limit?: number | undefined;
}

export interface RenderResult {
  readonly text: string;
  /** Known names with no value: the line still renders, with the marker. */
  readonly missing: readonly string[];
  /** Names this build does not know, left in the text verbatim so the user can see them. */
  readonly unknown: readonly string[];
  /** `{{…}}` shapes that are not names — left verbatim, never evaluated. */
  readonly unsupported: readonly string[];
  /** Tags stripped by sanitisation, reported rather than dropped quietly. */
  readonly strippedTags: readonly string[];
  readonly truncated: boolean;
  /** True only when truncation could not balance the markup, so tags were dropped to stay sendable. */
  readonly markupDropped: boolean;
  readonly direction: "rtl" | "ltr";
}

const ALLOWED_TAGS: readonly string[] = ["b", "strong", "i", "em", "u", "ins", "s", "strike", "code", "pre", "blockquote", "a"];

/**
 * Keep Telegram's tag subset, escape everything else.
 *
 * Deliberately NOT a general HTML sanitizer: it is only ever applied to text we then send as
 * `parse_mode: HTML`, and Telegram rejects unbalanced tags. So the contract is (a) no tag
 * outside the list, (b) no attributes on the tags we keep except `href` on `<a>`, and (c) an
 * `href` only to an https URL on an allowed host. Anything else becomes escaped text.
 */
export function sanitizeTelegramMarkup(
  html: string,
  allowedHosts: readonly string[] = [],
): { text: string; stripped: string[] } {
  const stripped: string[] = [];
  const text = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*)?)(\s*\/?)>/g, (whole, nameRaw: string, attrsRaw = "", selfClose = "") => {
    const name = (nameRaw as string).toLowerCase();
    const closing = whole.startsWith("</");
    const tag = ALLOWED_TAGS.includes(name) && !closing ? normalizeTag(name) : normalizeTag(name);
    // A self-closing form is not part of the subset Telegram accepts, and neither is any tag
    // outside the list: both become escaped text, reported so the preview can say so.
    if (selfClose !== "" || tag === null) {
      stripped.push(name);
      return escapeHtml(whole);
    }
    if (name === "a") {
      if (!closing) {
        const href = /(?:^|\s)href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrsRaw);
        const url = href?.[2] ?? href?.[3] ?? "";
        if (!isAllowedLink(url, allowedHosts)) {
          // Drop the ANCHOR, keep the label: the destination is what we refuse, the words the
          // user wrote are content. The orphan `</a>` is removed by `closeOpenTags`.
          stripped.push("a");
          return "";
        }
        return `<a href="${escapeHtml(url)}">`;
      }
      return "</a>";
    }
    // Every other allowed tag carries no attributes in this subset — `style`/`class`/`onclick`
    // on a <b> is as much an injection surface as a <script>, and Telegram ignores it anyway.
    if (attrsRaw.trim() !== "" && !closing) {
      stripped.push(name);
      return escapeHtml(whole);
    }
    return `<${closing ? "/" : ""}${tag}>`;
  });
  return { text: closeOpenTags(text), stripped: [...new Set(stripped)] };
}

/** Drop a trailing partial tag (`<blo`) or partial entity (`&am`) — never valid send markup. */
function trimPartialMarkup(value: string): string {
  let out = value;
  const lt = out.lastIndexOf("<");
  const gt = out.lastIndexOf(">");
  if (lt > gt) out = out.slice(0, lt);
  const amp = out.lastIndexOf("&");
  const semi = out.lastIndexOf(";");
  if (amp > semi && out.length - amp <= 10) out = out.slice(0, amp);
  return out;
}

/**
 * Balance the tags we kept.
 *
 * A template author can write `<b>x</b></b>` or `<b>x<i>`; Telegram's parser rejects unbalanced
 * markup, so a post that renders fine here would fail at send time. The rule is boring on purpose:
 * walk the kept tags, and for whatever is still open at the end, close it in reverse order.
 * Stray closers with nothing open are dropped. No inference about intent, no re-nesting.
 */
function closeOpenTags(text: string): string {
  const stack: string[] = [];
  const drop: number[] = [];
  for (const m of text.matchAll(/<(\/?)(b|i|u|s|code|pre|blockquote|a)\b[^>]*>/g)) {
    const at = m.index ?? 0;
    const tag = m[2] ?? "b";
    if (m[1] === "/") {
      const idx = stack.lastIndexOf(tag);
      if (idx < 0) drop.push(at);
      else stack.splice(idx);
    } else {
      stack.push(tag);
    }
  }
  let out = text;
  // Cut the orphan closers from the end backwards so earlier indices stay valid.
  for (const at of drop.sort((a, b) => b - a)) out = out.slice(0, at) + out.slice(at + 4);
  return out + closersFor(out);
}

/** The closers a string needs, in the order that nests correctly. "" when it is already balanced. */
function closersFor(text: string): string {
  const stack: string[] = [];
  for (const m of text.matchAll(/<(\/?)(b|i|u|s|code|pre|blockquote|a)\b[^>]*>/gu)) {
    const tag = m[2] ?? "b";
    if (m[1] === "/") {
      const idx = stack.lastIndexOf(tag);
      if (idx >= 0) stack.splice(idx);
    } else stack.push(tag);
  }
  return stack.reverse().map((t) => `</${t}>`).join("");
}

function normalizeTag(name: string): string | null {
  switch (name) {
    case "strong":
      return "b";
    case "em":
      return "i";
    case "ins":
      return "u";
    case "strike":
      return "s";
    default:
      return ALLOWED_TAGS.includes(name) ? name : null;
  }
}

export function isAllowedLink(url: string, allowedHosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  // AN EMPTY ALLOWLIST MEANS "NOTHING IS PERMITTED", not "everything is". The inversion is the whole
  // bug class: a caller with no configuration (no app origin set, a test harness, a Worker that
  // failed to read config) would otherwise publish EVERY https link a template body contains — and a
  // template body is user text. Refusing on empty costs one absent link; allowing on empty costs a
  // phishing button in front of the user's audience, signed with their own account.
  if (allowedHosts.length === 0) return false;
  return allowedHosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
}

/**
 * One pass over the body. Unknown/unsupported shapes are emitted verbatim; known-but-empty ones
 * get the marker; everything is escaped before it is re-assembled.
 */
export function renderTemplate(input: RenderInput): RenderResult {
  const { body, values, locale } = input;
  const markup = input.markup ?? true;
  const limit = input.limit ?? TELEGRAM_TEXT_LIMIT;
  const missing: string[] = [];
  const unknown: string[] = [];
  const unsupported: string[] = [];
  let out = "";
  let cursor = 0;
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(body)) !== null) {
    out += body.slice(cursor, match.index);
    cursor = (match.index ?? 0) + match[0].length;
    const inner = (match[1] ?? "").trim();
    if (!NAME_RE.test(inner)) {
      unsupported.push(inner === "" ? "(empty)" : inner);
      out += escapeHtml(match[0]);
      continue;
    }
    const spec = TEMPLATE_FIELDS[inner];
    if (spec === undefined) {
      unknown.push(inner);
      out += escapeHtml(match[0]);
      continue;
    }
    const raw = values[inner];
    const filled = raw !== null && raw !== undefined && String(raw).trim() !== "";
    if (!filled) {
      missing.push(inner);
      out += NOT_RECORDED[locale];
      continue;
    }
    const rendered = formatValue(String(raw), spec, locale);
    out += markup ? escapeHtml(rendered) : rendered;
  }
  out += body.slice(cursor);

  const stripped: string[] = [];
  if (markup) {
    const clean = sanitizeTelegramMarkup(out, input.allowedLinkHosts ?? []);
    out = clean.text;
    stripped.push(...clean.stripped);
  }
  let truncated = false;
  let markupDropped = false;
  if (out.length > limit) {
    // A truncation that splits a tag or an entity is a Telegram parse failure, and one that eats
    // an opener is another — so the cut and the balancing closers are computed together and
    // re-fitted, bounded by a guard instead of an assumption about how many tags are open.
    truncated = true;
    // The room the closers need is measured BEFORE the cut, never discovered by hitting the wall.
    // A balanced string needs nothing, so the reserve is 0 and the full budget is usable; a prefix
    // can only ever open FEWER tags than the whole text, so reserving by the whole text's closers
    // (then re-measuring on the trimmed prefix) cannot under-reserve.
    let budget = limit - 1 - closersFor(out).length;
    let cut = "";
    let closers = "";
    let fits = false;
    for (let guard = 0; guard < 4 && budget > 0; guard += 1) {
      cut = trimPartialMarkup(out.slice(0, budget));
      closers = closersFor(cut);
      if (cut.length + closers.length + 1 <= limit) {
        fits = true;
        break;
      }
      // Move the cut back by exactly what the closers need. Anything more is content the user
      // wrote that we would be throwing away for no reason.
      budget = limit - 1 - closers.length;
    }
    if (fits) {
      out = `${cut}${closers}…`;
    } else {
      // No cut that both fits and balances exists (an enormous run of unclosed tags). Then the
      // formatting goes and the TEXT is what is preserved — stripping BEFORE cutting is what keeps
      // close to `limit` characters of real content instead of collapsing to an ellipsis.
      // `markupDropped` says out loud that the preview and the post differ in styling; that is the
      // honest outcome, and a silent one would be a lie about what was sent.
      out = `${trimPartialMarkup(out.replace(/<\/?[a-z]+(?:\s[^<>]*)?>/gu, "").slice(0, limit - 1))}…`;
      markupDropped = true;
    }
  }
  return {
    text: out,
    missing: [...new Set(missing)],
    unknown: [...new Set(unknown)],
    unsupported: [...new Set(unsupported)],
    strippedTags: [...new Set(stripped)],
    truncated,
    markupDropped,
    direction: locale === "fa" ? "rtl" : "ltr",
  };
}

/**
 * Formatting is per-kind and only for display: `percent`/`ratio`/`money` values arrive ALREADY
 * computed by the domain/DB (a `winRate` is a percentage string, `netPnl` a decimal string), so
 * this never re-derives a number — it only adds a unit or a sign. Re-deriving here would put a
 * second, drifting copy of the P&L maths in the presentation layer.
 */
function formatValue(value: string, spec: TemplateField, locale: TemplateLocale): string {
  switch (spec.kind) {
    case "percent":
      return /^-?\d+(\.\d+)?$/.test(value) ? `${value}%` : value;
    case "state":
      return value === "CONFIRMED" ? (locale === "fa" ? "تأیید" : "confirmed") : value === "UNKNOWN" ? (locale === "fa" ? "نامشخص" : "unknown") : value === "UNREVIEWED" ? (locale === "fa" ? "بازبینی‌نشده" : "unreviewed") : value;
    case "link":
      return value;
    case "image":
      return value;
    default:
      return value;
  }
}

// ───────────────────────────────────────────────── the two built-in cards ──────────────────
export interface TemplateDefinition {
  readonly id: string;
  readonly version: number;
  readonly name: Readonly<Record<TemplateLocale, string>>;
  readonly description: Readonly<Record<TemplateLocale, string>>;
  readonly body: Readonly<Record<TemplateLocale, string>>;
  readonly builtIn: true;
  /** Which values the service must gather before this can render. */
  readonly requires: { readonly journal: boolean; readonly checklist: boolean; readonly stats: boolean };
}

/**
 * Built-in A — Trading Bias card.
 *
 * Every line is a field the trader confirmed (or explicitly marked unknown). The AI-supplied
 * reading is present only under a heading that says it is an AI interpretation, and it is omitted
 * entirely when there is none — a card that padded "no analysis" with "neutral" would be a
 * fabrication wearing brand colours.
 */
export const BUILT_IN_TEMPLATES: readonly TemplateDefinition[] = [
  {
    id: "velora.bias",
    version: 1,
    builtIn: true,
    name: { fa: "کارت بایاس معاملاتی", en: "Trading Bias Card" },
    description: {
      fa: "بایاس روزانه، لگ بازار، تایم‌فریم‌ها، ریسک و استاپ — فقط فیلدهای تأییدشده.",
      en: "Daily bias, market leg, timeframes, risk and stop — confirmed fields only.",
    },
    requires: { journal: true, checklist: true, stats: false },
    body: {
      fa: [
        "<b>VELORA | بایاس روزانه</b>",
        "تاریخ: {{date}}",
        "نماد: {{symbol}} · تایم‌فریم: {{timeframe}}",
        "",
        "بایاس روزانه: {{checklist.dailyBias}} ({{checklist.dailyBias.state}})",
        "لگ بازار: {{checklist.marketLeg}} ({{checklist.marketLeg.state}})",
        "موقعیت قیمت: {{checklist.priceLocation}} ({{checklist.priceLocation.state}})",
        "PD آرایه H4: {{checklist.pdArrayH4}} ({{checklist.pdArrayH4.state}})",
        "PD آرایه H1: {{checklist.pdArrayH1}} ({{checklist.pdArrayH1.state}})",
        "PD آرایه M15: {{checklist.pdArrayM15}} ({{checklist.pdArrayM15.state}})",
        "M1 CISD: {{checklist.m1Cisd}} ({{checklist.m1Cisd.state}})",
        "SMT: {{checklist.smt}} ({{checklist.smt.state}})",
        "تایمینگ ماکرو: {{checklist.macroTiming}} ({{checklist.macroTiming.state}})",
        "",
        "استاپ: {{checklist.stopLoss}} · ریسک: {{checklist.risk}}",
        "{{analysis}}",
      ].join("\n"),
      en: [
        "<b>VELORA | Daily Bias</b>",
        "Date: {{date}}",
        "Symbol: {{symbol}} · Timeframe: {{timeframe}}",
        "",
        "Daily bias: {{checklist.dailyBias}} ({{checklist.dailyBias.state}})",
        "Market leg: {{checklist.marketLeg}} ({{checklist.marketLeg.state}})",
        "Price location: {{checklist.priceLocation}} ({{checklist.priceLocation.state}})",
        "H4 PD array: {{checklist.pdArrayH4}} ({{checklist.pdArrayH4.state}})",
        "H1 PD array: {{checklist.pdArrayH1}} ({{checklist.pdArrayH1.state}})",
        "M15 PD array: {{checklist.pdArrayM15}} ({{checklist.pdArrayM15.state}})",
        "M1 CISD: {{checklist.m1Cisd}} ({{checklist.m1Cisd.state}})",
        "SMT: {{checklist.smt}} ({{checklist.smt.state}})",
        "Macro timing: {{checklist.macroTiming}} ({{checklist.macroTiming.state}})",
        "",
        "Stop: {{checklist.stopLoss}} · Risk: {{checklist.risk}}",
        "{{analysis}}",
      ].join("\n"),
    },
  },
  {
    id: "velora.setup",
    version: 1,
    builtIn: true,
    name: { fa: "کارت ستاپ/چک‌لیست", en: "Setup Checklist Card" },
    description: {
      fa: "چک‌لیست ستاپ با شمارش وضعیت‌ها، پلن معامله و تصویر چارت.",
      en: "The setup checklist with state counts, the trade plan and the chart image.",
    },
    requires: { journal: true, checklist: true, stats: false },
    body: {
      fa: [
        "<b>VELORA | چک‌لیست ستاپ</b>",
        "{{symbol}} · {{side}} · {{timeframe}} · {{date}}",
        "تأییدشده {{checklist.confirmed}} · نامشخص {{checklist.unknown}} · بازبینی‌نشده {{checklist.unreviewed}}",
        "",
        "ورود: {{entry}} · استاپ: {{stop}} · تارگت: {{target}}",
        "ریسک: {{risk}} · استراتژی: {{strategy}}",
        "",
        "یادداشت: {{notes}}",
        "{{analysis}}",
      ].join("\n"),
      en: [
        "<b>VELORA | Setup Checklist</b>",
        "{{symbol}} · {{side}} · {{timeframe}} · {{date}}",
        "Confirmed {{checklist.confirmed}} · unknown {{checklist.unknown}} · unreviewed {{checklist.unreviewed}}",
        "",
        "Entry: {{entry}} · Stop: {{stop}} · Target: {{target}}",
        "Risk: {{risk}} · Strategy: {{strategy}}",
        "",
        "Notes: {{notes}}",
        "{{analysis}}",
      ].join("\n"),
    },
  },
  {
    id: "velora.weekly",
    version: 1,
    builtIn: true,
    name: { fa: "خلاصهٔ عملکرد", en: "Performance Summary" },
    description: {
      fa: "آمار بازه با برچسب نمونه‌گیری، اگر آمار کامل نباشد.",
      en: "Window statistics, carrying the sampling label whenever the window is not complete.",
    },
    requires: { journal: false, checklist: false, stats: true },
    body: {
      fa: [
        "<b>VELORA | عملکرد</b>",
        "بازه: {{stats.window}}",
        "{{stats.sampled}}",
        "",
        "بسته: {{stats.closedCount}} · باز: {{stats.openCount}}",
        "وین‌ریت: {{stats.winRate}} · PF: {{stats.profitFactor}}",
        "P&L خالص: {{stats.netPnl}} · میانگین R: {{stats.averageR}}",
        "کارمزد: {{stats.totalFees}} · میانگین سود: {{stats.averageWin}} · میانگین ضرر: {{stats.averageLoss}}",
      ].join("\n"),
      en: [
        "<b>VELORA | Performance</b>",
        "Window: {{stats.window}}",
        "{{stats.sampled}}",
        "",
        "Closed: {{stats.closedCount}} · Open: {{stats.openCount}}",
        "Win rate: {{stats.winRate}} · PF: {{stats.profitFactor}}",
        "Net P&L: {{stats.netPnl}} · Average R: {{stats.averageR}}",
        "Fees: {{stats.totalFees}} · Avg win: {{stats.averageWin}} · Avg loss: {{stats.averageLoss}}",
      ].join("\n"),
    },
  },
];

export function builtinTemplate(id: string): TemplateDefinition | null {
  return BUILT_IN_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** Placeholders a caller must be able to fill for a definition — used by `missing` messaging. */
export function templateFieldKeys(body: string): string[] {
  const keys = new Set<string>();
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(body)) !== null) {
    const inner = (match[1] ?? "").trim();
    if (NAME_RE.test(inner) && TEMPLATE_FIELDS[inner] !== undefined) keys.add(inner);
  }
  return [...keys];
}

/** Human-readable explanation of what a template needs — the "explain it" half of validation. */
export function describeTemplateGaps(
  inspection: TemplateInspection,
  missing: readonly string[],
  locale: TemplateLocale,
): string[] {
  const lines: string[] = [];
  if (inspection.empty) lines.push(locale === "fa" ? "متن قالب خالی است." : "The template body is empty.");
  if (inspection.tooLong)
    lines.push(
      locale === "fa"
        ? `قالب از ${TEMPLATE_BODY_LIMIT} کاراکتر بلندتر است؛ ذخیره نمی‌شود.`
        : `The template is longer than ${TEMPLATE_BODY_LIMIT} characters and is not saved.`,
    );
  for (const name of inspection.unknown)
    lines.push(locale === "fa" ? `«${name}» را نمی‌شناسم — در متن می‌ماند.` : `Unknown field "{{${name}}}" — it will stay in the text.`);
  for (const name of inspection.unsupported)
    lines.push(
      locale === "fa"
        ? `«{{${name}}}» فیلد نیست؛ محاسبات در قالب مجاز نیست.`
        : `"{{${name}}}" is not a field. Templates cannot compute or run expressions.`,
    );
  for (const tag of inspection.disallowedTags)
    if (!ALLOWED_TAGS.includes(tag))
      lines.push(
        locale === "fa" ? `تگ <${tag}> پشتیبانی نمی‌شود و حذف می‌شود.` : `<${tag}> is not supported and will be removed.`,
      );
  for (const key of missing)
    lines.push(
      locale === "fa" ? `${key}: داده‌ای ثبت نشده (با «${NOT_RECORDED.fa}» نمایش داده می‌شود).` : `${key}: not recorded (shown as "${NOT_RECORDED.en}").`,
    );
  return lines;
}
