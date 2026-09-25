import { TradeExecutor } from '../src/execution/executor';
import { PaperExecutionProvider, StaticPriceOracle } from '../src/execution/paper';
import { RiskEngine } from '../src/risk/engine';
import { MockSecurityProvider } from '../src/security';
import { IdempotencyService, RedisLike } from '../src/infra/idempotency';
import { InMemoryExecutionStore } from '../src/state/executions';
import { InMemoryProposalStore, StoredProposal } from '../src/state/proposals';
import { InMemoryKillSwitch } from '../src/state/killSwitch';
import { InMemoryPnlStore } from '../src/state/dailyPnl';
import { InMemoryPositionLedger } from '../src/state/positions/inMemoryLedger';

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
    WALLET_PRIVATE_KEY: undefined,
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

const safeProposal = (o: Partial<StoredProposal> = {}): StoredProposal => ({
  id: 'prop_1',
  tradeRequestId: 'sig:sig_1',
  signalId: 'sig_1',
  status: 'APPROVED',
  createdAt: Date.now(),
  decision: { allowed: true },
  proposal: {
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
  },
  ...o,
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
  return { executor, proposals, executions, killSwitch, positions };
}

describe('TradeExecutor (Rules 11, 14, 24, 25, 34)', () => {
  it('CONFIRMS an approved proposal and increments positions', async () => {
    const { executor, positions } = mkExecutor();
    const r = await executor.execute(safeProposal());
    expect(r.kind).toBe('CONFIRMED');
    expect(await positions.getOpenCount()).toBe(1);
  });

  it('REJECTS a non-approved proposal', async () => {
    const { executor } = mkExecutor();
    const r = await executor.execute(safeProposal({ status: 'REJECTED' }));
    expect(r.kind).toBe('REJECTED');
  });

  it('REJECTS when kill switch activates between approval and execution', async () => {
    const { executor, killSwitch, positions } = mkExecutor();
    await killSwitch.activate('EMERGENCY', '1');
    const r = await executor.execute(safeProposal());
    expect(r.kind).toBe('REJECTED');
    expect(r.kind === 'REJECTED' && r.reason).toBe('KILL_SWITCH_ACTIVE');
    expect(await positions.getOpenCount()).toBe(0);
  });

  it('REJECTS stale quote on risk re-evaluation', async () => {
    const { executor } = mkExecutor();
    const stale = safeProposal();
    stale.proposal = { ...stale.proposal, quoteFetchedAt: Date.now() - 60_000 };
    const r = await executor.execute(stale);
    expect(r.kind).toBe('REJECTED');
    expect(r.kind === 'REJECTED' && r.reason).toBe('STALE_QUOTE');
  });

  it('DUPLICATE on second execute with same tradeRequestId', async () => {
    const { executor } = mkExecutor();
    const first = await executor.execute(safeProposal());
    const second = await executor.execute(safeProposal());
    expect(first.kind).toBe('CONFIRMED');
    expect(second.kind).toBe('DUPLICATE');
    expect(second.kind === 'DUPLICATE' && second.execution.id).toBe(
      first.kind === 'CONFIRMED' ? first.execution.id : '',
    );
  });

  it('does not increment positions twice for duplicate attempts', async () => {
    const { executor, positions } = mkExecutor();
    await executor.execute(safeProposal());
    await executor.execute(safeProposal());
    expect(await positions.getOpenCount()).toBe(1);
  });

  it('DECREMENTS positions on SELL', async () => {
    const { executor, positions } = mkExecutor();
    await positions.open({ tokenMint: 'mintA', tradeRequestId: 'tr_a', quantity: 0.05, priceSol: 1, signature: 'sig_a' });
    await positions.open({ tokenMint: 'mintB', tradeRequestId: 'tr_b', quantity: 0.05, priceSol: 1, signature: 'sig_b' });
    const sell = safeProposal({
      proposal: { ...safeProposal().proposal, side: 'SELL', tokenMint: 'mintA' },
    });
    await executor.execute(sell);
    expect(await positions.getOpenCount()).toBe(1);
  });
});
