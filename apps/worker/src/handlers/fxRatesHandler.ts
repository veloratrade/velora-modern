// Handler for the daily ECB rate job.
//
// SCOPE: fetch → parse → expand → upsert. It performs NO retry policy of its own
// (the queue owns retries) and NO scheduling (the scheduler owns cadence), so a
// failure surfaces as a failed job rather than a sleeping worker.
//
// FAILURE SEMANTICS: every failure path throws, which the runner records as a
// failed job. There is deliberately no "log and continue" branch: a silent
// failure here would leave stale rates in place while every conversion kept
// reporting a fresh date, which is worse than an alerting failure.
import type { QueuedJob } from "../queue/QueuePort.js";
import {
  ECB_DAILY_URL,
  buildRateRows,
  parseEcbDaily,
  storeRates,
  type EcbDailyRates,
  type RateQuery,
} from "../fx/ecbRates.js";

export const FX_RATES_JOB_CLASS = "fx.ecb-rates";

export interface FxRatesDeps {
  readonly q: RateQuery;
  /** Injected so the job is testable without network egress. */
  readonly fetchText: (url: string) => Promise<string>;
}

export interface FxRatesResult {
  readonly rateDate: string;
  readonly written: number;
}

/**
 * Adapt a `pg` Pool to the job's narrow query port.
 *
 * The worker deliberately does not import the API's query layer (separate
 * TypeScript project), so the adapter lives here — where it is also the natural
 * seam for the battery, which drives it with a real Pool.
 */
export function poolRateQuery(pool: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}): RateQuery {
  return async (sql, params) => {
    const result = await pool.query(sql, params === undefined ? undefined : [...params]);
    return result.rows as readonly Record<string, unknown>[];
  };
}

/** Fetch the ECB daily feed as text (the job's only network call). */
export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { accept: "application/xml,text/xml,*/*" } });
  if (!res.ok) throw new Error(`ecb: HTTP ${res.status}`);
  return await res.text();
}

/** Run one ingestion. Exported so the battery can drive it directly. */
export async function ingestEcbRates(
  deps: FxRatesDeps,
  xml?: string,
): Promise<FxRatesResult> {
  const body = xml ?? (await deps.fetchText(ECB_DAILY_URL));
  const parsed: EcbDailyRates = parseEcbDaily(body);
  const rows = buildRateRows(parsed);
  const written = await storeRates(deps.q, parsed.rateDate, rows);
  return { rateDate: parsed.rateDate, written };
}

/**
 * Registry-shaped handler.
 *
 * The job payload is IGNORED: the ingestion target is the ECB's own feed, so
 * there is nothing a producer could (or should) pass in. Accepting a URL from a
 * payload would turn a durable job row into an SSRF vector.
 */
export function makeFxRatesHandler(deps: FxRatesDeps) {
  return async (_job: QueuedJob): Promise<void> => {
    await ingestEcbRates(deps);
  };
}
