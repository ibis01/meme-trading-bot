import { MarketSnapshot } from '../strategy/types';
import { MarketDataProvider } from './types';

export interface MarketFeed {
  readonly name: string;
  /** Returns a batch of candidate snapshots to evaluate this tick. */
  next(): Promise<MarketSnapshot[]>;
}

/** Fixture feed: cycles through a fixed list. Used by paper/dev runs. */
export class FixtureFeed implements MarketFeed {
  readonly name = 'fixture';
  private cursor = 0;
  constructor(private readonly fixtures: MarketSnapshot[]) {}

  async next(): Promise<MarketSnapshot[]> {
    if (this.fixtures.length === 0) return [];
    const snap = this.fixtures[this.cursor % this.fixtures.length];
    this.cursor += 1;
    return [snap];
  }
}

/** Provider-backed feed: pulls the listed mints every tick. */
export class ProviderFeed implements MarketFeed {
  readonly name = 'provider';
  constructor(
    private readonly provider: MarketDataProvider,
    private readonly mints: string[],
  ) {}

  async next(): Promise<MarketSnapshot[]> {
    const results = await Promise.all(
      this.mints.map((m) => this.provider.fetchSnapshot(m)),
    );
    return results.filter((s): s is MarketSnapshot => s !== null);
  }
}
