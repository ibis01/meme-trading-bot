import { randomUUID } from 'crypto';
import { MarketSnapshot, Signal, Strategy, StrategyContext } from './types';

/**
 * Rule 18: baseline strategies provide a reference point.
 * A real strategy must beat these on the same data to justify its existence.
 */

/** Never trades. Reference for "do nothing." */
export class HoldNothingStrategy implements Strategy {
  readonly name = 'HOLD_NOTHING';
  readonly version = '1.0.0';
  evaluate(): Signal | null {
    return null;
  }
}

/** Buys on every eligible bar. Reference for "no intelligence." */
export class AlwaysBuyStrategy implements Strategy {
  readonly name = 'ALWAYS_BUY';
  readonly version = '1.0.0';
  constructor(private readonly fixedAmountSol: number = 0.1) {}

  evaluate(market: MarketSnapshot, ctx: StrategyContext): Signal | null {
    const amount = Math.min(this.fixedAmountSol, ctx.maxPositionSol, ctx.equitySol);
    if (amount <= 0) return null;
    return {
      id: randomUUID(),
      tokenMint: market.tokenMint,
      strategy: this.name,
      strategyVersion: this.version,
      createdAt: Date.now(),
      side: 'BUY',
      score: 0,
      proposedAmountSol: amount,
      proposedSlippageBps: 100,
      proposedPriceImpactBps: 100,
      evidence: {
        marketSnapshot: market,
        indicators: {},
        entryReason: 'always-buy baseline',
      },
    };
  }
}

/**
 * Deterministic pseudo-random entries.
 * Mulberry32 PRNG so tests are reproducible.
 */
export class SeededRandomStrategy implements Strategy {
  readonly name = 'SEEDED_RANDOM';
  readonly version = '1.0.0';
  private state: number;

  constructor(
    private readonly seed: number,
    /** Probability of entering on any eligible bar. */
    private readonly entryProbability: number = 0.15,
    private readonly fixedAmountSol: number = 0.1,
  ) {
    if (entryProbability < 0 || entryProbability > 1) {
      throw new Error('entryProbability must be in [0, 1]');
    }
    this.state = seed >>> 0;
  }

  private next(): number {
    // Mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  evaluate(market: MarketSnapshot, ctx: StrategyContext): Signal | null {
    if (this.next() > this.entryProbability) return null;
    const amount = Math.min(this.fixedAmountSol, ctx.maxPositionSol, ctx.equitySol);
    if (amount <= 0) return null;
    return {
      id: randomUUID(),
      tokenMint: market.tokenMint,
      strategy: this.name,
      strategyVersion: this.version,
      createdAt: Date.now(),
      side: 'BUY',
      score: 0,
      proposedAmountSol: amount,
      proposedSlippageBps: 100,
      proposedPriceImpactBps: 100,
      evidence: {
        marketSnapshot: market,
        indicators: {},
        entryReason: `random baseline p=${this.entryProbability}`,
      },
    };
  }
}
