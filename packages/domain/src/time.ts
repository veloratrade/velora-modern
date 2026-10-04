// Time utilities — ADR-004 (Accepted, D-11): UTC-only, injectable clock.
import { isTimestamptzString } from "@velora/contracts";

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export function toIsoUtc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function assertTimestamptz(value: string, field = "timestamp"): string {
  if (!isTimestamptzString(value)) {
    throw new Error(`${field} must be an ISO-8601 UTC timestamp with explicit offset (ADR-004): got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Render an instant as a NAIVE wall-clock string in a named timezone.
 *
 * WHY NAIVE, AND WHY THAT IS NOT A LOSS OF INFORMATION HERE.
 * ADR-004 (D-11) fixes the product rule for manually entered times: a naive
 * datetime is interpreted in the USER's profile timezone, and the operator's raw
 * input is retained verbatim (`raw_open_text`) independently of the derived UTC
 * instant. Clients that collect times from a human therefore send WALL CLOCK, not
 * a converted instant — converting here would apply the timezone twice.
 *
 * Used by the Telegram client, whose messages carry a human's local intent
 * ("امروز", "14:30"), so the journal draft hands TradeService exactly the shape a
 * web form would hand it and the existing interpretation policy applies unchanged.
 *
 * `Intl` is the only timezone facility used: no new dependency, and the ICU data
 * ships with Node 20 (the engine pinned by `engines.node`). An unknown timezone
 * name falls back to the UTC wall clock rather than throwing — the caller is a
 * message renderer, and a missing stroke is better than a failed journal entry.
 */
export function wallClockIn(timeZone: string, at: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(at);
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
    const hour = get("hour") === "24" ? "00" : get("hour"); // some ICU builds emit 24 for midnight
    const value = `${get("year")}-${get("month")}-${get("day")} ${pad(Number(hour))}:${pad(Number(get("minute")))}:${pad(Number(get("second")))}`;
    return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value : toIsoUtc(at).replace("T", " ").replace("Z", "");
  } catch {
    return toIsoUtc(at).replace("T", " ").replace("Z", "");
  }
}
