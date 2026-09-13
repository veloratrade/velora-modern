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
}
