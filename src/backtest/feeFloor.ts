import { PriceBar } from './types';

export interface FeeFloorReport {
  samples: number;
  /** Percentiles of the absolute price change over a `holdBars` horizon. */
  p50AbsChangePct: number;
  p90AbsChangePct: number;
  p99AbsChangePct: number;
  /** Minimum move required to break even after fees + slippage. */
  breakEvenPct: number;
  /** Fraction of sampled windows whose absolute move exceeds break-even. */
  fractionAboveBreakEven: number;
  /** If a trade fires only on a subset, what's the effective upside rate? */
  expectedUpsidePct: number;
}

/**
 * Rule 18: before running a strategy on real bars, ask whether it's even
 * mathematically capable of profit. If the p99 of price moves is below the
 * break-even threshold, no entry rule can produce positive expectancy.
 */
export function computeFeeFloor(
  bars: PriceBar[],
  holdBars: number,
  feeRate: number,
  slippageRate: number,
): FeeFloorReport {
  if (bars.length < holdBars + 1) {
    return {
      samples: 0,
      p50AbsChangePct: 0,
      p90AbsChangePct: 0,
      p99AbsChangePct: 0,
      breakEvenPct: 0,
      fractionAboveBreakEven: 0,
      expectedUpsidePct: 0,
    };
  }

  const moves: number[] = [];
  for (let i = 0; i + holdBars < bars.length; i++) {
    const entry = bars[i].priceUsd;
    const exit = bars[i + holdBars].priceUsd;
    if (entry > 0) moves.push(Math.abs((exit - entry) / entry) * 100);
  }

  // Round-trip cost as a percent of notional.
  const breakEvenPct = (feeRate + slippageRate) * 2 * 100;

  moves.sort((a, b) => a - b);
  const pct = (p: number) => moves[Math.min(moves.length - 1, Math.floor(moves.length * p))] ?? 0;

  const above = moves.filter((m) => m >= breakEvenPct).length;
  const fractionAboveBreakEven = moves.length > 0 ? above / moves.length : 0;

  // For random entry, upside minus downside is symmetric on average.
  // Expected return per trade = avg(change) - costs, which for zero-drift
  // data averages to -breakEvenPct. The useful number is:
  //   fractionAboveBreakEven × avgUpsideExcess - (1 - fraction) × avgDownsideExcess
  const upsides = moves.filter((m) => m >= breakEvenPct);
  const avgUpsideExcess =
    upsides.length > 0 ? upsides.reduce((s, m) => s + (m - breakEvenPct), 0) / upsides.length : 0;
  const expectedUpsidePct = fractionAboveBreakEven * avgUpsideExcess - (1 - fractionAboveBreakEven) * breakEvenPct;

  return {
    samples: moves.length,
    p50AbsChangePct: pct(0.5),
    p90AbsChangePct: pct(0.9),
    p99AbsChangePct: pct(0.99),
    breakEvenPct,
    fractionAboveBreakEven,
    expectedUpsidePct,
  };
}
