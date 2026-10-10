/**
 * Date/time bridge for broker screenshots and the trade journal.
 *
 * `datetime-local` has no timezone. Screenshot fields may carry an explicit ISO
 * offset or a validated offset hint; those values are converted for display in
 * the user's profile timezone and retain an exact UTC submission value until
 * the user edits them. Unzoned manual edits stay naive wall time for the API's
 * existing ADR-004/profile-timezone interpretation.
 */
export interface ScreenshotTimePrefill {
  readonly inputValue: string;
  /** Exact instant for an unedited, zoned screenshot value; null for wall time. */
  readonly apiValue: string | null;
  readonly valid: boolean;
}

interface CapturedWallTime {
  readonly date: string;
  readonly hourMinute: string;
  readonly second: string | null;
  readonly offset: string | null;
}

const CAPTURED_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/u;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep the long-standing helper name in the screenshot form path. A recognized
 * absolute time is shown in the profile zone; unzoned text is kept as a wall
 * time; an invalid value leaves the current form value unchanged.
 */
export function toLocalInputTime(
  value: string | null | undefined,
  current: string,
  profileTimeZone: string | null,
  timezoneOffsetHintMinutes?: unknown,
): string {
  return screenshotTimePrefill(value, current, profileTimeZone, timezoneOffsetHintMinutes).inputValue;
}

export function screenshotTimePrefill(
  value: string | null | undefined,
  current: string,
  profileTimeZone: string | null,
  timezoneOffsetHintMinutes?: unknown,
): ScreenshotTimePrefill {
  if (typeof value !== "string") return { inputValue: current, apiValue: null, valid: false };
  const match = CAPTURED_TIME.exec(value.trim());
  if (match === null) return { inputValue: current, apiValue: null, valid: false };

  const captured: CapturedWallTime = {
    date: match[1]!,
    hourMinute: match[2]!,
    second: match[3] ?? null,
    offset: match[4] ?? null,
  };
  if (!validWallTime(captured)) return { inputValue: current, apiValue: null, valid: false };

  const wallInput = `${captured.date}T${captured.hourMinute}${captured.second === null ? "" : `:${captured.second}`}`;
  const offsetMinutes = captured.offset === null
    ? validOffsetHint(timezoneOffsetHintMinutes)
    : parseIsoOffset(captured.offset);
  if (offsetMinutes === null) return { inputValue: wallInput, apiValue: null, valid: true };

  // The screenshot's wall time is UTC + source offset, so subtract that offset
  // to recover the instant before formatting in the user's profile timezone.
  const wallAsUtc = Date.parse(`${captured.date}T${captured.hourMinute}:${captured.second ?? "00"}Z`);
  const instantMs = wallAsUtc - offsetMinutes * 60_000;
  if (!Number.isFinite(instantMs)) return { inputValue: current, apiValue: null, valid: false };

  const targetZone = profileTimeZone !== null && isValidTimeZone(profileTimeZone) ? profileTimeZone : "UTC";
  const localValue = instantToLocalInput(instantMs, targetZone, captured.second !== null);
  if (localValue === null) return { inputValue: current, apiValue: null, valid: false };
  return {
    inputValue: localValue,
    apiValue: new Date(instantMs).toISOString().replace(/\.\d{3}Z$/u, "Z"),
    valid: true,
  };
}

/** Use an exact screenshot instant only while its display field is unchanged. */
export function toApiDateTime(value: string, preserved?: ScreenshotTimePrefill | null): string {
  if (value === "") return "";
  if (preserved?.valid === true && preserved.inputValue === value && preserved.apiValue !== null) {
    return preserved.apiValue;
  }
  return value.length === 16 ? `${value.replace("T", " ")}:00` : value.replace("T", " ");
}

function validWallTime(value: CapturedWallTime): boolean {
  const [year, month, day] = value.date.split("-").map(Number);
  const [hour, minute] = value.hourMinute.split(":").map(Number);
  const second = value.second === null ? 0 : Number(value.second);
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined) return false;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return false;
  const check = new Date(0);
  check.setUTCFullYear(year, month - 1, day);
  check.setUTCHours(hour, minute, second, 0);
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day && check.getUTCHours() === hour &&
    check.getUTCMinutes() === minute && check.getUTCSeconds() === second;
}

function parseIsoOffset(offset: string): number | null {
  if (offset === "Z") return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/u.exec(offset);
  if (match === null) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) return null;
  const absolute = hours * 60 + minutes;
  return match[1] === "+" ? absolute : -absolute;
}

function validOffsetHint(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value).trim();
  if (!/^[+-]?\d{1,4}$/u.test(text)) return null;
  const minutes = Number(text);
  return Number.isInteger(minutes) && minutes >= -720 && minutes <= 840 ? minutes : null;
}

function instantToLocalInput(instantMs: number, timeZone: string, includeSeconds: boolean): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA-u-nu-latn", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instantMs));
    const values = new Map(parts.map((part) => [part.type, part.value]));
    const year = (values.get("year") ?? "").padStart(4, "0");
    const month = values.get("month");
    const day = values.get("day");
    const hour = values.get("hour");
    const minute = values.get("minute");
    const second = values.get("second");
    if (!/^\d{4}$/u.test(year) || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined) return null;
    return `${year}-${month}-${day}T${hour === "24" ? "00" : hour}:${minute}${includeSeconds ? `:${second}` : ""}`;
  } catch {
    return null;
  }
}
