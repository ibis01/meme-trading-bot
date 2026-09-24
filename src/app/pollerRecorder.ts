import { MarketDataProvider } from '../data/types';
import { BarStore } from '../state/bars';
import { logger } from '../utils/logger';
import { MarketSnapshot } from '../strategy/types';

export interface PollerRecorderDeps {
  provider: MarketDataProvider;
  store: BarStore;
  mints: string[];
  /** Delay between per-mint requests, ms. Free-tier APIs are rate-limited. */
  interRequestDelayMs?: number;
}

export interface PollerTickResult {
  mints: number;
  fetched: number;
  skipped: number;
  persisted: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls a provider for each mint sequentially with a delay between requests.
 * Rule 20: every captured snapshot is durable evidence.
 * Rule 24: dedupe handled by BarStore's (mint, bucket) uniqueness.
 * Rule 30: providers fail closed — skipped snapshots are never synthesized.
 */
export class PollerRecorder {
  private readonly delayMs: number;

  constructor(private readonly deps: PollerRecorderDeps) {
    this.delayMs = deps.interRequestDelayMs ?? 1200;
  }

  async captureOnce(): Promise<PollerTickResult> {
    const result: PollerTickResult = {
      mints: this.deps.mints.length,
      fetched: 0,
      skipped: 0,
      persisted: 0,
    };

    const snapshots: MarketSnapshot[] = [];
    for (let i = 0; i < this.deps.mints.length; i++) {
      const mint = this.deps.mints[i];
      const snap = await this.deps.provider.fetchSnapshot(mint);
      if (!snap) {
        result.skipped += 1;
      } else {
        result.fetched += 1;
        snapshots.push(snap);
      }
      // Throttle between requests (skip after last one).
      if (i < this.deps.mints.length - 1) await sleep(this.delayMs);
    }

    if (snapshots.length > 0) {
      const bars = snapshots.map((s) => ({ ...s, nextPriceUsd: 0 }));
      await this.deps.store.saveMany(bars);
      result.persisted = bars.length;
    }

    logger.info({ event: 'POLLER_TICK', ...result }, 'Poller tick complete');
    return result;
  }
}
