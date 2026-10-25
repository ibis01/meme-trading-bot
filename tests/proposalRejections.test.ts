import { Pool } from 'pg';
import { PostgresRejectionStore } from '../src/state/proposalRejections';
import { ProposalOrchestrator } from '../src/orchestrator/orchestrator';
import { RiskEngine } from '../src/risk/engine';
import { MockSecurityProvider } from '../src/security';
import { IdempotencyService, RedisLike } from '../src/infra/idempotency';
import { InMemoryProposalStore } from '../src/state/proposals';
import { InMemorySignalStore } from '../src/state/signals';
import { InMemoryKillSwitch } from '../src/state/killSwitch';
import { InMemoryPnlStore } from '../src/state/dailyPnl';
import { InMemoryPositionStore } from '../src/state/positions/countStore';
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

/**
 * Migration 011 (proposal_rejections) + the orchestrator wiring that feeds
 * it. The Phase 1 commit batch added this audit trail with zero tests; every
 * reject path (strategy gate, risk engine) must land a row, and approvals
 * must NOT. Columns asserted here must stay in sync with
 * db/migrations/011_proposal_rejections.sql.
 */
describe('PostgresRejectionStore — SQL contract', () => {
  it('inserts all 011 columns and dedupes on trade_request_id', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const store = new PostgresRejectionStore({ query } as unknown as Pool);

    const evidence = { stage: 'RISK', stale: true, ratio: 1.5 };
    await store.saveRejection({
      tradeRequestId: 'sig:s1',
      tokenMint: 'MintAAAA1111',
      strategy: 'MEME_MOMENTUM_V1',
      strategyVersion: '1.0.0',
      reasonCode: 'STALE_QUOTE',
      evidence,
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO proposal_rejections');
    expect(sql).toContain('trade_request_id');
    expect(sql).toContain('reason_code');
    expect(sql).toContain('evidence');
    expect(sql).toContain('ON CONFLICT (trade_request_id) DO NOTHING');

    expect(params).toHaveLength(7);
    // id: UUIDv4
    expect(params[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(params[1]).toBe('sig:s1');
    expect(params[2]).toBe('MintAAAA1111');
    expect(params[3]).toBe('MEME_MOMENTUM_V1');
    expect(params[4]).toBe('1.0.0');
    expect(params[5]).toBe('STALE_QUOTE');
    expect(params[6]).toBe(JSON.stringify(evidence));
  });

  it('stringifies evidence even when the caller passes an empty object', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const store = new PostgresRejectionStore({ query } as unknown as Pool);
    await store.saveRejection({
      tradeRequestId: 'sig:s2', tokenMint: 'm', strategy: 's',
      strategyVersion: '1', reasonCode: 'X', evidence: {},
    });
    expect(query.mock.calls[0][1][6]).toBe('{}');
  });
});

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

function build(opts: { gateEnabled: boolean }) {
  const killSwitch = new InMemoryKillSwitch();
  const riskEngine = new RiskEngine({
    killSwitch,
    pnl: new InMemoryPnlStore(),
    positions: new InMemoryPositionStore(),
  });
  const signals = new InMemorySignalStore();
  const proposals = new InMemoryProposalStore();
  const verdicts = new InMemoryStrategyVerdictStore();
  const rejectionStore = { saveRejection: jest.fn().mockResolvedValue(undefined) };

  const orch = new ProposalOrchestrator({
    riskEngine,
    security: new MockSecurityProvider(),
    idempotency: new IdempotencyService(new MockRedis()),
    proposals,
    signals,
    strategyGate: new StrategyGate(verdicts, opts.gateEnabled),
    rejectionStore,
  });
  return { orch, killSwitch, rejectionStore, signals, proposals };
}

describe('Orchestrator → rejectionStore wiring', () => {
  it('persists a STRATEGY_GATE rejection with stage evidence', async () => {
    const { orch, rejectionStore, signals } = build({ gateEnabled: true });
    const r = await orch.process(signal);

    expect(r.kind).toBe('ERROR');
    expect(rejectionStore.saveRejection).toHaveBeenCalledTimes(1);
    const arg = rejectionStore.saveRejection.mock.calls[0][0];
    expect(arg.tradeRequestId).toBe('sig:sig_1');
    expect(arg.tokenMint).toBe('mint');
    expect(arg.strategy).toBe('MEME_MOMENTUM_V1');
    expect(arg.strategyVersion).toBe('1.0.0');
    expect(arg.reasonCode).toBe('STRATEGY_NOT_APPROVED:MEME_MOMENTUM_V1@1.0.0');
    expect(arg.evidence).toMatchObject({ stage: 'STRATEGY_GATE' });
    // Gate check precedes any state mutation — the signal is NOT saved.
    expect(await signals.getById('sig_1')).toBeNull();
  });

  it('persists a risk-engine rejection with the decision reason and evidence', async () => {
    const { orch, killSwitch, rejectionStore } = build({ gateEnabled: false });
    await killSwitch.activate('EMERGENCY', '1');
    const r = await orch.process(signal);

    expect(r.kind).toBe('REJECTED');
    expect(rejectionStore.saveRejection).toHaveBeenCalledTimes(1);
    const arg = rejectionStore.saveRejection.mock.calls[0][0];
    expect(arg.reasonCode).toBe('KILL_SWITCH_ACTIVE');
    expect(arg.evidence).toEqual(expect.objectContaining({ killSwitch: true, exitMode: false }));
  });

  it('does NOT persist anything on approval', async () => {
    const { orch, rejectionStore } = build({ gateEnabled: false });
    const r = await orch.process(signal);
    expect(r.kind).toBe('APPROVED');
    expect(rejectionStore.saveRejection).not.toHaveBeenCalled();
  });

  it('fails the flow (ERROR, lock released) when the rejection store itself fails — LOCKED behavior', async () => {
    const { orch, killSwitch, rejectionStore } = build({ gateEnabled: false });
    await killSwitch.activate('EMERGENCY', '1');
    rejectionStore.saveRejection.mockRejectedValueOnce(new Error('db down'));

    // Current contract: the audit row is inside the orchestration try-block,
    // so its failure returns ERROR and releases the idempotency lock (the
    // signal is re-processable; the proposal row is never saved). Changing
    // this to best-effort is a deliberate design decision, not an accident —
    // alter THIS test consciously if the orchestrator is ever relaxed.
    const r = await orch.process(signal);
    expect(r.kind).toBe('ERROR');
    expect(r.kind === 'ERROR' && r.reason).toBe('db down');
  });
});
