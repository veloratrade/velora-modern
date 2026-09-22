// Portfolio — v1.5 "Multi-Account & Prop Drawdown".
//
//   GET /api/v1/portfolio/summary      per-account + combined performance
//   GET /api/v1/portfolio/by-symbol    best/worst instruments across accounts
//   GET /api/v1/portfolio/fx-rates     stored ECB rates
//   GET /api/v1/portfolio/prop-status  drawdown vs the account's prop-firm rules
//
// ============================================================
// WHAT IS CARRIED OVER
// ============================================================
// Legacy had no portfolio surface (its dashboard was single-account). The
// roadmap (v1.5) is therefore the source of truth for the SHAPE, and the
// business RULES come from the same metric definitions the single-account
// analytics already use (`packages/domain/src/metrics.ts`) — a portfolio figure
// that disagreed with the per-account figure would be a bug, so both call the
// same computation.
//
// ============================================================
// CURRENCY AND FX — WHAT IS HONEST HERE
// ============================================================
// `trading_accounts.currency` varies per account, and `currency_rates` stores
// ECB rates. Converting every account to one base requires a rate for the
// ACCOUNT's currency, and the roadmap's daily ECB ingestion job is a WORKER
// concern that this pass does not run (network egress + scheduling are out of
// scope for the API process). So the portfolio summary reports each account in
// ITS OWN currency, plus a `convertedTotal` ONLY when every required rate is
// present. It never invents a 1:1 rate and never silently mixes currencies —
// an unconvertible account is reported as such. Recorded in the report as
// PARTIALLY_IMPLEMENTED (conversion depends on the FX ingestion job).
import { fail, ok } from "@velora/contracts";
import * as D from "@velora/domain";
import { computeSummary, type MetricTrade } from "@velora/domain";
import type { QueryFn } from "../persistence/pg.js";
import { capabilityAbsent, unauthenticated, validation } from "../routes/responses.js";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";

export const SUMMARY = "/api/v1/portfolio/summary";
export const BY_SYMBOL = "/api/v1/portfolio/by-symbol";
export const FX_RATES = "/api/v1/portfolio/fx-rates";
export const PROP_STATUS = "/api/v1/portfolio/prop-status";
/**
 * v1.5 routes named by the roadmap itself ("API Changes: /api/v1/portfolio/summary,
 * /api/v1/account-groups, /api/v1/prop-rules/{account_id}"). Neither existed
 * before pass 2 — the tables did (0018), the routes did not.
 */
export const ACCOUNT_GROUPS = "/api/v1/account-groups";
export const PROP_RULES = /^\/api\/v1\/prop-rules\/([^/]+)$/;
const ACCOUNT_GROUP_ID = /^\/api\/v1\/account-groups\/([^/]+)$/;

export interface AccountPerformance {
  readonly accountId: string;
  readonly label: string;
  readonly currency: string;
  readonly provider: string;
  readonly syncState: string;
  readonly balance: string;
  readonly equity: string;
  readonly metrics: ReturnType<typeof computeSummary>;
}

export interface PropStatus {
  readonly accountId: string;
  readonly ruleSetName: string;
  readonly maxTotalDrawdown: string | null;
  readonly maxDailyDrawdown: string | null;
  readonly profitTarget: string | null;
  readonly drawdownBasis: string;
  readonly alertThresholdPct: string;
  /** Peak-to-current drawdown as a positive amount, 2 dp. */
  readonly currentDrawdown: string;
  /** Drawdown as a percentage of the basis, 2 dp. Empty when the basis is 0. */
  readonly drawdownPct: string | null;
  /** True when drawdownPct ≥ alertThresholdPct — the roadmap's 80% alert. */
  readonly alert: boolean;
  /** True when the limit itself is breached. */
  readonly breached: boolean;
  readonly profitTargetReached: boolean;
}

export interface PortfolioStore {
  accounts(userId: string): Promise<
    {
      accountId: string;
      label: string;
      currency: string;
      provider: string;
      syncState: string;
      balance: string;
      equity: string;
      startingBalance: string;
      peakEquity: string | null;
    }[]
  >;
  tradesByAccount(userId: string): Promise<{ accountId: string; netPnl: string | null; rMultiple: string | null; symbol: string; strategy: string | null }[]>;
  fxRate(base: string, quote: string): Promise<{ rate: string; rateDate: string; source: string } | null>;
  propRules(accountId: string, userId: string): Promise<PropRules | null>;
  /** Full rule row as stored (the v1.5 CRUD surface; propRules is the evaluator's view). */
  readRules(accountId: string, userId: string): Promise<PropRules | null>;
  upsertRules(input: PropRulesInput): Promise<RulesOutcome>;
  listGroups(userId: string): Promise<AccountGroup[]>;
  createGroup(input: AccountGroupInput): Promise<GroupOutcome>;
  updateGroup(input: AccountGroupPatch): Promise<GroupOutcome>;
  deleteGroup(userId: string, groupId: string): Promise<boolean>;
}

/**
 * A prop-firm rule set (v1.5). Values are exact decimal strings, never numbers.
 *
 * `dailyResetTime`/`dailyResetTz` are carried because 0018 stores them: the daily
 * drawdown window is timezone-dependent, and a rule set that cannot say WHEN its
 * day starts is not a rule set.
 */
export interface PropRules {
  readonly ruleSetName: string;
  readonly maxDailyDrawdown: string | null;
  readonly maxTotalDrawdown: string | null;
  readonly profitTarget: string | null;
  readonly drawdownBasis: string;
  readonly alertThresholdPct: string;
  readonly dailyResetTime: string | null;
  readonly dailyResetTz: string | null;
}

export interface PropRulesInput {
  readonly userId: string;
  readonly accountId: string;
  readonly ruleSetName: string;
  readonly maxDailyDrawdown: string | null;
  readonly maxTotalDrawdown: string | null;
  readonly profitTarget: string | null;
  readonly drawdownBasis: string;
  readonly alertThresholdPct: string;
  readonly dailyResetTime: string | null;
  readonly dailyResetTz: string | null;
}

/**
 * Outcomes rather than booleans, so the route can answer with the RIGHT status:
 * a caller that does not own the account must not learn whether it exists, while
 * an unknown GROUP of one's own is a plain 404 and a duplicate name is a 409.
 */
export type RulesOutcome =
  | { readonly ok: true; readonly rules: PropRules }
  | { readonly ok: false; readonly reason: "account-not-owned" };

export interface AccountGroup {
  readonly groupId: string;
  readonly name: string;
  readonly description: string | null;
  readonly accountIds: readonly string[];
}

export interface AccountGroupInput {
  readonly userId: string;
  readonly name: string;
  readonly description: string | null;
  readonly accountIds: readonly string[];
}

export interface AccountGroupPatch {
  readonly userId: string;
  readonly groupId: string;
  readonly name: string;
  readonly description: string | null;
  /** Replaces the membership wholesale; an empty array empties the group. */
  readonly accountIds: readonly string[];
}

export type GroupOutcome =
  | { readonly ok: true; readonly group: AccountGroup }
  | { readonly ok: false; readonly reason: "duplicate-name" | "group-not-found" | "account-not-owned" };

type Row = Record<string, unknown>;

function s(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/** Fill the optional fixture fields with the contract's nulls. */
function normalizeRules(rules: MemoryRules): PropRules {
  return { ...rules, dailyResetTime: rules.dailyResetTime ?? null, dailyResetTz: rules.dailyResetTz ?? null };
}

/** A fixture-shaped rule row: the daily-reset fields are optional in fixtures. */
type MemoryRules = Omit<PropRules, "dailyResetTime" | "dailyResetTz"> &
  Partial<Pick<PropRules, "dailyResetTime" | "dailyResetTz">>;

/** Map a prop_firm_rules row to the contract shape. Shared by both adapters. */
function mapRules(row: Row): PropRules {
  return {
    ruleSetName: s(row["rule_set_name"]),
    maxDailyDrawdown: row["max_daily_drawdown"] === null || row["max_daily_drawdown"] === undefined ? null : s(row["max_daily_drawdown"]),
    maxTotalDrawdown: row["max_total_drawdown"] === null || row["max_total_drawdown"] === undefined ? null : s(row["max_total_drawdown"]),
    profitTarget: row["profit_target"] === null || row["profit_target"] === undefined ? null : s(row["profit_target"]),
    drawdownBasis: s(row["drawdown_basis"]),
    alertThresholdPct: s(row["alert_threshold_pct"]),
    dailyResetTime: row["reset_time"] === null || row["reset_time"] === undefined ? null : s(row["reset_time"]),
    dailyResetTz: row["daily_reset_tz"] === null || row["daily_reset_tz"] === undefined ? null : s(row["daily_reset_tz"]),
  };
}

/**
 * Translate a database error into a group outcome.
 *
 * 23505 = unique violation (0018's account_groups_user_name_unique) → a duplicate
 * name is a client-visible CONFLICT, not a 500.
 * 23503 = foreign-key violation: the composite FK
 * account_group_members(account_id, user_id) → trading_accounts(id, user_id), i.e.
 * the caller tried to group an account they do not own (the roadmap's own v1.5
 * security requirement). It is reported as "account-not-owned" and the route
 * answers non-disclosingly.
 */
function mapGroupError(
  err: unknown,
  input: { userId: string; accountIds: readonly string[] },
): GroupOutcome {
  const code = (err as { code?: string } | null)?.code;
  if (code === "23505") return { ok: false, reason: "duplicate-name" };
  if (code === "23503") return { ok: false, reason: "account-not-owned" };
  void input;
  throw err;
}

export class PgPortfolioStore implements PortfolioStore {
  constructor(private readonly q: QueryFn) {}

  async accounts(userId: string) {
    const rows = await this.q(
      `SELECT a.id::text AS account_id, a.label, a.currency, a.provider, a.sync_status, a.balance::text, a.equity::text,
              a.starting_balance::text,
              -- PEAK (high-water mark) for drawdown.
              --
              -- The foundation stores no equity-snapshot table, so the peak is
              -- DERIVED from the account's own closed-trade history: the running
              -- sum of net PnL added to the starting balance, and the starting
              -- balance itself always counts as a candidate peak (an account
              -- that has only lost money has not yet made a new high).
              --   peak = GREATEST(starting_balance, starting_balance + max(running_sum))
              -- A derived peak is stated as such rather than presented as a
              -- stored fact; when the account has no closed trades the peak is
              -- NULL and the drawdown evaluates to zero.
              (SELECT GREATEST(
                        a.starting_balance,
                        a.starting_balance + MAX(running.cum)
                      )::text
                 FROM (
                   SELECT SUM(t2.net_pnl) OVER (ORDER BY t2.occurred_at ASC, t2.id ASC) AS cum
                     FROM trades t2
                    WHERE t2.account_id = a.id
                      AND t2.deleted_at IS NULL
                      AND t2.quarantined = false
                      AND t2.net_pnl IS NOT NULL
                 ) running) AS peak_equity
         FROM trading_accounts a
        WHERE a.user_id = $1
        ORDER BY a.id ASC`,
      [userId],
    );
    return rows.map((row: Row) => ({
      accountId: s(row["account_id"]),
      label: s(row["label"]),
      currency: s(row["currency"]),
      provider: s(row["provider"]),
      syncState: s(row["sync_status"]),
      balance: s(row["balance"]),
      equity: s(row["equity"]),
      startingBalance: s(row["starting_balance"]),
      peakEquity: row["peak_equity"] === null || row["peak_equity"] === undefined ? null : s(row["peak_equity"]),
    }));
  }

  async tradesByAccount(userId: string) {
    const rows = await this.q(
      `SELECT account_id::text AS account_id, net_pnl::text, r_multiple::text, symbol,
              COALESCE(strategy_tag, strategy) AS strategy
         FROM trades
        WHERE user_id = $1 AND account_id IS NOT NULL AND deleted_at IS NULL AND quarantined = false
        ORDER BY occurred_at ASC, id ASC`,
      [userId],
    );
    return rows.map((row: Row) => ({
      accountId: s(row["account_id"]),
      netPnl: row["net_pnl"] === null ? null : s(row["net_pnl"]),
      rMultiple: row["r_multiple"] === null ? null : s(row["r_multiple"]),
      symbol: s(row["symbol"]),
      strategy: row["strategy"] === null ? null : s(row["strategy"]),
    }));
  }

  async fxRate(base: string, quote: string) {
    const rows = await this.q(
      `SELECT rate::text, rate_date::text, source FROM currency_rates
        WHERE base = $1 AND quote = $2 ORDER BY rate_date DESC LIMIT 1`,
      [base, quote],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { rate: formatRate(s(row["rate"])), rateDate: s(row["rate_date"]), source: s(row["source"]) };
  }

  async propRules(accountId: string, userId: string): Promise<PropRules | null> {
    // ONE implementation for both readers (the evaluator's view and the CRUD
    // surface): two SQL copies of "which rule set applies" would be free to drift,
    // and a rule set that reads differently in two places is exactly the class of
    // defect this pass is repairing.
    return this.readRules(accountId, userId);
  }

  async readRules(accountId: string, userId: string): Promise<PropRules | null> {
    const rows = await this.q(
      `SELECT rule_set_name, max_daily_drawdown::text, max_total_drawdown::text, profit_target::text,
              drawdown_basis, alert_threshold_pct::text,
              to_char(daily_reset_time, 'HH24:MI:SS') AS reset_time, daily_reset_tz
         FROM prop_firm_rules
        WHERE account_id = $1 AND user_id = $2 AND enabled = true
        LIMIT 1`,
      [accountId, userId],
    );
    const row = rows[0];
    return row === undefined ? null : mapRules(row);
  }

  async upsertRules(input: PropRulesInput): Promise<RulesOutcome> {
    // OWNERSHIP IS PART OF THE STATEMENT. There is no separate "does the user own
    // this account" round trip to get wrong: a rule row is only written for an
    // account row that belongs to the caller, and the FK
    // prop_firm_rules(account_id, user_id) -> trading_accounts(id, user_id) makes
    // the database the enforcer of that (0018).
    const owns = await this.q(
      "SELECT 1 AS ok FROM trading_accounts WHERE id = $1 AND user_id = $2",
      [input.accountId, input.userId],
    );
    if (owns.length === 0) return { ok: false, reason: "account-not-owned" };

    // 0018 has no UNIQUE(account_id, rule_set_name) — the migration is frozen — so
    // "one rule set per account" is enforced by looking the row up first: a second
    // call for the same pair UPDATES rather than appending a shadow rule set.
    const existing = await this.q(
      "SELECT id::text AS id FROM prop_firm_rules WHERE account_id = $1 AND user_id = $2 AND rule_set_name = $3 LIMIT 1",
      [input.accountId, input.userId, input.ruleSetName],
    );
    if (existing.length === 0) {
      await this.q(
        `INSERT INTO prop_firm_rules
           (account_id, user_id, rule_set_name, max_daily_drawdown, max_total_drawdown, profit_target,
            drawdown_basis, alert_threshold_pct, daily_reset_time, daily_reset_tz)
         VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric, $7, $8::numeric, $9::time, $10)`,
        [
          input.accountId, input.userId, input.ruleSetName, input.maxDailyDrawdown, input.maxTotalDrawdown,
          input.profitTarget, input.drawdownBasis, input.alertThresholdPct, input.dailyResetTime, input.dailyResetTz,
        ],
      );
    } else {
      await this.q(
        `UPDATE prop_firm_rules
            SET max_daily_drawdown = $4::numeric, max_total_drawdown = $5::numeric, profit_target = $6::numeric,
                drawdown_basis = $7, alert_threshold_pct = $8::numeric, daily_reset_time = $9::time,
                daily_reset_tz = $10, enabled = true, updated_at = now()
          WHERE account_id = $1 AND user_id = $2 AND rule_set_name = $3`,
        [
          input.accountId, input.userId, input.ruleSetName, input.maxDailyDrawdown, input.maxTotalDrawdown,
          input.profitTarget, input.drawdownBasis, input.alertThresholdPct, input.dailyResetTime, input.dailyResetTz,
        ],
      );
    }
    const rules = await this.readRules(input.accountId, input.userId);
    // A read-back that finds nothing would mean the write did not persist; it is a
    // programming error, not a client error, so it throws rather than returning a
    // fabricated success.
    if (rules === null) throw new Error("prop rules disappeared immediately after upsert");
    return { ok: true, rules };
  }

  async listGroups(userId: string): Promise<AccountGroup[]> {
    const rows = await this.q(
      `SELECT g.id::text AS group_id, g.name, g.description,
              COALESCE(array_agg(m.account_id::text ORDER BY m.account_id) FILTER (WHERE m.account_id IS NOT NULL), '{}') AS account_ids
         FROM account_groups g
         LEFT JOIN account_group_members m ON m.group_id = g.id
        WHERE g.user_id = $1
        GROUP BY g.id, g.name, g.description
        ORDER BY g.id ASC`,
      [userId],
    );
    return rows.map((row: Row) => ({
      groupId: s(row["group_id"]),
      name: s(row["name"]),
      description: row["description"] === null ? null : s(row["description"]),
      accountIds: (row["account_ids"] as string[] | null) ?? [],
    }));
  }

  async createGroup(input: AccountGroupInput): Promise<GroupOutcome> {
    try {
      // ONE STATEMENT, therefore atomic: the group and its membership are written
      // together, and a membership referencing an account the caller does not own
      // is refused by 0018's composite FK — so a partly-created group cannot
      // survive as a group with silently-missing accounts.
      const rows = await this.q(
        `WITH created AS (
           INSERT INTO account_groups (user_id, name, description)
           VALUES ($1, $2, $3)
           RETURNING id
         ), members AS (
           INSERT INTO account_group_members (group_id, account_id, user_id)
           SELECT created.id, m.account_id, $1
             FROM created, unnest($4::bigint[]) AS m(account_id)
           RETURNING 1
         )
         SELECT id::text AS group_id FROM created`,
        [input.userId, input.name, input.description, input.accountIds],
      );
    const groupId = s(rows[0]?.["group_id"]);
      const created = (await this.listGroups(input.userId)).find((g) => g.groupId === groupId);
      if (created === undefined) throw new Error("group disappeared immediately after insert");
      return { ok: true, group: created };
    } catch (err) {
      return mapGroupError(err, input);
    }
  }

  async updateGroup(input: AccountGroupPatch): Promise<GroupOutcome> {
    const updated = await this.q(
      `UPDATE account_groups SET name = $3, description = $4, updated_at = now()
        WHERE id = $2 AND user_id = $1 RETURNING id::text AS group_id`,
      [input.userId, input.groupId, input.name, input.description],
    );
    if (updated.length === 0) return { ok: false, reason: "group-not-found" };
    try {
      // Replace the membership. DELETE-then-INSERT (rather than "insert and delete
      // the rest") keeps this within one shape; a failure on the insert is
      // reported, and the caller sees the error rather than a half-updated group.
      await this.q("DELETE FROM account_group_members WHERE group_id = $1 AND user_id = $2", [input.groupId, input.userId]);
      if (input.accountIds.length > 0) {
        await this.q(
          `INSERT INTO account_group_members (group_id, account_id, user_id)
           SELECT $1, m.account_id, $2 FROM unnest($3::bigint[]) AS m(account_id)`,
          [input.groupId, input.userId, input.accountIds],
        );
      }
    } catch (err) {
      return mapGroupError(err, { ...input, userId: input.userId });
    }
    const group = (await this.listGroups(input.userId)).find((g) => g.groupId === input.groupId);
    if (group === undefined) throw new Error("group disappeared immediately after update");
    return { ok: true, group };
  }

  async deleteGroup(userId: string, groupId: string): Promise<boolean> {
    // Members cascade (0018: ON DELETE CASCADE), and the predicate keeps another
    // user's group untouchable — a non-disclosing false, not a 403.
    const rows = await this.q(
      "DELETE FROM account_groups WHERE id = $1 AND user_id = $2 RETURNING id",
      [groupId, userId],
    );
    return rows.length > 0;
  }
}

/** In-memory double (contract-identical; not database evidence). */
export class MemoryPortfolioStore implements PortfolioStore {
  readonly #owners = new Map<string, string>();
  readonly #perUser = new Map<string, Awaited<ReturnType<PortfolioStore["accounts"]>>>();
  readonly #groups = new Map<string, AccountGroup & { userId: string }>();
  #groupSeq = 0;

  constructor(
    private readonly accountRows: Awaited<ReturnType<PortfolioStore["accounts"]>>,
    private readonly tradeRows: Awaited<ReturnType<PortfolioStore["tradesByAccount"]>>,
    private readonly rates: Map<string, { rate: string; rateDate: string; source: string }> = new Map(),
    // Fixtures may omit the two daily-reset fields (they default to null): a test
    // that does not exercise the daily window should not have to spell it out,
    // while the CONTRACT still carries them.
    private readonly rules: Map<string, MemoryRules> = new Map(),
  ) {}

  /**
   * Register the accounts that belong to ONE user.
   *
   * The constructor's list models "the calling user's accounts" (which is what
   * most fixtures need). Ownership tests need two distinct owners, and the real
   * store filters by `user_id` in SQL — so the double must be able to answer
   * per-user too, or such a test would pass for the wrong reason.
   */
  addAccounts(userId: string, rows: Awaited<ReturnType<PortfolioStore["accounts"]>>): void {
    this.#perUser.set(userId, rows);
  }

  async accounts(userId?: string): ReturnType<PortfolioStore["accounts"]> {
    // As soon as ownership is MODELLED (any addAccounts call), the constructor
    // list stops standing in for every user: an unregistered user owns nothing.
    // Without this, a "not yours" assertion would pass for the wrong reason —
    // the fallback list would hand user B the accounts of user A.
    if (this.#perUser.size > 0) {
      return (userId === undefined ? undefined : this.#perUser.get(userId)) ?? [];
    }
    return this.accountRows;
  }
  async tradesByAccount(): ReturnType<PortfolioStore["tradesByAccount"]> {
    return this.tradeRows;
  }
  async fxRate(base: string, quote: string): ReturnType<PortfolioStore["fxRate"]> {
    const row = this.rates.get(`${base}/${quote}`);
    // Same normalization as the PostgreSQL adapter, so the two cannot disagree
    // about the representation of one rate.
    return row === undefined ? null : { ...row, rate: formatRate(row.rate) };
  }
  async propRules(accountId: string, userId: string): ReturnType<PortfolioStore["propRules"]> {
    // ONE lookup rule for both readers, so the evaluator's view and the CRUD view
    // can never disagree about which rule set belongs to an account.
    return this.readRules(accountId, userId);
  }

  /**
   * Accounts the double knows about, as accountId → userId.
   *
   * The real ownership rule is 0018's composite FK; keeping the same shape here
   * means the double refuses a foreign account for the same REASON rather than by
   * accident. An EMPTY registry means "ownership was not modelled in this test",
   * in which case ownership checks are skipped — never silently assumed to pass
   * for a registry that was populated.
   */
  addAccountOwner(accountId: string, userId: string): void {
    this.#owners.set(accountId, userId);
  }

  async readRules(accountId: string, userId: string): Promise<PropRules | null> {
    const rules = this.rules.get(`${userId}:${accountId}`);
    return rules === undefined ? null : normalizeRules(rules);
  }

  async upsertRules(input: PropRulesInput): Promise<RulesOutcome> {
    const owner = this.#owners.get(input.accountId);
    if (this.#owners.size > 0 && owner !== input.userId) return { ok: false, reason: "account-not-owned" };
    this.rules.set(`${input.userId}:${input.accountId}`, {
      ruleSetName: input.ruleSetName,
      maxDailyDrawdown: input.maxDailyDrawdown,
      maxTotalDrawdown: input.maxTotalDrawdown,
      profitTarget: input.profitTarget,
      drawdownBasis: input.drawdownBasis,
      alertThresholdPct: input.alertThresholdPct,
      dailyResetTime: input.dailyResetTime,
      dailyResetTz: input.dailyResetTz,
    });
    return { ok: true, rules: (await this.readRules(input.accountId, input.userId)) as PropRules };
  }

  async listGroups(userId: string): Promise<AccountGroup[]> {
    return [...this.#groups.values()]
      .filter((g) => g.userId === userId)
      .map((g) => ({ groupId: g.groupId, name: g.name, description: g.description, accountIds: [...g.accountIds] }));
  }

  async createGroup(input: AccountGroupInput): Promise<GroupOutcome> {
    if ([...this.#groups.values()].some((g) => g.userId === input.userId && g.name === input.name)) {
      return { ok: false, reason: "duplicate-name" };
    }
    const foreign = input.accountIds.find((id) => this.#owners.size > 0 && this.#owners.get(id) !== input.userId);
    if (foreign !== undefined) return { ok: false, reason: "account-not-owned" };
    this.#groupSeq += 1;
    const group = {
      userId: input.userId,
      groupId: String(this.#groupSeq),
      name: input.name,
      description: input.description,
      accountIds: [...input.accountIds],
    };
    this.#groups.set(group.groupId, group);
    return { ok: true, group: { groupId: group.groupId, name: group.name, description: group.description, accountIds: [...group.accountIds] } };
  }

  async updateGroup(input: AccountGroupPatch): Promise<GroupOutcome> {
    const group = this.#groups.get(input.groupId);
    if (group === undefined || group.userId !== input.userId) return { ok: false, reason: "group-not-found" };
    if (
      [...this.#groups.values()].some(
        (g) => g.userId === input.userId && g.name === input.name && g.groupId !== input.groupId,
      )
    ) {
      return { ok: false, reason: "duplicate-name" };
    }
    const foreign = input.accountIds.find((id) => this.#owners.size > 0 && this.#owners.get(id) !== input.userId);
    if (foreign !== undefined) return { ok: false, reason: "account-not-owned" };
    const updated = { ...group, name: input.name, description: input.description, accountIds: [...input.accountIds] };
    this.#groups.set(input.groupId, updated);
    return { ok: true, group: { groupId: updated.groupId, name: updated.name, description: updated.description, accountIds: [...updated.accountIds] } };
  }

  async deleteGroup(userId: string, groupId: string): Promise<boolean> {
    const group = this.#groups.get(groupId);
    if (group === undefined || group.userId !== userId) return false;
    this.#groups.delete(groupId);
    return true;
  }
}

/**
 * Drawdown against a prop-firm rule set.
 *
 * RULE (roadmap v1.5 + 0018): drawdown is measured from the PEAK of the chosen
 * basis. `basis = balance` → peak balance vs current balance; `basis = equity`
 * → peak equity vs current equity. The alert fires at `alert_threshold_pct`
 * (default 80) and the LIMIT is breached at 100%. Both are reported separately:
 * a warning is not a breach, and conflating them would either cry wolf or hide
 * an account that has already failed the challenge.
 */
export function evaluatePropRules(
  basisValue: string,
  peakValue: string | null,
  rules: {
    maxDailyDrawdown: string | null;
    maxTotalDrawdown: string | null;
    profitTarget: string | null;
    alertThresholdPct: string;
  },
  startingBalance: string,
): Omit<PropStatus, "accountId" | "ruleSetName" | "drawdownBasis"> {
  const current = D.fromString(basisValue === "" ? "0" : basisValue);
  const peak = D.fromString(peakValue ?? (basisValue === "" ? "0" : basisValue));
  const drawdown = D.cmp(peak, current) > 0 ? D.sub(peak, current) : D.fromString("0");
  const limit = rules.maxTotalDrawdown !== null ? D.fromString(rules.maxTotalDrawdown) : null;

  let pct: string | null = null;
  let alert = false;
  let breached = false;
  if (limit !== null && D.cmp(limit, D.fromString("0")) > 0) {
    const ratio = D.div(drawdown, limit, 8, "half-even");
    pct = D.toString(D.rescale(D.mul(ratio, D.fromString("100")), 2, "half-even"));
    alert = D.cmp(D.fromString(pct), D.fromString(rules.alertThresholdPct)) >= 0;
    breached = D.cmp(D.fromString(pct), D.fromString("100")) >= 0;
  }

  const target = rules.profitTarget !== null ? D.fromString(rules.profitTarget) : null;
  const start = D.fromString(startingBalance === "" ? "0" : startingBalance);
  const profitTargetReached =
    target !== null && D.cmp(D.sub(current, start), target) >= 0;

  return {
    maxTotalDrawdown: rules.maxTotalDrawdown,
    maxDailyDrawdown: rules.maxDailyDrawdown,
    profitTarget: rules.profitTarget,
    alertThresholdPct: rules.alertThresholdPct,
    currentDrawdown: D.toString(D.rescale(drawdown, 2, "half-even")),
    drawdownPct: pct,
    alert,
    breached,
    profitTargetReached,
  };
}

/** Convert to a base currency; `null` when a rate is missing (never 1:1). */
/**
 * Normalize an FX rate to the contract's representation.
 *
 * CONTRACT (found by a real-PostgreSQL test, not assumed): `currency_rates.rate`
 * is NUMERIC(24,10), so PostgreSQL renders it as fixed-scale text —
 * `'1.0842'::numeric(24,10)::text` is `'1.0842000000'`. The in-memory store
 * returned whatever string it was handed (`'1.0842'`), so the two adapters
 * disagreed about the SAME rate. Every rate that leaves this module (and every
 * rate the stores hand out) is therefore formatted to scale 10 with the domain
 * decimal, so the wire format does not depend on which store answered.
 */
export function formatRate(rate: string): string {
  return D.toString(D.rescale(D.fromString(rate), RATE_SCALE, "half-even"));
}

/** Scale of `currency_rates.rate`. */
export const RATE_SCALE = 10;

export function convert(amount: string, rate: string | null): string | null {
  if (rate === null) return null;
  return D.toString(D.rescale(D.mul(D.fromString(amount), D.fromString(rate)), 2, "half-even"));
}

const BASE_CURRENCY = "USD";

export async function handlePortfolioRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  const rulesMatch = PROP_RULES.exec(ctx.path);
  const groupMatch = ACCOUNT_GROUP_ID.exec(ctx.path);
  const isRules = rulesMatch !== null;
  const isGroups = ctx.path === ACCOUNT_GROUPS || groupMatch !== null;
  if (
    ctx.path !== SUMMARY &&
    ctx.path !== BY_SYMBOL &&
    ctx.path !== FX_RATES &&
    ctx.path !== PROP_STATUS &&
    !isRules &&
    !isGroups
  ) {
    return null;
  }
  const store: PortfolioStore | null = ctx.config.portfolio ?? null;
  if (store === null) return capabilityAbsent(ctx, "portfolio");
  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);

  const accounts = await store.accounts(claims.sub);
  const trades = await store.tradesByAccount(claims.sub);

  if (ctx.path === SUMMARY) {
    if (ctx.method !== "GET") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
    const perAccount: AccountPerformance[] = [];
    const converted: string[] = [];
    let unconvertible = 0;
    for (const account of accounts) {
      const rows = trades.filter((t) => t.accountId === account.accountId);
      const metrics = computeSummary(rows.map((r): MetricTrade => ({ netPnl: r.netPnl, rMultiple: r.rMultiple, strategy: r.strategy })));
      perAccount.push({
        accountId: account.accountId,
        label: account.label,
        currency: account.currency,
        provider: account.provider,
        syncState: account.syncState,
        balance: account.balance,
        equity: account.equity,
        metrics,
      });
      if (account.currency.toUpperCase() === BASE_CURRENCY) {
        converted.push(metrics.totalPnl);
      } else {
        const rate = await store.fxRate(account.currency.toUpperCase(), BASE_CURRENCY);
        const amount = convert(metrics.totalPnl, rate === null ? null : rate.rate);
        if (amount === null) unconvertible += 1;
        else converted.push(amount);
      }
    }
    let total = D.fromString("0");
    for (const amount of converted) total = D.add(total, D.fromString(amount));
    return {
      status: 200,
      body: ok({
        baseCurrency: BASE_CURRENCY,
        accounts: perAccount,
        convertedTotalPnl: D.toString(D.rescale(total, 2, "half-even")),
        // Stated explicitly so a client never reads `convertedTotalPnl` as a
        // complete figure when a rate was missing.
        unconvertibleAccounts: unconvertible,
      }),
    };
  }

  if (ctx.path === BY_SYMBOL) {
    if (ctx.method !== "GET") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
    const groups = new Map<string, MetricTrade[]>();
    for (const t of trades) {
      const list = groups.get(t.symbol);
      const metric: MetricTrade = { netPnl: t.netPnl, rMultiple: t.rMultiple, strategy: t.strategy };
      if (list === undefined) groups.set(t.symbol, [metric]);
      else list.push(metric);
    }
    return {
      status: 200,
      body: ok({
        symbols: [...groups.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([symbol, list]) => ({ symbol, ...computeSummary(list) })),
      }),
    };
  }

  if (ctx.path === FX_RATES) {
    if (ctx.method !== "GET") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
    const base = (ctx.url.searchParams.get("base") ?? "").toUpperCase();
    const quote = (ctx.url.searchParams.get("quote") ?? "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote) || base === quote) {
      return validation(ctx, { pair: "base and quote must be distinct ISO-4217 codes" });
    }
    const rate = await store.fxRate(base, quote);
    if (rate === null) return { status: 404, body: fail("NOT_FOUND", "No stored rate for that pair.", ctx.requestId) };
    return { status: 200, body: ok({ base, quote, ...rate }) };
  }

  // ---- v1.5 prop rules (CRUD) ---------------------------------------------
  if (isRules) {
    const accountId = decodeURIComponent(rulesMatch?.[1] ?? "");
    if (!/^\d+$/.test(accountId)) return validation(ctx, { account_id: "must be a numeric id" });
    // Ownership first, and non-disclosingly: an account the caller does not own
    // answers exactly like one that does not exist.
    if (!accounts.some((a) => a.accountId === accountId)) {
      return { status: 404, body: fail("NOT_FOUND", "Account not found.", ctx.requestId) };
    }

    if (ctx.method === "GET") {
      const rules = await store.readRules(accountId, claims.sub);
      if (rules === null) return { status: 404, body: fail("NOT_FOUND", "No enabled rule set for that account.", ctx.requestId) };
      return { status: 200, body: ok(rules) };
    }
    if (ctx.method !== "PUT") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };

    const body = await ctx.readBody(ctx.req);
    const parsed = parseRulesBody(ctx, body);
    if ("error" in parsed) return parsed.error;
    const outcome = await store.upsertRules({ ...parsed.value, userId: claims.sub, accountId });
    if (!outcome.ok) {
      // The ownership check above already passed, so a refusal here means the row
      // moved or the account was reassigned mid-request: still non-disclosing.
      return { status: 404, body: fail("NOT_FOUND", "Account not found.", ctx.requestId) };
    }
    return { status: 200, body: ok(outcome.rules) };
  }

  // ---- v1.5 account groups ------------------------------------------------
  if (isGroups) {
    if (ctx.path === ACCOUNT_GROUPS) {
      if (ctx.method === "GET") {
        return { status: 200, body: ok({ groups: await store.listGroups(claims.sub) }) };
      }
      if (ctx.method !== "POST") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
      const body = await ctx.readBody(ctx.req);
      const parsed = parseGroupBody(ctx, body);
      if ("error" in parsed) return parsed.error;
      const owned = assertAccountsOwned(ctx, parsed.value.accountIds, accounts);
      if (owned !== null) return owned;
      const outcome = await store.createGroup({ ...parsed.value, userId: claims.sub });
      if (!outcome.ok) return groupFailure(ctx, outcome.reason);
      return { status: 201, body: ok(outcome.group) };
    }

    const groupId = decodeURIComponent(groupMatch?.[1] ?? "");
    if (!/^\d+$/.test(groupId)) return validation(ctx, { group_id: "must be a numeric id" });

    if (ctx.method === "DELETE") {
      const deleted = await store.deleteGroup(claims.sub, groupId);
      // Non-disclosing: another user's group and a non-existent group are the
      // same answer.
      if (!deleted) return { status: 404, body: fail("NOT_FOUND", "Group not found.", ctx.requestId) };
      return { status: 204, body: null };
    }
    if (ctx.method !== "PUT") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };

    const body = await ctx.readBody(ctx.req);
    const parsed = parseGroupBody(ctx, body);
    if ("error" in parsed) return parsed.error;
    const owned = assertAccountsOwned(ctx, parsed.value.accountIds, accounts);
    if (owned !== null) return owned;
    const outcome = await store.updateGroup({ ...parsed.value, userId: claims.sub, groupId });
    if (!outcome.ok) return groupFailure(ctx, outcome.reason);
    return { status: 200, body: ok(outcome.group) };
  }

  // prop-status

  const accountId = ctx.url.searchParams.get("account_id");
  if (accountId === null || !/^\d+$/.test(accountId)) return validation(ctx, { account_id: "must be a numeric id" });
  const account = accounts.find((a) => a.accountId === accountId);
  // Non-disclosing: an account the caller does not own is not distinguishable
  // from one that does not exist.
  if (account === undefined) return { status: 404, body: fail("NOT_FOUND", "Account not found.", ctx.requestId) };
  const rules = await store.propRules(accountId, claims.sub);
  if (rules === null) return { status: 404, body: fail("NOT_FOUND", "No enabled rule set for that account.", ctx.requestId) };
  const basisValue = rules.drawdownBasis === "equity" ? account.equity : account.balance;
  const peakValue = rules.drawdownBasis === "equity" ? (account.equity === "" ? null : account.equity) : account.peakEquity;
  const evaluated = evaluatePropRules(basisValue, peakValue, rules, account.startingBalance);
  return {
    status: 200,
    body: ok({ accountId, ruleSetName: rules.ruleSetName, drawdownBasis: rules.drawdownBasis, ...evaluated }),
  };
}

/** Rule-set body, validated against 0018's own CHECK vocabulary. */
function parseRulesBody(
  ctx: ExtendedRouteContext,
  body: Record<string, unknown>,
): { value: Omit<PropRulesInput, "userId" | "accountId"> } | { error: RouteResult } {
  const name = body["rule_set_name"];
  if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 120) {
    return { error: validation(ctx, { rule_set_name: "1..120 characters" }) };
  }
  const basis = body["drawdown_basis"] ?? "balance";
  if (basis !== "balance" && basis !== "equity") {
    return { error: validation(ctx, { drawdown_basis: "balance|equity" }) };
  }
  const threshold = body["alert_threshold_pct"] ?? "80.00";
  // 0018: alert_threshold_pct > 0 AND <= 100.
  if (typeof threshold !== "string" || !/^\d+(\.\d{1,2})?$/.test(threshold)) {
    return { error: validation(ctx, { alert_threshold_pct: "decimal with at most 2 places" }) };
  }
  if (Number(threshold) <= 0 || Number(threshold) > 100) {
    return { error: validation(ctx, { alert_threshold_pct: "must be > 0 and <= 100" }) };
  }
  const amounts: Record<string, string | null> = {};
  for (const field of ["max_daily_drawdown", "max_total_drawdown", "profit_target"] as const) {
    const raw = body[field];
    if (raw === null || raw === undefined) {
      amounts[field] = null;
      continue;
    }
    // 0018: each is NUMERIC(20,2) with a `> 0` CHECK when present.
    if (typeof raw !== "string" || !/^\d+(\.\d{1,2})?$/.test(raw) || Number(raw) <= 0) {
      return { error: validation(ctx, { [field]: "a positive decimal with at most 2 places, or null" }) };
    }
    amounts[field] = raw;
  }
  if (amounts["max_daily_drawdown"] === null && amounts["max_total_drawdown"] === null && amounts["profit_target"] === null) {
    return { error: validation(ctx, { limits: "at least one of max_daily_drawdown, max_total_drawdown, profit_target is required" }) };
  }
  const resetTime = body["daily_reset_time"] ?? null;
  if (resetTime !== null && (typeof resetTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(resetTime))) {
    return { error: validation(ctx, { daily_reset_time: "HH:MM or HH:MM:SS" }) };
  }
  const resetTz = body["daily_reset_tz"] ?? null;
  if (resetTz !== null && (typeof resetTz !== "string" || resetTz.trim().length < 1 || resetTz.trim().length > 64)) {
    return { error: validation(ctx, { daily_reset_tz: "1..64 characters" }) };
  }
  return {
    value: {
      ruleSetName: name.trim(),
      maxDailyDrawdown: amounts["max_daily_drawdown"] ?? null,
      maxTotalDrawdown: amounts["max_total_drawdown"] ?? null,
      profitTarget: amounts["profit_target"] ?? null,
      drawdownBasis: basis,
      alertThresholdPct: threshold,
      dailyResetTime: resetTime === null ? null : (resetTime.length === 5 ? `${resetTime}:00` : resetTime),
      dailyResetTz: resetTz === null ? null : resetTz.trim(),
    },
  };
}

/** Group body, validated against 0018's CHECKs. */
function parseGroupBody(
  ctx: ExtendedRouteContext,
  body: Record<string, unknown>,
): { value: Omit<AccountGroupInput, "userId"> } | { error: RouteResult } {
  const name = body["name"];
  if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 120) {
    return { error: validation(ctx, { name: "1..120 characters" }) };
  }
  const description = body["description"] ?? null;
  if (description !== null && (typeof description !== "string" || description.length > 500)) {
    return { error: validation(ctx, { description: "at most 500 characters" }) };
  }
  const accountIds = body["account_ids"] ?? [];
  if (!Array.isArray(accountIds) || accountIds.some((id) => typeof id !== "string" || !/^\d+$/.test(id))) {
    return { error: validation(ctx, { account_ids: "an array of numeric account ids" }) };
  }
  if (new Set(accountIds).size !== accountIds.length) {
    return { error: validation(ctx, { account_ids: "duplicate account id" }) };
  }
  return {
    value: { name: name.trim(), description: description === null ? null : description, accountIds: accountIds as string[] },
  };
}

/** Every grouped account must be one the caller owns (roadmap v1.5 security clause). */
function assertAccountsOwned(
  ctx: ExtendedRouteContext,
  accountIds: readonly string[],
  accounts: readonly { accountId: string }[],
): RouteResult | null {
  const owned = new Set(accounts.map((a) => a.accountId));
  for (const id of accountIds) {
    // Non-disclosing: naming somebody else's account id is indistinguishable from
    // naming a non-existent one.
    if (!owned.has(id)) return { status: 404, body: fail("NOT_FOUND", `Account not found: ${id}`, ctx.requestId) };
  }
  return null;
}

/** Map a store outcome to the right status. */
function groupFailure(ctx: ExtendedRouteContext, reason: "duplicate-name" | "group-not-found" | "account-not-owned"): RouteResult {
  if (reason === "duplicate-name") {
    return { status: 409, body: fail("GROUP_NAME_EXISTS", "A group with that name already exists.", ctx.requestId) };
  }
  if (reason === "group-not-found") return { status: 404, body: fail("NOT_FOUND", "Group not found.", ctx.requestId) };
  return { status: 404, body: fail("NOT_FOUND", "Account not found.", ctx.requestId) };
}
