import { GeckoTerminalNewPoolsSource, mapDex } from '../src/data/newPairs/geckoTerminalNewPools';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WSOL = 'So11111111111111111111111111111111111111112';

const pool = (over: Record<string, unknown> = {}, rel: Record<string, unknown> = {}) => ({
  id: 'solana_POOL',
  type: 'pool',
  attributes: {
    address: 'POOL',
    pool_created_at: new Date(Date.now() - 60_000).toISOString(),
    base_token_price_usd: '0.002',
    reserve_in_usd: '12000.5',
    volume_usd: { h24: '3000' },
    ...over,
  },
  relationships: {
    base_token: { data: { id: `solana_${MINT}` } },
    quote_token: { data: { id: `solana_${WSOL}` } },
    dex: { data: { id: 'pumpswap' } },
    ...rel,
  },
});

const mkFetch = (payload: unknown, ok = true): typeof fetch =>
  (async () => ({ ok, status: ok ? 200 : 429, text: async () => '', json: async () => payload }) as Response) as unknown as typeof fetch;

describe('GeckoTerminalNewPoolsSource (Rule 30)', () => {
  it('parses a valid pool', async () => {
    const s = new GeckoTerminalNewPoolsSource(1, 'http://x', mkFetch({ data: [pool()] }));
    const [ev] = await s.fetchNew(0);
    expect(ev.tokenMint).toBe(MINT);
    expect(ev.dex).toBe('pumpswap');
    expect(ev.liquidityUsd).toBe(12000.5);
    expect(ev.volume24hUsd).toBe(3000);
    expect(ev.quoteMint).toBe(WSOL);
  });

  it('returns [] on HTTP error (e.g. 429)', async () => {
    const s = new GeckoTerminalNewPoolsSource(2, 'http://x', mkFetch({}, false));
    expect(await s.fetchNew(0)).toEqual([]);
  });

  it('skips unmapped dex, SOL base, bad ids and missing timestamps', async () => {
    const s = new GeckoTerminalNewPoolsSource(1, 'http://x', mkFetch({ data: [
      pool({}, { dex: { data: { id: 'some-new-dex' } } }),
      pool({}, { base_token: { data: { id: `solana_${WSOL}` } } }),
      pool({}, { base_token: { data: { id: 'solana_notapubkey' } } }),
      pool({}, { base_token: { data: { id: `eth_${MINT}` } } }),
      pool({ pool_created_at: undefined }),
    ] }));
    expect(await s.fetchNew(0)).toHaveLength(0);
  });

  it('missing liquidity stays undefined, never 0', async () => {
    const s = new GeckoTerminalNewPoolsSource(1, 'http://x', mkFetch({ data: [pool({ reserve_in_usd: undefined })] }));
    const [ev] = await s.fetchNew(0);
    expect(ev.liquidityUsd).toBeUndefined();
  });

  it('filters events older than sinceMs and sorts oldest first', async () => {
    const now = Date.now();
    const s = new GeckoTerminalNewPoolsSource(1, 'http://x', mkFetch({ data: [
      pool({ pool_created_at: new Date(now - 10_000).toISOString() }),
      pool({ pool_created_at: new Date(now - 90_000).toISOString() }),
      pool({ pool_created_at: new Date(now - 600_000).toISOString() }),
    ] }));
    const evs = await s.fetchNew(now - 120_000);
    expect(evs).toHaveLength(2);
    expect(evs[0].detectedAt).toBeLessThan(evs[1].detectedAt);
  });
});

describe('mapDex', () => {
  it('maps known dex ids and rejects unknown', () => {
    expect(mapDex('pumpswap')).toBe('pumpswap');
    expect(mapDex('pump-fun')).toBe('pumpfun');
    expect(mapDex('raydium-clmm')).toBe('raydium');
    expect(mapDex('meteora-dlmm')).toBe('meteora');
    expect(mapDex('orca')).toBe('orca');
    expect(mapDex('unknown')).toBeNull();
    expect(mapDex(undefined)).toBeNull();
  });
});
