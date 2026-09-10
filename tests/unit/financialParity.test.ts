import { describe, it, expect } from 'vitest';
import { PnlCalculator } from '../../src/modules/trades/pnlCalculator.js';

describe('Financial & Trading Logic Parity (PHP PnlCalculator Parity)', () => {
  it('Vector A — standard EURUSD Buy winner', () => {
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

  it('Vector B — fractional volume (0.00000001 lot micro volume)', () => {
    const res = PnlCalculator.calculate({
      entryPrice: '1.1000',
      exitPrice: '1.2000',
      volume: '0.00000001',
      direction: 'buy',
      commission: '0.00',
      swap: '0.00',
      stopLoss: '1.0000',
      contractSize: '100000',
    });

    // delta = 0.1000, volSize = 0.0010, gross = 0.00010000
    expect(res.grossPnl).toBe('0.00');
    expect(res.netPnl).toBe('0.00');
  });

  it('Vector C — fractional contract size (33.33333333)', () => {
    const res = PnlCalculator.calculate({
      entryPrice: '10.00',
      exitPrice: '15.00',
      volume: '2.0',
      direction: 'buy',
      commission: '1.25',
      swap: '0.50',
      stopLoss: '8.00',
      contractSize: '33.33333333',
    });

    // delta = 5.00, volSize = 66.66666666, gross = 333.33333330 -> 333.33
    // net = 333.33333330 - 1.25 - 0.50 = 331.58333330 -> 331.58
    // risk = 2.0 * 2.0 * 33.33333333 = 133.33333332
    // rMultiple = 331.58333330 / 133.33333332 = 2.48687500 -> 2.4869
    expect(res.grossPnl).toBe('333.33');
    expect(res.netPnl).toBe('331.58');
    expect(res.rMultiple).toBe('2.4869');
  });

  it('Vector D — commission & swap fractional values', () => {
    const res = PnlCalculator.calculate({
      entryPrice: '100.00',
      exitPrice: '105.00',
      volume: '1.5',
      direction: 'buy',
      commission: '2.34567891',
      swap: '1.23456789',
      stopLoss: '90.00',
      contractSize: '1',
    });

    // gross = 5.00 * 1.5 = 7.50
    // net = 7.50 - 2.34567891 - 1.23456789 = 3.91975320 -> 3.92
    expect(res.grossPnl).toBe('7.50');
    expect(res.netPnl).toBe('3.92');
  });

  it('Vector E — R-multiple with repeating division (10 / 3)', () => {
    const res = PnlCalculator.calculate({
      entryPrice: '1.1000',
      exitPrice: '1.1010',
      volume: '1.0',
      direction: 'buy',
      commission: '0.00',
      swap: '0.00',
      stopLoss: '1.0997',
      contractSize: '100000',
    });

    // delta = 0.0010, gross = 100.00
    // risk = 0.0003 * 100000 = 30.00
    // rMultiple = 100.00 / 30.00 = 3.33333333 -> 3.3333
    expect(res.grossPnl).toBe('100.00');
    expect(res.netPnl).toBe('100.00');
    expect(res.rMultiple).toBe('3.3333');
  });

  it('Vector F — partial exit cost allocation (ratio 0.5)', () => {
    // Parent trade: volume 1.0, commission 10.00, swap 2.00
    // Partial exit: volume 0.5 -> ratio = 0.5
    // Allocated commission = 5.00, swap = 1.00
    const res = PnlCalculator.calculate({
      entryPrice: '1.1000',
      exitPrice: '1.1050',
      volume: '0.5',
      direction: 'buy',
      commission: '5.00',
      swap: '1.00',
      contractSize: '100000',
    });

    // gross = 0.0050 * 0.5 * 100000 = 250.00
    // net = 250.00 - 5.00 - 1.00 = 244.00
    expect(res.grossPnl).toBe('250.00');
    expect(res.netPnl).toBe('244.00');
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
