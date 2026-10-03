import { resolveRecorderProvider } from '../src/app/recorderProvider';
import { PostgresBarStore } from '../src/state/bars';
import { Pool } from 'pg';

describe('resolveRecorderProvider (Rule 30)', () => {
  it('defaults to DexScreener with no API key', () => {
    const r = resolveRecorderProvider({});
    expect(r.provider.name).toBe('dexscreener');
    expect(r.defaultDelayMs).toBe(400);
  });

  it('birdeye requires an API key', () => {
    expect(() => resolveRecorderProvider({ source: 'birdeye' })).toThrow(/BIRDEYE_API_KEY/);
    const r = resolveRecorderProvider({ source: 'birdeye', birdeyeApiKey: 'k' });
    expect(r.provider.name).toBe('birdeye');
  });

  it('rejects unknown sources instead of falling back', () => {
    expect(() => resolveRecorderProvider({ source: 'nope' })).toThrow(/Unknown RECORDER_SOURCE/);
  });
});

describe('PostgresBarStore unknown-vs-zero for holder fields (Rule 30)', () => {
  const snap = {
    tokenMint: 'm', fetchedAt: 1000, priceUsd: 1, nextPriceUsd: 0,
    liquidityUsd: 10, volume24hUsd: 10,
    priceChange5mPercent: 0, priceChange1hPercent: 0,
  };

  it('writes undefined holder fields as NULL, not 0', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await new PostgresBarStore({ query } as unknown as Pool).saveMany([snap]);
    const params = query.mock.calls[0][1] as unknown[];
    // order: mint, bucket, price, liq, vol, holderCount, top10, flow, 5m, 1h
    expect(params[5]).toBeNull();
    expect(params[6]).toBeNull();
    expect(params[7]).toBeNull();
  });

  it('reads NULL holder columns back as undefined, not 0', async () => {
    const row = {
      token_mint: 'm', bucket_ms: '1000', price_usd: '1', liquidity_usd: '10',
      volume_24h_usd: '10', holder_count: null, top10_holder_percent: null,
      smart_wallet_net_flow_usd: null, price_change_5m_percent: '0', price_change_1h_percent: '0',
    };
    const query = jest.fn().mockResolvedValue({ rows: [row] });
    const [bar] = await new PostgresBarStore({ query } as unknown as Pool).get('m', 0, 2000);
    expect(bar.holderCount).toBeUndefined();
    expect(bar.top10HolderPercent).toBeUndefined();
    expect(bar.smartWalletNetFlowUsd).toBeUndefined();
  });
});
