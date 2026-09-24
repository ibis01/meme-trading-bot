/**
 * Bounded concurrency queue with correct serialization.
 * Rule 30: free-tier RPCs rate-limit aggressively. This queue guarantees:
 *   - At most `concurrency` jobs in flight.
 *   - At least `minSpacingMs` between job STARTS.
 *
 * The previous version had a race: two tick() invocations could both pass
 * the concurrency check before either incremented `active`. Fixed by
 * tracking the "loop running" state explicitly.
 */
export interface RpcQueueOptions {
  concurrency: number;
  minSpacingMs: number;
  /** Drop new jobs when queue length exceeds this. Prevents unbounded growth. */
  maxQueueLength?: number;
}

export class RpcQueue<T> {
  private readonly queue: Array<{
    job: () => Promise<T>;
    resolve: (v: T) => void;
    reject: (e: unknown) => void;
  }> = [];
  private active = 0;
  private lastStart = 0;
  private loopRunning = false;
  private readonly maxQueue: number;

  constructor(private readonly opts: RpcQueueOptions) {
    this.maxQueue = opts.maxQueueLength ?? 200;
  }

  enqueue(job: () => Promise<T>): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
      if (this.queue.length >= this.maxQueue) {
        // Backpressure: drop the new job. Resolves null so callers don't crash on reject.
        resolve(null);
        return;
      }
      this.queue.push({ job, resolve, reject });
      void this.runLoop();
    });
  }

  size(): number {
    return this.queue.length + this.active;
  }

  dropped(): boolean {
    return this.queue.length >= this.maxQueue;
  }

  private async runLoop(): Promise<void> {
    if (this.loopRunning) return;
    this.loopRunning = true;
    try {
      while (this.active < this.opts.concurrency && this.queue.length > 0) {
        const since = Date.now() - this.lastStart;
        const wait = Math.max(0, this.opts.minSpacingMs - since);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));

        const next = this.queue.shift();
        if (!next) break;

        this.active += 1;
        this.lastStart = Date.now();

        // Fire and forget; the finally block decrements and re-enters the loop.
        Promise.resolve()
          .then(next.job)
          .then(next.resolve)
          .catch(next.reject)
          .finally(() => {
            this.active -= 1;
            void this.runLoop();
          });
      }
    } finally {
      this.loopRunning = false;
    }
  }
}
