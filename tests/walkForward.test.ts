import { WalkForwardValidator, defaultWalkForwardConfig } from '../src/backtest/walkForward';
import { PriceBar } from '../src/backtest/types';
import { Strategy } from '../src/strategy/types';

function barsFromPrices(prices: number[]): PriceBar[] {
  return prices.slice(0, -1).map((p, i) => ({
    tokenMint: 'mint',
    fetchedAt: 1_700_000_000_000 + i * 60_000,
    priceUsd: p,
    nextPriceUsd: prices[i + 1],
    liquidityUsd: 250_000,
    volume24hUsd: 1_000_000,
    holderCount: 3_000,
    top10HolderPercent: 22,
    smartWalletNetFlowUsd: 8_500,
    priceChange5mPercent: 6.4,
    priceChange1hPercent: 14.1,
  }));
}

const alwaysBuy: Strategy = {
  name: 'always_buy',
  version: '1.0.0',
  evaluate: (market, ctx) => ({
    id: 's',
    tokenMint: market.tokenMint,
    strategy: 'always_buy',
    strategyVersion: '1.0.0',
    createdAt: Date.now(),
    side: 'BUY',
    score: 50,
    proposedAmountSol: Math.min(ctx.maxPositionSol, ctx.riskPerTradeSol),
    proposedSlippageBps: 100,
    proposedPriceImpactBps: 100,
    evidence: { marketSnapshot: market, indicators: {}, entryReason: 'always' },
  }),
};

const relaxedConfig = {
  ...defaultWalkForwardConfig,
  minTradesPerWindow: 0,
  minTradesTotal: 0,
};

describe('WalkForwardValidator (Rule 19)', () => {
  it('flags INSUFFICIENT_DATA when bars are too few', () => {
    const v = new WalkForwardValidator(alwaysBuy, relaxedConfig);
    const r = v.run(barsFromPrices([1, 1.01, 1.02]));
    expect(r.flags).toContain('INSUFFICIENT_DATA');
  });

  it('flags COST_INVALIDATED when all windows lose after costs', () => {
    const prices = Array.from({ length: 200 }, () => 1);
    const v = new WalkForwardValidator(alwaysBuy, relaxedConfig);
    const r = v.run(barsFromPrices(prices));
    expect(r.flags).toContain('COST_INVALIDATED');
  });

  it('flags EDGE_CONFIRMED when all windows are profitable and sample is sufficient', () => {
    // Steady uptrend that overwhelms fee+slippage.
    // Exponential path: each bar's return (2%) exceeds fee+slippage (0.5%) in every window.
    const prices = Array.from({ length: 400 }, (_, i) => Math.pow(1.02, i));
    const v = new WalkForwardValidator(alwaysBuy, {
      ...defaultWalkForwardConfig,
      minTradesPerWindow: 5,
      minTradesTotal: 20,
    });
    const r = v.run(barsFromPrices(prices));
    expect(r.flags).toContain('EDGE_CONFIRMED');
  });

  it('flags INSUFFICIENT_SAMPLE when profits exist but trade counts are too low', () => {
    // Small trending window: profitable but only a handful of trades.
    const prices = Array.from({ length: 100 }, (_, i) => 1 + i * 0.05);
    const v = new WalkForwardValidator(alwaysBuy, {
      ...defaultWalkForwardConfig,
      minTradesPerWindow: 100, // absurdly high threshold
      minTradesTotal: 1000,
    });
    const r = v.run(barsFromPrices(prices));
    expect(r.flags).toContain('INSUFFICIENT_SAMPLE');
    expect(r.flags).not.toContain('EDGE_CONFIRMED');
    expect(r.summary).toMatch(/Sample size/);
  });

  it('flags OVERFIT_TRAIN_ONLY when train wins but test loses', () => {
    const up = Array.from({ length: 80 }, (_, i) => 1 + i * 0.05);
    const flat = Array.from({ length: 40 }, () => up[up.length - 1]);
    const down = Array.from({ length: 80 }, (_, i) => flat[0] - i * 0.05);
    const prices = [...up, ...flat, ...down];
    const v = new WalkForwardValidator(alwaysBuy, relaxedConfig);
    const r = v.run(barsFromPrices(prices));
    expect(r.flags).toContain('OVERFIT_TRAIN_ONLY');
  });

  it('reports each window separately with its split label', () => {
    const prices = Array.from({ length: 200 }, (_, i) => Math.pow(1.02, i));
    const v = new WalkForwardValidator(alwaysBuy, relaxedConfig);
    const r = v.run(barsFromPrices(prices));
    expect(r.train.split).toBe('train');
    expect(r.validation.split).toBe('validation');
    expect(r.test.split).toBe('test');
    expect(r.train.bars + r.validation.bars + r.test.bars).toBe(199);
  });

  it('rejects invalid split fractions', () => {
    expect(() => new WalkForwardValidator(alwaysBuy, {
      ...defaultWalkForwardConfig,
      trainFraction: 0.9,
      validationFraction: 0.2,
    })).toThrow();
  });

  it('rejects negative min-trades config', () => {
    expect(() => new WalkForwardValidator(alwaysBuy, {
      ...defaultWalkForwardConfig,
      minTradesPerWindow: -1,
    })).toThrow();
  });

  it('does not modify the strategy between windows', () => {
    let evalCount = 0;
    const counting: Strategy = {
      name: 'counting',
      version: '1.0.0',
      evaluate: (market, ctx) => {
        evalCount += 1;
        return alwaysBuy.evaluate(market, ctx);
      },
    };
    const prices = Array.from({ length: 200 }, (_, i) => Math.pow(1.02, i));
    const v = new WalkForwardValidator(counting, relaxedConfig);
    v.run(barsFromPrices(prices));
    expect(evalCount).toBe(199);
  });
});
