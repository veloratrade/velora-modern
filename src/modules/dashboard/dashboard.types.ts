export interface EquityCurvePoint {
  date: string;
  pnl: string;
  equity: string;
}

export interface DashboardSummary {
  tradeCount: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: string;
  totalPnl: string;
  profitFactor: string | null;
  averageR: string;
  bestTrade: string;
  worstTrade: string;
  equityCurve: EquityCurvePoint[];
}

export interface StrategyPerformance {
  strategy: string | null;
  tradeCount: number;
  winRate: string;
  pnl: string;
}
