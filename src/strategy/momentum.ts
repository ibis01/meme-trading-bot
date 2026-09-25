import { randomUUID } from 'crypto';
import {
  MarketSnapshot,
  Signal,
  Strategy,
  StrategyContext,
} from './types';

export interface MomentumConfig {
  /** Minimum 5m price change to consider a buy signal, in percent (e.g. 0.5 = 0.5%). */
  min5mChangePercent: number;
  /** Minimum 1h price change confirming trend, in percent. */
  min1hChangePercent: number;
  /** Require positive smart-wallet net flow when the value is known. */
  requirePositiveSmartFlow: boolean;
  /** Stop distance in percent, used for risk-based sizing. */
  stopDistancePercent: number;
}

/**
 * Defaults calibrated for real Solana memecoin 1-minute closes (2026-09).
 * Observed p90 of 5m change on liquid memecoins: ~0.5%.
 * Observed p90 of 1h change: ~1.0%.
 *
 * To reproduce synthetic-data behavior, override with the old values:
 *   { min5mChangePercent: 3, min1hChangePercent: 5, requirePositiveSmartFlow: true }
 */
export const defaultMomentumConfig: MomentumConfig = {
  min5mChangePercent: 0.5,
  min1hChangePercent: 1.0,
  requirePositiveSmartFlow: false,
  stopDistancePercent: 15,
};

/** Preserved for synthetic-data regression tests. */
export const syntheticMomentumConfig: MomentumConfig = {
  min5mChangePercent: 3,
  min1hChangePercent: 5,
  requirePositiveSmartFlow: true,
  stopDistancePercent: 15,
};

export class MomentumStrategy implements Strategy {
  readonly name = 'MEME_MOMENTUM_V1';
  readonly version = '1.1.0'; // bumped: thresholds recalibrated for real data

  constructor(private readonly cfg: MomentumConfig = defaultMomentumConfig) {}

  evaluate(market: MarketSnapshot, ctx: StrategyContext): Signal | null {
    const reasons: string[] = [];

    if (market.priceChange5mPercent < this.cfg.min5mChangePercent) return null;
    reasons.push(`5m +${market.priceChange5mPercent.toFixed(2)}%`);

    if (market.priceChange1hPercent < this.cfg.min1hChangePercent) return null;
    reasons.push(`1h +${market.priceChange1hPercent.toFixed(2)}%`);

    // Rule 30: undefined = unknown → don't gate. Zero/negative = explicit bad signal.
    if (
      this.cfg.requirePositiveSmartFlow &&
      market.smartWalletNetFlowUsd !== undefined &&
      market.smartWalletNetFlowUsd <= 0
    ) {
      return null;
    }
    if (market.smartWalletNetFlowUsd !== undefined) {
      reasons.push(`flow +$${market.smartWalletNetFlowUsd.toFixed(0)}`);
    }

    const riskAmountSol = Math.min(ctx.riskPerTradeSol, ctx.equitySol);
    const stopFraction = this.cfg.stopDistancePercent / 100;
    const rawSize = stopFraction > 0 ? riskAmountSol / stopFraction : 0;
    const proposedAmountSol = Math.min(rawSize, ctx.maxPositionSol);
    if (proposedAmountSol <= 0) return null;

    const score = Math.min(
      100,
      Math.round(
        Math.min(40, market.priceChange5mPercent * 20) +
          Math.min(30, market.priceChange1hPercent * 5) +
          Math.min(30, (market.smartWalletNetFlowUsd ?? 0) / 1000),
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
          smartWalletNetFlowUsd: market.smartWalletNetFlowUsd ?? 0,  // indicators may normalize; score-side only
          score,
        },
        entryReason: reasons.join(' | '),
      },
    };
  }
}
