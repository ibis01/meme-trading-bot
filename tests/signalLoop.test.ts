import { SignalLoop } from '../src/app/signalLoop';
import { MarketFeed } from '../src/data/feed';
import { RiskEngine } from '../src/risk/engine';
import { ProposalOrchestrator } from '../src/orchestrator/orchestrator';
import { TradeExecutor } from '../src/execution/executor';
import { PaperExecutionProvider, StaticPriceOracle } from '../src/execution/paper';
import { MockSecurityProvider } from '../src/security';
import { IdempotencyService, RedisLike } from '../src/infra/idempotency';
import { InMemoryKillSwitch } from '../src/state/killSwitch';
import { InMemoryPnlStore } from '../src/state/dailyPnl';
import { InMemoryPositionStore } from '../src/state/positions';
import { InMemoryProposalStore } from '../src/state/proposals';
import { InMemoryExecutionStore } from '../src/state/executions';
import { InMemorySignalStore } from '../src/state/signals';
import { MomentumStrategy, defaultMomentumConfig } from '../src/strategy/momentum';
import { MarketSnapshot } from '../src/strategy/types';

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

/** Deterministic one-shot feed: returns the batch once, then nothing. */
class OneShotFeed implements MarketFeed {
  readonly name = 'one-shot';
  private used = false;
  constructor(private readonly batch: MarketSnapshot[]) {}
  async next(): Promise<MarketSnapshot[]> {
    if (this.used) return [];
    this.used = true;
    return this.batch;
  }
}

const market = (o: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  tokenMint: 'mint',
  fetchedAt: Date.now(),
  priceUsd: 0.001,
  liquidityUsd: 200_000,
  volume24hUsd: 1_000_000,
  holderCount: 3000,
  top10HolderPercent: 22,
  smartWalletNetFlowUsd: 8000,
  priceChange5mPercent: 6,
  priceChange1hPercent: 12,
  ...o,
});

function buildLoop(batch: MarketSnapshot[], oneShot = false) {
  const killSwitch = new InMemoryKillSwitch();
  const pnl = new InMemoryPnlStore();
  const positions = new InMemoryPositionStore();
  const riskEngine = new RiskEngine({ killSwitch, pnl, positions });
  const security = new MockSecurityProvider();
  const idempotency = new IdempotencyService(new MockRedis());
  const proposals = new InMemoryProposalStore();
  const executions = new InMemoryExecutionStore();
  const signals = new InMemorySignalStore();
  const provider = new PaperExecutionProvider(new StaticPriceOracle({ mint: 0.001 }));
  const orchestrator = new ProposalOrchestrator({ riskEngine, security, idempotency, proposals, signals });
  const executor = new TradeExecutor({ riskEngine, killSwitch, positions, proposals, executions, idempotency, provider });

  const feed = oneShot
    ? new OneShotFeed(batch)
    : new (require('../src/data/feed').FixtureFeed)(batch);

  const loop = new SignalLoop(
    {
      feed,
      strategy: new MomentumStrategy(defaultMomentumConfig),
      strategyContext: { equitySol: 10, riskPerTradeSol: 0.1, maxPositionSol: 0.1 },
      orchestrator,
      executor,
    },
    { intervalMs: 10 },
  );
  return { loop, positions };
}

describe('SignalLoop (Rules 22, 24, 34)', () => {
  it('runOnce executes an approved signal', async () => {
    const { loop, positions } = buildLoop([market()]);
    const r = await loop.runOnce();
    expect(r.signals).toBe(1);
    expect(r.approved).toBe(1);
    expect(r.executed).toBe(1);
    expect(await positions.getOpenCount()).toBe(1);
  });

  it('runOnce produces zero signals on weak momentum', async () => {
    const { loop } = buildLoop([market({ priceChange5mPercent: 0.1 })]);
    const r = await loop.runOnce();
    expect(r.signals).toBe(0);
    expect(r.executed).toBe(0);
  });

  it('empty feed returns an empty tick', async () => {
    const { loop } = buildLoop([]);
    const r = await loop.runOnce();
    expect(r.snapshots).toBe(0);
    expect(r.signals).toBe(0);
  });

  it('start/stop lifecycle', async () => {
    const { loop } = buildLoop([market()]);
    expect(loop.isRunning()).toBe(false);
    loop.start();
    expect(loop.isRunning()).toBe(true);
    await loop.stop();
    expect(loop.isRunning()).toBe(false);
  });

  it('stop waits for in-flight tick (one-shot feed → exactly one execution)', async () => {
    const { loop, positions } = buildLoop([market()], true);
    loop.start();
    await new Promise((r) => setTimeout(r, 25));
    await loop.stop();
    expect(await positions.getOpenCount()).toBe(1);
  });

  it('overlapping ticks are skipped, not queued', async () => {
    // Use a slow feed to force overlap; assert only one in-flight runs.
    let concurrent = 0;
    let maxConcurrent = 0;
    const slowFeed: MarketFeed = {
      name: 'slow',
      async next() {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 30));
        concurrent -= 1;
        return [];
      },
    };
    const killSwitch = new InMemoryKillSwitch();
    const pnl = new InMemoryPnlStore();
    const positions = new InMemoryPositionStore();
    const riskEngine = new RiskEngine({ killSwitch, pnl, positions });
    const orchestrator = new ProposalOrchestrator({
      riskEngine,
      security: new MockSecurityProvider(),
      idempotency: new IdempotencyService(new MockRedis()),
      proposals: new InMemoryProposalStore(),
      signals: new InMemorySignalStore(),
    });
    const executor = new TradeExecutor({
      riskEngine, killSwitch, positions,
      proposals: new InMemoryProposalStore(),
      executions: new InMemoryExecutionStore(),
      idempotency: new IdempotencyService(new MockRedis()),
      provider: new PaperExecutionProvider(new StaticPriceOracle({ mint: 0.001 })),
    });

    const loop = new SignalLoop(
      {
        feed: slowFeed,
        strategy: new MomentumStrategy(defaultMomentumConfig),
        strategyContext: { equitySol: 10, riskPerTradeSol: 0.1, maxPositionSol: 0.1 },
        orchestrator,
        executor,
      },
      { intervalMs: 5 },
    );

    loop.start();
    await new Promise((r) => setTimeout(r, 60));
    await loop.stop();

    expect(maxConcurrent).toBe(1);
  });
});
