import { MomentumStrategy, syntheticMomentumConfig } from '../src/strategy/momentum';
import { MarketSnapshot, StrategyContext } from '../src/strategy/types';

const ctx: StrategyContext = {
  equitySol: 10,
  riskPerTradeSol: 0.1,
  maxPositionSol: 0.1,
};

const baseMarket = (o: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  tokenMint: 'mint',
  fetchedAt: Date.now(),
  priceUsd: 0.001,
  liquidityUsd: 100_000,
  volume24hUsd: 500_000,
  holderCount: 1000,
  top10HolderPercent: 20,
  smartWalletNetFlowUsd: 5000,
  priceChange5mPercent: 5,
  priceChange1hPercent: 10,
  ...o,
});

describe('MomentumStrategy (Rule 28 — deterministic)', () => {
  const strategy = new MomentumStrategy(syntheticMomentumConfig);

  it('produces a signal on strong momentum + smart flow', () => {
    const s = strategy.evaluate(baseMarket(), ctx);
    expect(s).not.toBeNull();
    expect(s!.side).toBe('BUY');
    expect(s!.strategy).toBe('MEME_MOMENTUM_V1');
  });

  it('returns null when 5m change is too small', () => {
    expect(strategy.evaluate(baseMarket({ priceChange5mPercent: 1 }), ctx)).toBeNull();
  });

  it('returns null when 1h change is too small', () => {
    expect(strategy.evaluate(baseMarket({ priceChange1hPercent: 1 }), ctx)).toBeNull();
  });

  it('returns null when smart wallet flow is negative (required positive)', () => {
    expect(strategy.evaluate(baseMarket({ smartWalletNetFlowUsd: -100 }), ctx)).toBeNull();
  });

  it('caps position size at maxPositionSol', () => {
    const s = strategy.evaluate(baseMarket(), { ...ctx, maxPositionSol: 0.02 });
    expect(s!.proposedAmountSol).toBeLessThanOrEqual(0.02);
  });

  it('is deterministic — same input, same score/evidence', () => {
    const a = strategy.evaluate(baseMarket(), ctx)!;
    const b = strategy.evaluate(baseMarket(), ctx)!;
    expect(a.score).toBe(b.score);
    expect(a.proposedAmountSol).toBeCloseTo(b.proposedAmountSol, 10);
    expect(a.evidence.entryReason).toBe(b.evidence.entryReason);
  });

  it('never returns a signal without entry evidence', () => {
    const s = strategy.evaluate(baseMarket(), ctx)!;
    expect(s.evidence.entryReason.length).toBeGreaterThan(0);
    expect(s.evidence.marketSnapshot.tokenMint).toBe('mint');
  });

  it('score is bounded 0..100', () => {
    const s = strategy.evaluate(
      baseMarket({ priceChange5mPercent: 100, priceChange1hPercent: 500, smartWalletNetFlowUsd: 1e9 }),
      ctx,
    )!;
    expect(s.score).toBeLessThanOrEqual(100);
    expect(s.score).toBeGreaterThanOrEqual(0);
  });
});
