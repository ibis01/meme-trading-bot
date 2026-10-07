import { TradableOnly } from '../src/backtest/tradable';
import { PoolAwareSlippageModel } from '../src/backtest/slippage';
import { AlwaysBuyStrategy } from '../src/strategy/baselines';
import { MarketSnapshot } from '../src/strategy/types';

const mk = (liquidityUsd: number): MarketSnapshot => ({
  tokenMint: 'm', fetchedAt: 1, priceUsd: 1, liquidityUsd, volume24hUsd: 1,
  priceChange5mPercent: 0, priceChange1hPercent: 0,
});
const ctx = { equitySol: 10, riskPerTradeSol: 0.1, maxPositionSol: 0.1 };
const opts = { minLiquidityUsd: 5000, maxEntrySlippageRate: 0.1, solPriceUsd: 200 };
const wrap = () => new TradableOnly(new AlwaysBuyStrategy(), new PoolAwareSlippageModel(50, 2), opts);

describe('TradableOnly (no phantom trades)', () => {
  it('keeps the inner strategy identity', () => {
    expect(wrap().name).toBe('ALWAYS_BUY');
  });
  it('allows entries into a liquid pool', () => {
    expect(wrap().evaluate(mk(100_000), ctx)).not.toBeNull();
  });
  it('rejects zero, unknown and tiny liquidity', () => {
    expect(wrap().evaluate(mk(0), ctx)).toBeNull();
    expect(wrap().evaluate(mk(NaN), ctx)).toBeNull();
    expect(wrap().evaluate(mk(1000), ctx)).toBeNull();
  });
  it('rejects entries whose modelled slippage is too high', () => {
    // $5,000 pool, 0.1 SOL ($20): slippage 0.5% + 2*20/5000 = 1.3% -> allowed.
    expect(wrap().evaluate(mk(5000), ctx)).not.toBeNull();
    // Tighter cap blocks the same entry.
    const strict = new TradableOnly(new AlwaysBuyStrategy(), new PoolAwareSlippageModel(50, 2), { ...opts, maxEntrySlippageRate: 0.01 });
    expect(strict.evaluate(mk(5000), ctx)).toBeNull();
  });
});
