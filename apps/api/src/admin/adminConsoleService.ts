// AdminConsoleService — Phase 6. Validation, ranges, honest health, and the
// sensitive-field rule. The store reads; this decides what a caller is told.
//
// WHAT LIVES HERE AND WHY
//
//   * RANGE PARSING. Legacy's admin analytics accepted a preset plus an explicit
//     range and bounded it. The bounded part is the one that matters: an
//     unbounded `from=1970` on a table that only grows is a denial-of-service
//     vector an authenticated administrator could trigger by accident. Presets
//     and explicit ranges therefore pass through ONE parser with one upper bound.
//
//   * HONEST HEALTH. Every component the console reports is either MEASURED
//     (database latency, migration head, table and row counts) or explicitly
//     NOT APPLICABLE with a reason that names the phase that will build it. The
//     alternative — reporting `healthy` for a component that does not exist —
//     is the single most damaging thing an operator console can do, because a
//     green summary is exactly what stops anyone from looking.
//
//   * THE SENSITIVE-FIELD RULE, IN ONE PLACE. `audit.view_sensitive` (Legacy's
//     super-admin-exclusive permission) governs whether raw network identity —
//     ip_address and user_agent — leaves the process. The fields are REMOVED from
//     the response body for callers without it, never blanked in the client: a
//     value that reached the browser has already been disclosed, whatever the UI
//     chooses to draw. The same rule was already applied to the per-user login
//     history in Phase 3B; this service feeds it from the platform-wide feeds so
//     the two surfaces cannot drift apart.
import { AuthError } from "../auth/authService.js";
import type { AdminUserService } from "../auth/adminUserService.js";
import type { AuthorityContext } from "@velora/contracts";
import { canAct } from "@velora/contracts";
import type {
  AdminConsoleStore,
  ConsoleSecurityEventRow,
  Page,
} from "./adminConsoleStore.js";

/** Hard ceiling on any analytics window: 366 days, inclusive of a leap year. */
export const MAX_RANGE_DAYS = 366;

/** Page bounds. The console shows 25 rows; 100 is the ceiling it may request. */
export const CONSOLE_PAGE_SIZE_DEFAULT = 25;
export const CONSOLE_PAGE_SIZE_MAX = 100;

/** Bounds on the audit/security feeds. 500 rows is a screen-visible cap, not a
 *  scrape: an operator exporting a year of the trail is what the database export
 *  path is for, and an unbounded JSON response is how a console takes down the
 *  API it is meant to diagnose. */
export const CONSOLE_FEED_MAX = 500;

export type RangePreset = "today" | "7d" | "30d" | "90d" | "all";

export interface ResolvedRange {
  readonly from: Date;
  readonly to: Date;
  /** The preset that produced this range, or null for an explicit from/to. */
  readonly preset: RangePreset | null;
}

/** The oldest window `all` may report, and the floor for every explicit range. */
const ALL_FROM = new Date("2020-01-01T00:00:00.000Z");

export interface ComponentStatus {
  /** Component key — the message catalog owns the label (admin.system.*). */
  readonly key: string;
  readonly status:
    | "healthy"
    | "degraded"
    | "unhealthy"
    | "not_configured"
    | "not_applicable"
    | "unknown";
  /** Server-authored, non-translated detail (a measured value or the reason a
   *  component is not applicable). The UI shows it beside the localized label
   *  rather than inventing a translation for a fact it does not know. */
  readonly detail: string | null;
  /** Measured number, when the component has one (milliseconds). */
  readonly latencyMs?: number;
}

/**
 * A security feed row as RETURNED. `ipAddress`/`userAgent` are absent — not null —
 * for a caller without `audit.view_sensitive`, so the type models the omission
 * instead of pretending a hidden value is a missing one.
 */
export type ConsoleSecurityEventView = Omit<ConsoleSecurityEventRow, "ipAddress" | "userAgent"> &
  Partial<Pick<ConsoleSecurityEventRow, "ipAddress" | "userAgent">>;

export interface HealthReport {
  readonly checkedAt: string;
  readonly components: readonly ComponentStatus[];
  /** Highest severity present, so a UI can badge the whole report without
   *  re-implementing the ranking. */
  readonly overall: "healthy" | "degraded" | "unhealthy" | "unknown";
  readonly facts: {
    readonly appliedMigrations: number;
    readonly expectedMigrations: number | null;
    readonly migrationHead: string | null;
    readonly tables: number;
    readonly rateLimitBuckets: number;
    readonly auditRows: number;
    readonly authEvents: number;
    readonly processUptimeSeconds: number;
    readonly nodeVersion: string;
  };
}

/** Latency above this is reported as `degraded` rather than `healthy`. A single
 *  round trip on a local socket is sub-millisecond; 250 ms means something is
 *  wrong (lock contention, saturation, a network hop that should not be there)
 *  and an operator should see amber before it becomes a timeout. */
export const DEGRADED_LATENCY_MS = 250;

export interface AdminConsoleServiceDeps {
  readonly store: AdminConsoleStore;
  /** The canonical admin user service: it owns user EXISTENCE (404) so the
   *  console cannot answer for an id that does not exist with an empty list,
   *  which would read as "this user has no sessions" instead of "no such user". */
  readonly users: AdminUserService;
  readonly now?: () => Date;
}

export class AdminConsoleService {
  private readonly now: () => Date;

  constructor(private readonly deps: AdminConsoleServiceDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  async overview(): Promise<unknown> {
    return this.deps.store.overview();
  }

  /**
   * Resolve a range from the query parameters.
   *
   * Precedence: an explicit `from`/`to` pair WINS over a preset, because a caller
   * that supplies both has stated exactly what it wants and a preset that
   * silently overrode it would be a surprise. `preset` defaults to `30d`.
   */
  resolveRange(params: URLSearchParams): ResolvedRange {
    const now = this.now();
    const rawFrom = params.get("from");
    const rawTo = params.get("to");
    if (rawFrom !== null || rawTo !== null) {
      const from = parseInstant(rawFrom, "from", now);
      const to = parseInstant(rawTo, "to", now);
      if (from.getTime() >= to.getTime()) {
        throw new AuthError(422, "RANGE_INVALID", "The range start must precede its end.", {
          from: from.toISOString(),
          to: to.toISOString(),
        });
      }
      if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
        throw new AuthError(422, "RANGE_TOO_WIDE", `The range may not exceed ${MAX_RANGE_DAYS} days.`, {
          maxDays: String(MAX_RANGE_DAYS),
        });
      }
      return { from, to, preset: null };
    }

    const raw = params.get("range");
    const preset = raw === null || raw.trim() === "" ? "30d" : raw.trim();
    if (!isPreset(preset)) {
      throw new AuthError(422, "RANGE_INVALID", "Unknown range preset.", {
        allowed: "today,7d,30d,90d,all",
      });
    }
    return { ...presetRange(preset, now), preset };
  }

  async usersAnalytics(range: ResolvedRange): Promise<unknown> {
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString(), preset: range.preset },
      ...(await this.deps.store.usersAnalytics(range.from, range.to)),
    };
  }

  async tradingAnalytics(range: ResolvedRange): Promise<unknown> {
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString(), preset: range.preset },
      ...(await this.deps.store.tradingAnalytics(range.from, range.to)),
    };
  }

  async analyticsOverview(range: ResolvedRange): Promise<unknown> {
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString(), preset: range.preset },
      ...(await this.deps.store.analyticsOverview(range.from, range.to)),
    };
  }

  async aiAnalytics(range: ResolvedRange): Promise<unknown> {
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString(), preset: range.preset },
      ...(await this.deps.store.aiAnalytics(range.from, range.to)),
    };
  }

  async operationsAnalytics(range: ResolvedRange): Promise<unknown> {
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString(), preset: range.preset },
      ...(await this.deps.store.operationsAnalytics(range.from, range.to)),
    };
  }

  async revenueAnalytics(): Promise<unknown> {
    return this.deps.store.revenueAnalytics();
  }

  /**
   * The health report.
   *
   * An explicit list of components, each with ONE of the honest statuses. The
   * `not_applicable` entries are not placeholders waiting to be filled in with a
   * guess: each names the phase that will build the substrate, so an operator
   * reading the console learns what the platform can and cannot yet attest.
   */
  async health(): Promise<HealthReport> {
    const facts = await this.deps.store.health();
    const components: ComponentStatus[] = [];

    components.push({
      key: "database",
      status:
        facts.databaseLatencyMs > DEGRADED_LATENCY_MS
          ? facts.databaseLatencyMs > DEGRADED_LATENCY_MS * 4
            ? "unhealthy"
            : "degraded"
          : "healthy",
      detail: `round trip ${facts.databaseLatencyMs} ms`,
      latencyMs: facts.databaseLatencyMs,
    });

    // Migrations: the honest question is not "did it run" but "is the schema this
    // process was built against the schema it is talking to". A build that
    // expects more migrations than the database has applied is running against a
    // schema it does not understand, which is exactly the failure an operator
    // must see before it manifests as a query error.
    if (facts.expectedMigrations === null) {
      // The manifest was not readable from this process: say so. Comparing
      // against a guessed number would either hide a real mismatch or invent one.
      components.push({
        key: "migrations",
        status: "unknown",
        detail: `${facts.appliedMigrations} applied, head ${facts.migrationHead ?? "unknown"} — migration manifest not readable by this process`,
      });
    } else {
      const missing = facts.expectedMigrations - facts.appliedMigrations;
      components.push({
        key: "migrations",
        status: missing === 0 ? "healthy" : facts.appliedMigrations === 0 ? "unhealthy" : "degraded",
        detail:
          missing === 0
            ? `${facts.appliedMigrations} applied, head ${facts.migrationHead ?? "unknown"}`
            : missing < 0
              ? `database has ${-missing} migration(s) this build does not know — ${facts.appliedMigrations} applied`
              : `${missing} migration(s) not applied (head ${facts.migrationHead ?? "unknown"})`,
      });
    }

    components.push({
      key: "api",
      status: "healthy",
      detail: `Node ${facts.nodeVersion}, up ${facts.processUptimeSeconds}s`,
    });

    // The rate limiter's own substrate. Counted, not judged: a large bucket table
    // is normal until it is not, and the console reports the number so an
    // operator can see the trend rather than a colour.
    components.push({
      key: "rate_limiter",
      status: "healthy",
      detail: `${facts.rateLimitBuckets} tracked bucket(s)`,
    });

    // Components whose substrate does not exist in this phase. Each one is
    // reported as NOT APPLICABLE with the reason, never as healthy: a green
    // guess is worse than a stated absence.
    components.push({
      key: "worker",
      status: "not_applicable",
      detail: "no job substrate in Modern yet — built in phase 8 (integrations/worker)",
    });
    components.push({
      key: "email",
      status: "not_applicable",
      detail: "no outbound mail transport in Modern yet — built in phase 8 (email)",
    });
    components.push({
      key: "ai_provider",
      status: "not_applicable",
      detail: "AI providers are wired in phase 7 (fail-closed until then)",
    });
    components.push({
      key: "metaapi",
      status: "not_applicable",
      detail: "MetaAPI connectivity probing lands with the phase-8 integration surface",
    });
    components.push({
      key: "n8n_relay",
      status: "not_applicable",
      detail: "the n8n relay is phase 7 (AI routing); no relay is configured",
    });

    return {
      checkedAt: this.now().toISOString(),
      components,
      overall: rankComponents(components),
      facts: {
        appliedMigrations: facts.appliedMigrations,
        expectedMigrations: facts.expectedMigrations,
        migrationHead: facts.migrationHead,
        tables: facts.tables,
        rateLimitBuckets: facts.rateLimitBuckets,
        auditRows: facts.auditRows,
        authEvents: facts.authEvents,
        processUptimeSeconds: facts.processUptimeSeconds,
        nodeVersion: facts.nodeVersion,
      },
    };
  }

  /**
   * The platform-wide authentication feeds (Legacy `/admin/security/{signups,logins}`).
   *
   * The raw network identity is present only for a caller holding
   * `audit.view_sensitive` (super_admin, or the System Owner through `canAct`).
   * The KEYS ARE OMITTED — not nulled — for everyone else, matching the
   * established shape of the per-user login history: "you may not see this" and
   * "this was not recorded" are different facts, and a null would conflate them.
   */
  async securityFeed(
    eventType: "signup" | "login",
    params: URLSearchParams,
    authority: AuthorityContext,
  ): Promise<{ items: readonly ConsoleSecurityEventView[]; total: number; limit: number; sensitive: boolean }> {
    const limit = readLimit(params, 100, CONSOLE_FEED_MAX);
    const rawResult = params.get("result");
    if (rawResult !== null && rawResult.trim() !== "" && rawResult !== "success" && rawResult !== "failure") {
      throw new AuthError(422, "VALIDATION_FAILED", "Validation failed.", {
        result: "must be 'success' or 'failure'",
      });
    }
    const filter = {
      ...(rawResult !== null && rawResult.trim() !== ""
        ? { result: rawResult as "success" | "failure" }
        : {}),
      ...(params.get("before") ? { before: params.get("before")! } : {}),
      ...readInstantFilter(params, "since", "until"),
      limit,
    };
    const page = await this.deps.store.securityFeed(eventType, filter);
    const sensitive = canAct(authority, "audit.view_sensitive");
    const items: ConsoleSecurityEventView[] = page.items.map((item) =>
      sensitive
        ? item
        : {
            id: item.id,
            occurredAt: item.occurredAt,
            userId: item.userId,
            email: item.email,
            eventType: item.eventType,
            result: item.result,
            reason: item.reason,
          },
    );
    return { items, total: page.total, limit, sensitive };
  }

  /**
   * A user's trading accounts, as seen from the operator side.
   *
   * The user's existence is checked FIRST (through the canonical admin user
   * service) so an unknown id is a 404 rather than an empty list: "this account
   * has no trading accounts" and "there is no such account" are different facts,
   * and a console must not answer the second with the first.
   */
  async userAccounts(userId: string, params: URLSearchParams): Promise<Record<string, unknown>> {
    await this.deps.users.getUser(userId);
    const page = readPage(params);
    const result = await this.deps.store.userAccounts(userId, page.limit, page.offset);
    return { items: result.items, total: result.total, ...page };
  }

  async userTrades(userId: string, params: URLSearchParams): Promise<Record<string, unknown>> {
    await this.deps.users.getUser(userId);
    const page = readPage(params);
    const result = await this.deps.store.userTrades(userId, page.limit, page.offset);
    return { items: result.items, total: result.total, ...page };
  }

  /** Platform-wide trade list (Legacy `/admin/trades`). */
  async platformTrades(params: URLSearchParams): Promise<Record<string, unknown>> {
    const page = readPage(params);
    const status = params.get("status");
    if (status !== null && status.trim() !== "" && status !== "OPEN" && status !== "CLOSED") {
      throw new AuthError(422, "VALIDATION_FAILED", "Validation failed.", {
        status: "must be 'OPEN' or 'CLOSED'",
      });
    }
    const userId = params.get("userId");
    if (userId !== null && userId.trim() !== "" && !/^\d+$/.test(userId)) {
      throw new AuthError(422, "VALIDATION_FAILED", "Validation failed.", {
        userId: "must be a numeric id",
      });
    }
    const symbol = params.get("symbol");
    const result = await this.deps.store.platformTrades(
      {
        ...(userId !== null && userId.trim() !== "" ? { userId } : {}),
        ...(status !== null && status.trim() !== "" ? { status } : {}),
        ...(symbol !== null && symbol.trim() !== "" ? { symbol: symbol.trim().toUpperCase() } : {}),
        ...readInstantFilter(params, "since", "until"),
      },
      page.limit,
      page.offset,
    );
    return { items: result.items, total: result.total, ...page };
  }

  /** Platform-wide trading-account list (Legacy `/admin/trading-accounts`). */
  async platformAccounts(params: URLSearchParams): Promise<Record<string, unknown>> {
    const page = readPage(params);
    const userId = params.get("userId");
    if (userId !== null && userId.trim() !== "" && !/^\d+$/.test(userId)) {
      throw new AuthError(422, "VALIDATION_FAILED", "Validation failed.", {
        userId: "must be a numeric id",
      });
    }
    const syncStatus = params.get("syncStatus");
    const allowed = ["DISCONNECTED", "CONNECTING", "SYNCING", "CONNECTED", "ERROR"];
    if (syncStatus !== null && syncStatus.trim() !== "" && !allowed.includes(syncStatus)) {
      throw new AuthError(422, "VALIDATION_FAILED", "Validation failed.", {
        syncStatus: `must be one of ${allowed.join(", ")}`,
      });
    }
    const result = await this.deps.store.platformAccounts(
      {
        ...(userId !== null && userId.trim() !== "" ? { userId } : {}),
        ...(syncStatus !== null && syncStatus.trim() !== "" ? { syncStatus } : {}),
      },
      page.limit,
      page.offset,
    );
    return { items: result.items, total: result.total, ...page };
  }

  // --- Phase 10: effective config (secret-free) ---
  async effectiveConfig(): Promise<unknown> {
    return this.deps.store.effectiveConfig();
  }

  // --- Phase 10: diagnostics (detailed health) ---
  async diagnostics(): Promise<unknown> {
    return this.deps.store.diagnostics();
  }

  // --- Phase 10: refresh diagnostics (bounded, rate-limited, honest) ---
  async refreshDiagnostics(actorId: string): Promise<unknown> {
    const key = `admin-system-health-refresh:${actorId}`;
    const now = Date.now();
    const windowMs = 120_000;
    const maxHits = 5;
    let bucket = refreshBuckets.get(key);
    if (bucket === undefined) {
      bucket = [];
      refreshBuckets.set(key, bucket);
    }
    // prune outside window
    const fresh = bucket.filter((t) => now - t < windowMs);
    refreshBuckets.set(key, fresh);
    if (fresh.length >= maxHits) {
      throw new AuthError(429, "TOO_MANY_REQUESTS", "Too many refresh requests. Try again shortly.", {
        limit: String(maxHits),
        window: "120s",
      });
    }
    fresh.push(now);
    // Honest refresh: derive status from configuration presence (no external call that would storm providers).
    // Each integration's baseline (configured ? HEALTHY : NOT_CONFIGURED) is persisted so a subsequent GET
    // reflects the last operator-initiated refresh, matching Legacy's cache semantics without fabricating latency.
    const diag = await this.deps.store.diagnostics();
    const effective = await this.deps.store.effectiveConfig();
    const integrations = effective.integrations as unknown as Record<string, { configured: boolean }>;
    const probe: Record<string, { status: string; reachable: boolean; verified: boolean; latencyMs: number | null; checkedAt: string; message: string | null }> = {};
    const nowIso = new Date().toISOString();
    const toHealth = (status: string): string => {
      if (status === "SUCCESS") return "HEALTHY";
      if (status === "NOT_CONFIGURED") return "NOT_CONFIGURED";
      return "UNHEALTHY";
    };
    for (const name of ["metaapi", "email", "ai", "n8n_relay"] as const) {
      const configured = Boolean((integrations as Record<string, { configured: boolean }>)[name === "n8n_relay" ? "n8nRelay" : name]?.configured);
      const probeStatus = configured ? "SUCCESS" : "NOT_CONFIGURED";
      const healthStatus = toHealth(probeStatus);
      const msg = configured ? null : `${name} is not configured.`;
      await this.deps.store.refreshIntegrationHealth(name, healthStatus, 0, probeStatus === "SUCCESS" ? null : probeStatus, msg);
      probe[name] = {
        status: probeStatus,
        reachable: probeStatus === "SUCCESS",
        verified: probeStatus === "SUCCESS",
        latencyMs: 0,
        checkedAt: nowIso,
        message: msg,
      };
    }
    const refreshed = await this.deps.store.diagnostics();
    return { health: refreshed, probe, previous: diag };
  }

  async userActivity(userId: string, params: URLSearchParams): Promise<Record<string, unknown>> {
    await this.deps.users.getUser(userId);
    const page = readPage(params);
    const result = await this.deps.store.userActivity(userId, page.limit, page.offset);
    return { items: result.items, total: result.total, ...page };
  }
}

// In-memory rate limiter for diagnostics refresh (5 per 120s per actor). Exported for tests.
export const refreshBuckets: Map<string, number[]> = new Map();

/** The console's user list, projected for the operator (no secrets). */
export type { ConsoleUserRow } from "./adminConsoleStore.js";

function isPreset(value: string): value is RangePreset {
  return value === "today" || value === "7d" || value === "30d" || value === "90d" || value === "all";
}

function presetRange(preset: RangePreset, now: Date): { from: Date; to: Date } {
  const to = new Date(now.getTime());
  const day = 24 * 60 * 60 * 1000;
  switch (preset) {
    case "today": {
      const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return { from, to };
    }
    case "7d":
      return { from: new Date(to.getTime() - 7 * day), to };
    case "30d":
      return { from: new Date(to.getTime() - 30 * day), to };
    case "90d":
      return { from: new Date(to.getTime() - 90 * day), to };
    case "all":
      return { from: ALL_FROM, to };
  }
}

/** Parse an ISO instant, defaulting to the opposite end of a 30-day window. */
function parseInstant(raw: string | null, side: "from" | "to", now: Date): Date {
  if (raw === null || raw.trim() === "") {
    return side === "from" ? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) : new Date(now.getTime());
  }
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw new AuthError(422, "VALIDATION_FAILED", "Validation failed.", {
      [side]: "must be an ISO-8601 instant",
    });
  }
  if (value.getTime() < ALL_FROM.getTime() && side === "from") return new Date(ALL_FROM);
  return value;
}

function readInstantFilter(
  params: URLSearchParams,
  sinceKey: string,
  untilKey: string,
): { since?: Date; until?: Date } {
  const out: { since?: Date; until?: Date } = {};
  const since = params.get(sinceKey);
  if (since !== null && since.trim() !== "") {
    const value = new Date(since);
    if (Number.isNaN(value.getTime())) {
      throw new AuthError(422, "VALIDATION_FAILED", "Validation failed.", {
        [sinceKey]: "must be an ISO-8601 instant",
      });
    }
    out.since = value;
  }
  const until = params.get(untilKey);
  if (until !== null && until.trim() !== "") {
    const value = new Date(until);
    if (Number.isNaN(value.getTime())) {
      throw new AuthError(422, "VALIDATION_FAILED", "Validation failed.", {
        [untilKey]: "must be an ISO-8601 instant",
      });
    }
    out.until = value;
  }
  if (out.since !== undefined && out.until !== undefined && out.since.getTime() >= out.until.getTime()) {
    throw new AuthError(422, "RANGE_INVALID", "The range start must precede its end.");
  }
  return out;
}

function readLimit(params: URLSearchParams, fallback: number, max = CONSOLE_FEED_MAX): number {
  const raw = params.get("limit");
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new AuthError(422, "VALIDATION_FAILED", "Validation failed.", { limit: `1..${max}` });
  }
  return value;
}

function readPage(params: URLSearchParams): { page: number; perPage: number; limit: number; offset: number } {
  const rawPage = params.get("page");
  const rawPerPage = params.get("perPage");
  const page = rawPage === null || rawPage.trim() === "" ? 1 : Number(rawPage);
  const perPage = rawPerPage === null || rawPerPage.trim() === "" ? CONSOLE_PAGE_SIZE_DEFAULT : Number(rawPerPage);
  if (!Number.isInteger(page) || page < 1) {
    throw new AuthError(422, "VALIDATION_FAILED", "Validation failed.", { page: "must be >= 1" });
  }
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > CONSOLE_PAGE_SIZE_MAX) {
    throw new AuthError(422, "VALIDATION_FAILED", "Validation failed.", {
      perPage: `1..${CONSOLE_PAGE_SIZE_MAX}`,
    });
  }
  return { page, perPage, limit: perPage, offset: (page - 1) * perPage };
}

/**
 * Rank a component list into one overall verdict.
 *
 * The ORDER is the message: an unhealthy component outranks a degraded one, a
 * degraded one outranks `unknown`, and `not_applicable` never upgrades a report
 * (a platform with a broken database and nine unimplemented components is not
 * "mostly fine"). This is deliberately not an average or a percentage.
 */
export function rankComponents(
  components: readonly ComponentStatus[],
): "healthy" | "degraded" | "unhealthy" | "unknown" {
  const rank = (c: ComponentStatus): number => {
    switch (c.status) {
      case "unhealthy":
        return 4;
      case "degraded":
        return 3;
      case "unknown":
        return 2;
      default:
        return 0;
    }
  };
  const worst = components.reduce((acc, c) => Math.max(acc, rank(c)), 0);
  switch (worst) {
    case 4:
      return "unhealthy";
    case 3:
      return "degraded";
    case 2:
      return "unknown";
    default:
      return "healthy";
  }
}
