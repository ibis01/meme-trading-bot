import {
  ConstantSlippageModel,
  PoolAwareSlippageModel,
} from '../src/backtest/slippage';

describe('SlippageModel (Rule 18)', () => {
  describe('ConstantSlippageModel', () => {
    it('always returns the fixed rate', () => {
      const m = new ConstantSlippageModel(0.003);
      expect(m.compute({ amountSol: 0.1, solPriceUsd: 200, liquidityUsd: 1_000_000 })).toBe(0.003);
      expect(m.compute({ amountSol: 100, solPriceUsd: 200, liquidityUsd: 50_000 })).toBe(0.003);
    });
  });

  describe('PoolAwareSlippageModel', () => {
    it('rejects invalid params', () => {
      expect(() => new PoolAwareSlippageModel(-1)).toThrow();
      expect(() => new PoolAwareSlippageModel(50, 0)).toThrow();
    });

    it('returns 100% when liquidity is zero or negative', () => {
      const m = new PoolAwareSlippageModel();
      expect(m.compute({ amountSol: 0.1, solPriceUsd: 200, liquidityUsd: 0 })).toBe(1);
      expect(m.compute({ amountSol: 0.1, solPriceUsd: 200, liquidityUsd: -5 })).toBe(1);
    });

    it('charges base spread on tiny trades', () => {
      const m = new PoolAwareSlippageModel(50, 2);
      // $20 trade into $2M pool → 50 bps + ~0 bps = 0.005
      const rate = m.compute({ amountSol: 0.1, solPriceUsd: 200, liquidityUsd: 2_000_000 });
      expect(rate).toBeCloseTo(0.005, 4);
    });

    it('adds meaningful impact on medium trades', () => {
      const m = new PoolAwareSlippageModel(50, 2);
      // $200 trade into $200k pool → 50 bps + 20 bps = 70 bps
      const rate = m.compute({ amountSol: 1, solPriceUsd: 200, liquidityUsd: 200_000 });
      expect(rate).toBeCloseTo(0.007, 4);
    });

    it('charges huge slippage on large trades in thin pools', () => {
      const m = new PoolAwareSlippageModel(50, 2);
      // $2000 into $50k → 50 bps + 800 bps = 850 bps
      const rate = m.compute({ amountSol: 10, solPriceUsd: 200, liquidityUsd: 50_000 });
      expect(rate).toBeCloseTo(0.085, 4);
    });
  });
});
