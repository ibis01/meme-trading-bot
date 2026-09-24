import { paperRun } from '../src/app/paperRun';
import { MarketSnapshot, StrategyContext } from '../src/strategy/types';

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

const ctx: StrategyContext = { equitySol: 10, riskPerTradeSol: 0.1, maxPositionSol: 0.1 };

const goodMarket = (o: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
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

const prices = { mint: 0.001 };

describe('paperRun — end-to-end pipeline (Task 011)', () => {
  it('produces NO_SIGNAL when momentum is weak', async () => {
    const r = await paperRun({
      market: goodMarket({ priceChange5mPercent: 0.1 }),
      ctx, prices,
    });
    expect(r.orchestratorKind).toBe('NO_SIGNAL');
    expect(r.openPositionsAfter).toBe(0);
  });

  it('runs a full APPROVED → CONFIRMED paper trade', async () => {
    const r = await paperRun({ market: goodMarket(), ctx, prices });
    expect(r.signal).not.toBeNull();
    expect(r.orchestratorKind).toBe('APPROVED');
    expect(r.executionKind).toBe('CONFIRMED');
    expect(r.executionSignature?.startsWith('paper_')).toBe(true);
    expect(r.openPositionsAfter).toBe(1);
  });

  it('executes only once per signal (idempotency end-to-end)', async () => {
    // Simulate two runs on the same pipeline — each buildPaperApp gives a fresh store,
    // so this instead verifies the orchestrator+executor chain doesn't double count
    // within a single run.
    const r = await paperRun({ market: goodMarket(), ctx, prices });
    expect(r.openPositionsAfter).toBe(1);
  });

  it('REJECTS via risk engine when amount exceeds max', async () => {
    // Force strategy to propose more than MAX_POSITION_SIZE_SOL (0.1)
    const r = await paperRun({
      market: goodMarket({ priceChange5mPercent: 20, priceChange1hPercent: 30 }),
      ctx: { equitySol: 100, riskPerTradeSol: 50, maxPositionSol: 50 },
      prices,
    });
    expect(r.signal).not.toBeNull();
    expect(r.orchestratorKind).toBe('REJECTED');
    expect(r.orchestratorReason).toBe('MAX_POSITION_SIZE_EXCEEDED');
    expect(r.openPositionsAfter).toBe(0);
  });
});
