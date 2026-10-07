import { StopConfig } from './types';

/** Preserved for synthetic-data runs (30-min hold, wide stops). */
export const syntheticStops: StopConfig = {
  hardStopPct: 0.15,
  trailingStopPct: 0.1,
  timeStopMs: 30 * 60 * 1000,
};

/**
 * Calibrated for real Solana memecoin 1-minute bars.
 * - 3% hard stop catches wrong entries without over-tightening for noise.
 * - 2% trailing stop locks in any modest run-up.
 * - 5-minute time stop forces resolution — no more 30-minute cost bleed.
 */
export const realDataStops: StopConfig = {
  hardStopPct: 0.03,
  trailingStopPct: 0.02,
  timeStopMs: 5 * 60 * 1000,
};

/**
 * Rule 30: pick the preset explicitly. Never mix them by accident.
 */
export function selectStops(mode: string | undefined): StopConfig {
  if (mode === 'synthetic') return syntheticStops;
  if (mode === 'real' || mode === undefined) return realDataStops;
  throw new Error(`Unknown STOPS_MODE: ${mode}. Use "real" or "synthetic".`);
}

/**
 * Rule 16: stop config is expressed in wall-clock ms, but its intent is
 * "hold N bars". The defaults were calibrated for 1m bars (5 min = 5 bars).
 * Scale timeStopMs so the hold is the same number of bars at other intervals,
 * otherwise on 5m bars a 5-min time stop fires on the very next bar and no
 * strategy can clear costs. Hard and trailing stops are already in percent,
 * so they are interval-agnostic.
 */
export function stopsForInterval(intervalMs: number): StopConfig {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`stopsForInterval: intervalMs must be > 0, got ${intervalMs}`);
  }
  const factor = intervalMs / 60_000;
  return {
    ...realDataStops,
    timeStopMs: realDataStops.timeStopMs
      ? Math.round(realDataStops.timeStopMs * factor)
      : undefined,
  };
}
