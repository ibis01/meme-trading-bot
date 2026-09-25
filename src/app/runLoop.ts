import fs from 'fs';
import path from 'path';
import { buildProductionApp } from './productionBootstrap';
import { SignalLoop } from './signalLoop';
import { FixtureFeed, ProviderFeed, MarketFeed } from '../data/feed';
import { HeliusMarketProvider } from '../data/helius';
import { BirdeyeMarketProvider } from '../data/birdeye';
import { CompositeMarketProvider } from '../data/composite';
import { MarketDataProvider } from '../data/types';
import { MomentumStrategy, defaultMomentumConfig } from '../strategy/momentum';
import { MarketSnapshot } from '../strategy/types';
import { logger } from '../utils/logger';
import { closeRedis } from '../infra/redis';
import { closePool } from '../infra/db';
import { config } from '../config';

const DEMO_MINT = 'DEMO_TOKEN_MINT_11111111111111111111111111111';

function demoSnapshot(): MarketSnapshot {
  return {
    tokenMint: DEMO_MINT,
    fetchedAt: Date.now(),
    priceUsd: 0.001,
    liquidityUsd: 250_000,
    volume24hUsd: 1_200_000,
    holderCount: 3_200,
    top10HolderPercent: 22,
    smartWalletNetFlowUsd: 8_500,
    priceChange5mPercent: 6.4,
    priceChange1hPercent: 14.1,
  };
}

/** Read mints from RECORDER_MINTS env or mints.txt. */
function readMints(): string[] {
  const env = process.env.RECORDER_MINTS;
  if (env) {
    return env.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const file = path.resolve(process.cwd(), 'mints.txt');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function extractHeliusKey(rpcUrl: string): string {
  try {
    const u = new URL(rpcUrl);
    return u.searchParams.get('api-key') ?? '';
  } catch {
    return '';
  }
}

function buildProvider(): MarketDataProvider {
  const heliusKey = extractHeliusKey(config.SOLANA_RPC_URL);
  const helius = heliusKey
    ? new HeliusMarketProvider(heliusKey, config.SOLANA_RPC_URL)
    : null;
  const birdeye = config.BIRDEYE_API_KEY
    ? new BirdeyeMarketProvider(config.BIRDEYE_API_KEY)
    : null;

  if (helius && birdeye) return new CompositeMarketProvider(helius, birdeye);
  if (birdeye) {
    logger.warn('Helius unavailable — falling back to Birdeye-only provider.');
    return birdeye;
  }
  if (helius) {
    logger.warn('Birdeye unavailable — falling back to Helius-only provider.');
    return helius;
  }
  throw new Error('No market data provider available: set SOLANA_RPC_URL (Helius) and/or BIRDEYE_API_KEY.');
}

export function buildFeed(): MarketFeed {
  const source = process.env.MARKET_SOURCE ?? 'fixture';

  if (source === 'provider') {
    const mints = readMints();
    if (mints.length === 0) {
      throw new Error(
        'MARKET_SOURCE=provider requires mints. Set RECORDER_MINTS or create mints.txt.',
      );
    }
    const provider = buildProvider();
    logger.info({ provider: provider.name, mints: mints.length }, 'Using live market feed');
    return new ProviderFeed(provider, mints);
  }

  logger.warn(
    { source },
    'DEMO MODE — using FixtureFeed with synthetic data. Set MARKET_SOURCE=provider for real data.',
  );
  return new FixtureFeed([demoSnapshot()]);
}

async function main() {
  logger.info(
    { tradingMode: config.TRADING_MODE, marketSource: process.env.MARKET_SOURCE ?? 'fixture' },
    'Starting bot in loop mode',
  );

  const app = buildProductionApp();
  const feed = buildFeed();

  const loop = new SignalLoop(
    {
      feed,
      strategy: new MomentumStrategy(defaultMomentumConfig),
      strategyContext: { equitySol: 10, riskPerTradeSol: 0.1, maxPositionSol: 0.1 },
      orchestrator: app.orchestrator,
      executor: app.executor,
    },
    { intervalMs: Number(process.env.LOOP_INTERVAL_MS ?? 15_000) },
  );

  loop.start();

  const shutdown = async (signal: string) => {
    logger.warn({ event: 'SHUTDOWN_RECEIVED', signal }, 'Shutting down…');
    await loop.stop();
    try { await closeRedis(); } catch { /* ignore */ }
    try { await closePool(); } catch { /* ignore */ }
    logger.info({ event: 'SHUTDOWN_COMPLETE' }, 'Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// Only run when invoked directly (not when imported by tests).
if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'Startup failed');
    process.exit(1);
  });
}
