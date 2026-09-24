import { WalkForwardValidator, defaultWalkForwardConfig } from '../src/backtest/walkForward';
import { PoolAwareSlippageModel } from '../src/backtest/slippage';
import { PriceBar } from '../src/backtest/types';
import { Strategy } from '../src/strategy/types';

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

function bars(liquidityUsd: number): PriceBar[] {
  const n = 300;
  return Array.from({ length: n - 1 }, (_, i) => ({
    tokenMint: 'mint',
    fetchedAt: 1_700_000_000_000 + i * 60_000,
    priceUsd: 1 + i * 0.001,
    nextPriceUsd: 1 + (i + 1) * 0.001,
    liquidityUsd,
    volume24hUsd: 1_000_000,
    holderCount: 3_000,
    top10HolderPercent: 22,
    smartWalletNetFlowUsd: 8_500,
    priceChange5mPercent: 6.4,
    priceChange1hPercent: 14.1,
  }));
}

const relaxed = {
  ...defaultWalkForwardConfig,
  minTradesPerWindow: 0,
  minTradesTotal: 0,
};

describe('WalkForwardValidator + SlippageModel (Rule 18)', () => {
  it('passes slippageModel through to the backtester', () => {
    const poolAware = new PoolAwareSlippageModel(50, 2);
    const v = new WalkForwardValidator(alwaysBuy, { ...relaxed, slippageModel: poolAware });
    const r = v.run(bars(50_000)); // thin pool → high slippage
    // With pool-aware slippage on $50k pool, returns should be materially worse.
    expect(r.train.metrics.slippagePaidSol).toBeGreaterThan(0);
  });

  it('produces different results with constant vs pool-aware on the same bars', () => {
    const thin = bars(50_000);
    const constantResult = new WalkForwardValidator(alwaysBuy, relaxed).run(thin);
    const poolResult = new WalkForwardValidator(alwaysBuy, {
      ...relaxed,
      slippageModel: new PoolAwareSlippageModel(50, 2),
    }).run(thin);

    // Pool-aware must charge more slippage in a thin pool.
    expect(poolResult.train.metrics.slippagePaidSol).toBeGreaterThan(
      constantResult.train.metrics.slippagePaidSol,
    );
  });
});
