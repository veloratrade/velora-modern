// Hyperdrive-backed PostgreSQL executor shaped like the `pg` `Pool` the reused
import { apiProbeFields } from "./latencyProbe.js";
// adapters expect.
//
// WHY THIS FILE EXISTS
// The reused Telegram adapters (`PgTelegramStore`, `PgTradeStore`, `PgAuditStore`,
// `PgRateLimitStore`, `PgAiAttemptStore`, `PgAiCoachStore`) all take a `pg` `Pool`
// and talk to it through exactly two shapes, verified by reading them:
//
//   pool.query(sql, params) -> { rows }                 (single statement)
//   pool.connect()          -> { query(text,values), release() }
//                              used ONLY by withTransaction for BEGIN/COMMIT/ROLLBACK
//
// Nothing in the reused graph imports `pg` at RUNTIME (every `from "pg"` is
// `import type`), and no adapter reads `rowCount`. So the Workers port needs one
// adapter — this file — instead of a rewrite of the data layer.
//
// Workers have no raw TCP, which is why `pg` cannot run there. Hyperdrive exposes
// Postgres over a WebSocket bridge and `postgres` (postgres.js) is the driver
// Cloudflare supports on Workers.
import postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;

export interface QueryResultLike {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly rowCount: number;
}

/** The members of `pg`'s `Pool` the reused adapters actually touch. */
export interface PoolLike {
  query(text: string, values?: readonly unknown[]): Promise<QueryResultLike>;
  connect(): Promise<ClientLike>;
  end(): Promise<void>;
}

export interface ClientLike {
  query(text: string, values?: readonly unknown[]): Promise<QueryResultLike>;
  release(): void;
}

/**
 * Keeps a fire-and-forget close on the invocation that owns the socket.
 *
 * `withTransaction` releases its client synchronously (`pg`'s contract), so the
 * only way to finish the connection is to hand the promise to somebody. Dropping
 * it on the floor is not available on Workers: the socket belongs to THIS request's
 * context, and if the close lands after the response, workerd refuses it with
 * "Cannot perform I/O on behalf of a different request" — measured, see
 * `poolFor` below. So the host injects its `waitUntil`.
 */
export type Retain = (promise: Promise<unknown>) => void;

// The Workers `Hyperdrive` binding exposes `fetch()` at runtime; the published
// types do not always declare it, so the shape is structural and optional and the
// driver only wires it when it is really there.
export type HyperdriveFetch = { fetch?: (req: Request) => Promise<Response> } | unknown;

const hyperdriveFetcher = (hyperdrive: unknown): ((req: Request) => Promise<Response>) | null => {
  const candidate = (hyperdrive as { fetch?: unknown } | null | undefined)?.fetch;
  return typeof candidate === "function" ? (candidate as (req: Request) => Promise<Response>) : null;
};

/**
 * jsonb parameter convention mismatch — MEASURED, not assumed.
 *
 * A driver probe on this exact stack (`$n::jsonb` with three param shapes) showed:
 *   JS object {x:1}        -> jsonb object   ✓
 *   string '{"y":2}'       -> jsonb STRING   ✗  (a scalar holding JSON text)
 *   JS array ["m","n"]     -> jsonb array    ✓
 *
 * The reused adapters were written for `pg`, whose convention is to hand jsonb
 * parameters as an already-stringified value — `PgTelegramStore.createDraft` does
 * exactly that for `draft`, `missing_fields` and `media`. Under postgres.js that
 * string becomes a jsonb scalar, and the schema lawfully refuses it
 * (`telegram_journal_drafts_draft_check`: jsonb_typeof(draft) = 'object').
 *
 * So the adapter un-wraps JSON text, and ONLY for placeholders the SQL itself casts
 * to jsonb. Nothing else about parameter handling is touched, so every other reused
 * adapter keeps `pg`'s behaviour byte for byte.
 */
const JSONB_CAST = /\$(\d+)::jsonb/g;

const jsonbAware = (sql: string, values: readonly unknown[]): unknown[] => {
  const out = values.slice();
  let match: RegExpExecArray | null;
  JSONB_CAST.lastIndex = 0;
  while ((match = JSONB_CAST.exec(sql)) !== null) {
    const index = Number(match[1]) - 1;
    const value = out[index];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      out[index] = JSON.parse(trimmed);
    } catch {
      // Not JSON after all: leave it exactly as the caller wrote it.
    }
  }
  return out;
};

const normalize = (result: unknown): QueryResultLike => {
  // postgres.js answers a bare statement with the row array; some shapes return
  // { rows }. Normalise to the `pg` shape the adapters destructure.
  if (Array.isArray(result)) {
    return { rows: result as Record<string, unknown>[], rowCount: result.length };
  }
  const obj = result as { rows?: unknown[]; affected?: number } | null;
  const rows = Array.isArray(obj?.rows) ? (obj.rows as Record<string, unknown>[]) : [];
  return { rows, rowCount: typeof obj?.affected === "number" ? obj.affected : rows.length };
};

/**
 * Per-isolate connection budget for the shared (non-transaction) driver.
 *
 * Two ceilings decide this number, both read from the code and from the plan:
 *
 *  1. A Workers invocation may hold **6 simultaneous outgoing connections**
 *     (Workers platform limits, on Free and Paid alike). `max: 8` therefore asks
 *     for capacity the runtime will never grant — the surplus only widens the
 *     internal queue, it does not buy parallelism.
 *  2. Transactions are NOT served by this pool. `withTransaction`
 *     (`apps/api/src/persistence/pg.ts`) calls `pool.connect()`, and `PinnedClient`
 *     below opens its OWN single-connection driver, so the real peak per isolate is
 *     `POOL_MAX + concurrent in-flight transactions`. On the Free plan Hyperdrive
 *     caps the origin at roughly 20 connections per config, account-wide, and every
 *     other Worker on the account shares that. Keeping POOL_MIN small is what keeps
 *     a burst of journal confirmations from exhausting the origin's
 *     `max_connections` — which is a hard failure for the whole account, not just
 *     for the bot.
 *
 * 2 is enough for this bot's shape: one webhook delivery issues at most one ad-hoc
 * query at a time, and the queue depth beyond that is a wait, not a throughput win.
 * The harness in `scripts/integration.mjs` measures the actual peak and proves that
 * concurrent transactions still commit at this setting.
 */
export const POOL_MAX = 2;

const buildOptions = (
  hyperdrive: HyperdriveFetch | undefined,
  max: number,
): Parameters<typeof postgres>[1] => ({
  max,
  prepare: false, // adapters compose SQL at runtime — no cached-plan name conflicts
  transform: { undefined: null }, // `pg` maps undefined -> NULL; match it
  ...(hyperdriveFetcher(hyperdrive) === null ? {} : { fetch: (req: Request) => hyperdriveFetcher(hyperdrive)!(req) }),
}) as Parameters<typeof postgres>[1];

/**
 * A checked-out client. `withTransaction` requires BEGIN/COMMIT/ROLLBACK and the
 * statements between them to share ONE connection, so this is a dedicated
 * single-connection instance rather than the shared pool. `max: 1` is what pins it.
 */
class PinnedClient implements ClientLike {
  constructor(
    private readonly connectionString: string,
    private readonly hyperdrive: HyperdriveFetch | undefined,
    private readonly onRelease: (client: SqlClient) => void,
  ) {}

  #sql: SqlClient | null = null;

  private driver(): SqlClient {
    if (this.#sql === null) {
      this.#sql = postgres(this.connectionString, buildOptions(this.hyperdrive, 1));
    }
    return this.#sql;
  }

  async query(text: string, values: readonly unknown[] = []): Promise<QueryResultLike> {
    return normalize(await this.driver().unsafe(text, jsonbAware(text, values) as never[]));
  }

  release(): void {
    if (this.#sql !== null) {
      this.onRelease(this.#sql);
      this.#sql = null;
    }
  }
}

/**
 * `LATENCY_PROBE=1` turns this class into a stopwatch for ONE invocation.
 *
 * WHY IT EXISTS. Reports said "the bot is slow" and nothing in the code measured that, so every
 * explanation on offer (Neon suspending, too many round trips, Telegram backoff) was a story rather
 * than a number. `received_at`/`processed_at` in the ledger show only the whole window. This probe
 * splits it: how many statements, their total, and — the one that discriminates a cold database from a
 * chatty code path — how long the FIRST statement took, because that is the only one that can include
 * connect + TLS + auth + a compute wake.
 *
 * It is off unless the var is exactly "1", it logs the SQL *prefix* and never a bound value, and
 * statements inside `withTransaction` (a `PinnedClient`, `connect()` below) are not counted — so
 * `queries` is a floor, not an exhaustive count. Say so when quoting it.
 */
export class HyperdrivePool implements PoolLike {
  readonly #sql: SqlClient;
  readonly #openedAt = Date.now();
  readonly #probe: boolean;
  #queries = 0;
  #dbMs = 0;
  #firstMs = 0;
  #seen: { ms: number; sql: string }[] = [];

  constructor(
    private readonly connectionString: string,
    private readonly hyperdrive: HyperdriveFetch | undefined,
    readonly max: number = POOL_MAX,
    private readonly retain: Retain = () => {},
    probe = false,
  ) {
    this.#probe = probe;
    this.#sql = postgres(connectionString, buildOptions(hyperdrive, max));
  }

  async query(text: string, values: readonly unknown[] = []): Promise<QueryResultLike> {
    if (!this.#probe) {
      return normalize(await this.#sql.unsafe(text, jsonbAware(text, values) as never[]));
    }
    const started = Date.now();
    const result = normalize(await this.#sql.unsafe(text, jsonbAware(text, values) as never[]));
    const ms = Date.now() - started;
    this.#queries += 1;
    this.#dbMs += ms;
    if (this.#firstMs === 0) this.#firstMs = ms;
    this.#seen.push({ ms, sql: text.replace(/\s+/g, " ").trim().slice(0, 46) });
    return result;
  }

  async connect(): Promise<ClientLike> {
    return new PinnedClient(this.connectionString, this.hyperdrive, (client) => {
      // Close the dedicated connection once the transaction has committed/rolled
      // back, and keep that close inside the owning invocation (see `Retain`).
      this.retain(client.end({ timeout: 1 }));
    });
  }

  async end(): Promise<void> {
    if (this.#probe) {
      const slowest = this.#seen.sort((x, y) => y.ms - x.ms).slice(0, 6);
      console.log(
        JSON.stringify({
          level: "info",
          event: "telegram.latency_probe",
          queries: this.#queries,
          db_ms: this.#dbMs,
          first_query_ms: this.#firstMs,
          invocation_ms: Date.now() - this.#openedAt,
          ...apiProbeFields(),
          slowest,
        }),
      );
    }
    await this.#sql.end({ timeout: 1 });
  }
}

/**
 * Build the driver for ONE invocation. There is deliberately no cross-request cache.
 *
 * A previous revision memoised one instance per connection string, which looked like
 * the standard "Hyperdrive owns the real pool" pattern and worked in Node. It is
 * wrong on the actual runtime, and the failure is not theoretical: postgres.js's
 * Workers build (`postgres/cf`) wraps the Hyperdrive WebSocket in a stream whose
 * writes are bound to the request that created it, so a later request reusing that
 * instance dies with
 *
 *   Error: Cannot perform I/O on behalf of a different request.
 *     at EventEmitter.write (node_modules/postgres/cf/polyfills.js:182:16)
 *     at nextWrite (node_modules/postgres/cf/src/connection.js:257:22)
 *
 * Measured under workerd on 2026-10-17: sequential and concurrent webhook
 * deliveries came back as an alternating 200/500 pattern — and a 500 after the
 * update is already claimed means the bot goes quietly deaf, because Telegram does
 * not retry a response it never got... it does retry a 5xx, but the claim then
 * answers `duplicate` and the work is never done. Per-invocation construction is
 * the documented shape, and Hyperdrive's own pooling is what pays for it.
 */
export function poolFor(
  connectionString: string,
  env: { HYPERDRIVE?: unknown },
  max: number = POOL_MAX,
  retain?: Retain,
  probe = false,
): PoolLike {
  return new HyperdrivePool(connectionString, env.HYPERDRIVE, max, retain, probe);
}
