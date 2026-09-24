import { PoolEvent, PoolEventHandler, PoolEventSource } from './types';

export interface MockPoolEventSourceOptions {
  /** Events to emit, in order, one per interval. */
  fixtures: PoolEvent[];
  /** Delay between events, ms. */
  intervalMs?: number;
}

/**
 * Deterministic, offline event source. Used for tests and dry-runs.
 * Emits fixtures one at a time on an interval. No network.
 */
export class MockPoolEventSource implements PoolEventSource {
  readonly name = 'mock-pool-events';
  private handlers: PoolEventHandler[] = [];
  private timer: NodeJS.Timeout | null = null;
  private cursor = 0;
  private readonly intervalMs: number;

  constructor(private readonly opts: MockPoolEventSourceOptions) {
    this.intervalMs = opts.intervalMs ?? 500;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.cursor >= this.opts.fixtures.length) {
        // Reached end; stop cleanly.
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
        return;
      }
      const event = this.opts.fixtures[this.cursor];
      this.cursor += 1;
      for (const h of this.handlers) {
        // Defer the call so a synchronous throw is caught by .catch.
        Promise.resolve()
          .then(() => h(event))
          .catch(() => { /* swallow — source stays alive */ });
      }
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  onEvent(handler: PoolEventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}
