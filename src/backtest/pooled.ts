export interface PooledOptions {
  /** Bootstrap resamples (tokens drawn with replacement). */
  bootstrap: number;
  /** Seed so results are reproducible. */
  seed: number;
  minTrades: number;
  minTokens: number;
}

export const DEFAULT_POOLED_OPTIONS: PooledOptions = {
  bootstrap: 2000,
  seed: 42,
  minTrades: 100,
  minTokens: 30,
};

export type PooledFlag = 'NO_TRADES' | 'INSUFFICIENT_SAMPLE' | 'NO_EDGE' | 'EDGE_CANDIDATE';

export interface Percentiles {
  p1: number; p5: number; p25: number; p50: number; p75: number; p95: number; p99: number;
}

export interface PooledStats {
  trades: number;
  tokens: number;
  meanReturnPct: number;
  /** Mean after clamping every trade to the 1st..99th percentile (outlier-robust). */
  winsorMeanPct: number;
  medianReturnPct: number;
  winRate: number;
  /** 95% intervals for the mean net return per trade, bootstrapped over TOKENS. */
  ciLowPct: number;
  ciHighPct: number;
  winsorCiLowPct: number;
  winsorCiHighPct: number;
  percentiles: Percentiles;
  flag: PooledFlag;
}

const ZERO_PCT: Percentiles = { p1: 0, p5: 0, p25: 0, p50: 0, p75: 0, p95: 0, p99: 0 };

/**
 * Rule 30: no data, no numbers. Returns NO_TRADES rather than zeros that look like results.
 *
 * Trades from the same token are correlated, so the bootstrap resamples whole
 * tokens (clusters), not individual trades.
 *
 * Memecoin returns are extremely heavy-tailed, so EDGE_CANDIDATE needs BOTH the
 * raw-mean interval AND the winsorized-mean interval to sit above zero. One
 * glitch or one lucky 100x cannot create an "edge".
 */
export function pooledStats(
  returnsByToken: Map<string, number[]>,
  opts: PooledOptions = DEFAULT_POOLED_OPTIONS,
): PooledStats {
  const groups = [...returnsByToken.values()].filter((g) => g.length > 0);
  const all = groups.flat();
  if (all.length === 0) {
    return {
      trades: 0, tokens: 0, meanReturnPct: 0, winsorMeanPct: 0, medianReturnPct: 0, winRate: 0,
      ciLowPct: 0, ciHighPct: 0, winsorCiLowPct: 0, winsorCiHighPct: 0, percentiles: ZERO_PCT, flag: 'NO_TRADES',
    };
  }

  const sorted = [...all].sort((a, c) => a - c);
  const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  const lo = pct(0.01);
  const hi = pct(0.99);
  const clamp = (x: number) => Math.min(hi, Math.max(lo, x));
  const wGroups = groups.map((g) => g.map(clamp));

  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const rand = mulberry32(opts.seed);
  const rawMeans: number[] = [];
  const winMeans: number[] = [];
  for (let b = 0; b < opts.bootstrap; b++) {
    let sum = 0;
    let wsum = 0;
    let n = 0;
    for (let k = 0; k < groups.length; k++) {
      const idx = Math.floor(rand() * groups.length);
      const g = groups[idx];
      const w = wGroups[idx];
      for (let t = 0; t < g.length; t++) { sum += g[t]; wsum += w[t]; }
      n += g.length;
    }
    rawMeans.push(sum / n);
    winMeans.push(wsum / n);
  }
  rawMeans.sort((a, c) => a - c);
  winMeans.sort((a, c) => a - c);
  const lowIdx = Math.floor(0.025 * (opts.bootstrap - 1));
  const highIdx = Math.ceil(0.975 * (opts.bootstrap - 1));

  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  const ciLowPct = rawMeans[lowIdx];
  const winsorCiLowPct = winMeans[lowIdx];
  let flag: PooledFlag;
  if (all.length < opts.minTrades || groups.length < opts.minTokens) flag = 'INSUFFICIENT_SAMPLE';
  else if (ciLowPct > 0 && winsorCiLowPct > 0) flag = 'EDGE_CANDIDATE';
  else flag = 'NO_EDGE';

  return {
    trades: all.length,
    tokens: groups.length,
    meanReturnPct: mean(all),
    winsorMeanPct: mean(wGroups.flat()),
    medianReturnPct: median,
    winRate: all.filter((x) => x > 0).length / all.length,
    ciLowPct,
    ciHighPct: rawMeans[highIdx],
    winsorCiLowPct,
    winsorCiHighPct: winMeans[highIdx],
    percentiles: { p1: lo, p5: pct(0.05), p25: pct(0.25), p50: pct(0.5), p75: pct(0.75), p95: pct(0.95), p99: hi },
    flag,
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
