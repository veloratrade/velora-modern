// Trading session engine — the port of legacy
// api/src/Trades/TradingSessionEngine.php + SessionWindow.php (Phase 3;
// READ-ONLY source-read 2026-10-04, MG-DOMAIN-LEGACY-ONLY / audit §9.3).
//
// CONTRACT (identical to legacy):
//   Input : a canonical UTC instant 'YYYY-MM-DD HH:MM:SS' (only ever produced
//           for resolved trades), or null/unresolved.
//   Output: zero or more session labels (overlaps supported), plus derived
//           hour/day in UTC and an explicit status.
//
// HARD RULES (identical to legacy):
//   - The engine NEVER invents market windows. The window set is supplied as
//     explicit configuration. With no configuration it returns
//     status='unconfigured' and sessions=[] — it does not guess. The legacy
//     fixed-UTC marketing copy (Asia 00-08, London 08-13, ...) is deliberately
//     NOT wired in: it is DST-incorrect and not an approved product spec.
//   - No symbol, no broker name, no server/browser timezone, no UI locale is
//     read. Windows reference an explicit IANA zone each; the formatter is
//     pinned to a fixed locale ("en-US") so classification is independent of
//     the runtime environment (the structural form of legacy test S21, which
//     had to re-set PHP's default timezone to prove the same thing).
//   - DST is handled via the platform timezone database (PHP DateTimeZone ->
//     Intl.DateTimeFormat here); comparison is performed on UTC epochs.
//   - Sessions are DERIVED from canonical UTC, never stored as truth and
//     never fed back into canonical-time resolution. Session != broker tz.
//
// DIVERGENCES (deliberate, documented):
//   - IANA validation: legacy admits DateTimeZone::listIdentifiers(ALL_WITH_BC)
//     (including backward-compatibility ids); this port admits the runtime's
//     canonical Intl zone set — a strictly cleaner configuration surface.
//     Modern canonical zones (Europe/London, America/New_York, Asia/Tehran,
//     ...) behave identically; fixed offsets and abbreviations (GMT+3, EST)
//     are rejected exactly like legacy.
//   - Input strictness: legacy's createFromFormat tolerates some
//     non-padded components with warnings; this port requires the exact
//     canonical 'YYYY-MM-DD HH:MM:SS' shape — the only shape upstream
//     canonicalization emits.

/** Engine version — bump whenever the derivation algorithm changes (legacy contract). */
export const TRADING_SESSION_ENGINE_VERSION = 1;

const IANA_MAX_LENGTH = 64;
/** Fixed offsets and abbreviations are not IANA zones (legacy TimezoneResolver::isValidIana). */
const FIXED_OFFSET_RE = /(?:GMT|UTC)?\s*[+-]\d{1,2}(?::?\d{2})?/i;
const IANA_STRUCTURE_RE = /^[A-Za-z]+(?:[A-Za-z_+\-/]+)*$/;

let ianaZoneSet: Set<string> | null = null;
function ianaZones(): Set<string> {
  if (ianaZoneSet === null) {
    ianaZoneSet = new Set(Intl.supportedValuesOf("timeZone"));
  }
  return ianaZoneSet;
}

/** Legacy TimezoneResolver::isValidIana port: true only for canonical IANA identifiers. */
export function isValidIanaTimezone(timezone: unknown): boolean {
  if (typeof timezone !== "string") return false;
  const tz = timezone.trim();
  if (tz === "" || tz.length > IANA_MAX_LENGTH) return false;
  if (FIXED_OFFSET_RE.test(tz)) return false;
  if (!IANA_STRUCTURE_RE.test(tz)) return false;
  return ianaZones().has(tz);
}

/** One market session window — legacy SessionWindow, immutable data with parse-time validation. */
export interface SessionWindow {
  readonly id: string;
  readonly label: string;
  /** Reference IANA timezone; minutes are never interpreted as UTC. */
  readonly timezone: string;
  /** Wall-clock minutes-from-midnight (0..1439) in `timezone`. */
  readonly startMinute: number;
  /** 0..1439; endMinute <= startMinute expresses a cross-midnight window. */
  readonly endMinute: number;
  /** ISO weekdays (1=Mon..7=Sun) the window applies on; null = every day. */
  readonly daysOfWeek: readonly number[] | null;
  /** Optional tie-break priority (lower = higher precedence); null = none. */
  readonly priority: number | null;
}

function windowMinutes(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
    if (m !== null) return Number(m[1]) * 60 + Number(m[2]);
  }
  throw new Error(`Session window time must be "HH:MM" or minute-of-day (${field}).`);
}

/** Legacy SessionWindow::fromArray + constructor validation. Throws on invalid configuration. */
export function parseSessionWindow(a: Record<string, unknown>): SessionWindow {
  const id = typeof a["id"] === "string" ? a["id"] : "";
  const label = typeof a["label"] === "string" && a["label"] ? a["label"] : id;
  const timezone = typeof a["timezone"] === "string" ? a["timezone"] : typeof a["zone"] === "string" ? a["zone"] : "";
  const start = windowMinutes(a["start"] ?? a["startMinute"], "start");
  const end = windowMinutes(a["end"] ?? a["endMinute"], "end");

  const trimmedId = id.trim();
  if (trimmedId === "" || trimmedId.length > 40 || !/^[a-z0-9._-]+$/i.test(trimmedId)) {
    throw new Error("Invalid session window id.");
  }
  if (label.trim() === "" || label.length > 60) {
    throw new Error("Invalid session window label.");
  }
  if (!isValidIanaTimezone(timezone)) {
    throw new Error("Session window timezone must be a valid IANA identifier.");
  }
  if (start < 0 || start > 1439 || end < 0 || end > 1439) {
    throw new Error("Session window minutes must be within 0..1439.");
  }
  if (start === end) {
    throw new Error("Session window start and end must differ.");
  }
  let daysOfWeek: number[] | null = null;
  if (Array.isArray(a["daysOfWeek"])) {
    daysOfWeek = (a["daysOfWeek"] as unknown[]).map((x) => Number(x));
    for (const d of daysOfWeek) {
      if (!Number.isInteger(d) || d < 1 || d > 7) {
        throw new Error("Session window daysOfWeek must be ISO weekdays 1..7.");
      }
    }
  }
  const priorityRaw = a["priority"];
  const priority = typeof priorityRaw === "number" && Number.isInteger(priorityRaw) ? priorityRaw : null;
  if (priority !== null && priority < 0) {
    throw new Error("Session window priority must be >= 0.");
  }

  return { id: trimmedId, label, timezone: timezone.trim(), startMinute: start, endMinute: end, daysOfWeek, priority };
}

export type SessionStatus = "unconfigured" | "unresolved" | "invalid" | "outside" | "open";

export interface MatchedSession {
  id: string;
  label: string;
  timezone: string;
}

export interface SessionClassification {
  status: SessionStatus;
  sessions: MatchedSession[];
  hourUtc: number | null;
  dayOfWeekUtc: number | null; // ISO 1=Mon..7=Sun
  engineVersion: number;
  windowCount: number;
}

// --- UTC <-> IANA wall time (platform tz database; fixed locale, no env reads) ---

interface Wall {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  minute: number; // 0..59
  second: number; // 0..59
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();
function wallFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = wallFormatters.get(timeZone);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    wallFormatters.set(timeZone, fmt);
  }
  return fmt;
}

function zonedWall(epochMs: number, timeZone: string): Wall {
  const parts = wallFormatter(timeZone).formatToParts(epochMs);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Offset (ms) = wall-as-if-UTC − true UTC, at the given instant, in the given zone. */
function tzOffsetMs(epochMs: number, timeZone: string): number {
  const w = zonedWall(epochMs, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - epochMs;
}

/** Wall time in `timeZone` -> UTC epoch ms (two-probe refinement across DST edges). */
function wallToUtcMs(w: Pick<Wall, "year" | "month" | "day" | "hour" | "minute">, timeZone: string): number {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  let utc = guess - tzOffsetMs(guess, timeZone);
  utc = guess - tzOffsetMs(utc, timeZone);
  return utc;
}

/** ISO weekday (1=Mon..7=Sun) of a calendar date. */
function isoWeekdayOf(year: number, month: number, day: number): number {
  return ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
}

const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Deterministic, DST-aware market session classifier (legacy port).
 * Sessions are derived from a canonical UTC instant — never the reverse.
 */
export class TradingSessionEngine {
  readonly #windows: readonly SessionWindow[];

  constructor(windows: ReadonlyArray<Record<string, unknown> | SessionWindow> = []) {
    this.#windows = windows.map((w) => (isSessionWindow(w) ? w : parseSessionWindow(w)));
  }

  hasConfiguredWindows(): boolean {
    return this.#windows.length > 0;
  }

  windowCount(): number {
    return this.#windows.length;
  }

  engineVersion(): number {
    return TRADING_SESSION_ENGINE_VERSION;
  }

  /** Classify a canonical UTC 'YYYY-MM-DD HH:MM:SS' instant; null -> 'unresolved'. */
  classify(canonicalUtc: string | null): SessionClassification {
    const base: SessionClassification = {
      status: "unconfigured",
      sessions: [],
      hourUtc: null,
      dayOfWeekUtc: null,
      engineVersion: TRADING_SESSION_ENGINE_VERSION,
      windowCount: this.#windows.length,
    };
    const input = canonicalUtc === null ? null : canonicalUtc.trim();
    if (input === null || input === "") {
      return { ...base, status: "unresolved" };
    }
    if (!CANONICAL_UTC_RE.test(input)) {
      return { ...base, status: "invalid" };
    }
    const y = Number(input.slice(0, 4));
    const mo = Number(input.slice(5, 7));
    const d = Number(input.slice(8, 10));
    const h = Number(input.slice(11, 13));
    const mi = Number(input.slice(14, 16));
    const s = Number(input.slice(17, 19));
    // Explicit UTC construction — the default timezone is never consulted.
    const utcMs = Date.UTC(y, mo - 1, d, h, mi, s);
    if (Number.isNaN(utcMs) || !isValidUtcDate(y, mo, d, h, mi, s)) {
      return { ...base, status: "invalid" };
    }
    const asUtc = new Date(utcMs);
    const hourUtc = asUtc.getUTCHours();
    const dayOfWeekUtc = ((asUtc.getUTCDay() + 6) % 7) + 1;

    if (this.#windows.length === 0) {
      return { ...base, status: "unconfigured", hourUtc, dayOfWeekUtc };
    }

    const matched: MatchedSession[] = [];
    for (const window of this.#windows) {
      if (this.#matches(window, utcMs)) {
        matched.push({ id: window.id, label: window.label, timezone: window.timezone });
      }
    }
    return {
      status: matched.length === 0 ? "outside" : "open",
      sessions: matched,
      hourUtc,
      dayOfWeekUtc,
      engineVersion: TRADING_SESSION_ENGINE_VERSION,
      windowCount: this.#windows.length,
    };
  }

  /** Legacy matches(): DST/cross-midnight by building reference-local wall times and comparing UTC epochs. */
  #matches(w: SessionWindow, utcMs: number): boolean {
    const local = zonedWall(utcMs, w.timezone);
    const dow = isoWeekdayOf(local.year, local.month, local.day);
    if (w.daysOfWeek !== null && !w.daysOfWeek.includes(dow)) {
      return false;
    }

    const sh = Math.trunc(w.startMinute / 60);
    const sm = w.startMinute % 60;
    const eh = Math.trunc(w.endMinute / 60);
    const em = w.endMinute % 60;

    // Window starting on the local date of the instant.
    const startMs = wallToUtcMs({ year: local.year, month: local.month, day: local.day, hour: sh, minute: sm }, w.timezone);
    if (w.endMinute > w.startMinute) {
      // Same-day window [start, end).
      const endMs = wallToUtcMs({ year: local.year, month: local.month, day: local.day, hour: eh, minute: em }, w.timezone);
      return utcMs >= startMs && utcMs < endMs;
    }

    // Cross-midnight window: starts on D at HH:MM, ends next LOCAL day at HH:MM
    // (the +1 day is applied to the wall time, so a DST transition shifts it
    // with the zone — legacy modify('+1 day') on the zone-local object).
    const nextDay = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
    const endNextMs = wallToUtcMs(
      { year: nextDay.getUTCFullYear(), month: nextDay.getUTCMonth() + 1, day: nextDay.getUTCDate(), hour: eh, minute: em },
      w.timezone,
    );
    if (utcMs >= startMs && utcMs < endNextMs) {
      return true;
    }
    // An early-hours instant belongs to the window that started yesterday
    // ('-1 day' on the UTC epoch, exactly like the legacy UTC-zone modify).
    const startPrevMs = startMs - 86_400_000;
    const endTodayMs = wallToUtcMs({ year: local.year, month: local.month, day: local.day, hour: eh, minute: em }, w.timezone);
    return utcMs >= startPrevMs && utcMs < endTodayMs;
  }
}

function isSessionWindow(w: unknown): w is SessionWindow {
  return (
    typeof w === "object" &&
    w !== null &&
    "startMinute" in w &&
    "endMinute" in w &&
    typeof (w as SessionWindow).id === "string" &&
    typeof (w as SessionWindow).timezone === "string"
  );
}

function isValidUtcDate(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  const dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= dim;
}
