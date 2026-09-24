import {
  HoldNothingStrategy,
  AlwaysBuyStrategy,
  SeededRandomStrategy,
} from '../src/strategy/baselines';
import { MarketSnapshot, StrategyContext } from '../src/strategy/types';

const market: MarketSnapshot = {
  tokenMint: 'mint',
  fetchedAt: Date.now(),
  priceUsd: 0.001,
  liquidityUsd: 200_000,
  volume24hUsd: 1_000_000,
  holderCount: 3_000,
  top10HolderPercent: 22,
  smartWalletNetFlowUsd: 5_000,
  priceChange5mPercent: 6.4,
  priceChange1hPercent: 12.0,
};

const ctx: StrategyContext = { equitySol: 10, riskPerTradeSol: 0.1, maxPositionSol: 0.1 };

describe('Baseline strategies (Rule 18)', () => {
  it('HoldNothing never produces a signal', () => {
    const s = new HoldNothingStrategy();
    expect(s.evaluate()).toBeNull();
  });

  it('AlwaysBuy always produces a signal', () => {
    const s = new AlwaysBuyStrategy(0.1);
    const sig = s.evaluate(market, ctx);
    expect(sig).not.toBeNull();
    expect(sig!.proposedAmountSol).toBe(0.1);
  });

  it('AlwaysBuy respects maxPositionSol', () => {
    const s = new AlwaysBuyStrategy(1.0);
    const sig = s.evaluate(market, { ...ctx, maxPositionSol: 0.05 });
    expect(sig!.proposedAmountSol).toBe(0.05);
  });

  it('SeededRandom is deterministic for the same seed', () => {
    const a = new SeededRandomStrategy(42, 0.5, 0.1);
    const b = new SeededRandomStrategy(42, 0.5, 0.1);
    const seqA = Array.from({ length: 50 }, () => a.evaluate(market, ctx) !== null);
    const seqB = Array.from({ length: 50 }, () => b.evaluate(market, ctx) !== null);
    expect(seqA).toEqual(seqB);
  });

  it('SeededRandom differs across seeds', () => {
    const a = new SeededRandomStrategy(1, 0.5, 0.1);
    const b = new SeededRandomStrategy(2, 0.5, 0.1);
    const seqA = Array.from({ length: 50 }, () => a.evaluate(market, ctx) !== null);
    const seqB = Array.from({ length: 50 }, () => b.evaluate(market, ctx) !== null);
    expect(seqA).not.toEqual(seqB);
  });

  it('SeededRandom with p=0 never enters', () => {
    const s = new SeededRandomStrategy(1, 0, 0.1);
    const seq = Array.from({ length: 100 }, () => s.evaluate(market, ctx));
    expect(seq.every((x) => x === null)).toBe(true);
  });

  it('SeededRandom with p=1 always enters', () => {
    const s = new SeededRandomStrategy(1, 1, 0.1);
    const seq = Array.from({ length: 100 }, () => s.evaluate(market, ctx));
    expect(seq.every((x) => x !== null)).toBe(true);
  });

  it('SeededRandom rejects invalid probability', () => {
    expect(() => new SeededRandomStrategy(1, -0.1)).toThrow();
    expect(() => new SeededRandomStrategy(1, 1.1)).toThrow();
  });
});
