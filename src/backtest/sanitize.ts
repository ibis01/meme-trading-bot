import { PriceBar } from './types';

export interface SpikeFilterOptions {
  /** A bar is an outlier if its price is more than this factor above/below the baseline. */
  factor: number;
  /** A run of outliers is a data glitch only if price returns to normal within this time. */
  maxRunMs: number;
}

export const DEFAULT_SPIKE_FILTER: SpikeFilterOptions = {
  factor: 50,
  maxRunMs: 30 * 60_000,
};

export interface SpikeFilterResult {
  bars: PriceBar[];
  dropped: number;
}

/**
 * Rule 30: removes data glitches, never invents data.
 *
 * Drops runs of bars whose price jumps by more than `factor` versus the last
 * accepted price AND then returns to normal within `maxRunMs` (e.g. an
 * aggregator briefly reporting a wrong pair: 0.0000038 -> 0.06 -> 0.0000038).
 * A jump that does NOT revert is treated as a genuine regime shift and kept.
 * Moves that are continuous (each bar within `factor` of the previous accepted
 * bar) are never touched, so real pumps and dumps are preserved.
 */
export function dropRevertingSpikes(
  input: PriceBar[],
  opts: SpikeFilterOptions = DEFAULT_SPIKE_FILTER,
): SpikeFilterResult {
  if (input.length < 3) return { bars: input, dropped: 0 };

  const bars = [...input].sort((a, b) => a.fetchedAt - b.fetchedAt);
  const isNormal = (price: number, base: number): boolean =>
    base > 0 && price > 0 && price / base <= opts.factor && base / price <= opts.factor;

  let baseline = median(bars.slice(0, Math.min(7, bars.length)).map((b) => b.priceUsd));
  const out: PriceBar[] = [];
  let dropped = 0;
  let i = 0;

  while (i < bars.length) {
    if (isNormal(bars[i].priceUsd, baseline)) {
      out.push(bars[i]);
      baseline = bars[i].priceUsd;
      i++;
      continue;
    }

    // Candidate glitch: consecutive outliers versus the baseline.
    let j = i;
    while (
      j < bars.length &&
      !isNormal(bars[j].priceUsd, baseline) &&
      bars[j].fetchedAt - bars[i].fetchedAt <= opts.maxRunMs
    ) {
      j++;
    }

    const reverted =
      j < bars.length &&
      isNormal(bars[j].priceUsd, baseline) &&
      bars[j].fetchedAt - bars[i].fetchedAt <= opts.maxRunMs;

    if (reverted) {
      dropped += j - i;
      i = j;
    } else {
      // No revert: genuine level change. Keep and re-baseline.
      out.push(bars[i]);
      baseline = bars[i].priceUsd;
      i++;
    }
  }

  return { bars: out, dropped };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
