import { DexScreenerMarketProvider } from '../src/data/dexscreener';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

const pair = (over: Record<string, unknown>) => ({
  chainId: 'solana',
  dexId: 'raydium',
  pairAddress: 'P',
  baseToken: { address: MINT },
  quoteToken: { address: 'So11111111111111111111111111111111111111112' },
  priceUsd: '0.0000038',
  liquidity: { usd: 400_000 },
  volume: { h24: 500_000 },
  priceChange: { m5: 0.1, h1: 0.2 },
  ...over,
});

const providerWith = (pairs: unknown[]) =>
  new DexScreenerMarketProvider('http://x', (async () => ({
    ok: true, status: 200, text: async () => '', json: async () => ({ pairs }),
  })) as unknown as typeof fetch);

describe('DexScreener price disagreement (Rule 30)', () => {
  it('builds a snapshot when pools agree', async () => {
    const snap = await providerWith([pair({}), pair({ pairAddress: 'Q', priceUsd: '0.0000039', liquidity: { usd: 50_000 } })]).fetchSnapshot(MINT);
    expect(snap?.priceUsd).toBe(0.0000038);
  });

  it('refuses when liquid pools disagree by more than 10x', async () => {
    const snap = await providerWith([pair({}), pair({ pairAddress: 'Q', priceUsd: '0.06', liquidity: { usd: 450_000 } })]).fetchSnapshot(MINT);
    expect(snap).toBeNull();
  });

  it('ignores dust pools (<$1k liquidity) when checking agreement', async () => {
    const snap = await providerWith([pair({}), pair({ pairAddress: 'Q', priceUsd: '0.06', liquidity: { usd: 200 } })]).fetchSnapshot(MINT);
    expect(snap?.priceUsd).toBe(0.0000038);
  });
});
