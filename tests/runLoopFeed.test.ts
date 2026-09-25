import { MarketSnapshot } from '../src/strategy/types';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

let mockBirdeyeApiKey: string | undefined = 'test-key';

jest.mock('../src/config', () => ({
  config: {
    TRADING_MODE: 'paper',
    SOLANA_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=test',
    get BIRDEYE_API_KEY() { return mockBirdeyeApiKey; },
    DATABASE_URL: undefined,
    REDIS_URL: undefined,
    MAX_POSITION_SIZE_SOL: 0.1,
    MAX_DAILY_LOSS_SOL: 0.5,
    MAX_SLIPPAGE_BPS: 200,
    MAX_PRICE_IMPACT_BPS: 300,
    MAX_OPEN_POSITIONS: 5,
    MIN_LIQUIDITY_USD: 50000,
    MAX_TOP10_HOLDER_PERCENT: 30,
    MAX_DEV_WALLET_PERCENT: 5,
    MAX_QUOTE_AGE_MS: 5000,
    WALLET_PRIVATE_KEY: undefined,
  },
}));

jest.mock('../src/data/birdeye', () => ({
  BirdeyeMarketProvider: class {
    readonly name = 'birdeye-mock';
    async fetchSnapshot(mint: string): Promise<MarketSnapshot | null> {
      return {
        tokenMint: mint,
        fetchedAt: Date.now(),
        priceUsd: 0.001,
        liquidityUsd: 100_000,
        volume24hUsd: 500_000,
        holderCount: 1_000,
        top10HolderPercent: 20,
        smartWalletNetFlowUsd: 1_000,
        priceChange5mPercent: 1,
        priceChange1hPercent: 2,
      };
    }
  },
}));

describe('buildFeed (P1-11 / P1-11b)', () => {
  const OLD = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD };
    mockBirdeyeApiKey = 'test-key';
  });

  afterAll(() => {
    process.env = OLD;
  });

  it('returns a FixtureFeed by default', async () => {
    delete process.env.MARKET_SOURCE;
    const { buildFeed } = await import('../src/app/runLoop');
    const feed = buildFeed();
    expect(feed.name).toBe('fixture');
    const batch = await feed.next();
    expect(batch).toHaveLength(1);
    expect(batch[0].tokenMint).toContain('DEMO_TOKEN_MINT');
  });

  it('returns a ProviderFeed when MARKET_SOURCE=provider and mints are set', async () => {
    process.env.MARKET_SOURCE = 'provider';
    process.env.RECORDER_MINTS = 'So11111111111111111111111111111111111111112';
    const { buildFeed } = await import('../src/app/runLoop');
    const feed = buildFeed();
    expect(feed.name).toBe('provider');
    const batch = await feed.next();
    expect(batch).toHaveLength(1);
    expect(batch[0].tokenMint).toBe('So11111111111111111111111111111111111111112');
  });

  it('throws when MARKET_SOURCE=provider and no mints configured', async () => {
    process.env.MARKET_SOURCE = 'provider';
    delete process.env.RECORDER_MINTS;
    const { buildFeed } = await import('../src/app/runLoop');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noloop-'));
    const oldCwd = process.cwd();
    try {
      process.chdir(tmp);
      expect(() => buildFeed()).toThrow(/RECORDER_MINTS or create mints.txt/);
    } finally {
      process.chdir(oldCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws when BIRDEYE_API_KEY is missing (P1-11b fail-fast)', async () => {
    process.env.MARKET_SOURCE = 'provider';
    process.env.RECORDER_MINTS = 'So11111111111111111111111111111111111111112';
    mockBirdeyeApiKey = undefined;
    const { buildFeed } = await import('../src/app/runLoop');
    expect(() => buildFeed()).toThrow(/BIRDEYE_API_KEY is required/);
  });
});
