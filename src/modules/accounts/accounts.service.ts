import { ApiError } from '../../core/errors/errorHandler.js';
import { EntitlementService } from '../entitlements/entitlement.service.js';
import { AccountRepository } from './accounts.repository.js';
import { TradingAccountRecord, CreateAccountInput, DetectServerResult } from './accounts.types.js';

export class AccountService {
  private repository: AccountRepository;
  private entitlementService: EntitlementService;

  constructor(repository = new AccountRepository(), entitlementService = new EntitlementService()) {
    this.repository = repository;
    this.entitlementService = entitlementService;
  }

  public async listAccounts(userId: number): Promise<TradingAccountRecord[]> {
    return this.repository.listByUser(userId);
  }

  public async getAccount(id: number, userId: number): Promise<TradingAccountRecord> {
    const account = await this.repository.findByIdForUser(id, userId);
    if (!account) {
      throw new ApiError('Account not found.', 404, 'NOT_FOUND', null, 'errors.accounts.notFound');
    }
    return account;
  }

  public async createAccount(
    userId: number,
    input: CreateAccountInput,
    userPlan?: string,
  ): Promise<TradingAccountRecord> {
    const count = await this.repository.countByUser(userId);
    const plan = userPlan ?? (await this.entitlementService.getUserPlan(userId));
    await this.entitlementService.checkTradingAccountEntitlement(userId, count, plan);

    const provider = input.provider ?? 'MANUAL';
    if (!['MT4', 'MT5', 'MANUAL'].includes(provider)) {
      throw new ApiError('Invalid provider.', 400, 'VALIDATION_FAILED', {
        provider: 'INVALID_PROVIDER',
      });
    }

    const currency = (input.currency ?? 'USD').toUpperCase().trim();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new ApiError('Invalid account currency.', 400, 'VALIDATION_FAILED', {
        currency: 'INVALID_FORMAT',
      });
    }

    if (input.accountNumber && input.accountNumber.trim() !== '') {
      if (!/^[A-Za-z0-9*._-]{1,32}$/.test(input.accountNumber.trim())) {
        throw new ApiError('Invalid account number.', 400, 'VALIDATION_FAILED', {
          accountNumber: 'INVALID_FORMAT',
        });
      }
    }

    if (input.leverage && input.leverage.trim() !== '') {
      if (!/^(?:1:)?[1-9]\d{0,7}$/.test(input.leverage.trim())) {
        throw new ApiError('Invalid leverage.', 400, 'VALIDATION_FAILED', {
          leverage: 'INVALID_FORMAT',
        });
      }
    }

    if (input.timezone && input.timezone.trim() !== '') {
      const tz = input.timezone.trim();
      if (!this.isValidIanaTimezone(tz)) {
        throw new ApiError('Invalid timezone.', 400, 'VALIDATION_FAILED', {
          timezone: 'INVALID_TIMEZONE',
        });
      }
    }

    return this.repository.create(userId, input);
  }

  public detectServer(mtLoginRaw?: string): DetectServerResult {
    const login = mtLoginRaw ? String(mtLoginRaw).trim() : '';

    if (!/^\d{1,32}$/.test(login)) {
      throw new ApiError(
        'Invalid mt_login.',
        422,
        'VALIDATION_ERROR',
        { mt_login: 'INVALID_FORMAT' },
        'errors.validation.format',
      );
    }

    const common = [
      'ICMarkets-Demo',
      'ICMarkets-Live',
      'ICMarkets-MT5',
      'Exness-Demo',
      'Exness-Real',
      'Exness-MT5',
      'Alpari-Demo',
      'Alpari-Live',
      'Alpari-MT5',
      'XM-Demo',
      'XM-Real',
      'FBS-Demo',
      'FBS-Real',
      'RoboForex-Demo',
      'Pepperstone-Demo',
      'Tickmill-Demo',
      'Deriv-Demo',
      'OANDA-Demo',
    ];

    let suggested: string[];
    if (/^5\d{6,}/.test(login)) {
      suggested = ['ICMarkets-Demo', 'ICMarkets-Live', 'Pepperstone-Demo'];
    } else if (/^6\d{6,}/.test(login)) {
      suggested = ['Exness-Demo', 'Exness-Real'];
    } else {
      suggested = common.slice(0, 5);
    }

    return {
      mt_login: login,
      suggestedServers: suggested.slice(0, 5),
      allServers: common,
      messageKey: 'accounts.detectServerHint',
      nextStepKey: 'accounts.detectServerNextStep',
      params: {},
    };
  }

  public async updateTimezone(
    id: number,
    userId: number,
    timezoneRaw?: string,
  ): Promise<TradingAccountRecord> {
    const account = await this.repository.findByIdForUser(id, userId);
    if (!account) {
      throw new ApiError('Account not found.', 404, 'NOT_FOUND', null, 'errors.accounts.notFound');
    }

    const tz = timezoneRaw ? timezoneRaw.trim() : '';
    if (tz !== '') {
      if (!this.isValidIanaTimezone(tz)) {
        throw new ApiError('Invalid timezone.', 400, 'VALIDATION_FAILED', {
          timezone: 'INVALID_TIMEZONE',
        });
      }
      const updated = await this.repository.updateTimezone(id, userId, tz, 'user_config');
      if (!updated) {
        throw new ApiError(
          'Account not found.',
          404,
          'NOT_FOUND',
          null,
          'errors.accounts.notFound',
        );
      }
      return updated;
    } else {
      const updated = await this.repository.updateTimezone(id, userId, null, 'unknown');
      if (!updated) {
        throw new ApiError(
          'Account not found.',
          404,
          'NOT_FOUND',
          null,
          'errors.accounts.notFound',
        );
      }
      return updated;
    }
  }

  public async deleteAccount(id: number, userId: number): Promise<boolean> {
    const account = await this.repository.findByIdForUser(id, userId);
    if (!account) {
      throw new ApiError('Account not found.', 404, 'NOT_FOUND', null, 'errors.accounts.notFound');
    }

    return this.repository.delete(id, userId);
  }

  private isValidIanaTimezone(tz: string): boolean {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }
}
