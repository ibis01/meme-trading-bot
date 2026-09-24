import { MarketFeed } from '../data/feed';
import { BarStore } from '../state/bars';
import { logger } from '../utils/logger';

/**
 * Persists every snapshot seen by the feed as a bar.
 * Rule 20: evidence preserved. Rule 24: dedupe handled by store.
 */
export class BarRecorder {
  constructor(
    private readonly feed: MarketFeed,
    private readonly store: BarStore,
  ) {}

  async captureOnce(): Promise<number> {
    const snapshots = await this.feed.next();
    const bars = snapshots.map((s) => ({
      ...s,
      nextPriceUsd: 0, // recorder stores raw price; nextPrice is linked at read time
    }));
    await this.store.saveMany(bars);
    logger.info({ event: 'BARS_CAPTURED', count: bars.length }, 'Bars recorded');
    return bars.length;
  }
}
