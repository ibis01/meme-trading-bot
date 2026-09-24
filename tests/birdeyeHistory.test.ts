import { BirdeyeHistoryProvider } from '../src/data/birdeyeHistory';

const okFetch = (ohlcvItems: unknown[], overview?: Record<string, unknown>): typeof fetch => {
  return (async (url: string) => {
    const u = String(url);
    if (u.includes('/defi/token_overview')) {
      return {
        ok: true, status: 200,
        json: async () => ({ data: overview ?? {} }),
      } as Response;
    }
    if (u.includes('/defi/ohlcv')) {
      return {
        ok: true, status: 200,
        json: async () => ({ data: { items: ohlcvItems } }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
};

describe('BirdeyeHistoryProvider (Task 035)', () => {
  it('returns [] for unsupported interval', async () => {
    const p = new BirdeyeHistoryProvider({ apiKey: 'k', fetchImpl: okFetch([]) });
    const bars = await p.fetchBars('mint', 0, 1_000_000, 7_000); // 7s not supported
    expect(bars).toEqual([]);
  });

  it('returns [] when OHLCV is empty', async () => {
    const p = new BirdeyeHistoryProvider({ apiKey: 'k', fetchImpl: okFetch([]) });
    const bars = await p.fetchBars('mint', 1_700_000_000_000, 1_700_003_600_000, 60_000);
    expect(bars).toEqual([]);
  });

  it('parses OHLCV items into PriceBars', async () => {
    const items = [
      { unixTime: 1700000000, o: 1, h: 1, l: 1, c: 1.0, v: 100 },
      { unixTime: 1700000060, o: 1, h: 1, l: 1, c: 1.02, v: 100 },
      { unixTime: 1700000120, o: 1, h: 1, l: 1, c: 1.04, v: 100 },
    ];
    const p = new BirdeyeHistoryProvider({
      apiKey: 'k',
      fetchImpl: okFetch(items, { liquidity: 100_000, v24hUSD: 500_000, holder: 1000 }),
    });
    const bars = await p.fetchBars('mint', 1_700_000_000_000, 1_700_000_200_000, 60_000);
    expect(bars.length).toBe(3);
    expect(bars[0].priceUsd).toBe(1.0);
    expect(bars[1].priceUsd).toBeCloseTo(1.02);
    expect(bars[2].priceUsd).toBeCloseTo(1.04);
    expect(bars[0].liquidityUsd).toBe(100_000);
    expect(bars[0].holderCount).toBe(1000);
    // smartWalletNetFlowUsd left undefined on backfilled bars
    expect(bars[0].smartWalletNetFlowUsd).toBeUndefined();
  });

  it('computes priceChange from the price path', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      unixTime: 1700000000 + i * 60,
      o: 1, h: 1, l: 1,
      c: 1 + i * 0.01,
      v: 100,
    }));
    const p = new BirdeyeHistoryProvider({ apiKey: 'k', fetchImpl: okFetch(items) });
    const bars = await p.fetchBars('mint', 1_700_000_000_000, 1_700_000_700_000, 60_000);
    // First 5 bars: no lookback → 0%
    expect(bars[0].priceChange5mPercent).toBe(0);
    // 6th bar (i=5): 5-bar lookback = 5 min, price went from 1.00 to 1.05 → +5%
    expect(bars[5].priceChange5mPercent).toBeCloseTo(5, 1);
  });

  it('skips items with missing or invalid close', async () => {
    const items = [
      { unixTime: 1700000000, c: 1.0 },
      { unixTime: 1700000060 },                      // missing c
      { unixTime: 1700000120, c: 'not-a-number' },
      { unixTime: 1700000180, c: 1.04 },
    ];
    const p = new BirdeyeHistoryProvider({ apiKey: 'k', fetchImpl: okFetch(items) });
    const bars = await p.fetchBars('mint', 1_700_000_000_000, 1_700_000_200_000, 60_000);
    expect(bars.length).toBe(2);
    expect(bars[0].priceUsd).toBe(1.0);
    expect(bars[1].priceUsd).toBeCloseTo(1.04);
  });

  it('sorts bars by timestamp', async () => {
    const items = [
      { unixTime: 1700000120, c: 3 },
      { unixTime: 1700000000, c: 1 },
      { unixTime: 1700000060, c: 2 },
    ];
    const p = new BirdeyeHistoryProvider({ apiKey: 'k', fetchImpl: okFetch(items) });
    const bars = await p.fetchBars('mint', 1_700_000_000_000, 1_700_000_200_000, 60_000);
    expect(bars.map((b) => b.priceUsd)).toEqual([1, 2, 3]);
  });

  it('paginates when the range exceeds maxItemsPerRequest', async () => {
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes('/defi/token_overview')) {
        return { ok: true, status: 200, json: async () => ({ data: {} }) } as Response;
      }
      if (u.includes('/defi/ohlcv')) {
        calls += 1;
        // Return a single candle per page
        return {
          ok: true, status: 200,
          json: async () => ({ data: { items: [{ unixTime: 1700000000 + calls * 60, c: 1 }] } }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    }) as unknown as typeof fetch;

    const p = new BirdeyeHistoryProvider({
      apiKey: 'k',
      fetchImpl,
      maxItemsPerRequest: 2,
      interRequestDelayMs: 0,
    });
    await p.fetchBars('mint', 1_700_000_000_000, 1_700_000_600_000, 60_000);
    // 10 minutes at 2 min per page = 5 pages
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('returns [] on HTTP error', async () => {
    const bad = (async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    const p = new BirdeyeHistoryProvider({ apiKey: 'k', fetchImpl: bad });
    const bars = await p.fetchBars('mint', 1_700_000_000_000, 1_700_000_600_000, 60_000);
    expect(bars).toEqual([]);
  });
});
