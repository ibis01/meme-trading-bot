import { randomUUID } from 'crypto';
import { MarketSnapshot, Signal, Strategy, StrategyContext } from './types';

export interface MeanReversionConfig {
  /** Buy when 5m change is at or below this (negative). */
  max5mChangePercent: number;
  /** Buy when 1h change is at or below this (negative). */
  max1hChangePercent: number;
  stopDistancePercent: number;
}

/**
 * Defaults calibrated for real Solana memecoin 1-minute bars.
 * Memecoins mean-revert after sharp short-term dips more reliably than
 * they continue sharp pumps (see SYNTHETIC_RESULTS.md findings).
 */
export const defaultMeanReversionConfig: MeanReversionConfig = {
  max5mChangePercent: -0.4,
  max1hChangePercent: -0.8,
  stopDistancePercent: 3,
};

export class MeanReversionStrategy implements Strategy {
  readonly name = 'MEME_MEANREV_V1';
  readonly version = '1.0.0';

  constructor(private readonly cfg: MeanReversionConfig = defaultMeanReversionConfig) {}

  evaluate(market: MarketSnapshot, ctx: StrategyContext): Signal | null {
    if (market.priceChange5mPercent > this.cfg.max5mChangePercent) return null;
    if (market.priceChange1hPercent > this.cfg.max1hChangePercent) return null;

    const riskAmountSol = Math.min(ctx.riskPerTradeSol, ctx.equitySol);
    const stopFraction = this.cfg.stopDistancePercent / 100;
    const rawSize = stopFraction > 0 ? riskAmountSol / stopFraction : 0;
    const proposedAmountSol = Math.min(rawSize, ctx.maxPositionSol);
    if (proposedAmountSol <= 0) return null;

    const score = Math.min(
      100,
      Math.round(
        Math.min(50, Math.abs(market.priceChange5mPercent) * 25) +
          Math.min(50, Math.abs(market.priceChange1hPercent) * 10),
      ),
    );

    return {
      id: randomUUID(),
      tokenMint: market.tokenMint,
      strategy: this.name,
      strategyVersion: this.version,
      createdAt: Date.now(),
      side: 'BUY',
      score,
      proposedAmountSol,
      proposedSlippageBps: 150,
      proposedPriceImpactBps: 200,
      evidence: {
        marketSnapshot: market,
        indicators: {
          priceChange5mPercent: market.priceChange5mPercent,
          priceChange1hPercent: market.priceChange1hPercent,
          score,
        },
        entryReason: `mean-rev: 5m ${market.priceChange5mPercent.toFixed(2)}% | 1h ${market.priceChange1hPercent.toFixed(2)}%`,
      },
    };
  }
}
