/**
 * Rule 20: Signal evidence must be preserved.
 * Rule 28: AI may enrich signals, but never be the strategy itself.
 */

export interface MarketSnapshot {
  tokenMint: string;
  fetchedAt: number;
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  holderCount: number;
  top10HolderPercent: number;
  /** Optional. Undefined = unknown; 0 = known zero. */
  smartWalletNetFlowUsd?: number;
  priceChange5mPercent: number;
  priceChange1hPercent: number;
}

export interface SignalEvidence {
  marketSnapshot: MarketSnapshot;
  indicators: Record<string, number>;
  entryReason: string;
}

export interface Signal {
  id: string;
  tokenMint: string;
  strategy: string;
  strategyVersion: string;
  createdAt: number;
  side: 'BUY' | 'SELL';
  /** 0..100, ranking only. Never a gate (Rule 10). */
  score: number;
  /** Pre-computed values the risk engine will validate. */
  proposedAmountSol: number;
  proposedSlippageBps: number;
  proposedPriceImpactBps: number;
  evidence: SignalEvidence;
}

export interface StrategyContext {
  /** Rule 15: risk-based sizing. */
  equitySol: number;
  riskPerTradeSol: number;
  /** Cap on the largest single position the risk engine will allow. */
  maxPositionSol: number;
}

export interface Strategy {
  readonly name: string;
  readonly version: string;
  /**
   * Pure evaluation. Must NOT perform I/O, must NOT call the risk engine,
   * must NOT execute anything. Returns null when no signal is warranted.
   */
  evaluate(market: MarketSnapshot, ctx: StrategyContext): Signal | null;
}
