import { PollerRecorder } from '../src/app/pollerRecorder';
import { InMemoryBarStore } from '../src/state/bars';
import { MarketDataProvider } from '../src/data/types';
import { MarketSnapshot } from '../src/strategy/types';

const snap = (mint: string): MarketSnapshot => ({
  tokenMint: mint,
  fetchedAt: Date.now(),
  priceUsd: 0.001,
  liquidityUsd: 200_000,
  volume24hUsd: 1_000_000,
  holderCount: 3_000,
  top10HolderPercent: 22,
  smartWalletNetFlowUsd: 5_000,
  priceChange5mPercent: 6.4,
  priceChange1hPercent: 12.0,
});

describe('PollerRecorder (Rules 20, 24, 30)', () => {
  it('persists snapshots for every successful mint', async () => {
    const store = new InMemoryBarStore();
    const provider: MarketDataProvider = {
      name: 'fake',
      fetchSnapshot: async (mint) => snap(mint),
    };
    const rec = new PollerRecorder({ provider, store, mints: ['a', 'b', 'c'] });
    const r = await rec.captureOnce();
    expect(r.fetched).toBe(3);
    expect(r.persisted).toBe(3);
    expect(r.skipped).toBe(0);
    expect((await store.get('a', 0, Date.now() + 1000)).length).toBe(1);
    expect((await store.get('b', 0, Date.now() + 1000)).length).toBe(1);
    expect((await store.get('c', 0, Date.now() + 1000)).length).toBe(1);
  });

  it('skips mints when provider returns null (fail closed)', async () => {
    const store = new InMemoryBarStore();
    const provider: MarketDataProvider = {
      name: 'fake',
      fetchSnapshot: async (mint) => (mint === 'bad' ? null : snap(mint)),
    };
    const rec = new PollerRecorder({ provider, store, mints: ['good', 'bad'] });
    const r = await rec.captureOnce();
    expect(r.fetched).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.persisted).toBe(1);
  });

  it('handles empty mint list', async () => {
    const store = new InMemoryBarStore();
    const provider: MarketDataProvider = {
      name: 'fake',
      fetchSnapshot: async () => null,
    };
    const rec = new PollerRecorder({ provider, store, mints: [] });
    const r = await rec.captureOnce();
    expect(r.mints).toBe(0);
    expect(r.persisted).toBe(0);
  });

  it('dedupes repeated captures at the same bucket (Rule 24)', async () => {
    const store = new InMemoryBarStore();
    const fixedTime = 1_700_000_000_000;
    const provider: MarketDataProvider = {
      name: 'fake',
      fetchSnapshot: async (mint) => ({ ...snap(mint), fetchedAt: fixedTime }),
    };
    const rec = new PollerRecorder({ provider, store, mints: ['a'] });
    await rec.captureOnce();
    await rec.captureOnce();
    const bars = await store.get('a', 0, fixedTime + 1000);
    expect(bars).toHaveLength(1);
  });
});
