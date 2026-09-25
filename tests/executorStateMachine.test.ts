import { TradeExecutor } from '../src/execution/executor';
import { PaperExecutionProvider, StaticPriceOracle } from '../src/execution/paper';
import { ExecutionProvider, ExecutionOutcome } from '../src/execution/types';
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

/** Controllable provider for state-machine tests. */
class ScriptedProvider implements ExecutionProvider {
  readonly name = 'scripted';
  constructor(private readonly script: () => Promise<ExecutionOutcome>) {}
  assertEnabled(): void {}
  execute(): Promise<ExecutionOutcome> {
    return this.script();
  }
}

/** Provider that throws before returning (simulates RPC crash). */
class ThrowingProvider implements ExecutionProvider {
  readonly name = 'throwing';
  assertEnabled(): void {}
  async execute(): Promise<ExecutionOutcome> {
    throw new Error('RPC_CONNECTION_LOST');
  }
}

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

const proposal = (suffix: string): StoredProposal => ({
  id: `p_${suffix}`,
  tradeRequestId: `sig:${suffix}`,
  signalId: 's1',
  status: 'APPROVED',
  createdAt: Date.now(),
  decision: { allowed: true },
  proposal: {
    tokenMint: MINT,
    side: 'BUY',
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

function mkExecutor(provider: ExecutionProvider) {
  const killSwitch = new InMemoryKillSwitch();
  const pnl = new InMemoryPnlStore();
  const positions = new InMemoryPositionLedger();
  const riskEngine = new RiskEngine({ killSwitch, pnl, positions });
  const proposals = new InMemoryProposalStore();
  const executions = new InMemoryExecutionStore();
  const idempotency = new IdempotencyService(new MockRedis());
  const executor = new TradeExecutor({
    riskEngine, killSwitch, positions, proposals, executions, idempotency, provider, pnl,
  });
  return { executor, proposals, executions, idempotency };
}

describe('TradeExecutor — state machine (P1-6)', () => {
  it('CONFIRMED outcome books a fill and marks proposal EXECUTED', async () => {
    const provider = new PaperExecutionProvider(new StaticPriceOracle({ [MINT]: 0.01 }));
    const { executor, proposals } = mkExecutor(provider);
    await proposals.save(proposal('c1'));
    const r = await executor.execute(proposal('c1'));
    expect(r.kind).toBe('CONFIRMED');
    expect((await proposals.listRecent(1))[0].status).toBe('EXECUTED');
  });

  it('SUBMITTED outcome marks proposal SUBMITTED and keeps the lock', async () => {
    const provider = new ScriptedProvider(async () => ({
      txSignature: 'sig_sub',
      filledAmountSol: 0,
      filledPriceUsd: 0,
      status: 'SUBMITTED' as const,
    }));
    const { executor, proposals } = mkExecutor(provider);
    await proposals.save(proposal('s1'));
    const r = await executor.execute(proposal('s1'));
    expect(r.kind).toBe('SUBMITTED');
    expect((await proposals.listRecent(1))[0].status).toBe('SUBMITTED');
  });

  it('UNKNOWN outcome marks proposal UNKNOWN and keeps the lock', async () => {
    const provider = new ScriptedProvider(async () => ({
      txSignature: '',
      filledAmountSol: 0,
      filledPriceUsd: 0,
      status: 'UNKNOWN' as const,
      error: 'RPC_TIMEOUT',
    }));
    const { executor, proposals, idempotency } = mkExecutor(provider);
    await proposals.save(proposal('u1'));
    const r = await executor.execute(proposal('u1'));
    expect(r.kind).toBe('UNKNOWN');
    expect((await proposals.listRecent(1))[0].status).toBe('UNKNOWN');

    // Idempotency lock must be retained.
    const acquiredAgain = await idempotency.acquire('exec:sig:u1');
    expect(acquiredAgain).toBe(false);
  });

  it('FAILED outcome (provider-confident) keeps the lock', async () => {
    const provider = new ScriptedProvider(async () => ({
      txSignature: '',
      filledAmountSol: 0,
      filledPriceUsd: 0,
      status: 'FAILED' as const,
      error: 'SIMULATION_REJECTED',
    }));
    const { executor, idempotency } = mkExecutor(provider);
    const r = await executor.execute(proposal('f1'));
    expect(r.kind).toBe('FAILED');
    // Lock retained: the same signature may exist on-chain even if provider says failed.
    const acquiredAgain = await idempotency.acquire('exec:sig:f1');
    expect(acquiredAgain).toBe(false);
  });

  it('POST-submit exception is caught and recorded as UNKNOWN, lock retained', async () => {
    const provider = new ThrowingProvider();
    const { executor, executions, idempotency } = mkExecutor(provider);
    const r = await executor.execute(proposal('post'));
    expect(r.kind).toBe('UNKNOWN');
    const stored = await executions.getByRequestId('sig:post');
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe('UNKNOWN');
    // Lock retained.
    const acquiredAgain = await idempotency.acquire('exec:sig:post');
    expect(acquiredAgain).toBe(false);
  });

  it('PRE-submit rejection (kill switch) releases the lock', async () => {
    const provider = new PaperExecutionProvider(new StaticPriceOracle({ [MINT]: 0.01 }));
    const killSwitch = new InMemoryKillSwitch();
    await killSwitch.activate('test', '1');
    const pnl = new InMemoryPnlStore();
    const positions = new InMemoryPositionLedger();
    const riskEngine = new RiskEngine({ killSwitch, pnl, positions });
    const idempotency = new IdempotencyService(new MockRedis());
    const proposals = new InMemoryProposalStore();
    await proposals.save(proposal('ks'));
    const executor = new TradeExecutor({
      riskEngine, killSwitch, positions,
      proposals,
      executions: new InMemoryExecutionStore(),
      idempotency, provider, pnl,
    });
    const r = await executor.execute(proposal('ks'));
    expect(r.kind).toBe('REJECTED');
    // Lock must be released so a future signal can retry.
    const reacquired = await idempotency.acquire('exec:sig:ks');
    expect(reacquired).toBe(true);
  });

  it('idempotent duplicate returns the original outcome kind', async () => {
    const provider = new PaperExecutionProvider(new StaticPriceOracle({ [MINT]: 0.01 }));
    const { executor } = mkExecutor(provider);
    const first = await executor.execute(proposal('dup'));
    const second = await executor.execute(proposal('dup'));
    expect(first.kind).toBe('CONFIRMED');
    expect(second.kind).toBe('CONFIRMED');
  });
});
