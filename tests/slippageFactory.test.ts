import { selectSlippageModel } from '../src/backtest/slippageFactory';
import { ConstantSlippageModel, PoolAwareSlippageModel } from '../src/backtest/slippage';

describe('selectSlippageModel (Rule 18)', () => {
  const ctx = { amountSol: 5, solPriceUsd: 200, liquidityUsd: 50_000 };

  it('returns ConstantSlippageModel for undefined', () => {
    const m = selectSlippageModel(undefined, 0.003);
    expect(m).toBeInstanceOf(ConstantSlippageModel);
    expect(m.compute(ctx)).toBe(0.003);
  });

  it('returns ConstantSlippageModel for "constant"', () => {
    const m = selectSlippageModel('constant', 0.003);
    expect(m).toBeInstanceOf(ConstantSlippageModel);
  });

  it('returns PoolAwareSlippageModel for "pool-aware"', () => {
    const m = selectSlippageModel('pool-aware', 0.003);
    expect(m).toBeInstanceOf(PoolAwareSlippageModel);
    // $1000 into $50k pool → 50 bps + 400 bps = 450 bps
    expect(m.compute(ctx)).toBeCloseTo(0.045, 4);
  });

  it('falls back to constant for unknown values', () => {
    const m = selectSlippageModel('unknown-mode', 0.003);
    expect(m).toBeInstanceOf(ConstantSlippageModel);
  });
});
