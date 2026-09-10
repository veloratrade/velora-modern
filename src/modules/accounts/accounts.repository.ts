import { prisma } from '../../core/db.js';
import { ApiError } from '../../core/errors/errorHandler.js';
import {
  TradingAccountRecord,
  CreateAccountInput,
  AccountProvider,
  AccountStatus,
  SyncStatus,
} from './accounts.types.js';

export class AccountRepository {
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
