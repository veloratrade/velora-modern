// MetaAPI sync cadence resolution — MG-METAAPI-CADENCE (AC-35).
//
// WHAT LEGACY SHIPPED (@edede31, audit §12.1): a `metaapi_sync_worker` that
// polled EVERY MINUTE. That was its ONLY ingestion path — no webhooks, no
// manual trigger — so the poll cadence WAS the freshness guarantee.
//
// MODERN has three sync producers:
//   1. the MetaAPI webhook ingress (event-driven: a deal lands within seconds),
//   2. the user-triggered POST /accounts/{id}/sync (202 {jobId,status,dedup}),
//   3. this scheduled tick — the SAFETY NET that sweeps accounts whose
//      webhooks were missed (delivery is at-least-once from the provider's
//      side, but a lost webhook is a stale journal until something sweeps).
//
// The audit's finding stands: an hourly sweep is a 60-minute worst-case
// staleness for the safety net vs Legacy's 1-minute poll. The right default
// is a BUSINESS CALL (MetaAPI request volume × user-base size vs journal
// freshness), so per governance the DEFAULT IS UNCHANGED (hourly) and the
// cadence is operationally tunable through METAAPI_SYNC_CRON — no code
// change or redeploy-with-edit needed to tighten or relax it. The default
// value itself is recorded as an owner decision (OD-AC-CADENCE).

/** The audited default (unchanged): hourly, on the hour. */
export const DEFAULT_SYNC_CRON = "0 * * * *";

/** Legacy's poll cadence, kept as the documented reference point. */
export const LEGACY_SYNC_CRON = "* * * * *";

/**
 * Validate a 5-field minute-precision cron expression (pg-boss accepts
 * standard 5-field crons; 6-field with seconds is NOT wanted for a sweep).
 * Conservative by intent: allow-listed characters only, so a typo fails
 * validation instead of silently never firing.
 */
export function isValidSyncCron(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  // field charsets: minute/hour/dom/month/dow
  // minute+hour: numbers, *, ranges, lists, steps
  // dom/month/dow additionally allow names in standard cron — we do NOT
  // accept names (nothing in this system schedules by name; accepting them
  // would widen the typo surface for zero benefit).
  const numericField = /^\*|\*\/[0-9]+|[0-9]+(?:-[0-9]+)?(?:\/[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?(?:\/[0-9]+)?)*$/;
  return fields.every((f) => numericField.test(f));
}

/** Range sanity: minutes 0-59, hours 0-23, dom 1-31, months 1-12, dow 0-7. */
const RANGES: readonly [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

export function syncCronFieldRangesAreValid(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, i) => {
    const [min, max] = RANGES[i]!;
    if (field === "*") return true;
    // expand each comma part, each side of a range, each step base
    const parts = field.split(",");
    return parts.every((part) => {
      const [baseRaw, step] = part.split("/");
      const base = baseRaw ?? ""; // split always yields index 0; guard for noUncheckedIndexedAccess
      const stepNum = step === undefined ? 1 : Number.parseInt(step, 10);
      if (!Number.isInteger(stepNum) || stepNum < 1) return false;
      if (base === "*") return true; // "*/n" — every n within the field range
      const bounds = base.split("-").map((n) => Number.parseInt(n, 10));
      return bounds.every((n) => Number.isInteger(n) && n >= min && n <= max);
    });
  });
}

export interface ResolvedSyncCron {
  /** The cron expression to hand to pg-boss. */
  readonly cron: string;
  /** Where the value came from — logged, never guessed silently. */
  readonly source: "env" | "default";
  /**
   * Set when an METAAPI_SYNC_CRON value was present but invalid; the operator
   * must know the fallback happened (the tick still runs on the default).
   */
  readonly rejectedEnvValue: string | null;
}

/**
 * Resolve the sweep cadence: METAAPI_SYNC_CRON when present and valid,
 * otherwise the audited default. PURE — the caller owns process.env access,
 * which keeps this unit-testable.
 */
export function resolveSyncCron(envValue: string | undefined): ResolvedSyncCron {
  if (envValue === undefined || envValue.trim() === "") {
    return { cron: DEFAULT_SYNC_CRON, source: "default", rejectedEnvValue: null };
  }
  const trimmed = envValue.trim();
  if (!isValidSyncCron(trimmed) || !syncCronFieldRangesAreValid(trimmed)) {
    return { cron: DEFAULT_SYNC_CRON, source: "default", rejectedEnvValue: trimmed };
  }
  return { cron: trimmed, source: "env", rejectedEnvValue: null };
}
