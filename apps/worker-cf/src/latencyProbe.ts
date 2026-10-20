/**
 * A two-line stopwatch for one thing: where the seconds go in a Telegram message.
 *
 * WHY A SEPARATE MODULE. The database half was already countable at the pool, but the ledger numbers
 * (`received_at` → `processed_at`, 4.4-10.3 s on real messages) left several seconds that no Postgres
 * statement explains, and the other side of the path - the outbound Bot API calls - had no counter at
 * all. `latency_probe` logs `db_ms` next to `api_ms` so the remainder is attributed instead of argued.
 *
 * SHAPE, AND ITS LIMIT. The counters live at module scope, which in Workers means per isolate, not per
 * request: concurrent invocations blur them. Acceptable for a deliberate one-message-at-a-time
 * diagnostic; it must not be read as per-request accounting under load, and it is removed once the
 * latency question it answers is closed. Nothing here counts statements inside `withTransaction` (those
 * run on a `PinnedClient`), so `queries` is a floor.
 */

export interface ProbeCounters {
  on: boolean;
  apiCalls: number;
  apiMs: number;
  slowestApi: { ms: number; method: string }[];
}

export const probe: ProbeCounters = { on: false, apiCalls: 0, apiMs: 0, slowestApi: [] };

export const beginProbe = (enabled: boolean): void => {
  probe.on = enabled;
  probe.apiCalls = 0;
  probe.apiMs = 0;
  probe.slowestApi = [];
};

/**
 * Time every Bot API method call, without changing what it returns or throws.
 *
 * Only awaited property accesses are wrapped, and the receiver is preserved, so the proxy is
 * behaviour-transparent: `HttpTelegramBotApi` keeps its own private state (`#fetch`, its timeouts).
 */
export function withApiProbe<T extends object>(api: T, methodOf?: (name: string) => string): T {
  if (!probe.on) return api;
  const label = methodOf ?? ((name: string) => name);
  return new Proxy(api, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return async (...args: unknown[]) => {
        const started = Date.now();
        try {
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } finally {
          const ms = Date.now() - started;
          probe.apiCalls += 1;
          probe.apiMs += ms;
          probe.slowestApi.push({ ms, method: label(prop) });
        }
      };
    },
  }) as T;
}

/** The fields every probe line carries besides the database counters. */
export const apiProbeFields = (): { api_calls: number; api_ms: number; slowest_api: unknown[] } => ({
  api_calls: probe.apiCalls,
  api_ms: probe.apiMs,
  slowest_api: [...probe.slowestApi].sort((a, b) => b.ms - a.ms).slice(0, 4),
});
