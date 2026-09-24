import { BirdeyeNewListingSource } from '../src/data/newPairs/birdeyeNewListing';
import { MockNewPairSource, makeNewPairEvent } from '../src/data/newPairs/mock';
import { NewPairPoller } from '../src/data/newPairs/newPairPoller';

const mkFetch = (payload: unknown, ok = true): typeof fetch =>
  (async () => ({ ok, status: ok ? 200 : 500, text: async () => '', json: async () => payload }) as Response) as unknown as typeof fetch;

describe('BirdeyeNewListingSource', () => {
  it('returns [] on HTTP error', async () => {
    const s = new BirdeyeNewListingSource('k', 'http://x', mkFetch({}, false));
    expect(await s.fetchNew(0)).toEqual([]);
  });

  it('returns [] on empty response', async () => {
    const s = new BirdeyeNewListingSource('k', 'http://x', mkFetch({}));
    expect(await s.fetchNew(0)).toEqual([]);
  });

  it('parses valid items', async () => {
    const s = new BirdeyeNewListingSource('k', 'http://x', mkFetch({
      data: { items: [
        {
          address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
          liquidity: 5000,
          v24hUSD: 12000,
          price: 0.001,
          mc: 50000,
          liquidityAddedAt: Math.floor(Date.now() / 1000) - 10,
        },
      ] },
    }));
    const events = await s.fetchNew(0);
    expect(events).toHaveLength(1);
    expect(events[0].liquidityUsd).toBe(5000);
    expect(events[0].volume24hUsd).toBe(12000);
    expect(events[0].marketCapUsd).toBe(50000);
  });

  it('skips items with missing address', async () => {
    const s = new BirdeyeNewListingSource('k', 'http://x', mkFetch({
      data: { items: [{ liquidity: 5000 }] },
    }));
    expect(await s.fetchNew(0)).toHaveLength(0);
  });

  it('skips items with implausible address', async () => {
    const s = new BirdeyeNewListingSource('k', 'http://x', mkFetch({
      data: { items: [{ address: 'not-a-pubkey' }] },
    }));
    expect(await s.fetchNew(0)).toHaveLength(0);
  });
});

describe('NewPairPoller', () => {
  it('emits each new pair exactly once', async () => {
    const src = new MockNewPairSource([
      makeNewPairEvent({ tokenMint: 'So11111111111111111111111111111111111111112' }),
      makeNewPairEvent({ tokenMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' }),
    ]);
    const poller = new NewPairPoller(src, { intervalMs: 1000, maxAgeMs: 60000 });
    const seen: string[] = [];
    poller.onEvent((e) => { seen.push(e.tokenMint); });

    const r1 = await poller.tick();
    expect(r1.emitted).toBe(2);
    expect(seen).toHaveLength(2);

    const r2 = await poller.tick();
    expect(r2.emitted).toBe(0);
    expect(seen).toHaveLength(2);
  });

  it('start/stop lifecycle', async () => {
    const src = new MockNewPairSource([]);
    const poller = new NewPairPoller(src, { intervalMs: 50, maxAgeMs: 60000 });
    expect(poller.isRunning()).toBe(false);
    poller.start();
    expect(poller.isRunning()).toBe(true);
    await poller.stop();
    expect(poller.isRunning()).toBe(false);
  });

  it('advances sinceMs after emission', async () => {
    const now = Date.now();
    const src = new MockNewPairSource([makeNewPairEvent({ detectedAt: now })]);
    const poller = new NewPairPoller(src, { intervalMs: 1000, maxAgeMs: 60000 });
    const before = poller.currentSinceMs();
    await poller.tick();
    expect(poller.currentSinceMs()).toBeGreaterThanOrEqual(before);
  });
});
