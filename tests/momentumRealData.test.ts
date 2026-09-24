import {
  MomentumStrategy,
  defaultMomentumConfig,
  syntheticMomentumConfig,
} from '../src/strategy/momentum';
import { MarketSnapshot, StrategyContext } from '../src/strategy/types';

const ctx: StrategyContext = {
  equitySol: 10,
  riskPerTradeSol: 0.1,
  maxPositionSol: 0.1,
};

const market = (o: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  tokenMint: 'mint',
  fetchedAt: Date.now(),
  priceUsd: 0.001,
  liquidityUsd: 200_000,
  volume24hUsd: 1_000_000,
  holderCount: 3_000,
  top10HolderPercent: 22,
  smartWalletNetFlowUsd: 5_000,
  priceChange5mPercent: 6.4,
  priceChange1hPercent: 12,
  ...o,
});

describe('MomentumStrategy config presets', () => {
  it('default config calibrated for real data fires on 0.6% / 1.2% moves', () => {
    const s = new MomentumStrategy(defaultMomentumConfig);
    const sig = s.evaluate(market({ priceChange5mPercent: 0.6, priceChange1hPercent: 1.2 }), ctx);
    expect(sig).not.toBeNull();
  });

  it('default config does NOT fire on 0.4% / 0.5% moves', () => {
    const s = new MomentumStrategy(defaultMomentumConfig);
    const sig = s.evaluate(market({ priceChange5mPercent: 0.4, priceChange1hPercent: 0.5 }), ctx);
    expect(sig).toBeNull();
  });

  it('default config does not require smart-wallet flow when undefined', () => {
    const s = new MomentumStrategy(defaultMomentumConfig);
    const sig = s.evaluate(
      market({ priceChange5mPercent: 1, priceChange1hPercent: 2, smartWalletNetFlowUsd: undefined }),
      ctx,
    );
    expect(sig).not.toBeNull();
    expect(sig!.evidence.entryReason).not.toContain('flow');
  });

  it('synthetic config preserves the old thresholds', () => {
    const s = new MomentumStrategy(syntheticMomentumConfig);
    expect(s.evaluate(market({ priceChange5mPercent: 1 }), ctx)).toBeNull();
    expect(s.evaluate(market({ priceChange5mPercent: 3, priceChange1hPercent: 5 }), ctx)).not.toBeNull();
  });

  it('strategy version bumped to 1.1.0', () => {
    const s = new MomentumStrategy(defaultMomentumConfig);
    expect(s.version).toBe('1.1.0');
  });
});
