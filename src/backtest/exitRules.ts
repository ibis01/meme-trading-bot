import { ExitReason, OpenPosition, StopConfig } from './types';

export interface ExitDecision {
  shouldExit: boolean;
  reason?: ExitReason;
}

/**
 * Rule 16: hard stop, trailing stop, time stop.
 * Deterministic. No I/O. No side effects.
 */
export class ExitRules {
  constructor(private readonly cfg: StopConfig) {
    if (cfg.hardStopPct <= 0 || cfg.hardStopPct >= 1) {
      throw new Error('hardStopPct must be in (0, 1)');
    }
    if (cfg.trailingStopPct !== undefined && (cfg.trailingStopPct <= 0 || cfg.trailingStopPct >= 1)) {
      throw new Error('trailingStopPct must be in (0, 1)');
    }
    if (cfg.timeStopMs !== undefined && cfg.timeStopMs <= 0) {
      throw new Error('timeStopMs must be > 0');
    }
  }

  /** Called each bar. Updates HWM and returns the exit decision. */
  evaluate(position: OpenPosition, currentPriceUsd: number, nowMs: number): ExitDecision {
    // Time stop first — cheapest check, no price math.
    if (this.cfg.timeStopMs !== undefined) {
      const held = nowMs - position.entryAt;
      if (held >= this.cfg.timeStopMs) {
        return { shouldExit: true, reason: 'TIME_STOP' };
      }
    }

    // Hard stop: price below entry by hardStopPct.
    const hardFloor = position.entryPriceUsd * (1 - this.cfg.hardStopPct);
    if (currentPriceUsd <= hardFloor) {
      return { shouldExit: true, reason: 'HARD_STOP' };
    }

    // Trailing stop: price below HWM by trailingStopPct.
    if (this.cfg.trailingStopPct !== undefined) {
      const trailingFloor = position.highWatermarkUsd * (1 - this.cfg.trailingStopPct);
      if (currentPriceUsd <= trailingFloor) {
        return { shouldExit: true, reason: 'TRAILING_STOP' };
      }
    }

    return { shouldExit: false };
  }

  /** Update HWM. Called BEFORE evaluate on each bar. */
  updateHighWatermark(position: OpenPosition, currentPriceUsd: number): OpenPosition {
    return currentPriceUsd > position.highWatermarkUsd
      ? { ...position, highWatermarkUsd: currentPriceUsd }
      : position;
  }
}
