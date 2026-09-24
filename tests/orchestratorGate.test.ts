import { ProposalOrchestrator } from '../src/orchestrator/orchestrator';
import { RiskEngine } from '../src/risk/engine';
import { MockSecurityProvider } from '../src/security';
import { IdempotencyService, RedisLike } from '../src/infra/idempotency';
import { InMemoryProposalStore } from '../src/state/proposals';
import { InMemorySignalStore } from '../src/state/signals';
import { InMemoryKillSwitch } from '../src/state/killSwitch';
import { InMemoryPnlStore } from '../src/state/dailyPnl';
import { InMemoryPositionStore } from '../src/state/positions';
import { InMemoryStrategyVerdictStore } from '../src/state/strategyVerdicts';
import { StrategyGate } from '../src/risk/strategyGate';
import { Signal } from '../src/strategy/types';

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

const signal: Signal = {
  id: 'sig_1',
  tokenMint: 'mint',
  strategy: 'MEME_MOMENTUM_V1',
  strategyVersion: '1.0.0',
  createdAt: Date.now(),
  side: 'BUY',
  score: 80,
  proposedAmountSol: 0.05,
  proposedSlippageBps: 100,
  proposedPriceImpactBps: 150,
  evidence: {
    marketSnapshot: {
      tokenMint: 'mint', fetchedAt: Date.now(), priceUsd: 0.001,
      liquidityUsd: 100_000, volume24hUsd: 500_000, holderCount: 1000,
      top10HolderPercent: 20, smartWalletNetFlowUsd: 5000,
      priceChange5mPercent: 5, priceChange1hPercent: 10,
    },
    indicators: {}, entryReason: 'test',
  },
};

function build(gateEnabled: boolean) {
  const killSwitch = new InMemoryKillSwitch();
  const pnl = new InMemoryPnlStore();
  const positions = new InMemoryPositionStore();
  const riskEngine = new RiskEngine({ killSwitch, pnl, positions });
  const verdicts = new InMemoryStrategyVerdictStore();
  const gate = new StrategyGate(verdicts, gateEnabled);
  const orch = new ProposalOrchestrator({
    riskEngine,
    security: new MockSecurityProvider(),
    idempotency: new IdempotencyService(new MockRedis()),
    proposals: new InMemoryProposalStore(),
    signals: new InMemorySignalStore(),
    strategyGate: gate,
  });
  return { orch, verdicts };
}

describe('Orchestrator + StrategyGate (Rule 17)', () => {
  it('allows signal when gate disabled', async () => {
    const { orch } = build(false);
    const r = await orch.process(signal);
    expect(r.kind).toBe('APPROVED');
  });

  it('blocks signal when gate enabled and no verdict', async () => {
    const { orch } = build(true);
    const r = await orch.process(signal);
    expect(r.kind).toBe('ERROR');
    expect(r.kind === 'ERROR' && r.reason).toContain('STRATEGY_NOT_APPROVED');
  });

  it('allows signal when gate enabled and verdict approved', async () => {
    const { orch, verdicts } = build(true);
    await verdicts.upsert({
      strategyName: 'MEME_MOMENTUM_V1',
      strategyVersion: '1.0.0',
      flags: ['EDGE_CONFIRMED'],
      approved: true,
      trainReturnPct: 1, validationReturnPct: 1, testReturnPct: 1,
      createdAt: Date.now(),
    });
    const r = await orch.process(signal);
    expect(r.kind).toBe('APPROVED');
  });

  it('blocks signal with mismatched version even if strategy approved', async () => {
    const { orch, verdicts } = build(true);
    await verdicts.upsert({
      strategyName: 'MEME_MOMENTUM_V1',
      strategyVersion: '0.9.0',
      flags: ['EDGE_CONFIRMED'],
      approved: true,
      trainReturnPct: 1, validationReturnPct: 1, testReturnPct: 1,
      createdAt: Date.now(),
    });
    const r = await orch.process(signal);
    expect(r.kind).toBe('ERROR');
  });
});
