import { BirdeyeMarketProvider } from '../src/data/birdeye';

const mkFetch = (payload: unknown, ok = true): typeof fetch =>
  (async () => ({ ok, status: ok ? 200 : 500, json: async () => payload }) as Response) as unknown as typeof fetch;

describe('BirdeyeMarketProvider (Rule 30)', () => {
  it('throws on HTTP error (oracle failure must be distinguishable from no-data)', async () => {
    const p = new BirdeyeMarketProvider('key', 'http://x', mkFetch({}, false));
    await expect(p.fetchSnapshot('mint')).rejects.toThrow(/Birdeye HTTP 500/);
  });

  it('throws on network failure (ETIMEDOUT etc.)', async () => {
    const throwingFetch = (async () => { throw new Error('ETIMEDOUT'); }) as unknown as typeof fetch;
    const p = new BirdeyeMarketProvider('key', 'http://x', throwingFetch);
    await expect(p.fetchSnapshot('mint')).rejects.toThrow(/ETIMEDOUT/);
  });

  it('returns null on HTTP 200 with missing fields', async () => {
    const p = new BirdeyeMarketProvider('key', 'http://x', mkFetch({ data: { price: 1 } }));
    expect(await p.fetchSnapshot('mint')).toBeNull();
  });

  it('returns null on HTTP 200 with no data field', async () => {
    const p = new BirdeyeMarketProvider('key', 'http://x', mkFetch({}));
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
