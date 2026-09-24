import { MeanReversionStrategy, defaultMeanReversionConfig } from '../src/strategy/meanReversion';
import { MarketSnapshot, StrategyContext } from '../src/strategy/types';

const ctx: StrategyContext = { equitySol: 10, riskPerTradeSol: 0.1, maxPositionSol: 0.1 };

const market = (o: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  tokenMint: 'mint', fetchedAt: Date.now(), priceUsd: 0.001,
  liquidityUsd: 200_000, volume24hUsd: 1_000_000, holderCount: 3_000,
  top10HolderPercent: 22, smartWalletNetFlowUsd: 5_000,
  priceChange5mPercent: 0, priceChange1hPercent: 0, ...o,
});

describe('MeanReversionStrategy', () => {
  const s = new MeanReversionStrategy(defaultMeanReversionConfig);

  it('fires on a sharp dip', () => {
    expect(s.evaluate(market({ priceChange5mPercent: -0.5, priceChange1hPercent: -1 }), ctx)).not.toBeNull();
  });

  it('does not fire on flat price', () => {
    expect(s.evaluate(market({ priceChange5mPercent: 0, priceChange1hPercent: 0 }), ctx)).toBeNull();
  });

  it('does not fire on an up move', () => {
    expect(s.evaluate(market({ priceChange5mPercent: 1, priceChange1hPercent: 2 }), ctx)).toBeNull();
  });

  it('requires BOTH conditions', () => {
    expect(s.evaluate(market({ priceChange5mPercent: -0.5, priceChange1hPercent: 0 }), ctx)).toBeNull();
  });
});
