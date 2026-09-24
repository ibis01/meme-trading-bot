import { PriceBar } from '../backtest/types';

export interface HistoryProvider {
  readonly name: string;
  /** Fetch bars for [fromMs, toMs) at the given interval. */
  fetchBars(tokenMint: string, fromMs: number, toMs: number, intervalMs: number): Promise<PriceBar[]>;
}

/** Fixture provider — cycles a fixed list of bars. */
export class FixtureHistoryProvider implements HistoryProvider {
  readonly name = 'fixture';
  constructor(private readonly bars: PriceBar[]) {}
  async fetchBars(): Promise<PriceBar[]> {
    return this.bars;
  }
}

export const INTERVAL_MS = {
  minute: 60_000,
  fiveMinute: 5 * 60_000,
} as const;
