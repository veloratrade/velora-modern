/*
 * Product rule (legacy `velora-latin-digits.js` / i18n parity gate):
 * digits stay Latin 0-9 in every locale. Persian (U+06F0..) and Arabic-Indic
 * (U+0660..) digits are mapped back to ASCII.
 */
export function latinDigits(value: unknown): string {
  return String(value ?? '').replace(/[\u06F0-\u06F9\u0660-\u0669]/g, (ch) => {
    const code = ch.charCodeAt(0);
    if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
    if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
    return ch;
  });
}

export function interpolate(message: string, params?: Record<string, unknown> | null): string {
  if (!params) return latinDigits(message);
  return latinDigits(
    String(message).replace(/\{([A-Za-z0-9_.-]+)\}/g, (_, key: string) =>
      Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : `{${key}}`,
    ),
  );
}
