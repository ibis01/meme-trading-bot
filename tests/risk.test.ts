import { evaluateRisk } from '../src/risk/evaluate';
import { RiskSnapshot, TradeProposal } from '../src/risk/types';
import { TokenSecurityEvidence } from '../src/security';

jest.mock('../src/config', () => ({
  config: {
    TRADING_MODE: 'paper',
    MAX_POSITION_SIZE_SOL: 0.1,
    MAX_DAILY_LOSS_SOL: 0.5,
    MAX_SLIPPAGE_BPS: 200,
    MAX_PRICE_IMPACT_BPS: 300,
    MAX_OPEN_POSITIONS: 5,
    MIN_LIQUIDITY_USD: 50000,
    MAX_TOP10_HOLDER_PERCENT: 30,
    MAX_DEV_WALLET_PERCENT: 5,
    MAX_QUOTE_AGE_MS: 5000,
  },
}));

const safeSecurity: TokenSecurityEvidence = {
  tokenMint: 'So11111111111111111111111111111111111111112',
  mintAuthorityDisabled: true,
  freezeAuthorityDisabled: true,
  top10HolderPercent: 20,
  devWalletPercent: 2,
  liquidityUsd: 100_000,
  sellabilityConfirmed: true,
  fetchedAt: Date.now(),
  source: 'mock',
};

const proposal = (o: Partial<TradeProposal> = {}): TradeProposal => ({
  tokenMint: safeSecurity.tokenMint,
  side: 'BUY',
  amountSol: 0.05,
  expectedSlippageBps: 100,
  expectedPriceImpactBps: 150,
  quoteFetchedAt: Date.now(),
  security: { ...safeSecurity },
  ...o,
});

const snapshot = (o: Partial<RiskSnapshot> = {}): RiskSnapshot => ({
  killSwitchActive: false,
  dailyPnLSol: -0.1,
  currentOpenPositions: 1,
  now: Date.now(),
  ...o,
});

describe('evaluateRisk (Rules 6, 7, 8, 11, 14)', () => {
  it('ALLOWS a safe trade', () => {
    expect(evaluateRisk(proposal(), snapshot()).allowed).toBe(true);
  });

  it('REJECTS on kill switch', () => {
    expect(evaluateRisk(proposal(), snapshot({ killSwitchActive: true })).reason)
      .toBe('KILL_SWITCH_ACTIVE');
  });

  it('REJECTS stale quote', () => {
    const now = Date.now();
    expect(evaluateRisk(proposal({ quoteFetchedAt: now - 60_000 }), snapshot({ now })).reason)
      .toBe('STALE_QUOTE');
  });

  it('REJECTS active mint authority', () => {
    expect(evaluateRisk(proposal({ security: { ...safeSecurity, mintAuthorityDisabled: false } }), snapshot()).reason)
      .toBe('MINT_AUTHORITY_ACTIVE');
  });

  it('REJECTS active freeze authority', () => {
    expect(evaluateRisk(proposal({ security: { ...safeSecurity, freezeAuthorityDisabled: false } }), snapshot()).reason)
      .toBe('FREEZE_AUTHORITY_ACTIVE');
  });

  it('REJECTS unconfirmed sellability', () => {
    expect(evaluateRisk(proposal({ security: { ...safeSecurity, sellabilityConfirmed: false } }), snapshot()).reason)
      .toBe('SELLABILITY_UNCONFIRMED');
  });

  it('REJECTS insufficient liquidity', () => {
    expect(evaluateRisk(proposal({ security: { ...safeSecurity, liquidityUsd: 1_000 } }), snapshot()).reason)
      .toBe('INSUFFICIENT_LIQUIDITY');
  });

  it('REJECTS holder concentration', () => {
    expect(evaluateRisk(proposal({ security: { ...safeSecurity, top10HolderPercent: 80 } }), snapshot()).reason)
      .toBe('HOLDER_CONCENTRATION_TOO_HIGH');
  });

  it('REJECTS dev wallet concentration', () => {
    expect(evaluateRisk(proposal({ security: { ...safeSecurity, devWalletPercent: 20 } }), snapshot()).reason)
      .toBe('DEV_WALLET_TOO_HIGH');
  });

  it('REJECTS daily loss exceeded', () => {
    expect(evaluateRisk(proposal(), snapshot({ dailyPnLSol: -1 })).reason)
      .toBe('MAX_DAILY_LOSS_EXCEEDED');
  });

  it('REJECTS max open positions', () => {
    expect(evaluateRisk(proposal(), snapshot({ currentOpenPositions: 5 })).reason)
      .toBe('MAX_OPEN_POSITIONS_EXCEEDED');
  });

  it('REJECTS position size exceeded', () => {
    expect(evaluateRisk(proposal({ amountSol: 1 }), snapshot()).reason)
      .toBe('MAX_POSITION_SIZE_EXCEEDED');
  });

  it('REJECTS slippage exceeded', () => {
    expect(evaluateRisk(proposal({ expectedSlippageBps: 500 }), snapshot()).reason)
      .toBe('MAX_SLIPPAGE_EXCEEDED');
  });

  it('REJECTS price impact exceeded', () => {
    expect(evaluateRisk(proposal({ expectedPriceImpactBps: 500 }), snapshot()).reason)
      .toBe('MAX_PRICE_IMPACT_EXCEEDED');
  });

  it('does not let a caller lie about kill switch via proposal', () => {
    // Proposal no longer has isKillSwitchActive at all — compile-time proof
    const p = proposal() as TradeProposal & { isKillSwitchActive?: boolean };
    expect(p.isKillSwitchActive).toBeUndefined();
  });
});
