import { config } from '../config';
import { RiskDecision, RiskSnapshot, TradeProposal } from './types';

/**
 * Pure, deterministic. No I/O. No global state.
 * Rule 6: this function is the FINAL AUTHORITY on trade permission.
 * Rule 7 + 8 + 11 + 14: every gate lives here.
 *
 * Side-aware gating (audit fix C2):
 * Token-quality gates (mint/freeze authority, sellability, liquidity, holder
 * and dev concentration) protect ENTRY — they must never block an EXIT.
 * Applying them to SELLs traps capital in exactly the scenarios they were
 * built to detect (liquidity evaporating, rugged tokens).
 *
 * The kill switch blocks BUYs only; SELLs stay available (with execution
 * sanity limits still applied) so a paused/emergency bot can still flatten.
 * The daily-loss limit switches the engine into FLATTEN mode: no new buys,
 * sells allowed.
 */
export function evaluateRisk(
  proposal: TradeProposal,
  snapshot: RiskSnapshot,
): RiskDecision {
  const isBuy = proposal.side === 'BUY';

  const evidence: Record<string, unknown> = {
    tradingMode: config.TRADING_MODE,
    killSwitch: snapshot.killSwitchActive,
    dailyPnLSol: snapshot.dailyPnLSol,
    openPositions: snapshot.currentOpenPositions,
    exitMode: !isBuy,
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

  // Rule 14 — kill switch (must be first). Side-aware (audit fix C2): the
  // switch blocks NEW risk (BUYs) but never traps existing positions —
  // SELLs stay available so /pause or /emergency can't lock capital in.
  if (snapshot.killSwitchActive && isBuy) {
    return { allowed: false, reason: 'KILL_SWITCH_ACTIVE', evidence };
  }
  if (snapshot.killSwitchActive) {
    evidence.killSwitchActive = true; // exit under kill switch — audit event trail
  }

  // Rule 11 — never submit a stale quote (both sides: exits act on fresh state too)
  if (snapshot.now - proposal.quoteFetchedAt > config.MAX_QUOTE_AGE_MS) {
    return { allowed: false, reason: 'STALE_QUOTE', evidence };
  }

  // Rule 7 — daily loss limit. Entries blocked; exits allowed (FLATTEN mode):
  // when the day's loss limit trips, the safest action is to reduce exposure,
  // not to freeze the portfolio with positions still open.
  const dailyLossTripped = snapshot.dailyPnLSol <= -config.MAX_DAILY_LOSS_SOL;

  if (isBuy) {
    // Rule 8 — token security gates (entry-only; exits bypass, see C2)
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
    if (
      proposal.security.top10HolderPercent > config.MAX_TOP10_HOLDER_PERCENT
    ) {
      return {
        allowed: false,
        reason: 'HOLDER_CONCENTRATION_TOO_HIGH',
        evidence,
      };
    }
    if (proposal.security.devWalletPercent > config.MAX_DEV_WALLET_PERCENT) {
      return { allowed: false, reason: 'DEV_WALLET_TOO_HIGH', evidence };
    }

    // Rule 7 — daily loss limit blocks new risk.
    if (dailyLossTripped) {
      return { allowed: false, reason: 'MAX_DAILY_LOSS_EXCEEDED', evidence };
    }

    if (snapshot.currentOpenPositions >= config.MAX_OPEN_POSITIONS) {
      return {
        allowed: false,
        reason: 'MAX_OPEN_POSITIONS_EXCEEDED',
        evidence,
      };
    }
    if (proposal.amountSol > config.MAX_POSITION_SIZE_SOL) {
      return { allowed: false, reason: 'MAX_POSITION_SIZE_EXCEEDED', evidence };
    }
  } else if (dailyLossTripped) {
    evidence.flattenMode = true;
  }

  // Execution sanity limits apply to both sides.
  if (proposal.expectedSlippageBps > config.MAX_SLIPPAGE_BPS) {
    return { allowed: false, reason: 'MAX_SLIPPAGE_EXCEEDED', evidence };
  }
  if (proposal.expectedPriceImpactBps > config.MAX_PRICE_IMPACT_BPS) {
    return { allowed: false, reason: 'MAX_PRICE_IMPACT_EXCEEDED', evidence };
  }

  return { allowed: true, evidence };
}
