import { TelegramTradeHandler } from '../src/telegram/tradeHandlers';
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
import { PaperExecutionProvider, StaticPriceOracle } from '../src/execution/paper';

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

function build() {
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
  const executor = new TradeExecutor({
    riskEngine, killSwitch, positions,
    proposals: new InMemoryProposalStore(),
    executions: new InMemoryExecutionStore(),
    idempotency: new IdempotencyService(new MockRedis()),
    provider: new PaperExecutionProvider(new StaticPriceOracle({ [MINT]: 0.01 })),
    pnl,
  });
  const handler = new TelegramTradeHandler({ orchestrator, executor, positions });
  return { handler, killSwitch, positions };
}

describe('TelegramTradeHandler (P1-12)', () => {
  it('BUY executes through the full pipeline', async () => {
    const { handler, positions } = build();
    const r = await handler.handle({ userId: 1, kind: 'BUY', tokenMint: MINT, amountSol: 0.05 });
    expect(r.ok).toBe(true);
    expect(await positions.getOpenCount()).toBe(1);
  });

  it('rejects a non-positive amount before building a Signal', async () => {
    const { handler } = build();
    const r = await handler.handle({ userId: 1, kind: 'BUY', tokenMint: MINT, amountSol: 0 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/positive/i);
  });

  it('rejects an invalid mint', async () => {
    const { handler } = build();
    const r = await handler.handle({ userId: 1, kind: 'BUY', tokenMint: 'not-a-mint', amountSol: 0.05 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/invalid token/i);
  });

  it('is blocked by the kill switch (Rule 14)', async () => {
    const { handler, killSwitch, positions } = build();
    await killSwitch.activate('EMERGENCY', '1');
    const r = await handler.handle({ userId: 1, kind: 'BUY', tokenMint: MINT, amountSol: 0.05 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/KILL_SWITCH/);
    expect(await positions.getOpenCount()).toBe(0);
  });

  it('is rejected by the Risk Engine when position exceeds max', async () => {
    const { handler, positions } = build();
    const r = await handler.handle({ userId: 1, kind: 'BUY', tokenMint: MINT, amountSol: 999 });
    expect(r.ok).toBe(false);
    expect(await positions.getOpenCount()).toBe(0);
  });

  it('SELL closes a previously-opened BUY position', async () => {
    const { handler, positions } = build();
    await handler.handle({ userId: 1, kind: 'BUY', tokenMint: MINT, amountSol: 0.05 });
    expect(await positions.getOpenCount()).toBe(1);
    const r = await handler.handle({ userId: 1, kind: 'SELL', tokenMint: MINT });
    expect(r.ok).toBe(true);
    expect(await positions.getOpenCount()).toBe(0);
  });

  it('closeAll sells every open position', async () => {
    const { handler, positions } = build();
    const MINT2 = 'So11111111111111111111111111111111111111112';
    await handler.handle({ userId: 1, kind: 'BUY', tokenMint: MINT, amountSol: 0.05 });
    await handler.handle({ userId: 1, kind: 'BUY', tokenMint: MINT2, amountSol: 0.05 });
    expect(await positions.getOpenCount()).toBe(2);

    const r = await handler.closeAll(1);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/2 closed, 0 failed/);
    expect(await positions.getOpenCount()).toBe(0);
  });

  it('closeAll on empty portfolio is a no-op', async () => {
    const { handler } = build();
    const r = await handler.closeAll(1);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/No open positions/);
  });
});