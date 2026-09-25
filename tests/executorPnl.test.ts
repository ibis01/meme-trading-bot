import { TradeExecutor } from '../src/execution/executor';
import { PaperExecutionProvider, StaticPriceOracle } from '../src/execution/paper';
import { RiskEngine } from '../src/risk/engine';
import { MockSecurityProvider } from '../src/security';
import { IdempotencyService, RedisLike } from '../src/infra/idempotency';
import { InMemoryExecutionStore } from '../src/state/executions';
import { InMemoryProposalStore, StoredProposal } from '../src/state/proposals';
import { InMemoryKillSwitch } from '../src/state/killSwitch';
import { InMemoryPnlStore } from '../src/state/dailyPnl';
import { InMemoryPositionStore } from '../src/state/positions';

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

const baseProposal = (side: 'BUY' | 'SELL'): StoredProposal => ({
  id: 'p1',
  tradeRequestId: `sig:${side.toLowerCase()}`,
  signalId: 's1',
  status: 'APPROVED',
  createdAt: Date.now(),
  decision: { allowed: true },
  proposal: {
    tokenMint: 'mint',
    side,
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
  },
});

function mkExecutor() {
  const killSwitch = new InMemoryKillSwitch();
  const pnl = new InMemoryPnlStore();
  const positions = new InMemoryPositionStore();
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

describe('TradeExecutor — realized PnL reconciliation (Rule 7)', () => {
  it('BUY confirmed does not touch daily P&L', async () => {
    const { executor, pnl } = mkExecutor();
    await executor.execute(baseProposal('BUY'));
    expect(await pnl.getToday()).toBe(0);
  });

  it('SELL confirmed without cost basis does NOT crash and does NOT record fake PnL', async () => {
    const { executor, pnl, positions } = mkExecutor();
    await positions.increment();
    const r = await executor.execute(baseProposal('SELL'));
    expect(r.kind).toBe('CONFIRMED');
    // Cost basis is unavailable (P0-4 pending), so PnL is not recorded — but
    // the fill still completes and nothing crashes.
    expect(await pnl.getToday()).toBe(0);
  });
});
