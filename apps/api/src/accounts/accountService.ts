// AccountService — Phase C increment 2 (wave 3). Port of the Remote accounts
// capability (frozen snapshot src/modules/accounts/*) with PHP as the contract
// source (api/src/Accounts/AccountController.php). First ownership-scoped
// resource: EVERY operation goes through (id, userId); misses map to a
// non-disclosing 404 NOT_FOUND 'Account not found.' (verified in both
// lineages — an unauthorized user cannot distinguish "missing" from "not
// yours").
//
// Evidence anchors (Remote @ 99e024c / PHP @ a8eabac):
//  - validation: provider ∈ {MT4, MT5, MANUAL} (PHP: required; Remote defaults
//    to MANUAL — PHP required wins, DOCUMENTED DIFFERENCE); currency 3 upper
//    letters (default USD, Remote regex); accountNumber [A-Za-z0-9*._-]{1,32}
//    (Remote regex; PHP max:32); leverage "1:N" or "N" (Remote regex, default
//    100); timezone IANA-valid (Remote Intl probe; PHP max:64);
//    label max 120 (PHP).
//  - quota: free plan = 1 account, pro/enterprise = unlimited →
//    429 ACCOUNT_QUOTA_EXCEEDED with {plan, currentCount, maxAllowed}
//    (Remote createWithEntitlementCheck).
//  - concurrency: Remote enforces the quota inside a DB transaction with a
//    user row lock. D3 implements exactly that for transactional stores
//    (store.createWithQuotaGuard: users-row FOR UPDATE + count + insert in
//    one transaction); memory/PGlite test adapters keep the process-local
//    serialized path below.
//  - detect-server: pure static suggestion logic (Remote + PHP identical).
//  - updateTimezone: IANA tz or empty → null + source 'unknown'.
//  - delete: hard delete (Remote/PHP observable {deleted:true}); Phase E
//    ledger work may revisit account archival — trades keep their own history.
import type { AccountStore, AccountRecord, AccountProvider, AccountStatus } from "./accountStore.js";
import { AccountQuotaExceededError } from "./accountStore.js";

export class AccountError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

// Entitlement logic lives in the standalone entitlement module (inc 6,
// Remote EntitlementService shape). Re-exported for existing consumers.
export { getPlanQuota } from "../entitlements/entitlementService.js";
export type { PlanQuota } from "../entitlements/entitlementService.js";
import { getPlanQuota } from "../entitlements/entitlementService.js";

export interface DetectServerResult {
  readonly mt_login: string;
  readonly suggestedServers: string[];
  readonly allServers: string[];
  readonly messageKey: string;
  readonly nextStepKey: string;
  readonly params: Record<string, never>;
}

const COMMON_SERVERS = [
  "ICMarkets-Demo", "ICMarkets-Live", "ICMarkets-MT5",
  "Exness-Demo", "Exness-Real", "Exness-MT5",
  "Alpari-Demo", "Alpari-Live", "Alpari-MT5",
  "XM-Demo", "XM-Real", "FBS-Demo", "FBS-Real",
  "RoboForex-Demo", "Pepperstone-Demo", "Tickmill-Demo", "Deriv-Demo", "OANDA-Demo",
] as const;

const PROVIDERS: readonly AccountProvider[] = ["MT4", "MT5", "MANUAL"];
const STATUSES: readonly AccountStatus[] = ["connected", "error", "disconnected"];

function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface AccountDeps {
  readonly store: AccountStore;
  /** Current plan per user (default 'free' — Remote getUserPlan semantics). */
  readonly getPlan?: (userId: string) => Promise<string>;
  readonly now?: () => Date;
}

export class AccountService {
  private readonly now: () => Date;

  constructor(private readonly deps: AccountDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async listAccounts(userId: string): Promise<AccountRecord[]> {
    return this.deps.store.listByUser(userId);
  }

  /** Ownership-scoped read: null → non-disclosing 404. */
  async getAccount(id: string, userId: string): Promise<AccountRecord> {
    const account = await this.deps.store.findByIdForUser(id, userId);
    if (account === null) {
      throw new AccountError(404, "NOT_FOUND", "Account not found.");
    }
    return account;
  }

  async createAccount(
    userId: string,
    input: {
      provider?: unknown;
      label?: unknown;
      accountNumber?: unknown;
      currency?: unknown;
      leverage?: unknown;
      status?: unknown;
      timezone?: unknown;
    },
    userPlan?: string,
  ): Promise<AccountRecord> {
    // provider — required (PHP Validation 'required|string|in:…')
    if (typeof input.provider !== "string" || !PROVIDERS.includes(input.provider as AccountProvider)) {
      throw new AccountError(400, "VALIDATION_FAILED", "Invalid provider.", { provider: "INVALID_PROVIDER" });
    }
    const provider = input.provider as AccountProvider;

    const currency = typeof input.currency === "string" && input.currency.trim() !== ""
      ? input.currency.trim().toUpperCase()
      : "USD";
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new AccountError(400, "VALIDATION_FAILED", "Invalid account currency.", { currency: "INVALID_FORMAT" });
    }

    let accountNumber = "";
    if (typeof input.accountNumber === "string" && input.accountNumber.trim() !== "") {
      accountNumber = input.accountNumber.trim();
      if (!/^[A-Za-z0-9*._-]{1,32}$/.test(accountNumber)) {
        throw new AccountError(400, "VALIDATION_FAILED", "Invalid account number.", { accountNumber: "INVALID_FORMAT" });
      }
    }

    let leverage = "100";
    if (typeof input.leverage === "string" && input.leverage.trim() !== "") {
      leverage = input.leverage.trim();
      if (!/^(?:1:)?[1-9]\d{0,7}$/.test(leverage)) {
        throw new AccountError(400, "VALIDATION_FAILED", "Invalid leverage.", { leverage: "INVALID_FORMAT" });
      }
    }

    let timezone: string | null = null;
    if (typeof input.timezone === "string" && input.timezone.trim() !== "") {
      timezone = input.timezone.trim();
      if (!isValidIanaTimezone(timezone)) {
        throw new AccountError(400, "VALIDATION_FAILED", "Invalid timezone.", { timezone: "INVALID_TIMEZONE" });
      }
    }

    let label = "Trading Account";
    if (typeof input.label === "string" && input.label.trim() !== "") {
      label = input.label.trim().slice(0, 120); // PHP max:120
    }

    let status: AccountStatus = "disconnected";
    if (input.status !== undefined) {
      if (!STATUSES.includes(input.status as AccountStatus)) {
        throw new AccountError(400, "VALIDATION_FAILED", "Invalid status.", { status: "INVALID_STATUS" });
      }
      status = input.status as AccountStatus;
    }

    // Entitlement quota (Remote free=1 / pro|enterprise=unlimited → 429).
    const plan = userPlan ?? (await this.deps.getPlan?.(userId)) ?? "free";
    const quota = getPlanQuota(plan);

    // D3 — transactional path (real-PostgreSQL stores): the quota is enforced
    // ATOMICALLY in the database: one transaction locks the user's row
    // (SELECT … FOR UPDATE), counts their accounts, and inserts only under
    // the quota. Cross-process correct WITHOUT any process-local mutex (the
    // Remote production mechanism, implemented on direct pg).
    if (!quota.isUnlimited && this.deps.store.createWithQuotaGuard !== undefined) {
      try {
        return await this.deps.store.createWithQuotaGuard(
          userId,
          {
            provider,
            platform: provider,
            label,
            accountNumber,
            currency,
            leverage,
            timezone,
            timezoneSource: timezone !== null ? "user_config" : "unknown",
            status,
          },
          this.now(),
          quota.maxTradingAccounts,
        );
      } catch (err) {
        if (err instanceof AccountQuotaExceededError) {
          throw new AccountError(
            429,
            "ACCOUNT_QUOTA_EXCEEDED",
            `Trading account quota exceeded. Free plan allows up to ${quota.maxTradingAccounts} trading account.`,
            {
              messageKey: "errors.accounts.quotaExceeded", // Remote-verified (integration test)
              plan: quota.plan,
              currentCount: err.currentCount,
              maxAllowed: quota.maxTradingAccounts,
            },
          );
        }
        throw err;
      }
    }

    // Non-transactional stores (memory/PGlite test adapters): the check+create
    // pair runs under the per-user mutex — the Remote-evidenced memory-path
    // mechanism (repository userLocks) that makes concurrent creation
    // deterministically [201, 429] within one process.
    return this.withUserQuotaLock(userId, async () => {
      if (!quota.isUnlimited) {
        const count = await this.deps.store.countByUser(userId);
        if (count >= quota.maxTradingAccounts) {
          throw new AccountError(
            429,
            "ACCOUNT_QUOTA_EXCEEDED",
            `Trading account quota exceeded. Free plan allows up to ${quota.maxTradingAccounts} trading account.`,
            {
              messageKey: "errors.accounts.quotaExceeded", // Remote-verified (integration test)
              plan: quota.plan,
              currentCount: count,
              maxAllowed: quota.maxTradingAccounts,
            },
          );
        }
      }

      return this.deps.store.create(
        userId,
        {
          provider,
          platform: provider,
          label,
          accountNumber,
          currency,
          leverage,
          timezone,
          timezoneSource: timezone !== null ? "user_config" : "unknown",
          status,
        },
        this.now(),
      );
    });
  }

  /**
   * Per-user serialization of the quota check+create pair — the Remote
   * memory-path mechanism (repository `userLocks` promise chain) that makes
   * concurrent creation deterministically [201, 429] within ONE process.
   * D3: transactional stores enforce the quota at the database instead
   * (createWithQuotaGuard — users-row FOR UPDATE); this mutex now serves
   * only non-transactional adapters (memory/PGlite).
   */
  private readonly quotaLocks = new Map<string, Promise<void>>();

  private withUserQuotaLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.quotaLocks.get(userId) ?? Promise.resolve();
    const run = prev.then(fn);
    this.quotaLocks.set(
      userId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** Static server-suggestion helper (Remote + PHP identical pure logic). */
  detectServer(mtLoginRaw: unknown): DetectServerResult {
    const login = typeof mtLoginRaw === "string" ? mtLoginRaw.trim() : "";
    if (!/^\d{1,32}$/.test(login)) {
      throw new AccountError(422, "VALIDATION_ERROR", "Invalid mt_login.", { mt_login: "INVALID_FORMAT" });
    }
    let suggested: string[];
    if (/^5\d{6,}/.test(login)) {
      suggested = ["ICMarkets-Demo", "ICMarkets-Live", "Pepperstone-Demo"];
    } else if (/^6\d{6,}/.test(login)) {
      suggested = ["Exness-Demo", "Exness-Real"];
    } else {
      suggested = COMMON_SERVERS.slice(0, 5) as unknown as string[];
    }
    return {
      mt_login: login,
      suggestedServers: suggested.slice(0, 5),
      allServers: [...COMMON_SERVERS],
      messageKey: "accounts.detectServerHint",
      nextStepKey: "accounts.detectServerNextStep",
      params: {},
    };
  }

  async updateTimezone(id: string, userId: string, timezoneRaw: unknown): Promise<AccountRecord> {
    // ownership check first (non-disclosing 404)
    const account = await this.deps.store.findByIdForUser(id, userId);
    if (account === null) {
      throw new AccountError(404, "NOT_FOUND", "Account not found.");
    }
    const tz = typeof timezoneRaw === "string" ? timezoneRaw.trim() : "";
    if (tz !== "") {
      if (!isValidIanaTimezone(tz)) {
        throw new AccountError(400, "VALIDATION_FAILED", "Invalid timezone.", { timezone: "INVALID_TIMEZONE" });
      }
      const updated = await this.deps.store.updateTimezone(id, userId, tz, "user_config", this.now());
      if (updated === null) throw new AccountError(404, "NOT_FOUND", "Account not found.");
      return updated;
    }
    const updated = await this.deps.store.updateTimezone(id, userId, null, "unknown", this.now());
    if (updated === null) throw new AccountError(404, "NOT_FOUND", "Account not found.");
    return updated;
  }

  async deleteAccount(id: string, userId: string): Promise<{ deleted: true }> {
    const account = await this.deps.store.findByIdForUser(id, userId);
    if (account === null) {
      throw new AccountError(404, "NOT_FOUND", "Account not found.");
    }
    await this.deps.store.deleteForUser(id, userId);
    return { deleted: true };
  }
}
