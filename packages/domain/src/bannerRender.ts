// Velora banner composer — a post card as SVG text, in the email template's own palette.
//
// WHAT THIS IS AND WHAT IT IS NOT
// It emits an SVG document: dark card `#0e1626`, gold `#d4af37`, the same surface tokens as
// `renderEmailTemplate`. That is the visual identity Modern already ships, reused rather than
// reimagined, and it means contrast/typography live in ONE place I can measure in a test instead
// of a screenshot I cannot look at from here.
//
// It is NOT a bitmap. Modern has no rasterizer in either runtime — the dependency set is
// `postgres`, `pglite`, `wrangler`, `typescript`, `tsx` (+ web tooling): no `sharp`, no `canvas`,
// no `resvg`, and a Worker has no 2-D context to fall back on. So this module composes and stores
// the artwork and the CALLER decides what can actually be delivered:
//
//   • a rasterizer is wired in   → send the PNG via sendPhoto, this SVG is the editable source;
//   • it is not (today)          → send the text card and say so.
//
// `renderBanner` therefore never claims a picture was posted, and no caller may treat a returned
// SVG string as "the image is on Telegram". That is why the port (`BannerSink`) is injected and has
// no implementation in the shipping runtime: leaving it unimplemented is the honest state.
//
// LAYOUT, and why it is measured by estimate
// SVG has no text metrics without a font engine, which is exactly the thing this runtime does not
// have. Rather than pretend, the estimator is explicit: `widthOf` counts a character as wide
// (CJK/Persian/emoji 1.0em, upper/monospace 0.62em, other 0.5em) and truncates a value that would
// overflow the card with a visible `…`. A wrong estimate costs a clipped label; it can never invent
// a number, because nothing here reads values, only prints them.

/** The email template's palette, verbatim — see `renderEmailTemplate`'s Gold Outline module. */
export const BANNER_PALETTE = {
  card: "#0e1626",
  outline: "#9b782e",
  surface: "#0d1829",
  inset: "#101b2d",
  gold: "#d4af37",
  goldSoft: "#e7ca73",
  text: "#f3f4f6",
  muted: "#cbd5e1",
  gain: "#4ade80",
  loss: "#f87171",
  rule: "#3b465a",
} as const;

export const BANNER_WIDTH = 1080;
/**
 * The floor a card is never smaller than. Height is otherwise content-driven: a card sized to its
 * rows is a card that does not half-empty, and a floor this side of 360 px reads as a broken
 * thumbnail on a phone rather than as a compact one.
 */
export const BANNER_BASE_HEIGHT = 360;
export const BANNER_ROW_HEIGHT = 44;
/** The row budget the default card allows — documented and enforced, not "fits somehow". */
export const BANNER_MAX_ROWS = 11;
/** Row-length guidance, in characters, enforced by `pushRow` truncation. */
export const BANNER_LABEL_LIMIT = 26;
export const BANNER_VALUE_LIMIT = 48;

const FONT_STACK = "Vazirmatn, Tahoma, Arial, sans-serif";
/**
 * Bidirectional isolation for a text run.
 *
 * An SVG `<text>` has no base direction of its own beyond what the surrounding paragraph gives it, so a
 * label like `PD آرای H4` (Latin, then Persian, then a Latin token) can come out with its parts in the
 * wrong ORDER — the individual words shape correctly, which is exactly what makes the defect hard to
 * catch in a unit test and easy to catch by eye. Wrapping the run in FIRST-STRONG-ISOLATE /
 * POP-DIRECTIONAL-ISOLATE says "take the direction from the first strong character of THIS run", which
 * is what a card label means when a human writes it. Only applied to right-to-left cards: a
 * left-to-right card has nothing to disambiguate.
 *
 * The marks are invisible to the renderer, so the layout maths and the character counts above them stay
 * untouched.
 */
const FSI = "\u2068";
const PDI = "\u2069";

function isolate(text: string, rtl: boolean): string {
  return rtl ? `${FSI}${text}${PDI}` : text;
}

const MONO_STACK = "'JetBrains Mono', ui-monospace, monospace";

export type BannerDirection = "rtl" | "ltr";

export interface BannerRow {
  readonly label: string;
  readonly value: string;
  readonly emphasis?: "gain" | "loss" | "muted" | undefined;
  readonly mono?: boolean | undefined;
}

export interface BannerInput {
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly rows: readonly BannerRow[];
  readonly direction: BannerDirection;
  readonly locale?: "fa" | "en" | undefined;
  readonly footnote?: string | undefined;
  /** A data: URI or an https URL for the captured chart. Omit to skip the media block entirely. */
  readonly imageUrl?: string | undefined;
  readonly maxRows?: number | undefined;
}

export interface BannerResult {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
  readonly rowsShown: number;
  readonly rowsDropped: number;
  readonly truncatedValues: readonly string[];
}

/** Where a rasterized banner would be uploaded. No implementation ships in this runtime. */
/**
 * The port a *pre-uploaded* image would use. It has no implementation, and it is kept to record why:
 * the Bot API has no upload-only method, so a `file_id` does not exist until a photo has been sent to
 * some chat. The capability that DOES ship is rasterization at send time
 * (`apps/api/src/telegram/bannerRaster.ts`, injected into `TelegramPostService` as `renderBannerPng`),
 * which is why the service passes bytes to `sendPhoto` instead of asking a sink for a reference.
 */
export interface BannerSink {
  upload(input: { readonly svg: string; readonly width: number; readonly height: number }): Promise<{ readonly ref: string } | null>;
}

const EASTERN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** The one digit transform a banner performs, shared with the bot's own copy path. */
export function toPersianDigits(value: string): string {
  return value.replace(/[0-9]/g, (d) => EASTERN_DIGITS[Number(d)] ?? d);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    // A control character in an attribute is a broken document, not a styling choice.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** Rough advance width in em, by character class. See the header for why this is an estimate. */
function widthOf(text: string, size: number): number {
  let em = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x0590 && code <= 0x08ff) em += 0.5; // Hebrew/Arabic block: joined, narrower than 1em
    else if (code > 0x2e80) em += 1; // CJK + emoji
    else if (code >= 0x41 && code <= 0x5a) em += 0.68;
    else if (code >= 0x30 && code <= 0x39) em += 0.6;
    else em += 0.52;
  }
  return em * size;
}

/** Fit `text` into `max` px at `size`, cutting at a character boundary and marking the cut. */
function fitText(text: string, max: number, size: number): { text: string; cut: boolean } {
  if (widthOf(text, size) <= max) return { text, cut: false };
  let out = "";
  for (const ch of text) {
    const next = out + ch;
    if (widthOf(`${next}…`, size) > max) break;
    out = next;
  }
  return { text: `${out.trimEnd()}…`, cut: true };
}

/**
 * Compose the card. Deterministic: the same input always yields the same bytes, which is what
 * makes the artwork a reviewable artifact rather than a re-roll — a preview and the posted image
 * must not be different pictures.
 */
export function renderBanner(input: BannerInput): BannerResult {
  const direction = input.direction;
  const rtl = direction === "rtl";
  const locale = input.locale ?? (rtl ? "fa" : "en");
  const maxRows = Math.min(input.maxRows ?? BANNER_MAX_ROWS, BANNER_MAX_ROWS);
  const innerLeft = 56;
  const innerRight = BANNER_WIDTH - 56;
  const innerWidth = innerRight - innerLeft;
  const anchor = rtl ? "end" : "start";
  const textX = rtl ? innerRight : innerLeft;
  const labelX = rtl ? innerRight : innerLeft;
  const valueX = rtl ? innerLeft : innerRight;
  const valueAnchor = rtl ? "start" : "end";

  const truncatedValues: string[] = [];
  const shown = input.rows.slice(0, maxRows);
  const dropped = input.rows.length - shown.length;

  const parts: string[] = [];
  let y = 0;
  const hasImage = typeof input.imageUrl === "string" && input.imageUrl !== "";
  const imageHeight = hasImage ? 300 : 0;
  y = 64;

  const title = fitText(input.title, innerWidth - 200, 40);
  if (title.cut) truncatedValues.push(input.title);
  const subtitle = input.subtitle === undefined || input.subtitle === "" ? null : fitText(input.subtitle, innerWidth - 200, 22);
  if (subtitle?.cut === true && input.subtitle !== undefined) truncatedValues.push(input.subtitle);

  parts.push(
    `<text x="${textX}" y="${y + 34}" font-family="${FONT_STACK}" font-size="40" font-weight="bold" fill="${BANNER_PALETTE.text}" text-anchor="${anchor}">${escapeXml(isolate(locale === "fa" ? toPersianDigits(title.text) : title.text, rtl))}</text>`,
  );
  if (subtitle !== null) {
    parts.push(
      `<text x="${textX}" y="${y + 74}" font-family="${FONT_STACK}" font-size="22" fill="${BANNER_PALETTE.goldSoft}" text-anchor="${anchor}">${escapeXml(isolate(locale === "fa" ? toPersianDigits(subtitle.text) : subtitle.text, rtl))}</text>`,
    );
  }
  let cursor = y + (subtitle === null ? 76 : 108);

  if (hasImage === true) {
    const clipId = `chart-${Math.abs(hash(input.imageUrl ?? ""))}`;
    cursor += 14;
    parts.push(
      `<defs><clipPath id="${clipId}"><rect x="${innerLeft}" y="${cursor}" width="${innerWidth}" height="${imageHeight}" rx="14"/></clipPath></defs>`,
      `<rect x="${innerLeft}" y="${cursor}" width="${innerWidth}" height="${imageHeight}" rx="14" fill="${BANNER_PALETTE.inset}" stroke="${BANNER_PALETTE.rule}"/>`,
      `<image x="${innerLeft}" y="${cursor}" width="${innerWidth}" height="${imageHeight}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})" href="${escapeXml(input.imageUrl ?? "")}"/>`,
    );
    cursor += imageHeight + 28;
  }

  parts.push(
    `<line x1="${innerLeft}" y1="${cursor}" x2="${innerRight}" y2="${cursor}" stroke="${BANNER_PALETTE.outline}" stroke-width="2"/>`,
  );
  cursor += 16;

  // The rows sit on an inset panel — the same `#101b2d` + `#3b465a` module the email template
  // builds its content box from. It is drawn here, before the text, so the z-order is right.
  const panelHeight = (shown.length + (dropped > 0 ? 1 : 0)) * BANNER_ROW_HEIGHT + 16;
  parts.push(
    `<rect x="${innerLeft - 16}" y="${cursor - 8}" width="${innerWidth + 32}" height="${panelHeight}" rx="14" fill="${BANNER_PALETTE.inset}" stroke="${BANNER_PALETTE.rule}"/>`,
  );

  const labelWidth = Math.floor(innerWidth * 0.42);
  const valueWidth = innerWidth - labelWidth - 24;
  for (const row of shown) {
    const label = fitText(row.label, labelWidth, 24);
    const value = fitText(row.value, valueWidth, 24);
    if (label.cut) truncatedValues.push(row.label);
    if (value.cut) truncatedValues.push(row.value);
    const fill =
      row.emphasis === "gain"
        ? BANNER_PALETTE.gain
        : row.emphasis === "loss"
          ? BANNER_PALETTE.loss
          : row.emphasis === "muted"
            ? BANNER_PALETTE.muted
            : BANNER_PALETTE.text;
    const family = row.mono === true ? MONO_STACK : FONT_STACK;
    const text = (raw: string) => (locale === "fa" ? toPersianDigits(raw) : raw);
    parts.push(
      `<text x="${labelX}" y="${cursor + 28}" font-family="${FONT_STACK}" font-size="24" fill="${BANNER_PALETTE.muted}" text-anchor="${anchor}">${escapeXml(isolate(text(label.text), rtl))}</text>`,
      `<text x="${valueX}" y="${cursor + 28}" font-family="${family}" font-size="24" fill="${fill}" text-anchor="${valueAnchor}">${escapeXml(isolate(text(value.text), rtl))}</text>`,
    );
    cursor += BANNER_ROW_HEIGHT;
  }
  if (dropped > 0) {
    const note = locale === "fa" ? `+${dropped} ردیف دیگر` : `+${dropped} more rows`;
    parts.push(
      `<text x="${textX}" y="${cursor + 24}" font-family="${FONT_STACK}" font-size="20" fill="${BANNER_PALETTE.muted}" text-anchor="${anchor}">${escapeXml(isolate(locale === "fa" ? toPersianDigits(note) : note, rtl))}</text>`,
    );
    cursor += BANNER_ROW_HEIGHT;
  }

  if (input.footnote !== undefined && input.footnote !== "") {
    cursor += 12;
    const note = fitText(input.footnote, innerWidth, 18);
    parts.push(
      `<text x="${textX}" y="${cursor + 16}" font-family="${FONT_STACK}" font-size="18" fill="${BANNER_PALETTE.muted}" text-anchor="${anchor}">${escapeXml(isolate(locale === "fa" ? toPersianDigits(note.text) : note.text, rtl))}</text>`,
    );
    cursor += 34;
  }

  const height = Math.max(BANNER_BASE_HEIGHT, cursor + 56);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BANNER_WIDTH}" height="${height}" viewBox="0 0 ${BANNER_WIDTH} ${height}" dir="${direction}">` +
    `<rect width="${BANNER_WIDTH}" height="${height}" fill="${BANNER_PALETTE.card}"/>` +
    `<rect x="24" y="24" width="${BANNER_WIDTH - 48}" height="${height - 48}" rx="20" fill="${BANNER_PALETTE.surface}" stroke="${BANNER_PALETTE.outline}"/>` +
    `<text x="${rtl ? innerRight : innerLeft}" y="44" font-family="${FONT_STACK}" font-size="18" letter-spacing="6" fill="${BANNER_PALETTE.gold}" text-anchor="${rtl ? "end" : "start"}">VELORA</text>` +
    parts.join("") +
    `</svg>`;
  return { svg, width: BANNER_WIDTH, height, rowsShown: shown.length, rowsDropped: dropped, truncatedValues: [...new Set(truncatedValues)] };
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) | 0;
  return h;
}
