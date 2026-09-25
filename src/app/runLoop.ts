import '../infra/netDefaults';
import fs from 'fs';
import path from 'path';
import { buildProductionApp } from './productionBootstrap';
import { SignalLoop } from './signalLoop';
import { FixtureFeed, ProviderFeed, MarketFeed } from '../data/feed';
import { BirdeyeMarketProvider } from '../data/birdeye';
import { DexScreenerMarketProvider } from '../data/dexscreener';
import { MarketDataProvider } from '../data/types';
import { MomentumStrategy, defaultMomentumConfig } from '../strategy/momentum';
import { MarketSnapshot } from '../strategy/types';
import { logger } from '../utils/logger';
import { closeRedis } from '../infra/redis';
import { closePool } from '../infra/db';
import { config } from '../config';
import { startTelegramBot } from '../telegram/bot';
import { TelegramTradeHandler } from '../telegram/tradeHandlers';

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

function buildProvider(): MarketDataProvider {
  // P1-17: DexScreener is the default live provider — no API key, ~300 req/min.
  if ((process.env.MARKET_SOURCE ?? 'fixture') === 'dexscreener') {
    return new DexScreenerMarketProvider();
  }

  // Birdeye retained as fallback for when MARKET_SOURCE=provider.
  const apiKey = config.BIRDEYE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'BIRDEYE_API_KEY is required for MARKET_SOURCE=provider (Birdeye). Helius DAS does not expose price/liquidity/volume/holders (P1-11b).',
    );
  }
  return new BirdeyeMarketProvider(apiKey);
}

export function buildFeed(): MarketFeed {
  const source = process.env.MARKET_SOURCE ?? 'fixture';

  if (source === 'provider' || source === 'dexscreener') {
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
    'DEMO MODE — using FixtureFeed with synthetic data. Set MARKET_SOURCE=dexscreener for real data.',
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

  // P1-12: start the Telegram control plane if configured.
  let telegramBot: ReturnType<typeof startTelegramBot> = null;
  if (config.TELEGRAM_BOT_TOKEN) {
    const tradeHandler = new TelegramTradeHandler({
      orchestrator: app.orchestrator,
      executor: app.executor,
      positions: app.positions,
    });
    telegramBot = startTelegramBot({
      positions: app.positions,
      proposals: app.proposals,
      onTradeRequest: async (req) => tradeHandler.handle({
        userId: req.userId,
        kind: req.kind,
        tokenMint: req.tokenMint,
        amountSol: req.amountSol,
      }),
      onCloseAll: async (userId) => tradeHandler.closeAll(userId),
    });
  } else {
    logger.warn('TELEGRAM_BOT_TOKEN not set — Telegram disabled.');
  }

  const shutdown = async (signal: string) => {
    logger.warn({ event: 'SHUTDOWN_RECEIVED', signal }, 'Shutting down…');
    try { telegramBot?.stop('shutdown'); } catch { /* ignore */ }
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
