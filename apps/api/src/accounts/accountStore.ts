// AccountStore — Phase C increment 2 (wave 3): the accounts persistence port.
// First ownership-scoped resource: every read/write is keyed by (id, userId);
// a miss returns null and the service maps it to a non-disclosing 404
// (Remote findByIdForUser + PHP 'Account not found.' — verified both sides).
// All timestamps are ISO-8601 UTC strings. D3 adds the transactional quota
// guard (createWithQuotaGuard — users-row FOR UPDATE, atomic count+create),
// implemented by the real-PostgreSQL adapter; memory/test adapters keep
// check-then-create under the service's process-local serialization.
export type AccountProvider = "MT4" | "MT5" | "MANUAL";
export type AccountStatus = "connected" | "error" | "disconnected";
export type SyncStatus = "DISCONNECTED" | "CONNECTING" | "SYNCING" | "CONNECTED" | "ERROR";

export interface AccountRecord {
  readonly id: string;
  readonly userId: string;
  readonly provider: AccountProvider;
  readonly platform: string;
  readonly label: string;
  readonly accountNumber: string;
  readonly currency: string;
  readonly leverage: string;
  readonly timezone: string | null;
  readonly timezoneSource: string;
  readonly status: AccountStatus;
  readonly syncStatus: SyncStatus;
  readonly balance: string;
  readonly equity: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAccountInput {
  readonly provider: AccountProvider;
  readonly label?: string | undefined;
  readonly accountNumber?: string | undefined;
  readonly currency?: string | undefined;
  readonly leverage?: string | undefined;
  readonly status?: AccountStatus | undefined;
  readonly timezone?: string | undefined;
}

/** Resolved, service-validated creation payload (create / createWithQuotaGuard). */
export interface AccountCreatePayload {
  readonly provider: AccountProvider;
  readonly platform: string;
  readonly label: string;
  readonly accountNumber: string;
  readonly currency: string;
  readonly leverage: string;
  readonly timezone: string | null;
  readonly timezoneSource: string;
  readonly status: AccountStatus;
}

/** D3: thrown by createWithQuotaGuard when the user is at their plan's
 * trading-account quota — carries the transaction-time count for the 429 details. */
export class AccountQuotaExceededError extends Error {
  constructor(readonly currentCount: number) {
    super(`account quota exceeded (current count ${currentCount})`);
    this.name = "AccountQuotaExceededError";
  }
}

export interface AccountStore {
  /** List a user's accounts, newest first (Remote orderBy createdAt desc). */
  listByUser(userId: string): Promise<AccountRecord[]>;
  /** Ownership-scoped lookup: (id, userId) — null when missing OR not owned. */
  findByIdForUser(id: string, userId: string): Promise<AccountRecord | null>;
  countByUser(userId: string): Promise<number>;
  create(userId: string, input: {
    provider: AccountProvider;
    platform: string;
    label: string;
    accountNumber: string;
    currency: string;
    leverage: string;
    timezone: string | null;
    timezoneSource: string;
    status: AccountStatus;
  }, now: Date): Promise<AccountRecord>;
  /**
   * D3 (transactional adapters only — optional): atomically enforce the quota
   * and create the account in ONE database transaction — lock the user's row
   * (SELECT … FOR UPDATE), count their accounts, insert only when
   * count < maxTradingAccounts. Throws AccountQuotaExceededError(currentCount)
   * when the quota is met (the transaction rolls back; no row is written; the
   * lock is released). Stores without this method keep the service's
   * process-local serialized check-then-create path (memory/PGlite adapters).
   */
  createWithQuotaGuard?(
    userId: string,
    input: AccountCreatePayload,
    now: Date,
    maxTradingAccounts: number,
  ): Promise<AccountRecord>;
  updateTimezone(
    id: string,
    userId: string,
    timezone: string | null,
    timezoneSource: string,
    now: Date,
  ): Promise<AccountRecord | null>;
  deleteForUser(id: string, userId: string): Promise<boolean>;

  /**
   * OD-MP-1: the ONLY production writer of `trading_accounts.metaapi_account_id`.
   *
   * An explicit, ownership-scoped method rather than ad-hoc SQL from a route or
   * service: the column is protected by a GLOBAL partial UNIQUE index, and the
   * single place that writes it is the place where that invariant is enforced
   * and its 23505 translated into a domain outcome.
   *
   * `expectUnbound` makes the write a compare-and-set:
   *   • true  → binds only when the row is currently NULL, so a concurrent
   *             second binder loses the race instead of overwriting.
   *   • false → used by reconciliation, where the SAME id may be re-asserted.
   *
   * Returns the updated record, or null when the account is missing, not owned,
   * or already bound to a different id. Throws AccountBindingConflictError when
   * ANOTHER account (any user) already holds that provider id.
   *
   * @param binding the non-secret MetaAPI account identifier. NEVER a credential.
   */
  bindMetaApiAccount?(
    id: string,
    userId: string,
    binding: string,
    now: Date,
    expectUnbound: boolean,
    tx?: import("../persistence/pg.js").QueryFn,
  ): Promise<AccountRecord | null>;

  /**
   * OD-MP-3 A: LOCAL UNBINDING ONLY.
   *
   * Clears `metaapi_account_id`, which stops the credential-free worker from
   * ever selecting this account again (the scheduler's query is filtered on
   * `metaapi_account_id IS NOT NULL`). It deletes NO trade, rewrites NO P/L
   * and touches NO trade event.
   *
   * This is NOT provider deletion and NOT credential revocation — OD-MP-3 F
   * requires the three to stay distinct operations.
   *
   * Returns the previous binding (for the audit `before_state`), or null when
   * the account is missing, not owned, or was not bound.
   */
  unbindMetaApiAccount?(
    id: string,
    userId: string,
    now: Date,
    tx?: import("../persistence/pg.js").QueryFn,
  ): Promise<string | null>;

  /** Ownership-scoped read of the current binding. Null when absent/not owned. */
  getMetaApiBinding?(id: string, userId: string): Promise<string | null>;
}

/**
 * Raised when a MetaAPI account id is already bound to a different Velora
 * account. Surfaces the global UNIQUE index as a domain outcome rather than a
 * raw SQLSTATE, so the route can answer 409 without inspecting driver errors.
 */
export class AccountBindingConflictError extends Error {
  constructor() {
    super("This MetaAPI account is already linked to another trading account.");
    this.name = "AccountBindingConflictError";
  }
}
