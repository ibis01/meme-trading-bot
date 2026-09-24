import { PriceBar } from './types';

export const INTERVAL_NAMES: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
};

/**
 * Rule 30: resamples only bars we already have. No network, no guessing.
 * Aggregates N consecutive sub-interval bars into one target-interval bar.
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

  const groupSize = targetIntervalMs / sourceIntervalMs;
  const sorted = [...bars].sort((a, b) => a.fetchedAt - b.fetchedAt);

  const resampled: PriceBar[] = [];
  for (let i = 0; i < sorted.length; i += groupSize) {
    const slice = sorted.slice(i, i + groupSize);
    if (slice.length === 0) continue;

    // Use the last sub-bar's snapshot — most recent observation.
    const last = slice[slice.length - 1];

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
  const prices = resampled.map((b) => b.priceUsd);
  const lookback5m = Math.max(1, Math.round(5 * 60_000 / targetIntervalMs));
  const lookback1h = Math.max(1, Math.round(60 * 60_000 / targetIntervalMs));

  return resampled.map((b, i) => ({
    ...b,
    priceChange5mPercent: pctChange(prices, i, lookback5m),
    priceChange1hPercent: pctChange(prices, i, lookback1h),
  }));
}

function pctChange(prices: number[], i: number, lookback: number): number {
  const from = Math.max(0, i - lookback);
  if (i === from) return 0;
  const base = prices[from];
  if (base === 0) return 0;
  return ((prices[i] - base) / base) * 100;
}
