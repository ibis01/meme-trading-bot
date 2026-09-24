import { computeFeeFloor } from '../src/backtest/feeFloor';
import { PriceBar } from '../src/backtest/types';

function bars(prices: number[]): PriceBar[] {
  return prices.slice(0, -1).map((p, i) => ({
    tokenMint: 'm',
    fetchedAt: 1_700_000_000_000 + i * 60_000,
    priceUsd: p,
    nextPriceUsd: prices[i + 1],
    liquidityUsd: 100_000, volume24hUsd: 1_000, holderCount: 100,
    top10HolderPercent: 10, priceChange5mPercent: 0, priceChange1hPercent: 0,
  }));
}

describe('computeFeeFloor (Rule 18)', () => {
  it('returns zeroed report when not enough bars', () => {
    const r = computeFeeFloor(bars([1, 1.01]), 5, 0.002, 0.003);
    expect(r.samples).toBe(0);
  });

  it('reports break-even = (fee + slippage) * 2 in percent', () => {
    const prices = Array.from({ length: 50 }, () => 1);
    const r = computeFeeFloor(bars(prices), 5, 0.002, 0.003);
    // (0.002 + 0.003) * 2 * 100 = 1.0%
    expect(r.breakEvenPct).toBeCloseTo(1.0, 6);
  });

  it('fractionAboveBreakEven is low for low-volatility data', () => {
    const prices = Array.from({ length: 200 }, (_, i) => 1 + Math.sin(i / 10) * 0.001);
    const r = computeFeeFloor(bars(prices), 5, 0.002, 0.003);
    expect(r.fractionAboveBreakEven).toBeLessThan(0.05);
  });

  it('expectedUpsidePct is negative when volatility is below break-even', () => {
    const prices = Array.from({ length: 200 }, (_, i) => 1 + Math.sin(i / 10) * 0.001);
    const r = computeFeeFloor(bars(prices), 5, 0.002, 0.003);
    expect(r.expectedUpsidePct).toBeLessThan(0);
  });
});
