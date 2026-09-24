import { Backtester } from '../src/backtest/engine';
import { BacktestConfig, PriceBar } from '../src/backtest/types';
import { MomentumStrategy, defaultMomentumConfig } from '../src/strategy/momentum';
import { makeBars } from './helpers/backtestFixtures';

const baseConfig: BacktestConfig = {
  feeRate: 0.002,
  slippageRate: 0.003,
  initialEquitySol: 10,
  riskPerTradeSol: 0.1,
  maxPositionSol: 0.1,
  split: 'train',
};

describe('Backtester (Rules 17, 18, 19)', () => {
  it('produces zero trades when momentum never fires', () => {
    const bars = makeBars([1, 1.01, 1.02, 1.03, 1.04], { momentum: false });
    const bt = new Backtester(new MomentumStrategy(defaultMomentumConfig), baseConfig);
    const r = bt.run(bars);
    expect(r.trades).toHaveLength(0);
    expect(r.metrics.tradeCount).toBe(0);
    expect(r.profitableAfterCosts).toBe(false);
  });

  it('produces trades on a trending price path with momentum', () => {
    const prices = [1, 1.02, 1.04, 1.06, 1.08, 1.10, 1.12, 1.14, 1.16, 1.18];
    const bars = makeBars(prices);
    const bt = new Backtester(new MomentumStrategy(defaultMomentumConfig), baseConfig);
    const r = bt.run(bars);
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.metrics.tradeCount).toBe(r.trades.length);
    expect(r.bars).toBe(bars.length);
  });

  it('records fees and slippage on every trade', () => {
    const prices = [1, 1.02, 1.04, 1.06, 1.08];
    const bars = makeBars(prices);
    const bt = new Backtester(new MomentumStrategy(defaultMomentumConfig), baseConfig);
    const r = bt.run(bars);
    expect(r.metrics.feesPaidSol).toBeGreaterThan(0);
    expect(r.metrics.slippagePaidSol).toBeGreaterThan(0);
  });

  it('reports losses honestly when the price drops', () => {
    const prices = [1, 1.02, 1.00, 0.95, 0.90, 0.85];
    const bars = makeBars(prices);
    const bt = new Backtester(new MomentumStrategy(defaultMomentumConfig), baseConfig);
    const r = bt.run(bars);
    const losers = r.trades.filter((t) => t.pnlSol < 0);
    expect(losers.length).toBeGreaterThan(0);
    expect(r.profitableAfterCosts).toBe(false);
  });

  it('skips bars without a next price (Rule 30)', () => {
    const bars = makeBars([1, 1.02, 1.04]).map((b: PriceBar, i: number) =>
      i === 1 ? { ...b, nextPriceUsd: 0 } : b,
    );
    const bt = new Backtester(new MomentumStrategy(defaultMomentumConfig), baseConfig);
    const r = bt.run(bars);
    expect(r.trades.every((t) => t.entryIndex !== 1)).toBe(true);
  });

  it('computes Sharpe and Sortino without NaN', () => {
    const bars = makeBars([1, 1.02, 1.04, 1.06, 1.08, 1.10]);
    const bt = new Backtester(new MomentumStrategy(defaultMomentumConfig), baseConfig);
    const r = bt.run(bars);
    expect(Number.isFinite(r.metrics.sharpe)).toBe(true);
    expect(Number.isFinite(r.metrics.sortino)).toBe(true);
  });

  it('preserves the split label (Rule 19)', () => {
    const bars = makeBars([1, 1.02, 1.04]);
    const bt = new Backtester(new MomentumStrategy(defaultMomentumConfig), {
      ...baseConfig,
      split: 'validation',
    });
    const r = bt.run(bars);
    expect(r.split).toBe('validation');
  });

  it('flags profitableAfterCosts=false when fees exceed edge', () => {
    const prices = [1, 1.0001, 1.0002, 1.0003];
    const bars = makeBars(prices);
    const bt = new Backtester(new MomentumStrategy(defaultMomentumConfig), {
      ...baseConfig,
      feeRate: 0.05,
      slippageRate: 0.05,
    });
    const r = bt.run(bars);
    expect(r.profitableAfterCosts).toBe(false);
  });
});
