import { RiskEngine } from '../src/risk/engine';
import { InMemoryKillSwitch } from '../src/state/killSwitch';
import { InMemoryPnlStore } from '../src/state/dailyPnl';
import { InMemoryPositionStore } from '../src/state/positions';
import { TradeProposal } from '../src/risk/types';

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

const safeProposal = (): TradeProposal => ({
  tokenMint: 'mint',
  side: 'BUY',
  amountSol: 0.05,
  expectedSlippageBps: 100,
  expectedPriceImpactBps: 150,
  quoteFetchedAt: Date.now(),
  security: {
    tokenMint: 'mint',
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    top10HolderPercent: 20,
    devWalletPercent: 2,
    liquidityUsd: 100_000,
    sellabilityConfirmed: true,
    fetchedAt: Date.now(),
    source: 'mock',
  },
});

function mkEngine() {
  return {
    killSwitch: new InMemoryKillSwitch(),
    pnl: new InMemoryPnlStore(),
    positions: new InMemoryPositionStore(),
    engine: null as RiskEngine | null,
  };
}

describe('RiskEngine (Rule 6 — final authority)', () => {
  it('reads kill switch from the store, not the caller', async () => {
    const env = mkEngine();
    env.engine = new RiskEngine(env);
    await env.killSwitch.activate('test', '1');
    const r = await env.engine.evaluate(safeProposal());
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('KILL_SWITCH_ACTIVE');
  });

  it('reads daily PnL from the store', async () => {
    const env = mkEngine();
    env.engine = new RiskEngine(env);
    await env.pnl.addSol(-0.6);
    const r = await env.engine.evaluate(safeProposal());
    expect(r.reason).toBe('MAX_DAILY_LOSS_EXCEEDED');
  });

  it('reads open positions from the store', async () => {
    const env = mkEngine();
    env.engine = new RiskEngine(env);
    for (let i = 0; i < 5; i++) await env.positions.increment();
    const r = await env.engine.evaluate(safeProposal());
    expect(r.reason).toBe('MAX_OPEN_POSITIONS_EXCEEDED');
  });

  it('allows a clean trade with all stores empty', async () => {
    const env = mkEngine();
    env.engine = new RiskEngine(env);
    const r = await env.engine.evaluate(safeProposal());
    expect(r.allowed).toBe(true);
  });
});
