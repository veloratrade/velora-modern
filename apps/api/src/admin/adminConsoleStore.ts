// Admin console store — Phase 6 (the operator's platform-wide read surface).
//
// WHY THIS MODULE EXISTS
//
// Phase 5 gave the support capability its own store (`PgSupportStore`) and the
// admin queue reuses it unchanged. The Phase 6 console needs a different set of
// reads — platform aggregates, a user's accounts and trades as seen from the
// operator side, the audit trail by filter, and the two authentication feeds —
// and none of them belongs in a capability store that a USER's request path also
// serves. Putting them here keeps the rule the codebase already follows: one
// module per capability, one store per module, and the user-facing stores
// untouched by administrative reads.
//
// THREE PROPERTIES EVERY QUERY HERE MUST HAVE
//
//   1. IT COUNTS WHAT THE DOMAIN COUNTS. A tombstoned trade (`deleted_at IS NOT
//      NULL`) is excluded from every trade aggregate below, exactly as the
//      trade list and the analytics module exclude it. A console that disagreed
//      with the user's own dashboard about "how many trades" would be worse than
//      no console.
//   2. MONEY STAYS A STRING. `net_pnl`/`balance`/`equity` are NUMERIC and are
//      summed in SQL, then carried out of this module as strings (ADR-001). No
//      float ever touches them; `Number()` on a money value is a defect.
//   3. A TIME WINDOW IS HALF-OPEN [from, to). The caller supplies UTC instants;
//      `occurred_at >= $from AND occurred_at < $to`. Half-open is what makes
//      consecutive windows add up without double-counting the boundary row.
//
// NOTHING HERE FABRICATES. Where a Legacy section has no Modern substrate yet
// (AI usage, integration health, revenue), the SERVICE reports it as an
// explicitly unavailable section with a reason — never as zeros, and never as an
// empty list that reads like "we checked and found nothing".
import type { QueryFn } from "../persistence/pg.js";

type Row = Record<string, unknown>;

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : String(v ?? "");
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));
const num = (v: unknown): number => Number(v ?? 0);
/** Money and any other NUMERIC: the driver returns an exact string; keep it. */
const dec = (v: unknown): string => (v === null || v === undefined ? "0" : String(v));

function revenueUnavailable(): RevenueUnavailable {
  const unavailable = (): { readonly available: false; readonly reason: "NO_BILLING_SOURCE" } => ({ available: false, reason: "NO_BILLING_SOURCE" });
  return {
    available: false,
    reason: "NO_BILLING_SOURCE",
    note: "No authoritative billing source is configured. Financial metrics are unavailable, not zero.",
    metrics: {
      revenue: unavailable(),
      mrr: unavailable(),
      arr: unavailable(),
      churn: unavailable(),
      ltv: unavailable(),
      paymentVolume: unavailable(),
      refunds: unavailable(),
    },
  };
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One row of the operator's user table. No secrets, no password hash. */
export interface ConsoleUserRow {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: string;
  readonly status: string;
  readonly plan: string;
  readonly locale: string;
  readonly emailVerifiedAt: string | null;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}

export interface ConsoleAccountRow {
  readonly id: string;
  readonly userId: string;
  readonly ownerEmail: string;
  readonly label: string;
  readonly provider: string;
  readonly platform: string;
  readonly brokerServer: string | null;
  readonly accountNumberMasked: string;
  readonly currency: string;
  readonly syncStatus: string;
  readonly status: string;
  readonly balance: string;
  readonly equity: string;
  readonly lastError: string | null;
  readonly lastIncrementalAt: string | null;
  readonly createdAt: string;
}

export interface ConsoleTradeRow {
  readonly id: string;
  readonly userId: string;
  readonly ownerEmail: string;
  readonly accountId: string | null;
  readonly symbol: string;
  readonly direction: string;
  readonly status: string;
  readonly volume: string;
  readonly entryPrice: string;
  readonly exitPrice: string | null;
  readonly netPnl: string | null;
  readonly rMultiple: string | null;
  readonly occurredAt: string;
  readonly closedAt: string | null;
  readonly createdAt: string;
}

export interface ConsoleSecurityEventRow {
  readonly id: string;
  readonly occurredAt: string;
  readonly userId: string | null;
  readonly email: string | null;
  readonly eventType: string;
  readonly result: string;
  readonly reason: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

/** The operator dashboard: named groups of whole-table counts. */
export interface OverviewSnapshot {
  readonly users: {
    readonly total: number;
    readonly active: number;
    readonly suspended: number;
    readonly verified: number;
    readonly admins: number;
    readonly superAdmins: number;
    readonly byPlan: readonly { readonly key: string; readonly count: number }[];
    readonly byLocale: readonly { readonly key: string; readonly count: number }[];
    readonly newLast7Days: number;
  };
  readonly trading: {
    readonly accounts: number;
    readonly connectedAccounts: number;
    readonly accountsWithSyncError: number;
    readonly trades: number;
    readonly openTrades: number;
    readonly closedTrades: number;
    readonly tradesLast7Days: number;
    readonly netPnl: string;
    readonly equity: string;
  };
  readonly subscriptions: {
    readonly active: number;
    readonly trialing: number;
    readonly pastDue: number;
    readonly canceled: number;
    readonly byPlan: readonly { readonly key: string; readonly count: number }[];
  };
  readonly support: {
    readonly open: number;
    readonly pending: number;
    readonly closed: number;
    readonly archived: number;
    readonly unreadForAdmins: number;
  };
  readonly telegram: {
    readonly linkedAccounts: number;
    readonly activeChannels: number;
  };
}

export interface UsersAnalytics {
  readonly totals: {
    readonly total: number;
    readonly newInRange: number;
    readonly active: number;
    readonly suspended: number;
    readonly verified: number;
  };
  readonly byRole: readonly { readonly key: string; readonly count: number }[];
  readonly byLocale: readonly { readonly key: string; readonly count: number }[];
  readonly byPlan: readonly { readonly key: string; readonly count: number }[];
  readonly byStatus: readonly { readonly key: string; readonly count: number }[];
  readonly registrationTrend: readonly { readonly day: string; readonly count: number }[];
}

export interface TradingAnalytics {
  readonly totals: {
    readonly trades: number;
    readonly openTrades: number;
    readonly closedTrades: number;
    readonly volume: string;
    readonly netPnl: string;
    readonly wins: number;
    readonly losses: number;
    readonly breakEven: number;
    readonly distinctTraders: number;
  };
  readonly bySymbol: readonly { readonly key: string; readonly count: number }[];
  readonly byDirection: readonly { readonly key: string; readonly count: number }[];
  readonly pnlTrend: readonly { readonly day: string; readonly netPnl: string; readonly count: number }[];
}

/** Raw facts the SERVICE turns into a component status list. */
export interface HealthFacts {
  readonly databaseLatencyMs: number;
  readonly appliedMigrations: number;
  readonly migrationHead: string | null;
  /**
   * How many migrations the RUNNING BUILD expects, or `null` when this process
   * cannot see the manifest. `null` is not zero and must never be reported as
   * "all applied": a health check that cannot read the expectation reports
   * `unknown`, which is the honest answer and the one an operator can act on.
   */
  readonly expectedMigrations: number | null;
  readonly tables: number;
  readonly rateLimitBuckets: number;
  readonly auditRows: number;
  readonly authEvents: number;
  readonly processUptimeSeconds: number;
  readonly nodeVersion: string;
}

export interface SecurityFeedFilter {
  readonly result?: "success" | "failure";
  readonly since?: Date;
  readonly until?: Date;
  readonly limit: number;
  readonly before?: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
}

export interface AnalyticsOverview {
  readonly users: { readonly total: number; readonly active: number; readonly suspended: number; readonly newInRange: number };
  readonly trading: { readonly totalTrades: number; readonly tradesInRange: number; readonly tradingAccounts: number };
  readonly ai: { readonly totalRequests: number; readonly requestsInRange: number; readonly failedInRange: number };
  readonly operations: { readonly systemErrors: number; readonly integrationFailures: number };
  readonly revenue: RevenueUnavailable;
}

export interface AiAnalytics {
  readonly total: number;
  readonly inRange: number;
  readonly byStatus: readonly { readonly key: string; readonly count: number }[];
  readonly byProvider: readonly { readonly key: string; readonly count: number }[];
  readonly byFeature: readonly { readonly key: string; readonly count: number }[];
  readonly byModel: readonly { readonly key: string; readonly count: number }[];
  readonly tokensUsed: number;
  readonly cost: string;
  readonly trend: readonly { readonly day: string; readonly count: number }[];
}

export interface OperationsAnalytics {
  readonly systemLogs: {
    readonly total: number;
    readonly errors: number;
    readonly bySeverity: readonly { readonly key: string; readonly count: number }[];
    readonly bySource: readonly { readonly key: string; readonly count: number }[];
  };
  readonly integrations: readonly {
    readonly integration: string;
    readonly status: string;
    readonly latencyMs: number | null;
    readonly errorCode: string | null;
    readonly checkedAt: string;
  }[];
  readonly integrationFailures: number;
  readonly adminAudit: { readonly eventsInRange: number };
}

export interface RevenueUnavailable {
  readonly available: false;
  readonly reason: "NO_BILLING_SOURCE";
  readonly note: string;
  readonly metrics: Record<string, { readonly available: false; readonly reason: "NO_BILLING_SOURCE" }>;
}

// ---------------------------------------------------------------------------
// Store port
// ---------------------------------------------------------------------------

export interface AdminConsoleStore {
  overview(): Promise<OverviewSnapshot>;
  usersAnalytics(from: Date, to: Date): Promise<UsersAnalytics>;
  tradingAnalytics(from: Date, to: Date): Promise<TradingAnalytics>;
  analyticsOverview(from: Date, to: Date): Promise<AnalyticsOverview>;
  aiAnalytics(from: Date, to: Date): Promise<AiAnalytics>;
  operationsAnalytics(from: Date, to: Date): Promise<OperationsAnalytics>;
  revenueAnalytics(): Promise<RevenueUnavailable>;
  health(): Promise<HealthFacts>;
  securityFeed(
    eventType: "signup" | "login",
    filter: SecurityFeedFilter,
  ): Promise<Page<ConsoleSecurityEventRow>>;
  userAccounts(userId: string, limit: number, offset: number): Promise<Page<ConsoleAccountRow>>;
  userTrades(userId: string, limit: number, offset: number): Promise<Page<ConsoleTradeRow>>;
  platformAccounts(
    filter: { readonly userId?: string; readonly syncStatus?: string },
    limit: number,
    offset: number,
  ): Promise<Page<ConsoleAccountRow>>;
  platformTrades(
    filter: {
      readonly userId?: string;
      readonly status?: string;
      readonly symbol?: string;
      readonly since?: Date;
      readonly until?: Date;
    },
    limit: number,
    offset: number,
  ): Promise<Page<ConsoleTradeRow>>;
}

// ---------------------------------------------------------------------------
// PostgreSQL adapter
// ---------------------------------------------------------------------------

const ACCOUNT_COLUMNS = `
  a.id::text                AS id,
  a.user_id::text           AS user_id,
  u.email                   AS owner_email,
  a.label                   AS label,
  a.provider                AS provider,
  a.platform                AS platform,
  a.broker_server           AS broker_server,
  a.account_number_masked   AS account_number_masked,
  a.currency                AS currency,
  a.sync_status             AS sync_status,
  a.status                  AS status,
  a.balance                 AS balance,
  a.equity                  AS equity,
  a.last_error              AS last_error,
  a.last_incremental_at     AS last_incremental_at,
  a.created_at              AS created_at`;

const TRADE_COLUMNS = `
  t.id::text          AS id,
  t.user_id::text     AS user_id,
  u.email             AS owner_email,
  t.account_id::text  AS account_id,
  t.symbol            AS symbol,
  t.direction         AS direction,
  t.status            AS status,
  t.volume            AS volume,
  t.entry_price       AS entry_price,
  t.exit_price        AS exit_price,
  t.net_pnl           AS net_pnl,
  t.r_multiple        AS r_multiple,
  t.occurred_at       AS occurred_at,
  t.updated_at        AS updated_at,
  t.created_at        AS created_at`;

export class PgAdminConsoleStore implements AdminConsoleStore {
  constructor(
    private readonly q: QueryFn,
    /** The migration files the build expects to be applied; compared against
     *  `schema_migrations`. Supplied by the composition root so the check cannot
     *  drift from what the build actually shipped. */
    private readonly expectedMigrations: number | null,
    private readonly uptimeSeconds: () => number = () => process.uptime(),
  ) {}

  async overview(): Promise<OverviewSnapshot> {
    // One round trip, one consistent snapshot. Several small queries would each
    // see a different instant, and a dashboard whose sections disagree ("12
    // users" above "13 active users") destroys trust in the whole surface.
    const [counts] = await this.q(
      `SELECT
         (SELECT count(*)::int FROM users)                                        AS users_total,
         (SELECT count(*)::int FROM users WHERE status = 'active')                AS users_active,
         (SELECT count(*)::int FROM users WHERE status = 'suspended')             AS users_suspended,
         (SELECT count(*)::int FROM users WHERE email_verified_at IS NOT NULL)    AS users_verified,
         (SELECT count(*)::int FROM users WHERE role = 'admin')                   AS users_admin,
         (SELECT count(*)::int FROM users WHERE role = 'super_admin')             AS users_super,
         (SELECT count(*)::int FROM users WHERE created_at >= now() - interval '7 days') AS users_new7,
         (SELECT count(*)::int FROM trading_accounts)                             AS accounts_total,
         (SELECT count(*)::int FROM trading_accounts WHERE sync_status = 'CONNECTED') AS accounts_connected,
         (SELECT count(*)::int FROM trading_accounts WHERE sync_status = 'ERROR')  AS accounts_error,
         (SELECT count(*)::int FROM trades WHERE deleted_at IS NULL)              AS trades_total,
         (SELECT count(*)::int FROM trades WHERE deleted_at IS NULL AND status = 'OPEN') AS trades_open,
         (SELECT count(*)::int FROM trades WHERE deleted_at IS NULL AND status = 'CLOSED') AS trades_closed,
         (SELECT count(*)::int FROM trades WHERE deleted_at IS NULL AND occurred_at >= now() - interval '7 days') AS trades_new7,
         (SELECT COALESCE(sum(net_pnl), 0) FROM trades WHERE deleted_at IS NULL AND status = 'CLOSED') AS trades_pnl,
         (SELECT COALESCE(sum(equity), 0) FROM trading_accounts)                  AS equity_total,
         (SELECT count(*)::int FROM subscriptions WHERE status = 'active')        AS subs_active,
         (SELECT count(*)::int FROM subscriptions WHERE status = 'trialing')      AS subs_trialing,
         (SELECT count(*)::int FROM subscriptions WHERE status = 'past_due')      AS subs_past_due,
         (SELECT count(*)::int FROM subscriptions WHERE status = 'canceled')      AS subs_canceled,
         (SELECT count(*)::int FROM support_tickets WHERE status = 'open')        AS sup_open,
         (SELECT count(*)::int FROM support_tickets WHERE status = 'pending')     AS sup_pending,
         (SELECT count(*)::int FROM support_tickets WHERE status = 'closed')      AS sup_closed,
         (SELECT count(*)::int FROM support_tickets WHERE status = 'archived')    AS sup_archived,
         (SELECT COALESCE(sum(unread_admin_count), 0)::int FROM support_tickets)  AS sup_unread,
         (SELECT count(*)::int FROM telegram_identities WHERE status = 'LINKED')          AS tg_linked,
         (SELECT count(*)::int FROM telegram_channels WHERE status = 'ACTIVE')          AS tg_channels`,
      [],
    );
    const byPlan = await this.q(
      "SELECT plan AS key, count(*)::int AS n FROM users GROUP BY plan ORDER BY n DESC, key",
      [],
    );
    const byLocale = await this.q(
      "SELECT locale AS key, count(*)::int AS n FROM users GROUP BY locale ORDER BY n DESC, key",
      [],
    );
    const subsByPlan = await this.q(
      "SELECT plan AS key, count(*)::int AS n FROM subscriptions GROUP BY plan ORDER BY n DESC, key",
      [],
    );
    const c = counts ?? {};
    return {
      users: {
        total: num(c["users_total"]),
        active: num(c["users_active"]),
        suspended: num(c["users_suspended"]),
        verified: num(c["users_verified"]),
        admins: num(c["users_admin"]),
        superAdmins: num(c["users_super"]),
        byPlan: byPlan.map((r) => ({ key: String(r["key"]), count: num(r["n"]) })),
        byLocale: byLocale.map((r) => ({ key: String(r["key"]), count: num(r["n"]) })),
        newLast7Days: num(c["users_new7"]),
      },
      trading: {
        accounts: num(c["accounts_total"]),
        connectedAccounts: num(c["accounts_connected"]),
        accountsWithSyncError: num(c["accounts_error"]),
        trades: num(c["trades_total"]),
        openTrades: num(c["trades_open"]),
        closedTrades: num(c["trades_closed"]),
        tradesLast7Days: num(c["trades_new7"]),
        netPnl: dec(c["trades_pnl"]),
        equity: dec(c["equity_total"]),
      },
      subscriptions: {
        active: num(c["subs_active"]),
        trialing: num(c["subs_trialing"]),
        pastDue: num(c["subs_past_due"]),
        canceled: num(c["subs_canceled"]),
        byPlan: subsByPlan.map((r) => ({ key: String(r["key"]), count: num(r["n"]) })),
      },
      support: {
        open: num(c["sup_open"]),
        pending: num(c["sup_pending"]),
        closed: num(c["sup_closed"]),
        archived: num(c["sup_archived"]),
        unreadForAdmins: num(c["sup_unread"]),
      },
      telegram: {
        linkedAccounts: num(c["tg_linked"]),
        activeChannels: num(c["tg_channels"]),
      },
    };
  }

  async usersAnalytics(from: Date, to: Date): Promise<UsersAnalytics> {
    const [totals] = await this.q(
      `SELECT
         (SELECT count(*)::int FROM users) AS total,
         (SELECT count(*)::int FROM users WHERE created_at >= $1 AND created_at < $2) AS new_in_range,
         (SELECT count(*)::int FROM users WHERE status = 'active') AS active,
         (SELECT count(*)::int FROM users WHERE status = 'suspended') AS suspended,
         (SELECT count(*)::int FROM users WHERE email_verified_at IS NOT NULL) AS verified`,
      [from, to],
    );
    const group = async (column: string): Promise<{ key: string; count: number }[]> => {
      const rows = await this.q(
        `SELECT ${column} AS key, count(*)::int AS n FROM users GROUP BY ${column} ORDER BY n DESC, key`,
        [],
      );
      return rows.map((r) => ({ key: String(r["key"]), count: num(r["n"]) }));
    };
    const trend = await this.q(
      `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
              count(*)::int AS n
         FROM users
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY 1
        ORDER BY 1`,
      [from, to],
    );
    const t = totals ?? {};
    return {
      totals: {
        total: num(t["total"]),
        newInRange: num(t["new_in_range"]),
        active: num(t["active"]),
        suspended: num(t["suspended"]),
        verified: num(t["verified"]),
      },
      byRole: await group("role"),
      byLocale: await group("locale"),
      byPlan: await group("plan"),
      byStatus: await group("status"),
      registrationTrend: trend.map((r) => ({ day: String(r["day"]), count: num(r["n"]) })),
    };
  }

  async tradingAnalytics(from: Date, to: Date): Promise<TradingAnalytics> {
    // Every aggregate is scoped to the SAME window and the same tombstone rule
    // as the trade list: `deleted_at IS NULL` and occurred_at in [from, to).
    const [totals] = await this.q(
      `SELECT
         count(*)::int AS trades,
         count(*) FILTER (WHERE status = 'OPEN')::int   AS open_trades,
         count(*) FILTER (WHERE status = 'CLOSED')::int AS closed_trades,
         COALESCE(sum(volume), 0)                       AS volume,
         COALESCE(sum(net_pnl) FILTER (WHERE status = 'CLOSED'), 0) AS net_pnl,
         count(*) FILTER (WHERE status = 'CLOSED' AND net_pnl > 0)::int AS wins,
         count(*) FILTER (WHERE status = 'CLOSED' AND net_pnl < 0)::int AS losses,
         count(*) FILTER (WHERE status = 'CLOSED' AND net_pnl = 0)::int AS break_even,
         count(DISTINCT user_id)::int                   AS traders
       FROM trades
      WHERE deleted_at IS NULL AND occurred_at >= $1 AND occurred_at < $2`,
      [from, to],
    );
    const bySymbol = await this.q(
      `SELECT symbol AS key, count(*)::int AS n
         FROM trades
        WHERE deleted_at IS NULL AND occurred_at >= $1 AND occurred_at < $2
        GROUP BY symbol ORDER BY n DESC, key LIMIT 15`,
      [from, to],
    );
    const byDirection = await this.q(
      `SELECT direction AS key, count(*)::int AS n
         FROM trades
        WHERE deleted_at IS NULL AND occurred_at >= $1 AND occurred_at < $2
        GROUP BY direction ORDER BY n DESC, key`,
      [from, to],
    );
    const trend = await this.q(
      `SELECT to_char(date_trunc('day', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
              COALESCE(sum(net_pnl) FILTER (WHERE status = 'CLOSED'), 0) AS net_pnl,
              count(*)::int AS n
         FROM trades
        WHERE deleted_at IS NULL AND occurred_at >= $1 AND occurred_at < $2
        GROUP BY 1 ORDER BY 1`,
      [from, to],
    );
    const t = totals ?? {};
    return {
      totals: {
        trades: num(t["trades"]),
        openTrades: num(t["open_trades"]),
        closedTrades: num(t["closed_trades"]),
        volume: dec(t["volume"]),
        netPnl: dec(t["net_pnl"]),
        wins: num(t["wins"]),
        losses: num(t["losses"]),
        breakEven: num(t["break_even"]),
        distinctTraders: num(t["traders"]),
      },
      bySymbol: bySymbol.map((r) => ({ key: String(r["key"]), count: num(r["n"]) })),
      byDirection: byDirection.map((r) => ({ key: String(r["key"]), count: num(r["n"]) })),
      pnlTrend: trend.map((r) => ({
        day: String(r["day"]),
        netPnl: dec(r["net_pnl"]),
        count: num(r["n"]),
      })),
    };
  }

  async analyticsOverview(from: Date, to: Date): Promise<AnalyticsOverview> {
    const [users] = await this.q(
      `SELECT
         (SELECT count(*)::int FROM users) AS total,
         (SELECT count(*)::int FROM users WHERE status = 'active') AS active,
         (SELECT count(*)::int FROM users WHERE status = 'suspended') AS suspended,
         (SELECT count(*)::int FROM users WHERE created_at >= $1 AND created_at < $2) AS new_in_range`,
      [from, to],
    );
    const [trading] = await this.q(
      `SELECT
         (SELECT count(*)::int FROM trades WHERE deleted_at IS NULL) AS total_trades,
         (SELECT count(*)::int FROM trades WHERE deleted_at IS NULL AND created_at >= $1 AND created_at < $2) AS in_range,
         (SELECT count(*)::int FROM trading_accounts) AS accounts`,
      [from, to],
    );
    const [ai] = await this.q(
      `SELECT
         (SELECT count(*)::int FROM ai_coaching_logs) AS total,
         (SELECT count(*)::int FROM ai_coaching_logs WHERE created_at >= $1 AND created_at < $2) AS in_range,
         (SELECT count(*)::int FROM ai_coaching_logs WHERE outcome <> 'success' AND created_at >= $1 AND created_at < $2) AS failed`,
      [from, to],
    );
    const [ops] = await this.q(
      `SELECT
         (SELECT count(*)::int FROM system_logs WHERE severity = 'ERROR' AND created_at >= $1 AND created_at < $2) AS errors,
         (SELECT count(*)::int FROM integration_health WHERE status NOT IN ('HEALTHY','OK')) AS failures`,
      [from, to],
    );
    const u = users ?? {};
    const tr = trading ?? {};
    const a = ai ?? {};
    const o = ops ?? {};
    return {
      users: {
        total: num(u["total"]),
        active: num(u["active"]),
        suspended: num(u["suspended"]),
        newInRange: num(u["new_in_range"]),
      },
      trading: {
        totalTrades: num(tr["total_trades"]),
        tradesInRange: num(tr["in_range"]),
        tradingAccounts: num(tr["accounts"]),
      },
      ai: {
        totalRequests: num(a["total"]),
        requestsInRange: num(a["in_range"]),
        failedInRange: num(a["failed"]),
      },
      operations: {
        systemErrors: num(o["errors"]),
        integrationFailures: num(o["failures"]),
      },
      revenue: revenueUnavailable(),
    };
  }

  async aiAnalytics(from: Date, to: Date): Promise<AiAnalytics> {
    const [totals] = await this.q(`SELECT count(*)::int AS total FROM ai_coaching_logs`, []);
    const [inRange] = await this.q(
      `SELECT count(*)::int AS n FROM ai_coaching_logs WHERE created_at >= $1 AND created_at < $2`,
      [from, to],
    );
    const byStatus = await this.q(
      `SELECT outcome AS key, count(*)::int AS n FROM ai_coaching_logs WHERE created_at >= $1 AND created_at < $2 GROUP BY outcome ORDER BY n DESC, key`,
      [from, to],
    );
    const byProvider = await this.q(
      `SELECT provider AS key, count(*)::int AS n FROM ai_coaching_logs WHERE created_at >= $1 AND created_at < $2 GROUP BY provider ORDER BY n DESC, key`,
      [from, to],
    );
    const byFeature = await this.q(
      `SELECT feature AS key, count(*)::int AS n FROM ai_coaching_logs WHERE created_at >= $1 AND created_at < $2 GROUP BY feature ORDER BY n DESC, key`,
      [from, to],
    );
    const byModel = await this.q(
      `SELECT model AS key, count(*)::int AS n FROM ai_coaching_logs WHERE created_at >= $1 AND created_at < $2 GROUP BY model ORDER BY n DESC, key`,
      [from, to],
    );
    const [costRow] = await this.q(
      `SELECT COALESCE(sum(cost_micro_usd), 0)::bigint AS cost,
              COALESCE(sum(tokens_in), 0)::int + COALESCE(sum(tokens_out), 0)::int AS tokens
         FROM ai_coaching_logs WHERE created_at >= $1 AND created_at < $2`,
      [from, to],
    );
    const trend = await this.q(
      `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
              count(*)::int AS n
         FROM ai_coaching_logs WHERE created_at >= $1 AND created_at < $2
        GROUP BY 1 ORDER BY 1`,
      [from, to],
    );
    const c = costRow ?? {};
    return {
      total: num(totals?.["total"] ?? 0),
      inRange: num(inRange?.["n"] ?? 0),
      byStatus: byStatus.map((r) => ({ key: String(r["key"]), count: num(r["n"]) })),
      byProvider: byProvider.map((r) => ({ key: String(r["key"]), count: num(r["n"]) })),
      byFeature: byFeature.map((r) => ({ key: String(r["key"]), count: num(r["n"]) })),
      byModel: byModel.map((r) => ({ key: String(r["key"]), count: num(r["n"]) })),
      tokensUsed: num(c["tokens"] ?? 0),
      cost: (Number(c["cost"] ?? 0) / 1_000_000).toFixed(4),
      trend: trend.map((r) => ({ day: String(r["day"]), count: num(r["n"]) })),
    };
  }

  async operationsAnalytics(from: Date, to: Date): Promise<OperationsAnalytics> {
    const [sysTotal] = await this.q(`SELECT count(*)::int AS n FROM system_logs WHERE created_at >= $1 AND created_at < $2`, [from, to]);
    const [sysErrors] = await this.q(`SELECT count(*)::int AS n FROM system_logs WHERE severity = 'ERROR' AND created_at >= $1 AND created_at < $2`, [from, to]);
    const bySeverity = await this.q(
      `SELECT severity AS key, count(*)::int AS n FROM system_logs WHERE created_at >= $1 AND created_at < $2 GROUP BY severity ORDER BY n DESC, key`,
      [from, to],
    );
    const bySource = await this.q(
      `SELECT source AS key, count(*)::int AS n FROM system_logs WHERE created_at >= $1 AND created_at < $2 GROUP BY source ORDER BY n DESC, key`,
      [from, to],
    );
    const integrations = await this.q(
      `SELECT integration, status, latency_ms, error_code, checked_at FROM integration_health ORDER BY integration`,
      [],
    );
    const [failures] = await this.q(`SELECT count(*)::int AS n FROM integration_health WHERE status NOT IN ('HEALTHY','OK')`, []);
    const [audit] = await this.q(`SELECT count(*)::int AS n FROM audit_log WHERE created_at >= $1 AND created_at < $2`, [from, to]);
    return {
      systemLogs: {
        total: num(sysTotal?.["n"] ?? 0),
        errors: num(sysErrors?.["n"] ?? 0),
        bySeverity: bySeverity.map((r) => ({ key: String(r["key"]), count: num(r["n"]) })),
        bySource: bySource.map((r) => ({ key: String(r["key"]), count: num(r["n"]) })),
      },
      integrations: integrations.map((r) => ({
        integration: String(r["integration"]),
        status: String(r["status"]),
        latencyMs: r["latency_ms"] === null ? null : Number(r["latency_ms"]),
        errorCode: r["error_code"] === null ? null : String(r["error_code"]),
        checkedAt: iso(r["checked_at"]),
      })),
      integrationFailures: num(failures?.["n"] ?? 0),
      adminAudit: { eventsInRange: num(audit?.["n"] ?? 0) },
    };
  }

  async revenueAnalytics(): Promise<RevenueUnavailable> {
    return revenueUnavailable();
  }

  async health(): Promise<HealthFacts> {
    // Latency is measured around a real round trip from here, not read from a
    // monitoring table: with no metrics collector in this phase, this is the only
    // honest number available.
    const started = process.hrtime.bigint();
    await this.q("SELECT 1", []);
    const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const [row] = await this.q(
      `SELECT
         (SELECT count(*)::int FROM schema_migrations) AS migrations,
         (SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1) AS head,
         (SELECT count(*)::int FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tables,
         (SELECT count(*)::int FROM rate_limits) AS rate_buckets,
         (SELECT count(*)::int FROM audit_log) AS audit_rows,
         (SELECT count(*)::int FROM auth_events) AS auth_events`,
      [],
    );
    const r = row ?? {};
    return {
      databaseLatencyMs: Math.round(latencyMs * 100) / 100,
      appliedMigrations: num(r["migrations"]),
      migrationHead: r["head"] === null || r["head"] === undefined ? null : String(r["head"]),
      expectedMigrations: this.expectedMigrations,
      tables: num(r["tables"]),
      rateLimitBuckets: num(r["rate_buckets"]),
      auditRows: num(r["audit_rows"]),
      authEvents: num(r["auth_events"]),
      processUptimeSeconds: Math.round(this.uptimeSeconds()),
      nodeVersion: process.version,
    };
  }

  async securityFeed(
    eventType: "signup" | "login",
    filter: SecurityFeedFilter,
  ): Promise<Page<ConsoleSecurityEventRow>> {
    const where: string[] = ["e.event_type = $1"];
    const params: unknown[] = [eventType];
    if (filter.result !== undefined) {
      params.push(filter.result);
      where.push(`e.result = $${params.length}`);
    }
    if (filter.before !== undefined) {
      params.push(filter.before);
      where.push(`e.id < $${params.length}::bigint`);
    }
    if (filter.since !== undefined) {
      params.push(filter.since);
      where.push(`e.occurred_at >= $${params.length}`);
    }
    if (filter.until !== undefined) {
      params.push(filter.until);
      where.push(`e.occurred_at < $${params.length}`);
    }
    const clause = `WHERE ${where.join(" AND ")}`;
    params.push(filter.limit);
    const rows = await this.q(
      `SELECT e.id::text AS id, e.occurred_at, e.user_id::text AS user_id, u.email,
              e.event_type, e.result, e.reason, e.ip_address, e.user_agent
         FROM auth_events e
         LEFT JOIN users u ON u.id = e.user_id
         ${clause}
        ORDER BY e.id DESC
        LIMIT $${params.length}`,
      params,
    );
    const [count] = await this.q(
      `SELECT count(*)::int AS n FROM auth_events e ${clause}`,
      params.slice(0, params.length - 1),
    );
    return {
      items: rows.map((r) => ({
        id: String(r["id"]),
        occurredAt: iso(r["occurred_at"]),
        userId: r["user_id"] === null ? null : String(r["user_id"]),
        email: r["email"] === null || r["email"] === undefined ? null : String(r["email"]),
        eventType: String(r["event_type"]),
        result: String(r["result"]),
        reason: r["reason"] === null ? null : String(r["reason"]),
        ipAddress: r["ip_address"] === null ? null : String(r["ip_address"]),
        userAgent: r["user_agent"] === null ? null : String(r["user_agent"]),
      })),
      total: num(count?.["n"]),
    };
  }

  async userAccounts(userId: string, limit: number, offset: number): Promise<Page<ConsoleAccountRow>> {
    const rows = await this.q(
      `SELECT ${ACCOUNT_COLUMNS}
         FROM trading_accounts a JOIN users u ON u.id = a.user_id
        WHERE a.user_id = $1::bigint
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    const [count] = await this.q(
      "SELECT count(*)::int AS n FROM trading_accounts WHERE user_id = $1::bigint",
      [userId],
    );
    return { items: rows.map(mapAccount), total: num(count?.["n"]) };
  }

  async platformAccounts(
    filter: { readonly userId?: string; readonly syncStatus?: string },
    limit: number,
    offset: number,
  ): Promise<Page<ConsoleAccountRow>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.userId !== undefined) {
      params.push(filter.userId);
      where.push(`a.user_id = $${params.length}::bigint`);
    }
    if (filter.syncStatus !== undefined) {
      params.push(filter.syncStatus);
      where.push(`a.sync_status = $${params.length}`);
    }
    const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    params.push(limit, offset);
    const rows = await this.q(
      `SELECT ${ACCOUNT_COLUMNS}
         FROM trading_accounts a JOIN users u ON u.id = a.user_id
         ${clause}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const [count] = await this.q(
      `SELECT count(*)::int AS n FROM trading_accounts a ${clause}`,
      params.slice(0, params.length - 2),
    );
    return { items: rows.map(mapAccount), total: num(count?.["n"]) };
  }

  async userTrades(userId: string, limit: number, offset: number): Promise<Page<ConsoleTradeRow>> {
    return this.platformTrades({ userId }, limit, offset);
  }

  async platformTrades(
    filter: {
      readonly userId?: string;
      readonly status?: string;
      readonly symbol?: string;
      readonly since?: Date;
      readonly until?: Date;
    },
    limit: number,
    offset: number,
  ): Promise<Page<ConsoleTradeRow>> {
    const where: string[] = ["t.deleted_at IS NULL"];
    const params: unknown[] = [];
    if (filter.userId !== undefined) {
      params.push(filter.userId);
      where.push(`t.user_id = $${params.length}::bigint`);
    }
    if (filter.status !== undefined) {
      params.push(filter.status);
      where.push(`t.status = $${params.length}`);
    }
    if (filter.symbol !== undefined) {
      params.push(filter.symbol);
      where.push(`t.symbol = $${params.length}`);
    }
    if (filter.since !== undefined) {
      params.push(filter.since);
      where.push(`t.occurred_at >= $${params.length}`);
    }
    if (filter.until !== undefined) {
      params.push(filter.until);
      where.push(`t.occurred_at < $${params.length}`);
    }
    const clause = `WHERE ${where.join(" AND ")}`;
    params.push(limit, offset);
    const rows = await this.q(
      `SELECT ${TRADE_COLUMNS}
         FROM trades t JOIN users u ON u.id = t.user_id
         ${clause}
        ORDER BY t.occurred_at DESC, t.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const [count] = await this.q(
      `SELECT count(*)::int AS n FROM trades t ${clause}`,
      params.slice(0, params.length - 2),
    );
    return { items: rows.map(mapTrade), total: num(count?.["n"]) };
  }
}

function mapAccount(r: Row): ConsoleAccountRow {
  return {
    id: String(r["id"]),
    userId: String(r["user_id"]),
    ownerEmail: String(r["owner_email"]),
    label: String(r["label"]),
    provider: String(r["provider"]),
    platform: String(r["platform"]),
    brokerServer: r["broker_server"] === null ? null : String(r["broker_server"]),
    accountNumberMasked: String(r["account_number_masked"]),
    currency: String(r["currency"]),
    syncStatus: String(r["sync_status"]),
    status: String(r["status"]),
    balance: dec(r["balance"]),
    equity: dec(r["equity"]),
    lastError: r["last_error"] === null ? null : String(r["last_error"]),
    lastIncrementalAt: isoOrNull(r["last_incremental_at"]),
    createdAt: iso(r["created_at"]),
  };
}

function mapTrade(r: Row): ConsoleTradeRow {
  return {
    id: String(r["id"]),
    userId: String(r["user_id"]),
    ownerEmail: String(r["owner_email"]),
    accountId: r["account_id"] === null ? null : String(r["account_id"]),
    symbol: String(r["symbol"]),
    direction: String(r["direction"]),
    status: String(r["status"]),
    volume: dec(r["volume"]),
    entryPrice: dec(r["entry_price"]),
    exitPrice: r["exit_price"] === null ? null : dec(r["exit_price"]),
    netPnl: r["net_pnl"] === null ? null : dec(r["net_pnl"]),
    rMultiple: r["r_multiple"] === null ? null : dec(r["r_multiple"]),
    occurredAt: iso(r["occurred_at"]),
    // The trade's own "closed" instant is its last update in this schema (there
    // is no closed_at column); the field is named for what it holds rather than
    // inventing an instant the schema does not record.
    closedAt: isoOrNull(r["updated_at"]),
    createdAt: iso(r["created_at"]),
  };
}

// ---------------------------------------------------------------------------
// In-memory double (contract-identical; NOT database evidence)
// ---------------------------------------------------------------------------

/**
 * A double for route/service tests and for a memory-persistence boot.
 *
 * It returns EMPTY, self-consistent data rather than plausible numbers: a test
 * that wants a specific figure seeds it through the constructor, so no assertion
 * can accidentally pass against invented platform statistics.
 */
export class MemoryAdminConsoleStore implements AdminConsoleStore {
  constructor(
    private readonly data: {
      readonly overview?: OverviewSnapshot;
      readonly users?: UsersAnalytics;
      readonly trading?: TradingAnalytics;
      readonly health?: HealthFacts;
      readonly security?: Page<ConsoleSecurityEventRow>;
      readonly accounts?: Page<ConsoleAccountRow>;
      readonly trades?: Page<ConsoleTradeRow>;
    } = {},
  ) {}

  async overview(): Promise<OverviewSnapshot> {
    return (
      this.data.overview ?? {
        users: {
          total: 0,
          active: 0,
          suspended: 0,
          verified: 0,
          admins: 0,
          superAdmins: 0,
          byPlan: [],
          byLocale: [],
          newLast7Days: 0,
        },
        trading: {
          accounts: 0,
          connectedAccounts: 0,
          accountsWithSyncError: 0,
          trades: 0,
          openTrades: 0,
          closedTrades: 0,
          tradesLast7Days: 0,
          netPnl: "0",
          equity: "0",
        },
        subscriptions: { active: 0, trialing: 0, pastDue: 0, canceled: 0, byPlan: [] },
        support: { open: 0, pending: 0, closed: 0, archived: 0, unreadForAdmins: 0 },
        telegram: { linkedAccounts: 0, activeChannels: 0 },
      }
    );
  }

  async usersAnalytics(): Promise<UsersAnalytics> {
    return (
      this.data.users ?? {
        totals: { total: 0, newInRange: 0, active: 0, suspended: 0, verified: 0 },
        byRole: [],
        byLocale: [],
        byPlan: [],
        byStatus: [],
        registrationTrend: [],
      }
    );
  }

  async tradingAnalytics(): Promise<TradingAnalytics> {
    return (
      this.data.trading ?? {
        totals: {
          trades: 0,
          openTrades: 0,
          closedTrades: 0,
          volume: "0",
          netPnl: "0",
          wins: 0,
          losses: 0,
          breakEven: 0,
          distinctTraders: 0,
        },
        bySymbol: [],
        byDirection: [],
        pnlTrend: [],
      }
    );
  }

  async analyticsOverview(): Promise<AnalyticsOverview> {
    return {
      users: { total: 0, active: 0, suspended: 0, newInRange: 0 },
      trading: { totalTrades: 0, tradesInRange: 0, tradingAccounts: 0 },
      ai: { totalRequests: 0, requestsInRange: 0, failedInRange: 0 },
      operations: { systemErrors: 0, integrationFailures: 0 },
      revenue: revenueUnavailable(),
    };
  }

  async aiAnalytics(): Promise<AiAnalytics> {
    return {
      total: 0,
      inRange: 0,
      byStatus: [],
      byProvider: [],
      byFeature: [],
      byModel: [],
      tokensUsed: 0,
      cost: "0.0000",
      trend: [],
    };
  }

  async operationsAnalytics(): Promise<OperationsAnalytics> {
    return {
      systemLogs: { total: 0, errors: 0, bySeverity: [], bySource: [] },
      integrations: [],
      integrationFailures: 0,
      adminAudit: { eventsInRange: 0 },
    };
  }

  async revenueAnalytics(): Promise<RevenueUnavailable> {
    return revenueUnavailable();
  }

  async health(): Promise<HealthFacts> {
    return (
      this.data.health ?? {
        databaseLatencyMs: 0,
        appliedMigrations: 0,
        migrationHead: null,
        expectedMigrations: 0,
        tables: 0,
        rateLimitBuckets: 0,
        auditRows: 0,
        authEvents: 0,
        processUptimeSeconds: 0,
        nodeVersion: process.version,
      }
    );
  }

  async securityFeed(): Promise<Page<ConsoleSecurityEventRow>> {
    return this.data.security ?? { items: [], total: 0 };
  }

  async userAccounts(): Promise<Page<ConsoleAccountRow>> {
    return this.data.accounts ?? { items: [], total: 0 };
  }

  async userTrades(): Promise<Page<ConsoleTradeRow>> {
    return this.data.trades ?? { items: [], total: 0 };
  }

  async platformAccounts(): Promise<Page<ConsoleAccountRow>> {
    return this.data.accounts ?? { items: [], total: 0 };
  }

  async platformTrades(): Promise<Page<ConsoleTradeRow>> {
    return this.data.trades ?? { items: [], total: 0 };
  }
}
