import { InMemoryBarStore, linkNextPrices } from '../src/state/bars';
import { PriceBar } from '../src/backtest/types';

const bar = (bucket: number, price: number): PriceBar => ({
  tokenMint: 'mint',
  fetchedAt: bucket,
  priceUsd: price,
  nextPriceUsd: 0,
  liquidityUsd: 100,
  volume24hUsd: 100,
  holderCount: 10,
  top10HolderPercent: 10,
  smartWalletNetFlowUsd: 0,
  priceChange5mPercent: 0,
  priceChange1hPercent: 0,
});

describe('BarStore + linkNextPrices (Rules 20, 24)', () => {
  it('dedupes on (mint, bucket)', async () => {
    const s = new InMemoryBarStore();
    await s.save(bar(1000, 1));
    await s.save(bar(1000, 1.1));
    const got = await s.get('mint', 0, 2000);
    expect(got).toHaveLength(1);
  });

  it('filters by range', async () => {
    const s = new InMemoryBarStore();
    await s.saveMany([bar(1000, 1), bar(2000, 2), bar(3000, 3)]);
    const got = await s.get('mint', 1500, 3500);
    expect(got.map((b) => b.fetchedAt)).toEqual([2000, 3000]);
  });

  it('linkNextPrices fills nextPriceUsd from the following bar', () => {
    const bars = [bar(1000, 1), bar(2000, 2), bar(3000, 3)];
    const linked = linkNextPrices(bars);
    expect(linked[0].nextPriceUsd).toBe(2);
    expect(linked[1].nextPriceUsd).toBe(3);
    expect(linked[2].nextPriceUsd).toBe(0);
  });
});
