import { describe, it, expect } from 'vitest';
import { PnlCalculator } from '../../src/modules/trades/pnlCalculator.js';

describe('Financial & Trading Logic Parity (PHP PnlCalculator Parity)', () => {
  it('should compute exact EURUSD Buy trade gross, net PnL and R-multiple', () => {
    const res = PnlCalculator.calculate({
      entryPrice: '1.1000',
      exitPrice: '1.1050',
      volume: '1.0',
      direction: 'buy',
      commission: '5.00',
      swap: '1.50',
      stopLoss: '1.0970',
      contractSize: '100000',
    });

    expect(res.grossPnl).toBe('500.00');
    expect(res.commission).toBe('5.00');
    expect(res.swap).toBe('1.50');
    expect(res.netPnl).toBe('493.50');
    expect(res.rMultiple).toBe('1.6450');
  });

  it('should compute exact XAUUSD Sell trade gross, net PnL and R-multiple', () => {
    const res = PnlCalculator.calculate({
      entryPrice: '2000.00',
      exitPrice: '1990.00',
      volume: '0.5',
      direction: 'sell',
      commission: '2.50',
      swap: '0.00',
      stopLoss: '2005.00',
      contractSize: '100',
    });

    expect(res.grossPnl).toBe('500.00');
    expect(res.commission).toBe('2.50');
    expect(res.swap).toBe('0.00');
    expect(res.netPnl).toBe('497.50');
    expect(res.rMultiple).toBe('1.9900');
  });

  it('should return rMultiple = null when Stop Loss is undefined or on wrong side', () => {
    const resNoSl = PnlCalculator.calculate({
      entryPrice: '100.00',
      exitPrice: '110.00',
      volume: '1.0',
      direction: 'buy',
      stopLoss: null,
    });
    expect(resNoSl.rMultiple).toBeNull();

    const resWrongSl = PnlCalculator.calculate({
      entryPrice: '100.00',
      exitPrice: '110.00',
      volume: '1.0',
      direction: 'buy',
      stopLoss: '105.00', // SL above entry for a buy trade -> invalid risk
    });
    expect(resWrongSl.rMultiple).toBeNull();
  });
});
