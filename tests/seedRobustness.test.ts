import { SeedRobustnessRunner } from '../src/backtest/seedRobustness';
import { defaultWalkForwardConfig } from '../src/backtest/walkForward';
import { PriceBar } from '../src/backtest/types';
import { Strategy } from '../src/strategy/types';

function risingBars(_seed: number, count: number): PriceBar[] {
  return Array.from({ length: count - 1 }, (_, i) => ({
    tokenMint: 'mint',
    fetchedAt: 1_700_000_000_000 + i * 60_000,
    priceUsd: Math.pow(1.02, i),
    nextPriceUsd: Math.pow(1.02, i + 1),
    liquidityUsd: 250_000,
    volume24hUsd: 1_000_000,
    holderCount: 3_000,
    top10HolderPercent: 22,
    smartWalletNetFlowUsd: 8_500,
    priceChange5mPercent: 6.4,
    priceChange1hPercent: 14.1,
  }));
}

function flatBars(_seed: number, count: number): PriceBar[] {
  return Array.from({ length: count - 1 }, (_, i) => ({
    tokenMint: 'mint',
    fetchedAt: 1_700_000_000_000 + i * 60_000,
    priceUsd: 1,
    nextPriceUsd: 1,
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
    score: 0,
    proposedAmountSol: Math.min(ctx.maxPositionSol, ctx.riskPerTradeSol),
    proposedSlippageBps: 100,
    proposedPriceImpactBps: 100,
    evidence: { marketSnapshot: market, indicators: {}, entryReason: 'always' },
  }),
};

const holdNothing: Strategy = {
  name: 'hold_nothing',
  version: '1.0.0',
  evaluate: () => null,
};

const relaxedCfg = {
  ...defaultWalkForwardConfig,
  minTradesPerWindow: 5,
  minTradesTotal: 20,
};

describe('SeedRobustnessRunner (Rule 19)', () => {
  it('rejects invalid requiredPassRate', () => {
    expect(() => new SeedRobustnessRunner(
      () => alwaysBuy, risingBars, relaxedCfg, -0.1,
    )).toThrow();
    expect(() => new SeedRobustnessRunner(
      () => alwaysBuy, risingBars, relaxedCfg, 1.1,
    )).toThrow();
  });

  it('reports NO_EDGE when a strategy fails on all seeds', () => {
    const r = new SeedRobustnessRunner(() => holdNothing, risingBars, relaxedCfg);
    const report = r.run({ seed: 0, bars: 200 }, [1, 2, 3, 4, 5]);
    expect(report.verdict).toBe('NO_EDGE');
    expect(report.passCount).toBe(0);
  });

  it('reports ROBUST when a strategy passes on all seeds', () => {
    const r = new SeedRobustnessRunner(() => alwaysBuy, risingBars, relaxedCfg, 0.7);
    const report = r.run({ seed: 0, bars: 200 }, [1, 2, 3, 4, 5]);
    expect(report.verdict).toBe('ROBUST');
    expect(report.passRate).toBe(1);
  });

  it('reports INSUFFICIENT_EVIDENCE when pass rate is below threshold but nonzero', () => {
    // Craft a mixed scenario: two different path builders.
    let i = 0;
    const alternating = (_seed: number, count: number): PriceBar[] => {
      i++;
      return i % 2 === 0 ? risingBars(_seed, count) : flatBars(_seed, count);
    };
    const r = new SeedRobustnessRunner(() => alwaysBuy, alternating, relaxedCfg, 0.9);
    const report = r.run({ seed: 0, bars: 200 }, [1, 2, 3, 4, 5, 6]);
    expect(report.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(report.passCount).toBeGreaterThan(0);
    expect(report.passCount).toBeLessThan(report.totalRuns);
  });
});

describe('WalkForwardValidator — NO_TRADES flag', () => {
  it('flags NO_TRADES when a strategy never enters', async () => {
    const { WalkForwardValidator } = await import('../src/backtest/walkForward');
    const v = new WalkForwardValidator(holdNothing, relaxedCfg);
    const report = v.run(risingBars(1, 200));
    expect(report.flags).toEqual(['NO_TRADES']);
    expect(report.summary).toMatch(/never entered/);
  });
});
