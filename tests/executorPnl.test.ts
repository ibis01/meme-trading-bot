import { TradeExecutor } from '../src/execution/executor';
import { PaperExecutionProvider, StaticPriceOracle } from '../src/execution/paper';
import { RiskEngine } from '../src/risk/engine';
import { IdempotencyService, RedisLike } from '../src/infra/idempotency';
import { InMemoryExecutionStore } from '../src/state/executions';
import { InMemoryProposalStore, StoredProposal } from '../src/state/proposals';
import { InMemoryKillSwitch } from '../src/state/killSwitch';
import { InMemoryPnlStore } from '../src/state/dailyPnl';
import { InMemoryPositionLedger } from '../src/state/positions/inMemoryLedger';

jest.mock('../src/config', () => ({
  config: {
    TRADING_MODE: 'paper',
    MAX_POSITION_SIZE_SOL: 0.1, MAX_DAILY_LOSS_SOL: 0.5,
    MAX_SLIPPAGE_BPS: 200, MAX_PRICE_IMPACT_BPS: 300, MAX_OPEN_POSITIONS: 5,
    MIN_LIQUIDITY_USD: 50000, MAX_TOP10_HOLDER_PERCENT: 30, MAX_DEV_WALLET_PERCENT: 5,
    MAX_QUOTE_AGE_MS: 5000, WALLET_PRIVATE_KEY: undefined,
  },
}));

class MockRedis implements RedisLike {
  private store = new Map<string, { v: string; exp: number }>();
  async set(key: string, value: string, _m: 'PX', ttl: number, _f: 'NX') {
    const now = Date.now();
    const cur = this.store.get(key);
    if (cur && cur.exp > now) return null;
    this.store.set(key, { v: value, exp: now + ttl });
    return 'OK' as const;
  }
  async del(key: string) { return this.store.delete(key) ? 1 : 0; }
}

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

const proposal = (side: 'BUY' | 'SELL', requestSuffix: string): StoredProposal => ({
  id: `p_${requestSuffix}`,
  tradeRequestId: `sig:${requestSuffix}`,
  signalId: 's1',
  status: 'APPROVED',
  createdAt: Date.now(),
  decision: { allowed: true },
  proposal: {
    tokenMint: MINT,
    side,
    amountSol: 0.05,
    expectedSlippageBps: 100,
    expectedPriceImpactBps: 150,
    quoteFetchedAt: Date.now(),
    security: {
      tokenMint: MINT,
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      top10HolderPercent: 20,
      devWalletPercent: 2,
      liquidityUsd: 100_000,
      sellabilityConfirmed: true,
      fetchedAt: Date.now(),
      source: 'mock',
    },
  },
});

function mkExecutor() {
  const killSwitch = new InMemoryKillSwitch();
  const pnl = new InMemoryPnlStore();
  const positions = new InMemoryPositionLedger();
  const riskEngine = new RiskEngine({ killSwitch, pnl, positions });
  const proposals = new InMemoryProposalStore();
  const executions = new InMemoryExecutionStore();
  const idempotency = new IdempotencyService(new MockRedis());
  const provider = new PaperExecutionProvider(new StaticPriceOracle({ mint: 0.01 }));
  const executor = new TradeExecutor({
    riskEngine, killSwitch, positions, proposals, executions, idempotency, provider, pnl,
  });
  return { executor, pnl, positions };
}

describe('TradeExecutor — ledger reconciliation (P0-4b)', () => {
  it('BUY creates an open position', async () => {
    const { executor, positions } = mkExecutor();
    await executor.execute(proposal('BUY', 'buy1'));
    expect(await positions.getOpenCount()).toBe(1);
    const p = await positions.get(MINT);
    expect(p).not.toBeNull();
    expect(p!.quantity).toBeCloseTo(0.05, 8);
  });

  it('SELL closes the position and does not crash', async () => {
    const { executor, positions } = mkExecutor();
    await executor.execute(proposal('BUY', 'buy1'));
    const r = await executor.execute(proposal('SELL', 'sell1'));
    expect(r.kind).toBe('CONFIRMED');
    expect(await positions.getOpenCount()).toBe(0);
  });

  it('SELL without an open position logs a warning but still confirms the fill', async () => {
    const { executor, pnl } = mkExecutor();
    const r = await executor.execute(proposal('SELL', 'sell_no_pos'));
    expect(r.kind).toBe('CONFIRMED');
    expect(await pnl.getToday()).toBe(0);
  });

  it('full BUY → SELL cycle produces zero realized PnL at the same price', async () => {
    const { executor, pnl } = mkExecutor();
    // Same oracle price for both sides → buy notional == sell notional
    await executor.execute(proposal('BUY', 'cycle1'));
    await executor.execute(proposal('SELL', 'cycle2'));
    // Realized PnL is 0 because our SOL-notional model uses price=1 both ways
    // and the notional was identical.
    expect(await pnl.getToday()).toBeCloseTo(0, 8);
  });

  it('BUY does not touch daily PnL', async () => {
    const { executor, pnl } = mkExecutor();
    await executor.execute(proposal('BUY', 'buy_only'));
    expect(await pnl.getToday()).toBe(0);
  });
});
