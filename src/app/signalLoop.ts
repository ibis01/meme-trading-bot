import { SignalLoopDeps, SignalLoopOptions, TickResult } from './signalLoopTypes';
import { logger } from '../utils/logger';

export * from './signalLoopTypes';

/**
 * Long-lived loop:
 *   feed.next() → for each snapshot → strategy.evaluate → orchestrator → (if APPROVED) executor
 *
 * Rules honored:
 *  - Rule 5: no code path can jump from feed directly to execution.
 *  - Rule 22: every tick emits structured logs.
 *  - Rule 24: in-flight guard prevents overlapping ticks.
 *  - Rule 34: uses whatever executor the caller injected (paper by default).
 */
export class SignalLoop {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;
  private stopping = false;

  constructor(
    private readonly deps: SignalLoopDeps,
    private readonly opts: SignalLoopOptions,
  ) {}

  async runOnce(): Promise<TickResult> {
    const started = Date.now();
    const snapshots = await this.deps.feed.next();
    const result: TickResult = {
      startedAt: started,
      snapshots: snapshots.length,
      signals: 0,
      approved: 0,
      rejected: 0,
      executed: 0,
      failed: 0,
      duplicates: 0,
    };

    for (const market of snapshots) {
      if (this.stopping) break;
      const signal = this.deps.strategy.evaluate(market, this.deps.strategyContext);
      if (!signal) {
        // Debug-level so a busy loop doesn't flood info logs. Set LOG_LEVEL=debug
        // when investigating why a strategy is silent.
        logger.debug(
          {
            event: 'NO_SIGNAL',
            token: market.tokenMint,
            priceChange5mPercent: market.priceChange5mPercent,
            priceChange1hPercent: market.priceChange1hPercent,
          },
          'Strategy produced no signal',
        );
        continue;
      }
      result.signals += 1;

      const orch = await this.deps.orchestrator.process(signal);
      if (orch.kind === 'REJECTED') { result.rejected += 1; continue; }
      if (orch.kind === 'DUPLICATE') { result.duplicates += 1; continue; }
      if (orch.kind === 'ERROR') { result.failed += 1; continue; }
      result.approved += 1;

      const exec = await this.deps.executor.execute(orch.stored);
      if (exec.kind === 'CONFIRMED') result.executed += 1;
      else if (exec.kind === 'DUPLICATE') result.duplicates += 1;
      else result.failed += 1;
    }

    logger.info({ event: 'TICK', ...result }, 'Signal loop tick complete');
    return result;
  }

  /** Start periodic ticks. Overlapping ticks are skipped, not queued. */
  start(): void {
    if (this.timer) return;
    const interval = this.opts.intervalMs;
    this.timer = setInterval(() => {
      if (this.inFlight) {
        logger.warn({ event: 'TICK_SKIPPED_OVERLAP' }, 'Previous tick still running; skipping');
        return;
      }
      this.inFlight = this.runOnce()
        .catch((err) => logger.error({ event: 'TICK_ERROR', err }, 'Tick failed'))
        .finally(() => { this.inFlight = null; });
    }, interval);
    // Don't block process exit solely on the interval.
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.info({ event: 'LOOP_STARTED', intervalMs: interval }, 'Signal loop started');
  }

  /** Stop periodic ticks and await the in-flight tick, if any. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      await this.inFlight;
    }
    logger.info({ event: 'LOOP_STOPPED' }, 'Signal loop stopped');
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}
