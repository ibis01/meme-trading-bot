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
