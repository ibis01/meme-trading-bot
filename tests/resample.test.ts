import { resampleBars } from '../src/backtest/resample';
import { PriceBar } from '../src/backtest/types';

function series(count: number, basePrice = 1, step = 0.001): PriceBar[] {
  const start = 1_700_000_000_000;
  return Array.from({ length: count }, (_, i) => ({
    tokenMint: 'mint',
    fetchedAt: start + i * 60_000,
    priceUsd: basePrice + i * step,
    nextPriceUsd: 0,
    liquidityUsd: 100_000,
    volume24hUsd: 1_000_000,
    holderCount: 3_000,
    top10HolderPercent: 20,
    priceChange5mPercent: 0,
    priceChange1hPercent: 0,
  }));
}

describe('resampleBars (Task 041)', () => {
  it('rejects target < source', () => {
    expect(() => resampleBars(series(10), 30_000, 60_000)).toThrow();
  });

  it('rejects non-multiple target', () => {
    expect(() => resampleBars(series(10), 90_000, 60_000)).toThrow();
  });

  it('returns empty on empty input', () => {
    expect(resampleBars([], 300_000, 60_000)).toEqual([]);
  });

  it('aggregates 5 × 1m bars into one 5m bar', () => {
    const out = resampleBars(series(10), 300_000, 60_000);
    expect(out).toHaveLength(2);
    // First 5m bar uses last sub-bar's close (index 4)
    expect(out[0].priceUsd).toBeCloseTo(1 + 4 * 0.001, 6);
    // Second 5m bar uses index 9
    expect(out[1].priceUsd).toBeCloseTo(1 + 9 * 0.001, 6);
  });

  it('preserves latest snapshot metadata in each group', () => {
    const bars = series(5);
    bars[4].liquidityUsd = 999;
    const out = resampleBars(bars, 300_000, 60_000);
    expect(out[0].liquidityUsd).toBe(999);
  });

  it('recomputes priceChange5m at 5m intervals (1 bar lookback)', () => {
    // 10 sub-bars, price 1.000 → 1.009, 5m closes at i=4 (1.004) and i=9 (1.009)
    const out = resampleBars(series(10), 300_000, 60_000);
    // First bar: no lookback → 0
    expect(out[0].priceChange5mPercent).toBe(0);
    // Second bar: 1 bar lookback → (1.009 - 1.004) / 1.004 * 100
    expect(out[1].priceChange5mPercent).toBeCloseTo(((1.009 - 1.004) / 1.004) * 100, 2);
  });

  it('handles 1h target from 1m source', () => {
    const out = resampleBars(series(120), 3_600_000, 60_000);
    expect(out).toHaveLength(2);
    expect(out[0].priceUsd).toBeCloseTo(1 + 59 * 0.001, 6);
  });

  it('sorts unordered input before resampling', () => {
    const bars = series(5);
    const shuffled = [bars[3], bars[0], bars[4], bars[1], bars[2]];
    const out = resampleBars(shuffled, 300_000, 60_000);
    expect(out).toHaveLength(1);
    // The "last" bar by time is bars[4] (price = 1 + 4 * 0.001)
    expect(out[0].priceUsd).toBeCloseTo(1 + 4 * 0.001, 6);
  });

  it('preserves undefined smartWalletNetFlowUsd', () => {
    const bars = series(5).map((b) => ({ ...b, smartWalletNetFlowUsd: undefined }));
    const out = resampleBars(bars, 300_000, 60_000);
    expect(out[0].smartWalletNetFlowUsd).toBeUndefined();
  });
});

describe('resampleBars time bucketing (30s recorded bars)', () => {
  const start = 1_700_000_000_000;
  const bar = (tMs: number, price: number): PriceBar => ({
    tokenMint: 'mint', fetchedAt: start + tMs, priceUsd: price, nextPriceUsd: 0,
    liquidityUsd: 1, volume24hUsd: 1, priceChange5mPercent: 0, priceChange1hPercent: 0,
  });

  it('30s bars into 1m buckets: last bar per minute', () => {
    const bars = [0, 30_000, 60_000, 90_000, 120_000, 150_000].map((t, i) => bar(t, 1 + i));
    const out = resampleBars(bars, 60_000, 30_000);
    expect(out.map((b) => b.priceUsd)).toEqual([2, 4, 6]);
  });

  it('a real-time gap yields no fabricated bars', () => {
    // bars at 0s, 30s, then a 10-minute gap, then 630s, 660s
    const bars = [bar(0, 1), bar(30_000, 2), bar(630_000, 3), bar(660_000, 4)];
    const out = resampleBars(bars, 300_000, 30_000);
    expect(out).toHaveLength(2); // buckets 0 and 2; bucket 1 stays empty
    expect(out.map((b) => b.priceUsd)).toEqual([2, 4]);
  });
});
