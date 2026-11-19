// Legacy timestamp interpretation for the MySQL -> PostgreSQL data migration.
//
// ADR-004 (time model): PostgreSQL stores timestamptz UTC-only. Legacy MySQL
// datetimes are naive (no offset). Their meaning is evidence-gated: no
// transform code may interpret them until the ADR-004 sampling procedure has
// been executed and the owner confirms the interpretation.
//
// ADR-004 Amendment A-3 (owner decision, 2026-11-18, Option C):
//   1. Sample legacy dates first (read-only, against a staging export).
//   2. Then the owner confirms a single interpretation constant.
//   3. Asia/Tehran standby -- if sampling is not possible, the transform adopts
//      Asia/Tehran as the documented site-local interpretation constant, an
//      approximation that cannot be better than the evidence.
//
// This module implements STEP 3 (the standby). It is PURE: no database, no
// I/O, no network -- so it can be unit-tested without provisioning PostgreSQL.
//
// The transform NEVER invents an instant: if the naive text cannot be parsed
// into a confirmed calendar (e.g. Jalali/SH text whose conversion the sampling
// has not confirmed), it returns null and the caller must QUARANTINE the row,
// never promote a guessed instant.

/** IANA zone -> minutes east of UTC. Only zones the sampling evidence may
 * confirm are hard-coded here; every other zone stays owner-gated. */
export const KNOWN_TZ_OFFSET_MINUTES: Record<string, number> = {
  "Asia/Tehran": 210, // +03:30 (IRDT +04:30 in summer; the standby is the
  // winter standard offset -- the sampling must confirm whether DST applies)
  "UTC": 0,
};

/** ADR-004 Amendment A-3 standby interpretation constant. */
export const ADR004_STANDBY_TIMEZONE = "Asia/Tehran";

/** Parse an ISO-like naive datetime "YYYY-MM-DD HH:MM[:SS]" (no offset). */
export function parseIsoNaive(text: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: m[6] !== undefined ? Number(m[6]) : 0,
  };
}

/** Validate calendar ranges for a parsed naive datetime. */
function inRange(v: number, lo: number, hi: number) {
  return Number.isFinite(v) && v >= lo && v <= hi;
}

/**
 * Attempt to interpret a naive legacy datetime as a UTC instant.
 *
 * - ISO-format naive text + a confirmed timezone -> UTC instant + offset text.
 * - Anything else (Jalali/SH calendar text, unknown zone, empty) -> null: the
 *   row stays UNRESOLVED and must be quarantined, never invented.
 */
export function interpretNaiveInstant(naiveText: string | null, sourceTimezone: string | null) {
  if (naiveText === null || naiveText.trim() === "") return null;
  const parsed = parseIsoNaive(naiveText);
  if (parsed === null) return null; // unconfirmed calendar (e.g. Jalali) -- quarantine
  if (
    !inRange(parsed.month, 1, 12) ||
    !inRange(parsed.day, 1, 31) ||
    !inRange(parsed.hour, 0, 23) ||
    !inRange(parsed.minute, 0, 59) ||
    !inRange(parsed.second, 0, 59)
  ) {
    return null;
  }
  const tz = sourceTimezone ?? ADR004_STANDBY_TIMEZONE; // Amendment A-3 standby
  const offsetMinutes = KNOWN_TZ_OFFSET_MINUTES[tz];
  if (offsetMinutes === undefined) return null; // owner-gated zone -- quarantine
  // Treat the naive wall-clock as `tz` local time, then express as UTC instant.
  const ms =
    Date.UTC(parsed.year, parsed.month - 1, parsed.day, parsed.hour, parsed.minute, parsed.second) -
    offsetMinutes * 60 * 1000;
  const occurredAtUtc = new Date(ms).toISOString();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offAbs = Math.abs(offsetMinutes);
  const oh = Math.floor(offAbs / 60).toString().padStart(2, "0");
  const om = (offAbs % 60).toString().padStart(2, "0");
  const sourceTzOffset = `${sign}${oh}:${om}`;
  return { occurredAtUtc, sourceTzOffset };
}
