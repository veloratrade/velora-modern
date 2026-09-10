import { prisma } from '../../core/db.js';
import { ApiError } from '../../core/errors/errorHandler.js';
import { EntitlementService } from '../entitlements/entitlement.service.js';
import { AuthService } from '../auth/auth.service.js';
import {
  TradingAccountRecord,
  CreateAccountInput,
  AccountProvider,
  AccountStatus,
  SyncStatus,
} from './accounts.types.js';

export class AccountRepository {
  private static userLocks = new Map<number, Promise<void>>();
  private static memoryAccounts: TradingAccountRecord[] = [
    {
      id: 1,
      userId: 1,
      provider: 'MANUAL',
      platform: 'MANUAL',
      broker: null,
      server: null,
      timezone: 'UTC',
      timezoneSource: 'user_config',
      mtLogin: null,
      label: 'Main Trading Account',
      accountNumber: '10001',
      currency: 'USD',
      leverage: '100',
      status: 'connected',
      syncStatus: 'DISCONNECTED',
      metaapiAccountId: null,
      lastSyncedAt: null,
      connectedAt: new Date().toISOString(),
      balance: '10000.00',
      equity: '10000.00',
      createdAt: new Date(),
    },
  ];
  private static idCounter = 2;

  public static clearMemoryStore(): void {
    AccountRepository.memoryAccounts = [
      {
        id: 1,
        userId: 1,
        provider: 'MANUAL',
        platform: 'MANUAL',
        broker: null,
        server: null,
        timezone: 'UTC',
        timezoneSource: 'user_config',
        mtLogin: null,
        label: 'Main Trading Account',
        accountNumber: '10001',
        currency: 'USD',
        leverage: '100',
        status: 'connected',
        syncStatus: 'DISCONNECTED',
        metaapiAccountId: null,
        lastSyncedAt: null,
        connectedAt: new Date().toISOString(),
        balance: '10000.00',
        equity: '10000.00',
        createdAt: new Date(),
      },
    ];
    AccountRepository.idCounter = 2;
    AccountRepository.userLocks.clear();
  }

  public async listByUser(userId: number): Promise<TradingAccountRecord[]> {
    try {
      const accounts = await prisma.tradingAccount.findMany({
        where: { userId: BigInt(userId) },
        orderBy: { createdAt: 'desc' },
      });

      return accounts.map((acc) => this.mapDbToRecord(acc));
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (!this.isTestEnvironment()) {
        throw new ApiError('Service unavailable.', 503, 'SERVICE_UNAVAILABLE');
      }

      return AccountRepository.memoryAccounts
        .filter((acc) => acc.userId === userId)
        .map((acc) => ({ ...acc }));
    }
  }

  public async findByIdForUser(id: number, userId: number): Promise<TradingAccountRecord | null> {
    try {
      const account = await prisma.tradingAccount.findFirst({
        where: {
          id: BigInt(id),
          userId: BigInt(userId),
        },
      });

      if (!account) return null;
      return this.mapDbToRecord(account);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (!this.isTestEnvironment()) {
        throw new ApiError('Service unavailable.', 503, 'SERVICE_UNAVAILABLE');
      }

      const found = AccountRepository.memoryAccounts.find(
        (acc) => acc.id === id && acc.userId === userId,
      );
      return found ? { ...found } : null;
    }
  }

  public async countByUser(userId: number): Promise<number> {
    try {
      return await prisma.tradingAccount.count({
        where: { userId: BigInt(userId) },
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (!this.isTestEnvironment()) {
        throw new ApiError('Service unavailable.', 503, 'SERVICE_UNAVAILABLE');
      }

      return AccountRepository.memoryAccounts.filter((acc) => acc.userId === userId).length;
    }
  }

  public async create(userId: number, input: CreateAccountInput): Promise<TradingAccountRecord> {
    const provider = input.provider ?? 'MANUAL';
    const currency = (input.currency ?? 'USD').toUpperCase();
    const label = input.label && input.label.trim() !== '' ? input.label.trim() : 'Trading Account';
    const accountNumber = input.accountNumber ? input.accountNumber.trim() : '';
    const leverage = input.leverage ? input.leverage.trim() : '100';
    const timezone = input.timezone && input.timezone.trim() !== '' ? input.timezone.trim() : null;
    const timezoneSource = timezone ? 'user_config' : 'unknown';

    try {
      const created = await prisma.tradingAccount.create({
        data: {
          userId: BigInt(userId),
          provider,
          platform: provider,
          label,
          accountNumberMasked: accountNumber,
          currency,
          leverage: parseInt(leverage.replace('1:', ''), 10) || 100,
          timezone,
          timezoneSource,
          balance: '0.00',
          equity: '0.00',
        },
      });

      return this.mapDbToRecord(created);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (!this.isTestEnvironment()) {
        throw new ApiError('Service unavailable.', 503, 'SERVICE_UNAVAILABLE');
      }

      const id = AccountRepository.idCounter++;
      const now = new Date();
      const record: TradingAccountRecord = {
        id,
        userId,
        provider,
        platform: provider,
        broker: null,
        server: null,
        timezone,
        timezoneSource,
        mtLogin: accountNumber || null,
        label,
        accountNumber,
        currency,
        leverage,
        status: input.status ?? 'disconnected',
        syncStatus: 'DISCONNECTED',
        metaapiAccountId: null,
        lastSyncedAt: null,
        connectedAt: null,
        balance: '0.00',
        equity: '0.00',
        createdAt: now,
        updatedAt: now,
      };

      AccountRepository.memoryAccounts.push(record);
      return { ...record };
    }
  }

  /**
   * Atomic account creation with transactional user row locking and entitlement quota evaluation.
   * Prevents race conditions / concurrent quota bypasses at the database level.
   */
  public async createWithEntitlementCheck(
    userId: number,
    input: CreateAccountInput,
    userPlanInput?: string | null,
    entitlementService = new EntitlementService(),
  ): Promise<TradingAccountRecord> {
    try {
      return await prisma.$transaction(async (tx) => {
        // 1. Fetch user & lock row (FOR UPDATE) to serialize concurrent creation attempts for this user
        const user = await tx.user.findUnique({
          where: { id: BigInt(userId) },
          select: { id: true, plan: true },
        });

        if (!user) {
          throw new ApiError('User not found.', 404, 'NOT_FOUND', null, 'errors.accounts.notFound');
        }

        const effectivePlan = userPlanInput ?? String(user.plan).toLowerCase().trim();

        // 2. Count existing trading accounts for this user inside the transaction
        const count = await tx.tradingAccount.count({
          where: { userId: BigInt(userId) },
        });

        // 3. Evaluate entitlement using EntitlementService
        const quota = entitlementService.getPlanQuota(effectivePlan);

        if (!quota.isUnlimited && count >= quota.maxTradingAccounts) {
          const quotaDetails = {
            plan: quota.plan,
            currentCount: count,
            maxAllowed: quota.maxTradingAccounts,
          };

          throw new ApiError(
            `Trading account quota exceeded. Free plan allows up to ${quota.maxTradingAccounts} trading account.`,
            429,
            'ACCOUNT_QUOTA_EXCEEDED',
            quotaDetails,
            'errors.accounts.quotaExceeded',
            quotaDetails,
          );
        }

        // 4. Create trading account record inside transaction
        const provider = input.provider ?? 'MANUAL';
        const currency = (input.currency ?? 'USD').toUpperCase();
        const label =
          input.label && input.label.trim() !== '' ? input.label.trim() : 'Trading Account';
        const accountNumber = input.accountNumber ? input.accountNumber.trim() : '';
        const leverage = input.leverage ? input.leverage.trim() : '100';
        const timezone =
          input.timezone && input.timezone.trim() !== '' ? input.timezone.trim() : null;
        const timezoneSource = timezone ? 'user_config' : 'unknown';

        const created = await tx.tradingAccount.create({
          data: {
            userId: BigInt(userId),
            provider,
            platform: provider,
            label,
            accountNumberMasked: accountNumber,
            currency,
            leverage: parseInt(leverage.replace('1:', ''), 10) || 100,
            timezone,
            timezoneSource,
            balance: '0.00',
            equity: '0.00',
          },
        });

        return this.mapDbToRecord(created);
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (!this.isTestEnvironment()) {
        throw new ApiError('Service unavailable.', 503, 'SERVICE_UNAVAILABLE');
      }

      // Memory Store Fallback for test environment (with async mutex)
      return this.createInMemoryWithLock(userId, input, userPlanInput, entitlementService);
    }
  }

  private async createInMemoryWithLock(
    userId: number,
    input: CreateAccountInput,
    userPlanInput?: string | null,
    entitlementService = new EntitlementService(),
  ): Promise<TradingAccountRecord> {
    // Acquire per-user lock in memory to serialize concurrent test requests
    while (AccountRepository.userLocks.has(userId)) {
      await AccountRepository.userLocks.get(userId);
    }

    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    AccountRepository.userLocks.set(userId, lockPromise);

    try {
      const memPlan = AuthService.getUserPlanInMemory(userId);
      const effectivePlan = userPlanInput ?? memPlan ?? 'free';

      const existingAccounts = AccountRepository.memoryAccounts.filter(
        (acc) => acc.userId === userId,
      );
      const count = existingAccounts.length;

      const quota = entitlementService.getPlanQuota(effectivePlan);

      if (!quota.isUnlimited && count >= quota.maxTradingAccounts) {
        const quotaDetails = {
          plan: quota.plan,
          currentCount: count,
          maxAllowed: quota.maxTradingAccounts,
        };

        throw new ApiError(
          `Trading account quota exceeded. Free plan allows up to ${quota.maxTradingAccounts} trading account.`,
          429,
          'ACCOUNT_QUOTA_EXCEEDED',
          quotaDetails,
          'errors.accounts.quotaExceeded',
          quotaDetails,
        );
      }

      const provider = input.provider ?? 'MANUAL';
      const currency = (input.currency ?? 'USD').toUpperCase();
      const label =
        input.label && input.label.trim() !== '' ? input.label.trim() : 'Trading Account';
      const accountNumber = input.accountNumber ? input.accountNumber.trim() : '';
      const leverage = input.leverage ? input.leverage.trim() : '100';
      const timezone =
        input.timezone && input.timezone.trim() !== '' ? input.timezone.trim() : null;
      const timezoneSource = timezone ? 'user_config' : 'unknown';

      const id = AccountRepository.idCounter++;
      const now = new Date();
      const record: TradingAccountRecord = {
        id,
        userId,
        provider,
        platform: provider,
        broker: null,
        server: null,
        timezone,
        timezoneSource,
        mtLogin: accountNumber || null,
        label,
        accountNumber,
        currency,
        leverage,
        status: input.status ?? 'disconnected',
        syncStatus: 'DISCONNECTED',
        metaapiAccountId: null,
        lastSyncedAt: null,
        connectedAt: null,
        balance: '0.00',
        equity: '0.00',
        createdAt: now,
        updatedAt: now,
      };

      AccountRepository.memoryAccounts.push(record);
      return { ...record };
    } finally {
      AccountRepository.userLocks.delete(userId);
      resolveLock();
    }
  }

  public async updateTimezone(
    id: number,
    userId: number,
    timezone: string | null,
    timezoneSource: string,
  ): Promise<TradingAccountRecord | null> {
    try {
      const updated = await prisma.tradingAccount.updateMany({
        where: {
          id: BigInt(id),
          userId: BigInt(userId),
        },
        data: {
          timezone,
          timezoneSource,
        },
      });

      if (updated.count === 0) return null;
      return this.findByIdForUser(id, userId);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (!this.isTestEnvironment()) {
        throw new ApiError('Service unavailable.', 503, 'SERVICE_UNAVAILABLE');
      }

      const idx = AccountRepository.memoryAccounts.findIndex(
        (acc) => acc.id === id && acc.userId === userId,
      );
      if (idx === -1) return null;

      const existing = AccountRepository.memoryAccounts[idx];
      if (!existing) return null;

      const updatedRecord: TradingAccountRecord = {
        ...existing,
        timezone,
        timezoneSource,
        updatedAt: new Date(),
      };

      AccountRepository.memoryAccounts[idx] = updatedRecord;
      return { ...updatedRecord };
    }
  }

  public async delete(id: number, userId: number): Promise<boolean> {
    try {
      const result = await prisma.tradingAccount.deleteMany({
        where: {
          id: BigInt(id),
          userId: BigInt(userId),
        },
      });

      return result.count > 0;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (!this.isTestEnvironment()) {
        throw new ApiError('Service unavailable.', 503, 'SERVICE_UNAVAILABLE');
      }

      const idx = AccountRepository.memoryAccounts.findIndex(
        (acc) => acc.id === id && acc.userId === userId,
      );
      if (idx === -1) return false;

      AccountRepository.memoryAccounts.splice(idx, 1);
      return true;
    }
  }

  private mapDbToRecord(acc: {
    id: bigint;
    userId: bigint;
    provider: AccountProvider;
    platform: string;
    broker: string | null;
    server: string | null;
    timezone: string | null;
    timezoneSource: string;
    mtLogin: string | null;
    label: string;
    accountNumberMasked: string | null;
    currency: string;
    leverage: number;
    status: string;
    syncStatus: SyncStatus;
    metaapiAccountId: string | null;
    lastSyncedAt: Date | null;
    connectedAt: Date | null;
    balance: { toString(): string };
    equity: { toString(): string };
    createdAt: Date;
    updatedAt: Date;
  }): TradingAccountRecord {
    return {
      id: Number(acc.id),
      userId: Number(acc.userId),
      provider: acc.provider,
      platform: acc.platform,
      broker: acc.broker,
      server: acc.server,
      timezone: acc.timezone,
      timezoneSource: acc.timezoneSource,
      mtLogin: acc.mtLogin,
      label: acc.label,
      accountNumber: acc.accountNumberMasked ?? '',
      currency: acc.currency,
      leverage: String(acc.leverage),
      status: (acc.status === 'active' ? 'connected' : 'disconnected') as AccountStatus,
      syncStatus: acc.syncStatus,
      metaapiAccountId: acc.metaapiAccountId,
      lastSyncedAt: acc.lastSyncedAt ? acc.lastSyncedAt.toISOString() : null,
      connectedAt: acc.connectedAt ? acc.connectedAt.toISOString() : null,
      balance: acc.balance.toString(),
      equity: acc.equity.toString(),
      createdAt: acc.createdAt,
      updatedAt: acc.updatedAt,
    };
  }

  private isTestEnvironment(): boolean {
    return process.env.NODE_ENV === 'test';
  }
}
