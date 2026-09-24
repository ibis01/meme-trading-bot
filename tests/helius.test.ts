import { HeliusMarketProvider } from '../src/data/helius';

const mkFetch = (payload: unknown, ok = true): typeof fetch =>
  (async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  }) as Response) as unknown as typeof fetch;

describe('HeliusMarketProvider (Rule 30 — fail closed)', () => {
  it('returns null when a required field is missing', async () => {
    const fetchImpl = mkFetch({
      result: {
        liquidityUsd: 100_000,
        priceUsd: 0.001,
        // volume24hUsd missing
      },
    });
    const p = new HeliusMarketProvider('key', 'http://x', fetchImpl);
    expect(await p.fetchSnapshot('mint')).toBeNull();
  });

  it('returns null on HTTP error', async () => {
    const p = new HeliusMarketProvider('key', 'http://x', mkFetch({}, false));
    expect(await p.fetchSnapshot('mint')).toBeNull();
  });

  it('returns null on fetch throw', async () => {
    const bad: typeof fetch = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
    const p = new HeliusMarketProvider('key', 'http://x', bad);
    expect(await p.fetchSnapshot('mint')).toBeNull();
  });

  it('builds a snapshot when all required fields are present', async () => {
    const fetchImpl = mkFetch({
      result: {
        liquidityUsd: 100_000,
        priceUsd: 0.001,
        volume24hUsd: 500_000,
        holderCount: 1200,
        top10HolderPercent: 22,
        smartWalletNetFlowUsd: 5000,
        priceChange5mPercent: 5,
        priceChange1hPercent: 10,
      },
    });
    const p = new HeliusMarketProvider('key', 'http://x', fetchImpl);
    const snap = await p.fetchSnapshot('mint');
    expect(snap).not.toBeNull();
    expect(snap!.liquidityUsd).toBe(100_000);
    expect(snap!.tokenMint).toBe('mint');
  });
});
