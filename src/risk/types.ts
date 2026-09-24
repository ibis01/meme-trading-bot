import { TokenSecurityEvidence } from '../security';

export interface RiskDecision {
  allowed: boolean;
  reason?: string;
  evidence?: Record<string, unknown>;
}

/**
 * Proposals carry NO self-declared risk state.
 * The RiskEngine fetches that from authoritative stores.
 */
export interface TradeProposal {
  tokenMint: string;
  side: 'BUY' | 'SELL';
  amountSol: number;
  expectedSlippageBps: number;
  expectedPriceImpactBps: number;
  quoteFetchedAt: number;
  security: TokenSecurityEvidence;
}

/**
 * Rule 6: Authoritative snapshot.
 * Only the RiskEngine builds this — never the caller.
 */
export interface RiskSnapshot {
  killSwitchActive: boolean;
  dailyPnLSol: number;
  currentOpenPositions: number;
  now: number;
}
