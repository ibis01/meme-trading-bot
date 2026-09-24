import { InMemorySignalStore } from '../src/state/signals';
import { MomentumStrategy, defaultMomentumConfig } from '../src/strategy/momentum';
import { MarketSnapshot, StrategyContext } from '../src/strategy/types';

const ctx: StrategyContext = { equitySol: 10, riskPerTradeSol: 0.1, maxPositionSol: 0.1 };
const market: MarketSnapshot = {
  tokenMint: 'mint',
  fetchedAt: Date.now(),
  priceUsd: 0.001,
  liquidityUsd: 100_000,
  volume24hUsd: 500_000,
  holderCount: 1000,
  top10HolderPercent: 20,
  smartWalletNetFlowUsd: 5000,
  priceChange5mPercent: 5,
  priceChange1hPercent: 10,
};

describe('SignalStore (Rule 20)', () => {
  it('persists a signal with full evidence', async () => {
    const store = new InMemorySignalStore();
    const strategy = new MomentumStrategy(defaultMomentumConfig);
    const signal = strategy.evaluate(market, ctx)!;
    await store.save(signal);
    const loaded = await store.getById(signal.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.evidence.entryReason).toBe(signal.evidence.entryReason);
    expect(loaded!.evidence.marketSnapshot.tokenMint).toBe('mint');
    expect(loaded!.evidence.indicators.score).toBe(signal.score);
  });

  it('saving the same id twice does not duplicate', async () => {
    const store = new InMemorySignalStore();
    const strategy = new MomentumStrategy(defaultMomentumConfig);
    const signal = strategy.evaluate(market, ctx)!;
    await store.save(signal);
    await store.save(signal);
    expect(await store.listRecent(10)).toHaveLength(1);
  });

  it('listRecent returns newest first', async () => {
    const store = new InMemorySignalStore();
    const strategy = new MomentumStrategy(defaultMomentumConfig);
    const s1 = strategy.evaluate(market, ctx)!;
    await new Promise((r) => setTimeout(r, 5));
    const s2 = strategy.evaluate(market, ctx)!;
    await store.save(s1);
    await store.save(s2);
    const recent = await store.listRecent(10);
    expect(recent[0].id).toBe(s2.id);
    expect(recent[1].id).toBe(s1.id);
  });
});
