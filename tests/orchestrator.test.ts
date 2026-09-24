import { ProposalOrchestrator } from '../src/orchestrator/orchestrator';
import { RiskEngine } from '../src/risk/engine';
import { MockSecurityProvider } from '../src/security';
import { IdempotencyService, RedisLike } from '../src/infra/idempotency';
import { InMemoryProposalStore } from '../src/state/proposals';
import { InMemorySignalStore } from '../src/state/signals';
import { InMemoryKillSwitch } from '../src/state/killSwitch';
import { InMemoryPnlStore } from '../src/state/dailyPnl';
import { InMemoryPositionStore } from '../src/state/positions';
import { Signal } from '../src/strategy/types';

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

const mkSignal = (overrides: Partial<Signal> = {}): Signal => ({
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
    indicators: { score: 80 },
    entryReason: 'test signal',
  },
  ...overrides,
});

function mkOrch(opts: {
  security?: MockSecurityProvider;
  killSwitch?: InMemoryKillSwitch;
} = {}) {
  const killSwitch = opts.killSwitch ?? new InMemoryKillSwitch();
  const pnl = new InMemoryPnlStore();
  const positions = new InMemoryPositionStore();
  const riskEngine = new RiskEngine({ killSwitch, pnl, positions });
  const security = opts.security ?? new MockSecurityProvider();
  const idempotency = new IdempotencyService(new MockRedis());
  const proposals = new InMemoryProposalStore();
  const signals = new InMemorySignalStore();
  const orch = new ProposalOrchestrator({
    riskEngine, security, idempotency, proposals, signals,
  });
  return { orch, killSwitch, proposals, signals, security };
}

describe('ProposalOrchestrator (Rules 6, 20, 25)', () => {
  it('APPROVES a safe signal', async () => {
    const { orch, proposals } = mkOrch();
    const r = await orch.process(mkSignal());
    expect(r.kind).toBe('APPROVED');
    const stored = await proposals.getByRequestId('sig:sig_1');
    expect(stored!.status).toBe('APPROVED');
  });

  it('REJECTS when kill switch is active', async () => {
    const ks = new InMemoryKillSwitch();
    await ks.activate('test', '1');
    const { orch, proposals } = mkOrch({ killSwitch: ks });
    const r = await orch.process(mkSignal());
    expect(r.kind).toBe('REJECTED');
    expect(r.kind === 'REJECTED' && r.stored.decision.reason).toBe('KILL_SWITCH_ACTIVE');
    // Rule 20: rejected proposal is still persisted
    expect(await proposals.getByRequestId('sig:sig_1')).not.toBeNull();
  });

  it('REJECTS when liquidity fails', async () => {
    const security = new MockSecurityProvider({ liquidityUsd: 100 });
    const { orch } = mkOrch({ security });
    const r = await orch.process(mkSignal());
    expect(r.kind).toBe('REJECTED');
    expect(r.kind === 'REJECTED' && r.stored.decision.reason).toBe('INSUFFICIENT_LIQUIDITY');
  });

  it('DUPLICATE on second process of same signal', async () => {
    const { orch } = mkOrch();
    const first = await orch.process(mkSignal());
    const second = await orch.process(mkSignal());
    expect(first.kind).toBe('APPROVED');
    expect(second.kind).toBe('DUPLICATE');
    expect(second.kind === 'DUPLICATE' && second.stored.id).toBe(
      first.kind === 'APPROVED' ? first.stored.id : '',
    );
  });

  it('persists signal evidence even when rejected (Rule 20)', async () => {
    const security = new MockSecurityProvider({ mintAuthorityDisabled: false });
    const { orch, signals } = mkOrch({ security });
    await orch.process(mkSignal());
    const saved = await signals.getById('sig_1');
    expect(saved).not.toBeNull();
    expect(saved!.evidence.entryReason).toBe('test signal');
  });

  it('releases idempotency lock on internal error', async () => {
    const security = new MockSecurityProvider();
    // Force an error by making check throw
    jest.spyOn(security, 'check').mockRejectedValueOnce(new Error('boom'));
    const { orch } = mkOrch({ security });
    const r1 = await orch.process(mkSignal());
    expect(r1.kind).toBe('ERROR');
    // Second attempt should be allowed (lock released)
    const r2 = await orch.process(mkSignal());
    expect(r2.kind).toBe('APPROVED');
  });

  it('different signals produce different proposals', async () => {
    const { orch, proposals } = mkOrch();
    await orch.process(mkSignal({ id: 'a' }));
    await orch.process(mkSignal({ id: 'b' }));
    expect(await proposals.listRecent(10)).toHaveLength(2);
  });
});
