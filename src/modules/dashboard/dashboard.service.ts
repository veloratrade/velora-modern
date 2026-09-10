import { Decimal } from 'decimal.js';
import { DashboardRepository } from './dashboard.repository.js';
import { DashboardSummary, EquityCurvePoint, StrategyPerformance } from './dashboard.types.js';

export class DashboardService {
  private repository: DashboardRepository;

  constructor(repository = new DashboardRepository()) {
    this.repository = repository;
  }

  public async getSummary(userId: number): Promise<DashboardSummary> {
    const trades = await this.repository.getUserTrades(userId);

    let wins = 0;
    let losses = 0;
    let breakeven = 0;
    let totalPnl = new Decimal(0);
    let grossProfit = new Decimal(0);
    let grossLoss = new Decimal(0);
    let bestTrade: Decimal | null = null;
    let worstTrade: Decimal | null = null;

    let rMultipleSum = new Decimal(0);
    let rMultipleCount = 0;

    for (const t of trades) {
      const pnl = new Decimal(t.profitLoss ?? '0');
      totalPnl = totalPnl.plus(pnl);

      if (pnl.greaterThan(0)) {
        wins++;
        grossProfit = grossProfit.plus(pnl);
      } else if (pnl.lessThan(0)) {
        losses++;
        grossLoss = grossLoss.plus(pnl.abs());
      } else {
        breakeven++;
      }

      if (bestTrade === null || pnl.greaterThan(bestTrade)) {
        bestTrade = pnl;
      }
      if (worstTrade === null || pnl.lessThan(worstTrade)) {
        worstTrade = pnl;
      }

      if (t.rMultiple !== null && t.rMultiple !== undefined) {
        rMultipleSum = rMultipleSum.plus(new Decimal(t.rMultiple));
        rMultipleCount++;
      }
    }

    const tradeCount = trades.length;
    const decided = wins + losses;
    const winRate =
      decided > 0
        ? new Decimal(wins).dividedBy(decided).toDP(4, Decimal.ROUND_DOWN).toFixed(4)
        : '0.0000';

    let profitFactor: string | null = null;
    if (grossLoss.greaterThan(0)) {
      profitFactor = grossProfit.dividedBy(grossLoss).toDP(4, Decimal.ROUND_DOWN).toFixed(4);
    } else if (grossProfit.greaterThan(0)) {
      profitFactor = null; // null = infinity (no losses)
    } else {
      profitFactor = '0';
    }

    const averageR =
      rMultipleCount > 0
        ? rMultipleSum.dividedBy(rMultipleCount).toDP(4, Decimal.ROUND_DOWN).toFixed(4)
        : '0.0000';

    const equityCurve = await this.getEquityCurve(userId, 30);

    return {
      tradeCount,
      wins,
      losses,
      breakeven,
      winRate,
      totalPnl: totalPnl.toFixed(2),
      profitFactor,
      averageR,
      bestTrade: (bestTrade ?? new Decimal(0)).toFixed(2),
      worstTrade: (worstTrade ?? new Decimal(0)).toFixed(2),
      equityCurve,
    };
  }

  public async getEquityCurve(userId: number, requestedDays = 30): Promise<EquityCurvePoint[]> {
    const days = Math.max(7, Math.min(365, requestedDays));
    const trades = await this.repository.getUserTrades(userId);

    const now = new Date();
    const cutoffDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const cutoffStr = cutoffDate.toISOString().substring(0, 10);

    // Group net PnL by close day (YYYY-MM-DD)
    const dayPnlMap = new Map<string, Decimal>();

    for (const t of trades) {
      const closeTimeStr = t.closeTime || t.openTime;
      const dayStr = closeTimeStr.substring(0, 10);

      if (dayStr >= cutoffStr) {
        const pnl = new Decimal(t.profitLoss ?? '0');
        const existing = dayPnlMap.get(dayStr) ?? new Decimal(0);
        dayPnlMap.set(dayStr, existing.plus(pnl));
      }
    }

    // Sort days ascending
    const sortedDays = Array.from(dayPnlMap.keys()).sort();

    let cumulative = new Decimal(0);
    const points: EquityCurvePoint[] = [];

    for (const day of sortedDays) {
      const dayPnl = dayPnlMap.get(day)!;
      cumulative = cumulative.plus(dayPnl);
      points.push({
        date: day,
        pnl: dayPnl.toFixed(2),
        equity: cumulative.toFixed(2),
      });
    }

    return points;
  }

  public async getPerStrategy(userId: number): Promise<StrategyPerformance[]> {
    const trades = await this.repository.getUserTrades(userId);

    const groups = new Map<string | null, { count: number; wins: number; pnl: Decimal }>();

    for (const t of trades) {
      const strategy = t.strategyTag && t.strategyTag.trim() !== '' ? t.strategyTag.trim() : null;
      const pnl = new Decimal(t.profitLoss ?? '0');

      const existing = groups.get(strategy) ?? { count: 0, wins: 0, pnl: new Decimal(0) };
      existing.count++;
      if (pnl.greaterThan(0)) {
        existing.wins++;
      }
      existing.pnl = existing.pnl.plus(pnl);
      groups.set(strategy, existing);
    }

    const result: StrategyPerformance[] = [];

    for (const [strategy, stat] of groups.entries()) {
      const winRate =
        stat.count > 0
          ? new Decimal(stat.wins).dividedBy(stat.count).toDP(4, Decimal.ROUND_DOWN).toFixed(4)
          : '0.0000';

      result.push({
        strategy,
        tradeCount: stat.count,
        winRate,
        pnl: stat.pnl.toFixed(2),
      });
    }

    // Sort by pnl descending
    result.sort((a, b) => new Decimal(b.pnl).minus(new Decimal(a.pnl)).toNumber());

    return result;
  }
}
