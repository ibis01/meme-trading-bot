import { config } from '../config';
import { RiskDecision, RiskSnapshot, TradeProposal } from './types';

/**
 * Pure, deterministic. No I/O. No global state.
 * Rule 6: this function is the FINAL AUTHORITY on trade permission.
 * Rule 7 + 8 + 11 + 14: every gate lives here.
 */
export function evaluateRisk(
  proposal: TradeProposal,
  snapshot: RiskSnapshot,
): RiskDecision {
  const evidence: Record<string, unknown> = {
    tradingMode: config.TRADING_MODE,
    killSwitch: snapshot.killSwitchActive,
    dailyPnLSol: snapshot.dailyPnLSol,
    openPositions: snapshot.currentOpenPositions,
    limits: {
      maxPosition: config.MAX_POSITION_SIZE_SOL,
      maxSlippageBps: config.MAX_SLIPPAGE_BPS,
      maxPriceImpactBps: config.MAX_PRICE_IMPACT_BPS,
      maxOpenPositions: config.MAX_OPEN_POSITIONS,
      maxTop10HolderPercent: config.MAX_TOP10_HOLDER_PERCENT,
      maxDevWalletPercent: config.MAX_DEV_WALLET_PERCENT,
      minLiquidityUsd: config.MIN_LIQUIDITY_USD,
      maxQuoteAgeMs: config.MAX_QUOTE_AGE_MS,
      maxDailyLossSol: config.MAX_DAILY_LOSS_SOL,
    },
    security: proposal.security,
  };

  // Rule 14 — kill switch (must be first)
  if (snapshot.killSwitchActive) {
    return { allowed: false, reason: 'KILL_SWITCH_ACTIVE', evidence };
  }

  // Rule 11 — never submit a stale quote
  if (snapshot.now - proposal.quoteFetchedAt > config.MAX_QUOTE_AGE_MS) {
    return { allowed: false, reason: 'STALE_QUOTE', evidence };
  }

  // Rule 8 — token security gates
  if (!proposal.security.mintAuthorityDisabled) {
    return { allowed: false, reason: 'MINT_AUTHORITY_ACTIVE', evidence };
  }
  if (!proposal.security.freezeAuthorityDisabled) {
    return { allowed: false, reason: 'FREEZE_AUTHORITY_ACTIVE', evidence };
  }
  if (!proposal.security.sellabilityConfirmed) {
    return { allowed: false, reason: 'SELLABILITY_UNCONFIRMED', evidence };
  }
  if (proposal.security.liquidityUsd < config.MIN_LIQUIDITY_USD) {
    return { allowed: false, reason: 'INSUFFICIENT_LIQUIDITY', evidence };
  }
  if (proposal.security.top10HolderPercent > config.MAX_TOP10_HOLDER_PERCENT) {
    return { allowed: false, reason: 'HOLDER_CONCENTRATION_TOO_HIGH', evidence };
  }
  if (proposal.security.devWalletPercent > config.MAX_DEV_WALLET_PERCENT) {
    return { allowed: false, reason: 'DEV_WALLET_TOO_HIGH', evidence };
  }

  // Rule 7 — portfolio + numeric gates
  if (snapshot.dailyPnLSol <= -config.MAX_DAILY_LOSS_SOL) {
    return { allowed: false, reason: 'MAX_DAILY_LOSS_EXCEEDED', evidence };
  }
  if (proposal.side === 'BUY' && snapshot.currentOpenPositions >= config.MAX_OPEN_POSITIONS) {
    return { allowed: false, reason: 'MAX_OPEN_POSITIONS_EXCEEDED', evidence };
  }
  if (proposal.amountSol > config.MAX_POSITION_SIZE_SOL) {
    return { allowed: false, reason: 'MAX_POSITION_SIZE_EXCEEDED', evidence };
  }
  if (proposal.expectedSlippageBps > config.MAX_SLIPPAGE_BPS) {
    return { allowed: false, reason: 'MAX_SLIPPAGE_EXCEEDED', evidence };
  }
  if (proposal.expectedPriceImpactBps > config.MAX_PRICE_IMPACT_BPS) {
    return { allowed: false, reason: 'MAX_PRICE_IMPACT_EXCEEDED', evidence };
  }

  return { allowed: true, evidence };
}
