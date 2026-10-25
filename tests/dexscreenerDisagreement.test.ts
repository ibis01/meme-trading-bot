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

describe('DexScreener outlier materiality (BONK pollution fix)', () => {
  it('builds a snapshot when an immaterial pool deviates >10x from the dominant pool', async () => {
    // BONK failure mode: a $2k polluted side-pool quoting ~15,000x off used
    // to veto a $400k main pool and blind the bot to the mint entirely.
    const snap = await providerWith([
      pair({}),
      pair({ pairAddress: 'TRASH', priceUsd: '0.06', liquidity: { usd: 2_000 } }),
    ]).fetchSnapshot(MINT);
    expect(snap).not.toBeNull();
    expect(snap?.priceUsd).toBe(0.0000038);
    expect(snap?.liquidityUsd).toBe(400_000);
  });

  it('still refuses when a MATERIAL pool deviates from the dominant pool', async () => {
    const snap = await providerWith([
      pair({ liquidity: { usd: 1_000_000 } }),
      pair({ pairAddress: 'Q', priceUsd: '0.00000003', liquidity: { usd: 300_000 } }),
    ]).fetchSnapshot(MINT);
    expect(snap).toBeNull();
  });

  it('treats a pool at exactly 5% of dominant liquidity as material (veto-capable)', async () => {
    const snap = await providerWith([
      pair({ liquidity: { usd: 1_000_000 } }),
      pair({ pairAddress: 'Q', priceUsd: '0.00000003', liquidity: { usd: 50_000 } }),
    ]).fetchSnapshot(MINT);
    expect(snap).toBeNull();
  });

  it('ignores an immaterial pool deviating DOWNWARD as well (ratio is symmetric)', async () => {
    const snap = await providerWith([
      pair({}),
      pair({ pairAddress: 'TRASH', priceUsd: '0.0000000001', liquidity: { usd: 2_000 } }),
    ]).fetchSnapshot(MINT);
    expect(snap?.priceUsd).toBe(0.0000038);
  });

  it('does not veto when a material pool agrees but an immaterial one deviates', async () => {
    const snap = await providerWith([
      pair({ liquidity: { usd: 1_000_000 } }),
      pair({ pairAddress: 'OK', priceUsd: '0.0000040', liquidity: { usd: 200_000 } }),
      pair({ pairAddress: 'TRASH', priceUsd: '0.06', liquidity: { usd: 5_000 } }),
    ]).fetchSnapshot(MINT);
    expect(snap?.priceUsd).toBe(0.0000038);
  });
});
