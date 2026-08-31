// Time contract — ADR-004 (Accepted, D-11).
// timestamptz / UTC-only storage; ISO-8601 with explicit offset on the API.
// Dual-column trading timestamps for sync-sourced trades (approved design).
// NOTE: interpretation of legacy MySQL naive datetimes is EVIDENCE-GATED
// (sampling) — nothing in this module guesses a legacy timezone.

export const UTC_ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function isTimestamptzString(v: unknown): v is string {
  return typeof v === "string" && UTC_ISO_RE.test(v);
}

/** Dual-column trading timestamp (sync-sourced), per ADR-004 §2. */
export interface TradingTimestamp {
  /** Instant of occurrence, UTC (timestamptz). */
  occurredAt: string;
  /** Broker-reported naive time, preserved verbatim. */
  sourceTimeNaive: string;
  /** Offset of the source time when known (e.g. "+03:30"); null if unknown. */
  sourceTzOffset: string | null;
}

/** Explicit migration blocker — recorded, never guessed (ADR-004 §3). */
export const LEGACY_TZ_INTERPRETATION = {
  status: "BLOCKED_ON_SAMPLING" as const,
  note: "Legacy MySQL naive datetime timezone is not interpreted until the ADR-004 sampling procedure produces evidence and the owner confirms. No transform code may be written before that.",
};
