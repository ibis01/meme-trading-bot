import { CompositeMarketProvider } from '../src/data/composite';
import { MarketSnapshot } from '../src/strategy/types';

const mkProvider = (name: string, value: MarketSnapshot | null) => ({
  name,
  fetchSnapshot: async () => value,
}) as never;

const birdeyeSnap: MarketSnapshot = {
  tokenMint: 'mint',
  fetchedAt: Date.now(),
  priceUsd: 0.001,
  liquidityUsd: 250_000,
  volume24hUsd: 1_200_000,
  holderCount: 3_500,
  top10HolderPercent: 0,
  priceChange5mPercent: 2.1,
  priceChange1hPercent: 5.4,
};

describe('CompositeMarketProvider (Rule 30)', () => {
  it('returns null when Birdeye is missing (fail closed)', async () => {
    const c = new CompositeMarketProvider(
      mkProvider('helius', null) as never,
      mkProvider('birdeye', null) as never,
    );
    expect(await c.fetchSnapshot('mint')).toBeNull();
  });

  it('returns the Birdeye snapshot when Helius is missing', async () => {
    const c = new CompositeMarketProvider(
      mkProvider('helius', null) as never,
      mkProvider('birdeye', birdeyeSnap) as never,
    );
    const snap = await c.fetchSnapshot('mint');
    expect(snap).not.toBeNull();
    expect(snap!.priceUsd).toBe(birdeyeSnap.priceUsd);
  });

  it('returns the Birdeye snapshot when both are present', async () => {
    const c = new CompositeMarketProvider(
      mkProvider('helius', { ...birdeyeSnap, liquidityUsd: 999 }) as never,
      mkProvider('birdeye', birdeyeSnap) as never,
    );
    const snap = await c.fetchSnapshot('mint');
    expect(snap!.liquidityUsd).toBe(birdeyeSnap.liquidityUsd); // Birdeye wins
  });
});
