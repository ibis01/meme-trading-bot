import { PriceBar } from './types';

export const INTERVAL_NAMES: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
};

/**
 * Rule 30: resamples only bars we already have. No network, no guessing.
 * Aggregates sub-interval bars into time buckets of the target interval.
 *
 * For each output bar:
 *   - fetchedAt          = last sub-bar's fetchedAt
 *   - priceUsd           = last sub-bar's close (a real observed price)
 *   - nextPriceUsd       = 0 (linkNextPrices fills on read)
 *   - liquidityUsd/…     = last sub-bar's value (most recent snapshot)
 *   - priceChange5m/1h   = recomputed from the resampled close path
 *
 * If the input interval doesn't evenly divide the target interval, throws.
 */
export function resampleBars(
  bars: PriceBar[],
  targetIntervalMs: number,
  sourceIntervalMs: number = 60_000,
): PriceBar[] {
  if (targetIntervalMs < sourceIntervalMs) {
    throw new Error(`Target interval (${targetIntervalMs}ms) smaller than source (${sourceIntervalMs}ms)`);
  }
  if (targetIntervalMs % sourceIntervalMs !== 0) {
    throw new Error(`Target interval must be a multiple of source interval`);
  }
  if (bars.length === 0) return [];

  const sorted = [...bars].sort((a, b) => a.fetchedAt - b.fetchedAt);

  // Bucket by TIME (relative to the first bar), not by count. Recorded bars
  // are 30s apart with possible gaps (sleep, outages); count-based grouping
  // would silently mislabel the interval. Empty buckets are skipped, never
  // filled (Rule 30).
  const t0 = sorted[0].fetchedAt;
  const buckets = new Map<number, PriceBar>();
  for (const bar of sorted) {
    buckets.set(Math.floor((bar.fetchedAt - t0) / targetIntervalMs), bar);
  }

  const resampled: PriceBar[] = [];
  for (const idx of [...buckets.keys()].sort((x, y) => x - y)) {
    // Last sub-bar in the bucket — most recent observation.
    const last = buckets.get(idx) as PriceBar;

    resampled.push({
      tokenMint: last.tokenMint,
      fetchedAt: last.fetchedAt,
      priceUsd: last.priceUsd,
      nextPriceUsd: 0,
      liquidityUsd: last.liquidityUsd,
      volume24hUsd: last.volume24hUsd,
      holderCount: last.holderCount,
      top10HolderPercent: last.top10HolderPercent,
      // Preserve undefined vs 0 distinction.
      smartWalletNetFlowUsd: last.smartWalletNetFlowUsd,
      // Recompute below.
      priceChange5mPercent: 0,
      priceChange1hPercent: 0,
    });
  }

  // Recompute price-change indicators from the resampled close path.
  // Windows are measured in TIME, not bar count: after a recording gap the
  // look-back must not reach across the gap, or a stale price from hours ago
  // would be reported as a 1h move (fake momentum). Bars with no earlier bar
  // inside the window get 0, same as the start of the series.
  const slack = targetIntervalMs / 2;
  return resampled.map((b, i) => ({
    ...b,
    priceChange5mPercent: pctChangeByTime(resampled, i, 5 * 60_000 + slack),
    priceChange1hPercent: pctChangeByTime(resampled, i, 60 * 60_000 + slack),
  }));
}

function pctChangeByTime(bars: PriceBar[], i: number, windowMs: number): number {
  let from = i;
  while (from > 0 && bars[i].fetchedAt - bars[from - 1].fetchedAt <= windowMs) from--;
  if (from === i) return 0;
  const base = bars[from].priceUsd;
  if (base === 0) return 0;
  return ((bars[i].priceUsd - base) / base) * 100;
}
