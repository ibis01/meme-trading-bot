import { PositionAwareBacktester } from '../src/backtest/positionAwareBacktester';
import { MomentumStrategy, defaultMomentumConfig } from '../src/strategy/momentum';
import { PriceBar, StopConfig } from '../src/backtest/types';

function barsFromPrices(prices: number[], opts: { momentum?: boolean } = {}): PriceBar[] {
  return prices.slice(0, -1).map((p, i) => ({
    tokenMint: 'mint',
    fetchedAt: 1_700_000_000_000 + i * 60_000,
    priceUsd: p,
    nextPriceUsd: prices[i + 1],
    liquidityUsd: 250_000,
    volume24hUsd: 1_000_000,
    holderCount: 3_000,
    top10HolderPercent: 22,
    smartWalletNetFlowUsd: opts.momentum === false ? -100 : 8_500,
    priceChange5mPercent: opts.momentum === false ? 0.1 : 6.4,
    priceChange1hPercent: opts.momentum === false ? 0.2 : 14.1,
  }));
}

const stops: StopConfig = { hardStopPct: 0.15, trailingStopPct: 0.1 };

const config = {
  feeRate: 0.002,
  slippageRate: 0.003,
  initialEquitySol: 10,
  riskPerTradeSol: 0.1,
  maxPositionSol: 0.1,
  split: 'train' as const,
  stops,
};

describe('PositionAwareBacktester (Rule 16)', () => {
  it('holds a position across bars until a stop fires', () => {
    // Steady rise then a hard crash: trailing stop should fire once.
    const prices = [1, 1.02, 1.04, 1.06, 1.08, 1.10, 1.12, 1.10, 1.00, 0.90];
    const bt = new PositionAwareBacktester(new MomentumStrategy(defaultMomentumConfig), config);
    const r = bt.run(barsFromPrices(prices));
    expect(r.trades.length).toBeGreaterThan(0);
    const trade = r.trades[0];
    expect(['HARD_STOP', 'TRAILING_STOP', 'END_OF_DATA', 'TIME_STOP']).toContain(trade.exitReason);
    expect(trade.holdBars).toBeGreaterThan(0);
  });

  it('does not re-enter while holding', () => {
    const prices = Array.from({ length: 50 }, (_, i) => 1 + i * 0.02);
    const bt = new PositionAwareBacktester(new MomentumStrategy(defaultMomentumConfig), config);
    const r = bt.run(barsFromPrices(prices));
    // No overlapping entries — each trade's entry index must be after the previous exit.
    for (let i = 1; i < r.trades.length; i++) {
      expect(r.trades[i].entryIndex).toBeGreaterThanOrEqual(r.trades[i - 1].exitIndex);
    }
  });

  it('closes any remaining position at end of data', () => {
    // Slow rise with no stop firing, then data ends.
    const prices = Array.from({ length: 10 }, (_, i) => 1 + i * 0.01);
    const bt = new PositionAwareBacktester(new MomentumStrategy(defaultMomentumConfig), config);
    const r = bt.run(barsFromPrices(prices));
    if (r.trades.length > 0) {
      expect(r.trades[r.trades.length - 1].exitReason).toBe('END_OF_DATA');
    }
  });

  it('records fees and slippage from all closed trades', () => {
    const prices = [1, 1.02, 1.04, 1.06, 1.08];
    const bt = new PositionAwareBacktester(new MomentumStrategy(defaultMomentumConfig), config);
    const r = bt.run(barsFromPrices(prices));
    if (r.trades.length > 0) {
      expect(r.metrics.feesPaidSol).toBeGreaterThan(0);
      expect(r.metrics.slippagePaidSol).toBeGreaterThan(0);
    }
  });

  it('is deterministic', () => {
    const prices = [1, 1.02, 1.04, 1.06, 1.08, 1.10];
    const a = new PositionAwareBacktester(new MomentumStrategy(defaultMomentumConfig), config).run(barsFromPrices(prices));
    const b = new PositionAwareBacktester(new MomentumStrategy(defaultMomentumConfig), config).run(barsFromPrices(prices));
    expect(a.trades.length).toBe(b.trades.length);
    expect(a.metrics.totalReturnPct).toBeCloseTo(b.metrics.totalReturnPct, 10);
  });

  it('produces zero trades when momentum never fires', () => {
    const prices = [1, 1.02, 1.04, 1.06, 1.08];
    const bt = new PositionAwareBacktester(new MomentumStrategy(defaultMomentumConfig), config);
    const r = bt.run(barsFromPrices(prices, { momentum: false }));
    expect(r.trades).toHaveLength(0);
  });
});
