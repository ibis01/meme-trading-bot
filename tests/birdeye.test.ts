import { BirdeyeMarketProvider } from '../src/data/birdeye';

const mkFetch = (payload: unknown, ok = true): typeof fetch =>
  (async () => ({ ok, status: ok ? 200 : 500, json: async () => payload }) as Response) as unknown as typeof fetch;

describe('BirdeyeMarketProvider (Rule 30)', () => {
  it('returns null on HTTP error', async () => {
    const p = new BirdeyeMarketProvider('key', 'http://x', mkFetch({}, false));
    expect(await p.fetchSnapshot('mint')).toBeNull();
  });

  it('returns null on missing fields', async () => {
    const p = new BirdeyeMarketProvider('key', 'http://x', mkFetch({ data: { price: 1 } }));
    expect(await p.fetchSnapshot('mint')).toBeNull();
  });

  it('builds a snapshot from a complete response', async () => {
    const p = new BirdeyeMarketProvider('key', 'http://x', mkFetch({
      data: {
        price: 0.001,
        liquidity: 250_000,
        v24hUSD: 1_200_000,
        holder: 3_500,
        priceChange5mPercent: 2.1,
        priceChange1hPercent: 5.4,
      },
    }));
    const snap = await p.fetchSnapshot('mint');
    expect(snap).not.toBeNull();
    expect(snap!.priceUsd).toBe(0.001);
    expect(snap!.liquidityUsd).toBe(250_000);
    expect(snap!.holderCount).toBe(3_500);
    expect(snap!.smartWalletNetFlowUsd).toBeUndefined();
  });
});
