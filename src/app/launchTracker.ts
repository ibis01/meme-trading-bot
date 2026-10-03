export interface LaunchTrackerOptions {
  /** How long each new token is recorded for after detection. */
  trackMs: number;
  /** Hard cap on concurrently tracked tokens (bounds tick duration). */
  maxTracked: number;
}

export type TrackResult = 'ADDED' | 'DUPLICATE' | 'AT_CAPACITY';

/**
 * Pure bookkeeping for which freshly-launched mints are currently recorded.
 * A mint is only ever tracked once: expired mints are not re-added if the
 * source reports them again.
 */
export class LaunchTracker {
  private readonly expiry = new Map<string, number>();
  private readonly seen = new Set<string>();

  constructor(private readonly opts: LaunchTrackerOptions) {}

  add(mint: string, now: number): TrackResult {
    this.purge(now);
    if (this.seen.has(mint)) return 'DUPLICATE';
    if (this.expiry.size >= this.opts.maxTracked) return 'AT_CAPACITY';
    this.seen.add(mint);
    this.expiry.set(mint, now + this.opts.trackMs);
    return 'ADDED';
  }

  active(now: number): string[] {
    this.purge(now);
    return [...this.expiry.keys()];
  }

  private purge(now: number): void {
    for (const [mint, exp] of this.expiry) {
      if (exp <= now) this.expiry.delete(mint);
    }
  }
}
