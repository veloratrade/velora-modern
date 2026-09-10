import { prisma } from '../../core/db.js';
import { ApiError } from '../../core/errors/errorHandler.js';

export interface PlanQuota {
  plan: string;
  maxTradingAccounts: number;
  isUnlimited: boolean;
}

export class EntitlementService {
  /**
   * Returns commercial plan limits and entitlement metadata for a given plan string.
   * Free plan: exactly 1 trading account
   * Pro / Enterprise plan: unlimited trading accounts (Infinity)
   */
  public getPlanQuota(planInput?: string | null): PlanQuota {
    const plan = (planInput || 'free').toLowerCase().trim();

    if (plan === 'pro' || plan === 'enterprise') {
      return {
        plan,
        maxTradingAccounts: Infinity,
        isUnlimited: true,
      };
    }

    return {
      plan: 'free',
      maxTradingAccounts: 1,
      isUnlimited: false,
    };
  }

  /**
   * Retrieves the user's plan from the database or memory store fallback.
   */
  public async getUserPlan(userId: number): Promise<string> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: BigInt(userId) },
        select: { plan: true },
      });

      if (user && user.plan) {
        return String(user.plan).toLowerCase();
      }
    } catch {
      // DB unavailable or in test environment fallback
    }

    return 'free';
  }

  /**
   * Checks if user is entitled to create another Trading Account (MT4, MT5, MANUAL).
   * Projects are distinct entities in the system and are NOT counted as Trading Accounts.
   */
  public async checkTradingAccountEntitlement(
    userId: number,
    currentAccountCount: number,
    userPlanInput?: string | null,
  ): Promise<{ allowed: boolean; limit: number; currentCount: number }> {
    const plan = userPlanInput ?? (await this.getUserPlan(userId));
    const quota = this.getPlanQuota(plan);

    if (!quota.isUnlimited && currentAccountCount >= quota.maxTradingAccounts) {
      const quotaDetails = {
        plan: quota.plan,
        currentCount: currentAccountCount,
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

    return {
      allowed: true,
      limit: quota.maxTradingAccounts,
      currentCount: currentAccountCount,
    };
  }
}
