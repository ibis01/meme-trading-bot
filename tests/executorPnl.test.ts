import { TradeExecutor } from '../src/execution/executor';
import {
  PaperExecutionProvider,
  StaticPriceOracle,
  SolAwarePriceOracle,
} from '../src/execution/paper';
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
  async del(key: string) {
    return this.store.delete(key) ? 1 : 0;
  }
}

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SOL_USD = 100;

/** Oracle whose token price can move between fills — drives real PnL. */
class MutablePriceOracle implements SolAwarePriceOracle {
  constructor(
    public prices: Record<string, number>,
    private readonly solPriceUsd: number = SOL_USD,
  ) {}
  async getPriceUsd(tokenMint: string): Promise<number> {
    return this.prices[tokenMint] ?? 0.001;
  }
  async getSolPriceUsd(): Promise<number> {
    return this.solPriceUsd;
  }
}

const proposal = (
  side: 'BUY' | 'SELL',
  requestSuffix: string,
  sellPercentBps?: number,
): StoredProposal => ({
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
    sellPercentBps,
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

function mkExecutor(oracle: SolAwarePriceOracle) {
  const killSwitch = new InMemoryKillSwitch();
  const pnl = new InMemoryPnlStore();
  const positions = new InMemoryPositionLedger();
  const riskEngine = new RiskEngine({ killSwitch, pnl, positions });
  const proposals = new InMemoryProposalStore();
  const executions = new InMemoryExecutionStore();
  const idempotency = new IdempotencyService(new MockRedis());
  const provider = new PaperExecutionProvider(oracle);
  const executor = new TradeExecutor({
    riskEngine,
    killSwitch,
    positions,
    proposals,
    executions,
    idempotency,
    provider,
    pnl,
  });
  return { executor, pnl, positions, provider };
}

describe('TradeExecutor — token-unit ledger + realized PnL (audit fix C1)', () => {
  it('BUY books TOKEN quantity at SOL-per-token cost, not SOL notional', async () => {
    // 0.05 SOL at $0.01/token and $100/SOL → 0.01/100 = 0.0001 SOL per token → 500 tokens.
    const { executor, positions } = mkExecutor(
      new StaticPriceOracle({ [MINT]: 0.01 }, SOL_USD),
    );
    await executor.execute(proposal('BUY', 'buy1'));
    expect(await positions.getOpenCount()).toBe(1);
    const p = await positions.get(MINT);
    expect(p).not.toBeNull();
    expect(p!.quantity).toBeCloseTo(500, 6);
    expect(p!.avgCostSol).toBeCloseTo(0.0001, 10);
  });

  it('SELL closes the position and books REALIZED PnL at an unchanged price (0)', async () => {
    const { executor, pnl, positions } = mkExecutor(
      new StaticPriceOracle({ [MINT]: 0.01 }, SOL_USD),
    );
    await executor.execute(proposal('BUY', 'c1'));
    const r = await executor.execute(proposal('SELL', 'c2'));
    expect(r.kind).toBe('CONFIRMED');
    expect(await positions.getOpenCount()).toBe(0);
    // Same price in and out → proceeds 0.05, cost 0.05 → PnL 0.
    expect(await pnl.getToday()).toBeCloseTo(0, 8);
  });

  it('price doubling between entry and exit books a POSITIVE realized PnL', async () => {
    const oracle = new MutablePriceOracle({ [MINT]: 0.01 });
    const { executor, pnl } = mkExecutor(oracle);
    await executor.execute(proposal('BUY', 'up1'));

    oracle.prices[MINT] = 0.02; // 2x
    const r = await executor.execute(proposal('SELL', 'up2'));
    expect(r.kind).toBe('CONFIRMED');
    // Proceeds = 0.10 SOL on 0.05 cost → +0.05 SOL realized.
    expect(await pnl.getToday()).toBeCloseTo(0.05, 8);
  });

  it('price collapse between entry and exit books a NEGATIVE realized PnL', async () => {
    const oracle = new MutablePriceOracle({ [MINT]: 0.01 });
    const { executor, pnl } = mkExecutor(oracle);
    await executor.execute(proposal('BUY', 'down1'));

    oracle.prices[MINT] = 0.002; // −80%
    const r = await executor.execute(proposal('SELL', 'down2'));
    expect(r.kind).toBe('CONFIRMED');
    // Proceeds = 0.01 SOL on 0.05 cost → −0.04 SOL realized.
    expect(await pnl.getToday()).toBeCloseTo(-0.04, 8);
  });

  it('partial sell (sellPercentBps) closes only the requested fraction', async () => {
    const { executor, positions, pnl } = mkExecutor(
      new StaticPriceOracle({ [MINT]: 0.01 }, SOL_USD),
    );
    await executor.execute(proposal('BUY', 'part1'));
    const r = await executor.execute(proposal('SELL', 'part2', 5_000)); // 50%
    expect(r.kind).toBe('CONFIRMED');
    const p = await positions.get(MINT);
    expect(p!.quantity).toBeCloseTo(250, 6);
    expect(await positions.getOpenCount()).toBe(1);
    expect(await pnl.getToday()).toBeCloseTo(0, 8); // same price → 0 PnL
  });

  it('REJECTS a SELL with no open position before submission (pre-submit)', async () => {
    const { executor, pnl } = mkExecutor(
      new StaticPriceOracle({ [MINT]: 0.01 }, SOL_USD),
    );
    const r = await executor.execute(proposal('SELL', 'sell_no_pos'));
    expect(r.kind).toBe('REJECTED');
    expect(r.kind === 'REJECTED' && r.reason).toBe('NO_OPEN_POSITION');
    expect(await pnl.getToday()).toBe(0);
  });

  it('BUY does not touch daily PnL', async () => {
    const { executor, pnl } = mkExecutor(
      new StaticPriceOracle({ [MINT]: 0.01 }, SOL_USD),
    );
    await executor.execute(proposal('BUY', 'buy_only'));
    expect(await pnl.getToday()).toBe(0);
  });
});
