import { Decimal } from 'decimal.js';
import { ApiError } from '../../core/errors/errorHandler.js';

export interface PnlCalculationInput {
  entryPrice: string;
  exitPrice: string;
  volume: string;
  direction: 'buy' | 'sell';
  commission?: string;
  swap?: string;
  stopLoss?: string | null;
  contractSize?: string;
}

export interface PnlCalculationResult {
  grossPnl: string;
  commission: string;
  swap: string;
  netPnl: string;
  rMultiple: string | null;
}

export class PnlCalculator {
  /**
   * Compute gross PnL in account currency for a closed trade.
   * Buy:  (exitPrice - entryPrice) * volume * contractSize
   * Sell: (entryPrice - exitPrice) * volume * contractSize
   */
  public static grossPnl(
    entryPrice: string,
    exitPrice: string,
    volume: string,
    direction: 'buy' | 'sell',
    contractSize = '1',
  ): Decimal {
    const entry = new Decimal(entryPrice);
    const exit = new Decimal(exitPrice);
    const vol = new Decimal(volume);
    const size = new Decimal(contractSize);

    const delta = direction === 'buy' ? exit.minus(entry) : entry.minus(exit);
    return delta.times(vol).times(size);
  }

  /**
   * Risk = |entry - stopLoss| * volume * contractSize.
   * SL on wrong side yields null (undefined risk).
   */
  public static riskAmount(
    entryPrice: string,
    volume: string,
    direction: 'buy' | 'sell',
    stopLoss?: string | null,
    contractSize = '1',
  ): Decimal | null {
    if (!stopLoss || new Decimal(stopLoss).isZero()) {
      return null;
    }

    const entry = new Decimal(entryPrice);
    const sl = new Decimal(stopLoss);
    const vol = new Decimal(volume);
    const size = new Decimal(contractSize);

    const delta = direction === 'buy' ? entry.minus(sl) : sl.minus(entry);

    if (delta.lessThanOrEqualTo(0)) {
      return null; // SL on wrong side
    }

    return delta.times(vol).times(size);
  }

  /**
   * Complete calculation for trade financial metrics.
   * Net PnL = grossPnl - commission - swap
   * R-Multiple = netPnl / risk (when risk > 0)
   */
  public static calculate(input: PnlCalculationInput): PnlCalculationResult {
    const commissionStr = input.commission ?? '0';
    const swapStr = input.swap ?? '0';
    const contractSizeStr = input.contractSize ?? '1';

    const gross = this.grossPnl(
      input.entryPrice,
      input.exitPrice,
      input.volume,
      input.direction,
      contractSizeStr,
    );

    const commission = new Decimal(commissionStr);
    const swap = new Decimal(swapStr);

    const net = gross.minus(commission).minus(swap);

    const risk = this.riskAmount(
      input.entryPrice,
      input.volume,
      input.direction,
      input.stopLoss,
      contractSizeStr,
    );

    let rMultiple: Decimal | null = null;
    if (risk !== null && risk.greaterThan(0)) {
      rMultiple = net.dividedBy(risk);
    }

    this.assertFits(net, 'profitLoss', 16, 8);
    if (rMultiple !== null) {
      this.assertFits(rMultiple, 'rMultiple', 10, 8);
    }

    return {
      grossPnl: gross.toFixed(2),
      commission: commission.toFixed(2),
      swap: swap.toFixed(2),
      netPnl: net.toFixed(2),
      rMultiple: rMultiple !== null ? rMultiple.toFixed(4) : null,
    };
  }

  private static assertFits(
    value: Decimal,
    field: string,
    maxIntDigits: number,
    maxDecDigits: number,
  ): void {
    const str = value.toString();
    const pattern = new RegExp(`^-?\\d{1,${maxIntDigits}}(?:\\.\\d{1,${maxDecDigits}})?$`);
    if (!pattern.test(str)) {
      throw new ApiError(
        'Calculated financial value is outside the supported range.',
        422,
        'VALIDATION_FAILED',
        { field },
        'errors.validation.range',
      );
    }
  }
}
