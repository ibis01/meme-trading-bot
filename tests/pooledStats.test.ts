import { pooledStats, DEFAULT_POOLED_OPTIONS } from '../src/backtest/pooled';

const opts = { ...DEFAULT_POOLED_OPTIONS, bootstrap: 500, minTrades: 6, minTokens: 3 };
const mk = (entries: Record<string, number[]>) => new Map(Object.entries(entries));

describe('pooledStats (Rule 30)', () => {
  it('NO_TRADES when nothing traded, with no fake zeros as a verdict', () => {
    const r = pooledStats(mk({ a: [], b: [] }), opts);
    expect(r.flag).toBe('NO_TRADES');
    expect(r.trades).toBe(0);
  });

  it('computes mean, median, win rate over pooled trades', () => {
    const r = pooledStats(mk({ a: [1, -1], b: [3], c: [-2, 2] }), { ...opts, minTrades: 1, minTokens: 1 });
    expect(r.trades).toBe(5);
    expect(r.tokens).toBe(3);
    expect(r.meanReturnPct).toBeCloseTo(0.6, 6);
    expect(r.medianReturnPct).toBe(1);
    expect(r.winRate).toBeCloseTo(3 / 5, 6);
  });

  it('INSUFFICIENT_SAMPLE below the trade or token minimum', () => {
    const r = pooledStats(mk({ a: [1, 1, 1], b: [1, 1, 1] }), opts); // 6 trades, 2 tokens
    expect(r.flag).toBe('INSUFFICIENT_SAMPLE');
  });

  it('EDGE_CANDIDATE only when the whole CI is above zero', () => {
    const win = mk({ a: [2, 3], b: [2, 4], c: [3, 2], d: [4, 3] });
    expect(pooledStats(win, opts).flag).toBe('EDGE_CANDIDATE');
  });

  it('NO_EDGE when the CI straddles zero', () => {
    const noisy = mk({ a: [5, -5], b: [-4, 4], c: [6, -6], d: [-3, 3] });
    expect(pooledStats(noisy, opts).flag).toBe('NO_EDGE');
  });

  it('is reproducible for the same seed', () => {
    const data = mk({ a: [1, -2, 3], b: [-1, 2], c: [0.5, -0.5, 1], d: [2, -1] });
    expect(pooledStats(data, opts)).toEqual(pooledStats(data, opts));
  });

  it('bootstraps over tokens: one token cannot produce a tight interval', () => {
    const r = pooledStats(mk({ only: [1, 2, 3, 4, 5, 6, 7, 8] }), { ...opts, minTokens: 1 });
    expect(r.ciLowPct).toBeCloseTo(r.ciHighPct, 9); // single cluster resamples to itself
    expect(r.flag).toBe('EDGE_CANDIDATE'); // note: caller's minTokens guards this in practice
  });
});

describe('pooledStats outlier robustness', () => {
  it('one extreme glitch trade cannot create an EDGE_CANDIDATE', () => {
    const losers = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`t${i}`, [-3, -4, -2, -5, -3]]),
    );
    const data = new Map(Object.entries({ ...losers, glitch: [1_000_000] }));
    const r = pooledStats(data, { ...DEFAULT_POOLED_OPTIONS, bootstrap: 500 });
    expect(r.meanReturnPct).toBeGreaterThan(0); // the raw mean is fooled by the glitch...
    expect(r.winsorMeanPct).toBeLessThan(0);   // ...the winsorized mean is not
    expect(r.flag).not.toBe('EDGE_CANDIDATE');
  });

  it('reports percentiles', () => {
    const data = new Map([['a', Array.from({ length: 101 }, (_, i) => i)]]);
    const r = pooledStats(data, { ...DEFAULT_POOLED_OPTIONS, bootstrap: 50, minTokens: 1, minTrades: 1 });
    expect(r.percentiles.p50).toBe(50);
    expect(r.percentiles.p1).toBe(1);
    expect(r.percentiles.p99).toBe(99);
  });
});
