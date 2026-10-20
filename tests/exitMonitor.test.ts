import { ExitMonitor, SOL_MINT, ExitRulesConfig } from '../src/app/exitMonitor';
import { MarketDataProvider } from '../src/data/types';
import { MarketSnapshot } from '../src/strategy/types';
import { ProposalOrchestrator } from '../src/orchestrator/orchestrator';
import { TradeExecutor } from '../src/execution/executor';
import { RiskEngine } from '../src/risk/engine';
import { MockSecurityProvider } from '../src/security';
import { IdempotencyService, RedisLike } from '../src/infra/idempotency';
import { InMemoryExecutionStore } from '../src/state/executions';
import { InMemoryProposalStore } from '../src/state/proposals';
import { InMemorySignalStore } from '../src/state/signals';
import { InMemoryKillSwitch } from '../src/state/killSwitch';
import { InMemoryPnlStore } from '../src/state/dailyPnl';
import { InMemoryPositionLedger } from '../src/state/positions/inMemoryLedger';
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionOutcome,
} from '../src/execution/types';

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

/** Mutable market data provider keyed by mint. */
class MockMarket implements MarketDataProvider {
  readonly name = 'mock-market';
  public prices: Record<string, number> = { [MINT]: 0.01, [SOL_MINT]: SOL_USD };
  async fetchSnapshot(tokenMint: string): Promise<MarketSnapshot | null> {
    const priceUsd = this.prices[tokenMint];
    if (priceUsd === undefined) return null;
    return {
      tokenMint,
      fetchedAt: Date.now(),
      priceUsd,
      liquidityUsd: 100_000,
      volume24hUsd: 1_000_000,
      priceChange5mPercent: 0,
      priceChange1hPercent: 0,
    };
  }
}

/**
 * Provider that prices SELLs off the mock market (mirrors PaperExecutionProvider
 * math) without paper-wallet state, so tests can seed ledger positions directly.
 */
class MarketPricedProvider implements ExecutionProvider {
  readonly name = 'market-priced';
  public requests: ExecutionRequest[] = [];
  constructor(private readonly market: MockMarket) {}
  assertEnabled(): void {}
  async execute(req: ExecutionRequest): Promise<ExecutionOutcome> {
    this.requests.push(req);
    const priceUsd = this.market.prices[req.tokenMint] ?? 0;
    if (!(priceUsd > 0)) {
      return {
        txSignature: '',
        filledAmountSol: 0,
        filledTokenAmount: 0,
        filledPriceUsd: 0,
        status: 'FAILED',
        error: 'ORACLE_PRICE_UNAVAILABLE',
      };
    }
    const priceSolPerToken = priceUsd / SOL_USD;
    if (req.side === 'BUY') {
      const tokens = req.amountSol / priceSolPerToken;
      return {
        txSignature: `sim_${Math.random()}`,
        filledAmountSol: req.amountSol,
        filledTokenAmount: tokens,
        filledPriceUsd: priceUsd,
        status: 'CONFIRMED',
      };
    }
    const tokens = req.tokenAmount ?? 0;
    return {
      txSignature: `sim_${Math.random()}`,
      filledAmountSol: tokens * priceSolPerToken,
      filledTokenAmount: tokens,
      filledPriceUsd: priceUsd,
      status: 'CONFIRMED',
    };
  }
}

const RULES: ExitRulesConfig = {
  stopLossPercent: 30,
  takeProfitPercent: 50,
  maxHoldMs: 0, // time stop off unless a test enables it
};

function buildHarness(opts: { rules?: Partial<ExitRulesConfig> } = {}) {
  const killSwitch = new InMemoryKillSwitch();
  const pnl = new InMemoryPnlStore();
  const positions = new InMemoryPositionLedger();
  const riskEngine = new RiskEngine({ killSwitch, pnl, positions });
  const orchestrator = new ProposalOrchestrator({
    riskEngine,
    security: new MockSecurityProvider(),
    idempotency: new IdempotencyService(new MockRedis()),
    proposals: new InMemoryProposalStore(),
    signals: new InMemorySignalStore(),
  });
  const market = new MockMarket();
  const provider = new MarketPricedProvider(market);
  const executor = new TradeExecutor({
    riskEngine,
    killSwitch,
    positions,
    proposals: new InMemoryProposalStore(),
    executions: new InMemoryExecutionStore(),
    idempotency: new IdempotencyService(new MockRedis()),
    provider,
    pnl,
  });
  const monitor = new ExitMonitor({
    positions,
    market,
    orchestrator,
    executor,
    rules: { ...RULES, ...opts.rules },
    exitSlippageBps: 200,
    exitPriceImpactBps: 300,
    intervalMs: 0,
  });

  const seedPosition = async (
    over: Partial<{ quantity: number; avgCostSol: number }> = {},
  ): Promise<void> => {
    await positions.open({
      tokenMint: MINT,
      tradeRequestId: `tr_${Math.random()}`,
      quantity: over.quantity ?? 500,
      priceSol: over.avgCostSol ?? 0.0001, // entry: $0.01 token at $100 SOL
      signature: 'sig_seed',
    });
  };

  return {
    monitor,
    positions,
    market,
    pnl,
    killSwitch,
    provider,
    seedPosition,
  };
}

describe('ExitMonitor (audit fix H1)', () => {
  it('does nothing when there are no open positions', async () => {
    const { monitor } = buildHarness();
    const r = await monitor.runOnce();
    expect(r.positionsChecked).toBe(0);
    expect(r.exitsTriggered).toBe(0);
  });

  it('holds a position inside the stop band (no exit)', async () => {
    const h = buildHarness();
    await h.seedPosition();
    const r = await h.monitor.runOnce();
    expect(r.exitsTriggered).toBe(0);
    expect(await h.positions.getOpenCount()).toBe(1);
  });

  it('fires STOP_LOSS beyond the stop distance, executes a full SELL, books real PnL', async () => {
    const h = buildHarness();
    await h.seedPosition(); // 500 tokens @ 0.0001 SOL = 0.05 SOL cost
    h.market.prices[MINT] = 0.005; // −50%
    const r = await h.monitor.runOnce();
    expect(r.exitsTriggered).toBe(1);
    expect(r.exitsApproved).toBe(1);
    expect(r.exitsExecuted).toBe(1);
    expect(await h.positions.getOpenCount()).toBe(0);
    // Proceeds 500 × 0.00005 = 0.025 SOL on 0.05 cost → −0.025 realized.
    expect(await h.pnl.getToday()).toBeCloseTo(-0.025, 8);
    // The provider got the exact ledger quantity.
    const sellReq = h.provider.requests.find((q) => q.side === 'SELL');
    expect(sellReq?.tokenAmount).toBeCloseTo(500, 6);
  });

  it('fires TAKE_PROFIT beyond the target and books a gain', async () => {
    const h = buildHarness();
    await h.seedPosition();
    h.market.prices[MINT] = 0.02; // +100%
    const r = await h.monitor.runOnce();
    expect(r.exitsTriggered).toBe(1);
    expect(r.exitsExecuted).toBe(1);
    expect(await h.pnl.getToday()).toBeCloseTo(0.05, 8);
  });

  it('fires TIME_STOP on aged positions regardless of price', async () => {
    const h = buildHarness({ rules: { maxHoldMs: 60_000 } });
    await h.seedPosition();
    // Age the position: rewrite openedAt via a fresh position entry.
    const pos = await h.positions.get(MINT);
    (pos as { openedAt: number }).openedAt = Date.now() - 120_000;
    // The in-memory ledger holds its own copy — patch it through close/open instead:
    // simplest deterministic path is a fresh harness with an old openedAt is not
    // exposed, so instead verify the rule logic via the second open path:
    await h.positions.close({
      tokenMint: MINT,
      tradeRequestId: 'tr_x',
      quantity: 500,
      priceSol: 0.0001,
      signature: 's',
    });
    await h.positions.open({
      tokenMint: MINT,
      tradeRequestId: 'tr_y',
      quantity: 500,
      priceSol: 0.0001,
      signature: 'sig_seed2',
    });
    // Patch the ledger's internal map directly (test-only access).
    const internal = (
      h.positions as unknown as { byMint: Map<string, { openedAt: number }> }
    ).byMint.get(MINT);
    internal!.openedAt = Date.now() - 120_000;

    const r = await h.monitor.runOnce();
    expect(r.exitsTriggered).toBe(1);
    expect(r.exitsExecuted).toBe(1);
  });

  it('skips positions with no market price and keeps them open', async () => {
    const h = buildHarness();
    await h.seedPosition();
    delete h.market.prices[MINT];
    const r = await h.monitor.runOnce();
    expect(r.pricesUnavailable).toBe(1);
    expect(r.exitsTriggered).toBe(0);
    expect(await h.positions.getOpenCount()).toBe(1);
  });

  it('exit still executes under an active kill switch (C2: exits are risk-reducing)', async () => {
    const h = buildHarness();
    await h.seedPosition();
    h.market.prices[MINT] = 0.005; // −50% → STOP_LOSS
    await h.killSwitch.activate('EMERGENCY', 'operator');
    const r = await h.monitor.runOnce();
    expect(r.exitsTriggered).toBe(1);
    expect(r.exitsExecuted).toBe(1);
  });

  it('exit proposal carries edge-of-config slippage so risk sanity gates pass', async () => {
    const h = buildHarness();
    await h.seedPosition();
    h.market.prices[MINT] = 0.02;
    await h.monitor.runOnce();
    // Any approved/attempted signal → orchestrator stores it; the executor ran.
    expect(h.provider.requests.length).toBe(1);
  });
});
