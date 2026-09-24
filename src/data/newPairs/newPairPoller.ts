import { NewPairSource, NewPairEvent } from './types';
import { logger } from '../../utils/logger';

export interface NewPairPollerOptions {
  intervalMs: number;
  /** Don't re-emit events detected more than this long ago. */
  maxAgeMs: number;
}

export type NewPairHandler = (event: NewPairEvent) => void | Promise<void>;

/**
 * Long-lived poller. Every tick:
 *   1. Call source.fetchNew(sinceMs).
 *   2. Dedup on tokenMint.
 *   3. Emit to handlers.
 *   4. Advance `sinceMs`.
 *
 * Never overlaps ticks. Never crashes on source errors.
 */
export class NewPairPoller {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;
  private stopping = false;
  private sinceMs: number;
  private readonly seen = new Set<string>();
  private readonly seenCap = 5000;
  private handlers: NewPairHandler[] = [];

  constructor(
    private readonly source: NewPairSource,
    private readonly opts: NewPairPollerOptions,
  ) {
    this.sinceMs = Date.now() - opts.maxAgeMs;
  }

  onEvent(handler: NewPairHandler): () => void {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter((h) => h !== handler); };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inFlight) {
        logger.warn({ event: 'NEW_PAIR_TICK_SKIPPED_OVERLAP' }, 'Previous tick still running');
        return;
      }
      this.inFlight = this.tick()
        .catch((err) => logger.error({ event: 'NEW_PAIR_TICK_ERROR', err }, 'Tick failed'))
        .finally(() => { this.inFlight = null; });
    }, this.opts.intervalMs);
    logger.info(
      { source: this.source.name, intervalMs: this.opts.intervalMs },
      'NewPairPoller started',
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight) await this.inFlight;
    logger.info({ event: 'NEW_PAIR_POLLER_STOPPED' }, 'NewPairPoller stopped');
  }

  /** Manual tick — used by tests and the CLI. */
  async tick(): Promise<{ fetched: number; emitted: number }> {
    const events = await this.source.fetchNew(this.sinceMs);
    let emitted = 0;

    for (const ev of events) {
      if (this.stopping) break;
      if (this.seen.has(ev.tokenMint)) continue;
      if (this.seen.size >= this.seenCap) this.seen.clear();
      this.seen.add(ev.tokenMint);

      for (const h of this.handlers) {
        Promise.resolve()
          .then(() => h(ev))
          .catch((err) => logger.error({ event: 'NEW_PAIR_HANDLER_ERROR', err }, 'Handler threw'));
      }
      emitted += 1;
      if (ev.detectedAt > this.sinceMs) this.sinceMs = ev.detectedAt;
    }

    return { fetched: events.length, emitted };
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  currentSinceMs(): number {
    return this.sinceMs;
  }
}
