/*
 * Product rule (Legacy `velora-latin-digits.js`, i18n parity gate):
 * every numeral shown by the product is Latin 0-9, in every locale.
 * Pure string functions only — safe for server and client.
 */
const NON_LATIN_DIGIT = /[\u06F0-\u06F9\u0660-\u0669]/g;

export function toLatin(value: unknown): string {
  return String(value ?? "")
    .replace(NON_LATIN_DIGIT, (ch) => {
      const code = ch.charCodeAt(0);
      if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
      return String(code - 0x0660);
    })
    // Arabic decimal/thousands separators are not digits but must render as Latin punctuation.
    .replace(/[\u066B\u066C]/g, (ch) => (ch === "\u066B" ? "." : ","));
}

export function interpolate(message: string, params?: Readonly<Record<string, unknown>> | null): string {
  if (!params) return toLatin(message);
  return toLatin(
    message.replace(/\{([A-Za-z0-9_.-]+)\}/g, (whole, key: string) =>
      Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole,
    ),
  );
}

export interface DigitSegment {
  readonly text: string;
  readonly digits: boolean;
}

/**
 * Splits text into digit runs and other text, with the exact run grammar of the
 * Legacy walker (`/([0-9][0-9.,:+\-/%]*)/`). Digit runs are rendered as
 * `<span class="v-latn-num" lang="en" dir="ltr">` so bidi isolation and the
 * `.v-latn-num` typography match Legacy — but on the server, with no DOM observer.
 */
export function splitDigitRuns(value: string): DigitSegment[] {
  const text = toLatin(value);
  const out: DigitSegment[] = [];
  for (const part of text.split(/([0-9][0-9.,:+\-/%]*)/g)) {
    if (!part) continue;
    out.push({ text: part, digits: /[0-9]/.test(part) });
  }
  return out;
}
